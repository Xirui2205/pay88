package com.telebirr.gateway.agent.activation

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.view.WindowManager
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.telebirr.gateway.agent.AgentApplication
import com.telebirr.gateway.agent.BuildConfig
import com.telebirr.gateway.agent.R
import com.telebirr.gateway.agent.config.AgentConfig
import com.telebirr.gateway.agent.pin.LocalPinEnrollmentValidation
import com.telebirr.gateway.agent.pin.LocalPinEnrollmentValidator
import com.telebirr.gateway.agent.service.HeartbeatService
import com.telebirr.gateway.agent.transport.MtlsOkHttpClientFactory
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

class ActivationActivity : AppCompatActivity() {
    private val permissions = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { /* Heartbeats report any denied permission; assignments remain disabled. */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        setContentView(R.layout.activity_activation)
        requestRuntimePermissions()

        val application = application as AgentApplication
        val status = findViewById<TextView>(R.id.activationStatus)
        status.text = application.container.config.current()?.let { "Activated: ${it.deviceId}" }
            ?: getString(R.string.not_activated)

        findViewById<Button>(R.id.activateButton).setOnClickListener {
            val gateway = findViewById<EditText>(R.id.gatewayUrl).text.toString().trim()
            val codeField = findViewById<EditText>(R.id.activationCode)
            val code = codeField.text.toString().trim()
            if (code.isBlank()) {
                status.text = getString(R.string.activation_fields_required)
                return@setOnClickListener
            }
            status.text = getString(R.string.activating)
            lifecycleScope.launch {
                runCatching {
                    val client = ActivationClient(
                        MtlsOkHttpClientFactory.create(this@ActivationActivity, "")
                            .newBuilder()
                            .callTimeout(20, TimeUnit.SECONDS)
                            .readTimeout(20, TimeUnit.SECONDS)
                            .build(),
                    )
                    val response = client.activate(
                        gateway,
                        ActivationRequest(
                            activationCode = code,
                            installationId = installationId(),
                            hardwareSerial = installationId(),
                            certificateAlias = "",
                            protocolVersion = BuildConfig.AGENT_PROTOCOL_VERSION,
                            manufacturer = Build.MANUFACTURER,
                            model = Build.MODEL,
                            androidRelease = Build.VERSION.RELEASE,
                            androidSdk = Build.VERSION.SDK_INT,
                            appVersion = BuildConfig.VERSION_NAME,
                            buildFingerprint = Build.FINGERPRINT,
                        ),
                    )
                    val activeSubscriptions = application.container.subscriptionResolver.active()
                    response.sims.forEach { enrolled ->
                        val observed = activeSubscriptions.singleOrNull { it.iccid == enrolled.iccid }
                            ?: error("Enrolled SIM is not uniquely present")
                        check(observed.slotIndex == enrolled.expectedSlotIndex) {
                            "Enrolled SIM is in the wrong slot"
                        }
                        application.container.simEnrollments.enroll(
                            iccid = enrolled.iccid,
                            telebirrNumber = enrolled.telebirrNumber,
                            accountName = enrolled.registeredName,
                            expectedSlot = enrolled.expectedSlotIndex,
                            observedSlot = observed.slotIndex,
                            subscriptionId = observed.subscriptionId,
                        )
                    }
                    application.container.config.saveActivation(
                        AgentConfig(
                            gatewayBaseUrl = gateway,
                            websocketUrl = response.websocketUrl,
                            deviceId = response.deviceId,
                            deviceToken = response.deviceToken,
                            clientCertificateAlias = "",
                            signingKeyId = response.keyId,
                            signingPublicKeyX509 = com.telebirr.gateway.agent.crypto.PayloadVerifier
                                .x509Base64FromPem(response.signingPublicKeyPem),
                            heartbeatIntervalSeconds = response.heartbeatIntervalSeconds,
                        ),
                    )
                    response.deviceId
                }.onSuccess { deviceId ->
                    status.text = getString(R.string.activated_device, deviceId)
                    HeartbeatService.start(this@ActivationActivity)
                }.onFailure { error ->
                    status.text = error.message ?: getString(R.string.activation_failed)
                }
                // The short-lived activation secret is erased from the view either way.
                codeField.text.clear()
            }
        }

        findViewById<Button>(R.id.savePinButton).setOnClickListener {
            val iccidField = findViewById<EditText>(R.id.iccid)
            val pinField = findViewById<EditText>(R.id.localPin)
            val confirmationField = findViewById<EditText>(R.id.localPinConfirmation)
            val iccid = iccidField.text.toString().trim()
            val pin = CharArray(pinField.text.length) { index -> pinField.text[index] }
            val confirmation = CharArray(confirmationField.text.length) { index ->
                confirmationField.text[index]
            }
            try {
                when (LocalPinEnrollmentValidator.validate(iccid, pin, confirmation)) {
                    LocalPinEnrollmentValidation.REQUIRED_FIELD_MISSING -> {
                        status.text = getString(R.string.pin_fields_required)
                    }

                    LocalPinEnrollmentValidation.PIN_MISMATCH -> {
                        status.text = getString(R.string.pin_confirmation_mismatch)
                    }

                    LocalPinEnrollmentValidation.VALID -> {
                        runCatching { application.container.pinVault.put(iccid, pin) }
                            .onSuccess {
                                status.text = getString(R.string.local_pin_stored, iccid.takeLast(4))
                                iccidField.text.clear()
                            }
                            .onFailure {
                                status.text = it.message ?: getString(R.string.pin_storage_failed)
                            }
                    }
                }
            } finally {
                pin.fill('\u0000')
                confirmation.fill('\u0000')
                pinField.text.clear()
                confirmationField.text.clear()
            }
        }
    }

    @SuppressLint("HardwareIds")
    private fun installationId(): String = Settings.Secure.getString(
        contentResolver,
        Settings.Secure.ANDROID_ID,
    )

    private fun requestRuntimePermissions() {
        val requested = arrayOf(
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_PHONE_NUMBERS,
            Manifest.permission.CALL_PHONE,
        ).filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (requested.isNotEmpty()) permissions.launch(requested.toTypedArray())
    }
}
