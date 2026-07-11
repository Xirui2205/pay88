package com.telebirr.gateway.agent.ussd.profile

import android.content.Context
import com.telebirr.gateway.agent.crypto.CryptoEncoding
import com.telebirr.gateway.agent.crypto.PayloadVerifier
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import java.io.File

class FlowProfileVerifier(
    private val verifier: PayloadVerifier,
    private val acceptedKeyId: String,
    private val json: Json = Json { ignoreUnknownKeys = false },
) {
    fun verify(envelope: SignedFlowProfileEnvelope): VerifiedFlowProfile {
        require(envelope.keyId == acceptedKeyId) { "Unexpected profile signing key" }
        require(envelope.payloadBase64.length in 4..96_000) { "Profile payload is too large" }
        require(envelope.signatureBase64.length in 4..1_024) { "Profile signature is too large" }
        val payload = CryptoEncoding.base64Decode(envelope.payloadBase64)
        val signature = CryptoEncoding.base64Decode(envelope.signatureBase64)
        require(verifier.verify(payload, signature)) { "Invalid profile signature" }
        return VerifiedFlowProfile(
            profile = json.decodeFromString<FlowProfile>(payload.decodeToString()).validated(),
            exactPayload = payload,
            envelope = envelope,
        )
    }
}

data class VerifiedFlowProfile(
    val profile: FlowProfile,
    val exactPayload: ByteArray,
    val envelope: SignedFlowProfileEnvelope,
)

/** Atomic no-backup storage. Every read rechecks the signature before execution. */
class FlowProfileStore(
    context: Context,
    private val verifier: FlowProfileVerifier,
    private val json: Json = Json { ignoreUnknownKeys = false },
) {
    private val directory = File(context.noBackupFilesDir, "signed-flow-profiles").apply { mkdirs() }

    @Synchronized
    fun install(envelope: SignedFlowProfileEnvelope): FlowProfile {
        val verified = verifier.verify(envelope)
        val target = profileFile(verified.profile.profileId, verified.profile.version)
        val highestInstalled = installedMetadata()
            .filter { it.first == verified.profile.profileId }
            .maxOfOrNull { it.second }
        require(highestInstalled == null || verified.profile.version >= highestInstalled) {
            "Profile rollback is prohibited"
        }
        if (target.exists()) {
            val existing = json.decodeFromString<SignedFlowProfileEnvelope>(target.readText(Charsets.UTF_8))
            // ECDSA signatures are intentionally non-deterministic. Re-signing the
            // exact same profile payload must therefore be idempotent even when the
            // signature bytes differ.
            verifier.verify(existing)
            require(existing.keyId == envelope.keyId && existing.payloadBase64 == envelope.payloadBase64) {
                "Profile version already has different signed content"
            }
            return verified.profile
        }
        val temporary = File(directory, target.name + ".tmp")
        temporary.writeText(json.encodeToString(envelope), Charsets.UTF_8)
        check(temporary.renameTo(target) || run {
            target.delete() && temporary.renameTo(target)
        }) { "Could not atomically install profile" }
        return verified.profile
    }

    fun load(profileId: String, version: Int): FlowProfile {
        val encoded = profileFile(profileId, version).readText(Charsets.UTF_8)
        val envelope = json.decodeFromString<SignedFlowProfileEnvelope>(encoded)
        val verified = verifier.verify(envelope).profile
        require(verified.profileId == profileId && verified.version == version) {
            "Profile identity mismatch"
        }
        return verified
    }

    fun installedMetadata(): List<Pair<String, Int>> = directory.listFiles()
        .orEmpty()
        .filter { it.isFile && it.name.endsWith(".signed.json") }
        .mapNotNull { file ->
            runCatching {
                val envelope = json.decodeFromString<SignedFlowProfileEnvelope>(file.readText(Charsets.UTF_8))
                verifier.verify(envelope).profile.let { it.profileId to it.version }
            }.getOrNull()
        }
        .distinct()
        .sortedWith(compareBy<Pair<String, Int>> { it.first }.thenBy { it.second })

    private fun profileFile(profileId: String, version: Int): File {
        require(profileId.matches(Regex("[a-z0-9][a-z0-9._-]{2,63}")))
        require(version > 0)
        return File(directory, "$profileId-$version.signed.json")
    }
}
