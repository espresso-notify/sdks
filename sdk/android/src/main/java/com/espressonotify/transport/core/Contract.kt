package com.espressonotify.transport.core

/**
 * The JavaScript to native contract of the transport module (sdk-private-transport, design "JS to native contract").
 *
 * This file and its siblings in `core/` import nothing from Android or React Native, so a plain JVM test compiles them
 * (`sdk/native-tests/android`). Whatever crosses the bridge is a closed set: a response of four fields, or one of nine
 * error codes. No text of an exception, a URL, a header or a body ever becomes an error.
 */

/** The version this module reports in `getConstants().contractVersion`; the JavaScript lists the versions it speaks. */
const val CONTRACT_VERSION = 1

/** The most response bytes the module reads; more cancels the call with `response_too_large`. */
const val MAX_RESPONSE_BYTES = 4_194_304L

/** The time one request may take, from the start of the call to the last byte of the answer. */
const val DEFAULT_TIMEOUT_MS = 30_000L

/** The closed list of failures the module may report. The code is also the message of the rejection. */
object ErrorCodes {
    const val TIMEOUT = "timeout"
    const val NO_CONNECTION = "no_connection"
    const val DNS = "dns"
    const val TLS = "tls"
    const val PIN_MISMATCH = "pin_mismatch"
    const val CANCELLED = "cancelled"
    const val RESPONSE_TOO_LARGE = "response_too_large"
    const val INVALID_REQUEST = "invalid_request"
    const val UNKNOWN = "unknown"

    val ALL: List<String> = listOf(TIMEOUT, NO_CONNECTION, DNS, TLS, PIN_MISMATCH, CANCELLED, RESPONSE_TOO_LARGE, INVALID_REQUEST, UNKNOWN)
}

/** What the module gives back for any HTTP answer, whatever its status. No other header leaves the native layer. */
class HttpResult(
    val status: Int,
    /** As the platform gives it; may be empty on HTTP/2. */
    val statusText: String,
    /** The raw first `Retry-After` value, or an empty string. */
    val retryAfter: String,
    /** UTF-8 text, at most [MAX_RESPONSE_BYTES] bytes before decoding (invalid bytes are replaced). */
    val body: String,
)

/** Settled once per request: with an answer, or with one of the codes of [ErrorCodes]. */
interface RequestCallback {
    fun onResponse(result: HttpResult)
    fun onFailure(code: String)
}

/** One host of the pin set: `pins` are base64 SPKI SHA-256 values (a leading `sha256/` is tolerated). */
class PinEntry(val host: String, val includeSubdomains: Boolean, val pins: List<String>)
