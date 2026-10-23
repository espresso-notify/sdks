package com.espressonotify.transport.core

import java.security.SecureRandom

/**
 * Secure random bytes for the SDK (sdk-secure-device-id). Hermes has no `crypto.getRandomValues`, so the JavaScript asks
 * the module for the bytes of the device id and of the nonce of a signed request, and this is where they come from: the
 * platform generator, never a seeded or time-based one. Like the rest of `core/`, it imports nothing from Android or
 * React Native, so a plain JVM test compiles it.
 */
object RandomBytes {
    /** The most bytes one call gives; the SDK asks for 8 and 16. */
    const val MAX_COUNT = 256

    private val generator = SecureRandom()
    private const val DIGITS = "0123456789abcdef"

    /** `count` bytes as `2 x count` lowercase hex characters, or null when `count` is not from 1 to [MAX_COUNT]. */
    fun hex(count: Int): String? {
        if (count < 1 || count > MAX_COUNT) return null
        val bytes = ByteArray(count)
        generator.nextBytes(bytes)
        val out = StringBuilder(count * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xff
            out.append(DIGITS[v ushr 4]).append(DIGITS[v and 0x0f])
        }
        return out.toString()
    }
}
