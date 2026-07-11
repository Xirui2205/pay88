package com.telebirr.gateway.agent.ussd.profile

import com.telebirr.gateway.agent.crypto.CryptoEncoding
import com.telebirr.gateway.agent.crypto.PayloadVerifier
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import kotlin.io.path.createTempDirectory

@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class)
class FlowProfileStoreTest {
    private val root = createTempDirectory("flow-profile-store-").toFile()
    private val context = object : android.content.ContextWrapper(null) {
        override fun getNoBackupFilesDir(): File = root
    }
    private val profileDirectory = File(root, "signed-flow-profiles")

    @After
    fun cleanUp() {
        profileDirectory.deleteRecursively()
        root.deleteRecursively()
    }

    @Test
    fun `same signed payload can be installed again with a different valid ECDSA signature`() {
        profileDirectory.deleteRecursively()
        val generator = KeyPairGenerator.getInstance("EC").apply {
            initialize(ECGenParameterSpec("secp256r1"))
        }
        val keyPair = generator.generateKeyPair()
        val keyId = "test-key"
        val verifier = FlowProfileVerifier(
            PayloadVerifier.fromX509Base64(CryptoEncoding.base64(keyPair.public.encoded)),
            keyId,
        )
        val payload = Json.encodeToString(BuiltInTelebirrProfiles.balanceQuery()).toByteArray()

        fun envelope(): SignedFlowProfileEnvelope {
            val signature = Signature.getInstance("SHA256withECDSA").run {
                initSign(keyPair.private)
                update(payload)
                sign()
            }
            return SignedFlowProfileEnvelope(
                keyId = keyId,
                payloadBase64 = CryptoEncoding.base64(payload),
                signatureBase64 = CryptoEncoding.base64(signature),
            )
        }

        val first = envelope()
        var second = envelope()
        while (second.signatureBase64 == first.signatureBase64) second = envelope()
        val store = FlowProfileStore(context, verifier)

        assertEquals(2, store.install(first).version)
        assertEquals(2, store.install(second).version)
        assertEquals(listOf("telebirr.balance-query.v1" to 2), store.installedMetadata())
    }
}
