package com.espressonotify.transport

import com.espressonotify.transport.core.CONTRACT_VERSION
import com.espressonotify.transport.core.ErrorCodes
import com.espressonotify.transport.core.HttpCore
import com.espressonotify.transport.core.HttpResult
import com.espressonotify.transport.core.PinEntry
import com.espressonotify.transport.core.PinStore
import com.espressonotify.transport.core.RandomBytes
import com.espressonotify.transport.core.RequestCallback
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableType
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.turbomodule.core.interfaces.TurboModule

/**
 * The native transport of the Espresso Notify SDK, as a React Native module (sdk-private-transport, design "Android").
 *
 * It is a transport and nothing else: `request` sends one HTTP request through the [HttpCore] of the package and settles
 * the promise with the answer or with one of the nine closed codes; `setPins` and `clearPins` hold the certificate pins; `randomBytes` hands out secure random bytes.
 * Signing, queue, retry and batching stay in JavaScript.
 *
 * One class serves both architectures. It extends [ReactContextBaseJavaModule] and implements [TurboModule], which is
 * what the class generated from the codegen spec is, so on the New Architecture the generated JNI binding finds the
 * methods by name and signature, and on the old one the bridge finds them by [ReactMethod]. The signatures below are the
 * ones the codegen derives from `src/native/NativeEspressoNotifyTransport.ts`. A rejection carries the code as its code
 * and as its message (`promise.reject(code, code)`): no free text crosses the bridge.
 */
@ReactModule(name = EspressoNotifyTransportModule.NAME)
class EspressoNotifyTransportModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext), TurboModule {

    override fun getName(): String = NAME

    override fun getConstants(): MutableMap<String, Any> = mutableMapOf("contractVersion" to CONTRACT_VERSION)

    @ReactMethod
    fun request(method: String, url: String, headers: ReadableArray, body: String?, timeoutMs: Double, promise: Promise) {
        val flat = ArrayList<String>(headers.size())
        for (i in 0 until headers.size()) {
            if (headers.getType(i) != ReadableType.String) {
                promise.reject(ErrorCodes.INVALID_REQUEST, ErrorCodes.INVALID_REQUEST)
                return
            }
            flat.add(headers.getString(i) ?: "")
        }
        core.request(method, url, flat, body, timeoutMs.toLong(), object : RequestCallback {
            override fun onResponse(result: HttpResult) {
                val map = Arguments.createMap()
                map.putInt("status", result.status)
                map.putString("statusText", result.statusText)
                map.putString("retryAfter", result.retryAfter)
                map.putString("body", result.body)
                promise.resolve(map)
            }

            override fun onFailure(code: String) {
                promise.reject(code, code)
            }
        })
    }

    @ReactMethod
    fun setPins(entries: ReadableArray, promise: Promise) {
        val parsed = try {
            parsePins(entries)
        } catch (e: Exception) {
            null
        }
        promise.resolve(parsed != null && pins.set(parsed))
    }

    @ReactMethod
    fun clearPins(promise: Promise) {
        pins.clear()
        promise.resolve(null)
    }

    /**
     * `count` bytes from the platform generator as lowercase hex, for the device id and the nonce of a signed request. A
     * count outside 1 to 256 (a NaN or an infinity included) rejects with `invalid_request`.
     */
    @ReactMethod
    fun randomBytes(count: Double, promise: Promise) {
        val hex = RandomBytes.hex(count.toInt())
        if (hex == null) {
            promise.reject(ErrorCodes.INVALID_REQUEST, ErrorCodes.INVALID_REQUEST)
        } else {
            promise.resolve(hex)
        }
    }

    /** The entries as the store takes them, or null when any is not an object of the shape the contract names. */
    private fun parsePins(entries: ReadableArray): List<PinEntry>? {
        val out = ArrayList<PinEntry>(entries.size())
        for (i in 0 until entries.size()) {
            val entry = entries.getMap(i) ?: return null
            if (!entry.hasKey("host") || entry.getType("host") != ReadableType.String) return null
            if (!entry.hasKey("pins") || entry.getType("pins") != ReadableType.Array) return null
            val includeSubdomains = entry.hasKey("includeSubdomains") &&
                entry.getType("includeSubdomains") == ReadableType.Boolean &&
                entry.getBoolean("includeSubdomains")
            val list = entry.getArray("pins") ?: return null
            val values = ArrayList<String>(list.size())
            for (j in 0 until list.size()) {
                if (list.getType(j) != ReadableType.String) return null
                values.add(list.getString(j) ?: return null)
            }
            out.add(PinEntry(entry.getString("host") ?: return null, includeSubdomains, values))
        }
        return out
    }

    companion object {
        const val NAME = "EspressoNotifyTransport"

        /** One client and one pin table for the process, so every instance of the module sends through the same pool. */
        private val core = HttpCore()
        private val pins = PinStore(core)
    }
}
