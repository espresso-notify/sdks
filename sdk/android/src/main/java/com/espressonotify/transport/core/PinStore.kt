package com.espressonotify.transport.core

import okhttp3.CertificatePinner
import okio.ByteString.Companion.decodeBase64

/**
 * The certificate pins of the native transport (SPT-33 to SPT-38), kept in memory for the life of the process.
 *
 * [set] replaces the whole set or nothing: when any entry is invalid, or the list is empty, it applies nothing, keeps
 * the set that was there and returns false. A valid set becomes one [CertificatePinner] (a pattern for the host, and
 * `**.host` when subdomains are included), the client is rebuilt on a new connection pool and the old pool is evicted,
 * so no connection that was validated under the old pins is ever reused (SPT-38). [clear] does the same with no pins.
 *
 * OkHttp's pinner runs after the normal validation of the chain, so a chain the client does not trust fails even with a
 * matching pin, and a match on any certificate of the chain (leaf, intermediate, root) passes.
 *
 * Pin format: base64 SPKI SHA-256 of 32 bytes, as the native SDKs and the pinning library of the project use; a leading
 * `sha256/` is accepted and removed.
 */
class PinStore(private val core: HttpCore) {

    private class Valid(val host: String, val includeSubdomains: Boolean, val pins: List<String>)

    private val lock = Any()

    @Volatile
    private var current: List<Valid> = emptyList()

    init {
        core.isPinned = { host -> isPinned(host) }
    }

    /** True when `host` is covered by the pins now in force. */
    fun isPinned(host: String): Boolean {
        val name = host.lowercase()
        return current.any { name == it.host || (it.includeSubdomains && name.endsWith("." + it.host)) }
    }

    /** Applies the whole set, or nothing. Never throws. Returns whether the set is now in force. */
    fun set(entries: List<PinEntry>): Boolean {
        val valid = try {
            validate(entries)
        } catch (e: Exception) {
            null
        } ?: return false
        return try {
            val pinner = CertificatePinner.Builder().apply {
                for (entry in valid) {
                    val pins = entry.pins.map { "sha256/$it" }.toTypedArray()
                    add(entry.host, *pins)
                    if (entry.includeSubdomains) add("**." + entry.host, *pins)
                }
            }.build()
            install(pinner, valid)
            true
        } catch (e: Exception) {
            false
        }
    }

    /** Removes every pin: the client is rebuilt with the default trust only. Never throws. */
    fun clear() {
        try {
            install(CertificatePinner.DEFAULT, emptyList())
        } catch (e: Exception) {
            // Nothing to do: the set in force stays.
        }
    }

    private fun install(pinner: CertificatePinner, entries: List<Valid>) {
        synchronized(lock) {
            val old = core.currentClient()
            core.replaceClient { it.newBuilder().certificatePinner(pinner).connectionPool(HttpCore.newConnectionPool()).build() }
            current = entries
            old.connectionPool.evictAll()
        }
    }

    /** The entries in the form OkHttp takes, or null when the list is empty or any entry is invalid. */
    private fun validate(entries: List<PinEntry>): List<Valid>? {
        if (entries.isEmpty()) return null
        val out = ArrayList<Valid>(entries.size)
        for (entry in entries) {
            val host = entry.host.trim().lowercase()
            if (!HOST.matches(host) || entry.pins.isEmpty()) return null
            val pins = ArrayList<String>(entry.pins.size)
            for (raw in entry.pins) {
                val pin = raw.trim().removePrefix("sha256/")
                if (!BASE64_32.matches(pin) || pin.decodeBase64()?.size != 32) return null
                pins.add(pin)
            }
            out.add(Valid(host, entry.includeSubdomains, pins))
        }
        return out
    }

    private companion object {
        /** A host name or an address: letters, digits, dots and hyphens, no wildcard, no port, no scheme. */
        val HOST = Regex("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$")

        /** 32 bytes in standard base64 with padding: 43 characters and one `=`. */
        val BASE64_32 = Regex("^[A-Za-z0-9+/]{43}=$")
    }
}
