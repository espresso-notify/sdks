package com.espressonotify.transport.core

import java.io.IOException
import java.io.InterruptedIOException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLException
import javax.net.ssl.SSLPeerUnverifiedException
import okhttp3.Call
import okhttp3.Callback
import okhttp3.ConnectionPool
import okhttp3.Dispatcher
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.Buffer

/**
 * The HTTP side of the transport module: one process-wide [OkHttpClient] of its own, never the Networking module of
 * React Native, its client factory or an interceptor of React Native, Expo or a third party (SPT-28).
 *
 * The client follows no redirect, keeps no cookie and no cache, writes nothing to disk, and has no interceptor. Every call
 * is enqueued, so no React Native thread waits for the network. The module retries nothing on its own; OkHttp's
 * recovery of a stale pooled connection is the only retry (SPT-23), and the queue of the SDK does the rest.
 *
 * [configure] lets a test change the builder (trust of a test certificate, name resolution). The module passes nothing.
 */
class HttpCore(configure: (OkHttpClient.Builder) -> Unit = {}) {

    @Volatile
    private var client: OkHttpClient

    /** Says whether a host is covered by the pins of the [PinStore]; it only decides how a failed handshake is named. */
    @Volatile
    var isPinned: (String) -> Boolean = { false }

    init {
        val builder = OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .callTimeout(DEFAULT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .connectTimeout(DEFAULT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .readTimeout(DEFAULT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .writeTimeout(DEFAULT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .dispatcher(Dispatcher().apply { maxRequestsPerHost = 6 })
            .connectionPool(newConnectionPool())
        configure(builder)
        client = builder.build()
    }

    /** The client in use now. */
    fun currentClient(): OkHttpClient = client

    /**
     * Swaps the client for the one `transform` makes from the current one. The pin store uses it; the dispatcher is
     * shared, so the calls in flight keep their place.
     */
    @Synchronized
    fun replaceClient(transform: (OkHttpClient) -> OkHttpClient) {
        client = transform(client)
    }

    /**
     * Sends one request and settles `callback` once. Never throws: a request that cannot be built is `invalid_request`.
     *
     * @param headers flat list `name, value, name, value`; the last value of a repeated name wins.
     * @param body UTF-8 text, or null when there is none.
     */
    fun request(
        method: String,
        url: String,
        headers: List<String>,
        body: String?,
        timeoutMs: Long,
        callback: RequestCallback,
    ) {
        val settled = AtomicBoolean(false)
        val settle: (() -> Unit) -> Unit = { action -> if (settled.compareAndSet(false, true)) action() }

        val parsed = url.toHttpUrlOrNull()
        val built = if (parsed == null || headers.size % 2 != 0) null else try {
            val upper = method.uppercase()
            val requestBody = when {
                body != null -> body.toByteArray(Charsets.UTF_8).toRequestBody(null)
                upper == "POST" || upper == "PUT" || upper == "PATCH" -> ByteArray(0).toRequestBody(null)
                else -> null
            }
            val builder = Request.Builder().url(parsed).method(upper, requestBody)
            for (i in headers.indices step 2) builder.header(headers[i], headers[i + 1])
            builder.build()
        } catch (e: IllegalArgumentException) {
            null
        }
        if (parsed == null || built == null || (parsed.scheme != "http" && parsed.scheme != "https")) {
            settle { callback.onFailure(ErrorCodes.INVALID_REQUEST) }
            return
        }

        val call = client.newCall(built)
        call.timeout().timeout(if (timeoutMs > 0) timeoutMs else DEFAULT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        val host = parsed.host
        try {
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    settle { callback.onFailure(failureCode(e, call, host)) }
                }

                override fun onResponse(call: Call, response: Response) {
                    val outcome = try {
                        response.use { read(it, call, host) }
                    } catch (e: IOException) {
                        Failure(failureCode(e, call, host))
                    } catch (e: Throwable) {
                        Failure(ErrorCodes.UNKNOWN)
                    }
                    settle {
                        when (outcome) {
                            is Failure -> callback.onFailure(outcome.code)
                            is Success -> callback.onResponse(outcome.result)
                        }
                    }
                }
            })
        } catch (e: Throwable) {
            settle { callback.onFailure(ErrorCodes.UNKNOWN) }
        }
    }

    private sealed class Outcome
    private class Success(val result: HttpResult) : Outcome()
    private class Failure(val code: String) : Outcome()

    /** Reads the answer with a running count, so a body over the cap is never held in full. */
    private fun read(response: Response, call: Call, host: String): Outcome {
        val body = response.body
        var text = ""
        if (body != null) {
            if (body.contentLength() > MAX_RESPONSE_BYTES) {
                call.cancel()
                return Failure(ErrorCodes.RESPONSE_TOO_LARGE)
            }
            val source = body.source()
            val buffer = Buffer()
            while (true) {
                val read = source.read(buffer, READ_CHUNK)
                if (read == -1L) break
                if (buffer.size > MAX_RESPONSE_BYTES) {
                    call.cancel()
                    return Failure(ErrorCodes.RESPONSE_TOO_LARGE)
                }
            }
            text = buffer.readUtf8()
        }
        return Success(
            HttpResult(
                status = response.code,
                statusText = response.message,
                retryAfter = response.headers.values("Retry-After").firstOrNull() ?: "",
                body = text,
            ),
        )
    }

    /** Names a failure with one of the closed codes. The message of the exception is read here and goes no further. */
    private fun failureCode(e: Throwable, call: Call, host: String): String = when {
        e is InterruptedIOException -> ErrorCodes.TIMEOUT
        e is UnknownHostException -> ErrorCodes.DNS
        e is SSLPeerUnverifiedException ->
            if (isPinned(host) && e.message?.startsWith(PINNING_FAILURE) == true) ErrorCodes.PIN_MISMATCH else ErrorCodes.TLS
        e is SSLException -> ErrorCodes.TLS
        call.isCanceled() -> ErrorCodes.CANCELLED
        e is IOException -> ErrorCodes.NO_CONNECTION
        else -> ErrorCodes.UNKNOWN
    }

    companion object {
        private const val READ_CHUNK = 8192L

        /** The text OkHttp's `CertificatePinner` starts its exception with. */
        private const val PINNING_FAILURE = "Certificate pinning failure"

        /** A pool of its own: two idle connections, five minutes. The pin store makes a new one on every change. */
        fun newConnectionPool(): ConnectionPool = ConnectionPool(2, 5, TimeUnit.MINUTES)
    }
}
