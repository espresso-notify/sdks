"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var _a, _b, _c, _d, _e, _f, _g, _h;
Object.defineProperty(exports, "__esModule", { value: true });
exports.getForeignInitialNotification = exports.handleImagePushInitialNotification = exports.handleImagePushBackgroundEvent = exports.createNotificationHandler = exports.Devices = exports.PushClient = exports.BareDisplayAdapter = exports.FirebaseAppCheckProvider = exports.ExpoAppAttestProvider = exports.NullAttestationProvider = exports.AsyncStorageKeyStore = exports.ExpoSecureKeyStore = exports.MemoryKeyStore = exports.BareProvider = exports.ExpoPushProvider = exports.EspressoNotifyHttpError = exports.EspressoNotifyError = void 0;
exports.resolvePushProvider = resolvePushProvider;
exports.sha256Hex = sha256Hex;
exports.sha256HexUtf8 = sha256HexUtf8;
exports.sortQuery = sortQuery;
exports.buildCanonical = buildCanonical;
exports.capabilities = capabilities;
exports._classifySendError = _classifySendError;
exports._extractHost = _extractHost;
exports.enableCertificatePinning = enableCertificatePinning;
exports.enableEspressoPinning = enableEspressoPinning;
exports.disableCertificatePinning = disableCertificatePinning;
exports.describeMissingPushProvider = describeMissingPushProvider;
const errors_1 = require("./errors");
const transport_1 = require("./transport");
var errors_2 = require("./errors");
Object.defineProperty(exports, "EspressoNotifyError", { enumerable: true, get: function () { return errors_2.EspressoNotifyError; } });
Object.defineProperty(exports, "EspressoNotifyHttpError", { enumerable: true, get: function () { return errors_2.EspressoNotifyHttpError; } });
// ─── Concrete PushProvider ────────────────────────────────────────────────────
/**
 * ExpoPushProvider — PushProvider backed by expo-notifications.
 * Mirrors the permission + token acquisition logic from the usePushNotifications
 * hook exactly (same API calls, same mapping).
 *
 * tokenStrategy (default 'expo'):
 *   'expo'   → getExpoPushTokenAsync({ projectId }) → provider 'expo'
 *   'device' → getDevicePushTokenAsync() → provider 'apns' (iOS) or 'fcm' (Android)
 *
 * The EAS project id for the 'expo' strategy comes from `expoProjectId`, else
 * from expo-constants (`expoConfig.extra.eas.projectId`, then
 * `easConfig.projectId`). When expo-constants is present and has neither, the
 * token request is skipped and `lastError.code` is 'EXPO_PROJECT_ID_MISSING'.
 */
class ExpoPushProvider {
    constructor(options) {
        var _a;
        this.lastError = null;
        /** The last Expo push token this provider handed out; a rotation event delivers only a different one. */
        this._lastExpoToken = null;
        this._tokenStrategy = (_a = options === null || options === void 0 ? void 0 : options.tokenStrategy) !== null && _a !== void 0 ? _a : 'expo';
        this._expoProjectId = (options === null || options === void 0 ? void 0 : options.expoProjectId) || undefined;
    }
    /**
     * string → use it; undefined → expo-constants is absent, let
     * getExpoPushTokenAsync() infer it; null → known to be missing.
     */
    _resolveExpoProjectId() {
        var _a, _b, _c, _d, _e;
        if (this._expoProjectId)
            return this._expoProjectId;
        if (!ExpoConstants)
            return undefined;
        const id = (_d = (_c = (_b = (_a = ExpoConstants.expoConfig) === null || _a === void 0 ? void 0 : _a.extra) === null || _b === void 0 ? void 0 : _b.eas) === null || _c === void 0 ? void 0 : _c.projectId) !== null && _d !== void 0 ? _d : (_e = ExpoConstants.easConfig) === null || _e === void 0 ? void 0 : _e.projectId;
        return typeof id === 'string' && id ? id : null;
    }
    requestPermissions() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!Notifications)
                return null;
            try {
                const status = mapExpoPermission(yield Notifications.requestPermissionsAsync());
                if (status !== 'undetermined' || typeof Notifications.getPermissionsAsync !== 'function') {
                    return status;
                }
                // The request can resolve before the answer is reflected (e.g. the JS
                // reloaded while the system prompt was open); read the settings again.
                return mapExpoPermission(yield Notifications.getPermissionsAsync());
            }
            catch (_a) {
                return null;
            }
        });
    }
    getToken() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            this.lastError = null;
            if (!Notifications)
                return null;
            try {
                if (this._tokenStrategy === 'device') {
                    const data = yield Notifications.getDevicePushTokenAsync();
                    // data.type: 'ios' | 'android' | string; data.data: raw token string
                    const provider = data.type === 'ios' ? 'apns' : 'fcm';
                    return { token: data.data, provider };
                }
                const projectId = this._resolveExpoProjectId();
                if (projectId === null) {
                    this.lastError = new errors_1.EspressoNotifyError('EXPO_PROJECT_ID_MISSING', errors_1.EXPO_PROJECT_ID_MISSING_MESSAGE);
                    return null;
                }
                const data = projectId
                    ? yield Notifications.getExpoPushTokenAsync({ projectId })
                    : yield Notifications.getExpoPushTokenAsync();
                this._lastExpoToken = data.data;
                return { token: data.data, provider: 'expo' };
            }
            catch (err) {
                this.lastError = (err === null || err === void 0 ? void 0 : err.code) === 'ERR_NOTIFICATIONS_NO_EXPERIENCE_ID'
                    ? new errors_1.EspressoNotifyError('EXPO_PROJECT_ID_MISSING', errors_1.EXPO_PROJECT_ID_MISSING_MESSAGE)
                    : new errors_1.EspressoNotifyError('PUSH_TOKEN_UNAVAILABLE', `[espresso-notify] Could not get a push token: ${(_a = err === null || err === void 0 ? void 0 : err.message) !== null && _a !== void 0 ? _a : String(err)}`);
                return null;
            }
        });
    }
    /**
     * The Expo push token, asked again after the device token rotated. `null` when it did not change, when the EAS
     * project id is missing or when Expo does not answer (the next rotation event or the next start tries again).
     */
    _changedExpoToken() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const projectId = this._resolveExpoProjectId();
                if (projectId === null)
                    return null;
                const data = projectId
                    ? yield Notifications.getExpoPushTokenAsync({ projectId })
                    : yield Notifications.getExpoPushTokenAsync();
                const token = data === null || data === void 0 ? void 0 : data.data;
                if (typeof token !== 'string' || !token || token === this._lastExpoToken)
                    return null;
                this._lastExpoToken = token;
                return { token, provider: 'expo' };
            }
            catch (_a) {
                return null;
            }
        });
    }
    onTokenRefresh(cb) {
        try {
            if (!(Notifications === null || Notifications === void 0 ? void 0 : Notifications.addPushTokenListener))
                return () => { };
            let active = true;
            const subscription = Notifications.addPushTokenListener((t) => {
                if (this._tokenStrategy === 'device') {
                    cb({ token: t.data, provider: t.type === 'ios' ? 'apns' : 'fcm' });
                    return;
                }
                // The event carries the raw token of the device (FCM or APNs), which Expo does not accept as an Expo token.
                // Ask Expo for its own token again and report it only when it changed.
                void this._changedExpoToken().then((changed) => {
                    if (active && changed)
                        cb(changed);
                });
            });
            return () => {
                var _a;
                active = false;
                (_a = subscription === null || subscription === void 0 ? void 0 : subscription.remove) === null || _a === void 0 ? void 0 : _a.call(subscription);
            };
        }
        catch (_a) {
            return () => { };
        }
    }
    getPermissionStatus() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!Notifications)
                return null;
            try {
                return mapExpoPermission(yield Notifications.getPermissionsAsync());
            }
            catch (_a) {
                return null;
            }
        });
    }
}
exports.ExpoPushProvider = ExpoPushProvider;
// iOS UNAuthorizationStatus values reported by expo-notifications in `ios.status`.
const IOS_AUTHORIZED = 2;
const IOS_PROVISIONAL = 3;
const IOS_EPHEMERAL = 4;
/**
 * Map an expo-notifications permission response. expo-notifications reports
 * `status: 'undetermined'` for iOS provisional and ephemeral authorization, which
 * do deliver notifications, so `ios.status` and `granted` are checked too.
 */
function mapExpoPermission(r) {
    var _a;
    if (!r)
        return 'undetermined';
    const iosStatus = (_a = r.ios) === null || _a === void 0 ? void 0 : _a.status;
    if (r.granted === true ||
        r.status === 'granted' ||
        iosStatus === IOS_AUTHORIZED ||
        iosStatus === IOS_PROVISIONAL ||
        iosStatus === IOS_EPHEMERAL) {
        return 'granted';
    }
    if (r.status === 'denied')
        return 'denied';
    return 'undetermined';
}
/**
 * BareProvider — PushProvider backed by @react-native-firebase/messaging.
 * Used in bare React Native projects that do NOT use expo-notifications.
 *
 * Token refresh listeners are not added here — that is task #807.
 * Direct APNs token retrieval (messaging().getAPNSToken()) is a future option
 * for pure-APNs use cases but is not implemented here (task #803 scope).
 */
class BareProvider {
    requestPermissions() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d, _e, _f, _g;
            if (!FirebaseMessaging)
                return null;
            const ios = (RNPlatform === null || RNPlatform === void 0 ? void 0 : RNPlatform.OS) === 'ios';
            if (ios) {
                try {
                    // registerDeviceForRemoteMessages is iOS-only; guard in case it is absent
                    if (typeof FirebaseMessaging().registerDeviceForRemoteMessages === 'function') {
                        yield FirebaseMessaging().registerDeviceForRemoteMessages();
                    }
                }
                catch ( /* best-effort */_h) { /* best-effort */ }
                try {
                    const status = yield FirebaseMessaging().requestPermission();
                    // Map AuthorizationStatus enum values.
                    // Use the constants when available; fall back to numeric literals.
                    const AS = (_a = FirebaseMessaging.AuthorizationStatus) !== null && _a !== void 0 ? _a : {};
                    const AUTHORIZED = (_b = AS.AUTHORIZED) !== null && _b !== void 0 ? _b : 1;
                    const PROVISIONAL = (_c = AS.PROVISIONAL) !== null && _c !== void 0 ? _c : 2;
                    const DENIED = (_d = AS.DENIED) !== null && _d !== void 0 ? _d : 0;
                    // NOT_DETERMINED = AS.NOT_DETERMINED ?? -1 (fallthrough to 'undetermined')
                    if (status === AUTHORIZED || status === PROVISIONAL)
                        return 'granted';
                    if (status === DENIED)
                        return 'denied';
                    return 'undetermined';
                }
                catch (_j) {
                    return null;
                }
            }
            // Android
            try {
                const version = typeof (RNPlatform === null || RNPlatform === void 0 ? void 0 : RNPlatform.Version) === 'number'
                    ? RNPlatform.Version
                    : parseInt(String((_e = RNPlatform === null || RNPlatform === void 0 ? void 0 : RNPlatform.Version) !== null && _e !== void 0 ? _e : '0'), 10);
                if (version >= 33 && PermissionsAndroid) {
                    // Android 13+ requires explicit POST_NOTIFICATIONS permission
                    const result = yield PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
                    const GRANTED = (_g = (_f = PermissionsAndroid.RESULTS) === null || _f === void 0 ? void 0 : _f.GRANTED) !== null && _g !== void 0 ? _g : 'granted';
                    return result === GRANTED ? 'granted' : 'denied';
                }
                // Android < 13: permission is auto-granted at install time
                return 'granted';
            }
            catch (_k) {
                return null;
            }
        });
    }
    getToken() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!FirebaseMessaging)
                return null;
            try {
                const token = yield FirebaseMessaging().getToken();
                if (!token)
                    return null;
                return { token, provider: 'fcm' };
            }
            catch (_a) {
                return null;
            }
        });
    }
    /**
     * Calls `cb` when Firebase issues a new FCM token. Nothing is registered by itself: with `usePushNotifications` the
     * hook does it, with a bare `PushClient` the app must, in this order: `await client.devices.register({ pushToken,
     * provider: 'fcm' })` with the new token, then set `client.pushToken` to it, then `await client.devices.identify({
     * externalId })` when a user is logged in (a token registered alone is anonymous and a send by `externalId` would not
     * reach it), and only then `client.devices.recordLifecycle('subscription', oldToken, newToken)`.
     */
    onTokenRefresh(cb) {
        try {
            if (!FirebaseMessaging)
                return () => { };
            const unsubscribe = FirebaseMessaging().onTokenRefresh((token) => {
                cb({ token, provider: 'fcm' });
            });
            return typeof unsubscribe === 'function' ? unsubscribe : () => { };
        }
        catch (_a) {
            return () => { };
        }
    }
    getPermissionStatus() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d, _e, _f, _g;
            if (!FirebaseMessaging)
                return null;
            const ios = (RNPlatform === null || RNPlatform === void 0 ? void 0 : RNPlatform.OS) === 'ios';
            if (ios) {
                try {
                    const status = yield FirebaseMessaging().hasPermission();
                    const AS = (_a = FirebaseMessaging.AuthorizationStatus) !== null && _a !== void 0 ? _a : {};
                    const AUTHORIZED = (_b = AS.AUTHORIZED) !== null && _b !== void 0 ? _b : 1;
                    const PROVISIONAL = (_c = AS.PROVISIONAL) !== null && _c !== void 0 ? _c : 2;
                    const DENIED = (_d = AS.DENIED) !== null && _d !== void 0 ? _d : 0;
                    if (status === AUTHORIZED || status === PROVISIONAL)
                        return 'granted';
                    if (status === DENIED)
                        return 'denied';
                    return 'undetermined';
                }
                catch (_h) {
                    return null;
                }
            }
            // Android — check runtime version
            try {
                const version = typeof (RNPlatform === null || RNPlatform === void 0 ? void 0 : RNPlatform.Version) === 'number'
                    ? RNPlatform.Version
                    : parseInt(String((_e = RNPlatform === null || RNPlatform === void 0 ? void 0 : RNPlatform.Version) !== null && _e !== void 0 ? _e : '0'), 10);
                if (version >= 33 && PermissionsAndroid) {
                    const GRANTED = (_g = (_f = PermissionsAndroid.RESULTS) === null || _f === void 0 ? void 0 : _f.GRANTED) !== null && _g !== void 0 ? _g : 'granted';
                    const result = yield PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
                    // check() returns boolean on some RN versions, string on others
                    return (result === true || result === GRANTED) ? 'granted' : 'denied';
                }
                // Android < 13: permission is auto-granted at install time
                return 'granted';
            }
            catch (_j) {
                return null;
            }
        });
    }
}
exports.BareProvider = BareProvider;
/**
 * Resolves the appropriate PushProvider:
 * 1. ExpoPushProvider when expo-notifications is present.
 * 2. BareProvider when expo absent but @react-native-firebase/messaging is present.
 * 3. null — no provider available.
 *
 * Explicit provider override + display auto-detection are task #805.
 */
function resolvePushProvider(options) {
    if (Notifications) {
        return new ExpoPushProvider(options);
    }
    if (FirebaseMessaging) {
        return new BareProvider();
    }
    return null;
}
const API_URL = "https://api.espressonotify.com";
// ─── SHA-256 (pure TypeScript, no native deps) ───────────────────────────────
/**
 * Pure-TypeScript SHA-256 over an array of bytes.
 * Returns a 32-byte Uint8Array.
 * @internal
 */
function _sha256Bytes(bytes) {
    // SHA-256 constants: first 32 bits of fractional parts of cube roots of first 64 primes
    const K = new Uint32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
        0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
        0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
        0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
        0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]);
    // Initial hash values: first 32 bits of fractional parts of square roots of first 8 primes
    let h0 = 0x6a09e667;
    let h1 = 0xbb67ae85;
    let h2 = 0x3c6ef372;
    let h3 = 0xa54ff53a;
    let h4 = 0x510e527f;
    let h5 = 0x9b05688c;
    let h6 = 0x1f83d9ab;
    let h7 = 0x5be0cd19;
    // Pre-processing: adding padding bits
    const msgLen = bytes.length;
    const bitLen = msgLen * 8;
    // Padded length: message + 0x80 + zeros + 8-byte big-endian length
    // Must be a multiple of 64 bytes
    const padded = new Uint8Array(((msgLen + 9 + 63) & ~63));
    padded.set(bytes);
    padded[msgLen] = 0x80;
    // Write 64-bit big-endian bit length at the end
    // JavaScript bitwise ops work on 32-bit; handle high/low 32-bit halves
    const bitLenHigh = Math.floor(bitLen / 0x100000000);
    const bitLenLow = bitLen >>> 0;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, bitLenHigh, false);
    dv.setUint32(padded.length - 4, bitLenLow, false);
    // Process each 512-bit (64-byte) chunk
    const w = new Uint32Array(64);
    for (let offset = 0; offset < padded.length; offset += 64) {
        // Prepare message schedule
        for (let i = 0; i < 16; i++) {
            w[i] = dv.getUint32(offset + i * 4, false);
        }
        for (let i = 16; i < 64; i++) {
            // Sigma-0 and sigma-1 for message schedule — >>> 0 to keep unsigned
            const s0 = (_rotr32(w[i - 15], 7) ^ _rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
            const s1 = (_rotr32(w[i - 2], 17) ^ _rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
            // Split the 4-operand sum to avoid intermediate overflow beyond 2^53
            w[i] = ((w[i - 16] + s0) >>> 0) + ((w[i - 7] + s1) >>> 0);
            w[i] = w[i] >>> 0;
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
        for (let i = 0; i < 64; i++) {
            // Sigma-1(e) — >>> 0 to keep unsigned
            const S1 = (_rotr32(e, 6) ^ _rotr32(e, 11) ^ _rotr32(e, 25)) >>> 0;
            // Ch(e, f, g) — >>> 0 to keep unsigned
            const ch = ((e & f) ^ (~e & g)) >>> 0;
            // tmp1 = h + S1 + ch + K[i] + w[i] — split to avoid overflow beyond 2^53
            const tmp1 = (((h + S1) >>> 0) + ((ch + K[i]) >>> 0) + w[i]) >>> 0;
            // Sigma-0(a) — >>> 0 to keep unsigned
            const S0 = (_rotr32(a, 2) ^ _rotr32(a, 13) ^ _rotr32(a, 22)) >>> 0;
            // Maj(a, b, c) — >>> 0 to keep unsigned
            const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
            const tmp2 = (S0 + maj) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + tmp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (tmp1 + tmp2) >>> 0;
        }
        h0 = (h0 + a) >>> 0;
        h1 = (h1 + b) >>> 0;
        h2 = (h2 + c) >>> 0;
        h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0;
        h5 = (h5 + f) >>> 0;
        h6 = (h6 + g) >>> 0;
        h7 = (h7 + h) >>> 0;
    }
    const digest = new Uint8Array(32);
    const out = new DataView(digest.buffer);
    out.setUint32(0, h0, false);
    out.setUint32(4, h1, false);
    out.setUint32(8, h2, false);
    out.setUint32(12, h3, false);
    out.setUint32(16, h4, false);
    out.setUint32(20, h5, false);
    out.setUint32(24, h6, false);
    out.setUint32(28, h7, false);
    return digest;
}
/** Right-rotate a 32-bit integer. @internal */
function _rotr32(x, n) {
    return ((x >>> n) | (x << (32 - n))) >>> 0;
}
/**
 * Encode a string as UTF-8 bytes (portable, no native dep).
 * @internal
 */
function _toUtf8Bytes(s) {
    // TextEncoder is available in Node ≥11 (ts-jest env) and modern RN (Hermes).
    // Fallback for environments where it's absent.
    if (typeof TextEncoder !== 'undefined') {
        return new TextEncoder().encode(s);
    }
    // Manual UTF-8 encoding fallback
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c < 0x80) {
            bytes.push(c);
        }
        else if (c < 0x800) {
            bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        }
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
            // Surrogate pair
            const next = s.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
                bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
                i++;
            }
        }
        else {
            bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
    }
    return new Uint8Array(bytes);
}
/**
 * SHA-256 over the raw bytes of `input` (interpreted as a Latin-1 byte string
 * — each char code is one byte, 0-255). Used when the input is already binary
 * data encoded as a string. Returns lowercase hex digest.
 * @internal
 */
function sha256Hex(input) {
    const bytes = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) {
        bytes[i] = input.charCodeAt(i) & 0xff;
    }
    return _bytesToHex(_sha256Bytes(bytes));
}
/**
 * SHA-256 over the UTF-8 encoding of `input`. Returns lowercase hex digest.
 * Use this for request body strings (which may contain non-ASCII).
 * @internal
 */
function sha256HexUtf8(input) {
    return _bytesToHex(_sha256Bytes(_toUtf8Bytes(input)));
}
/**
 * Base64 of the SHA-256 of the UTF-8 bytes of a server challenge: the `clientDataHash` that App Attest binds into
 * the attestation. The backend hashes the same bytes (`sha256(challenge)`) to check it.
 * @internal
 */
function _challengeHashBase64(challenge) {
    const digest = _sha256Bytes(_toUtf8Bytes(challenge));
    let binary = '';
    for (let i = 0; i < digest.length; i++)
        binary += String.fromCharCode(digest[i]);
    return _toBase64(binary);
}
/** Convert a byte array to a lowercase hex string. @internal */
function _bytesToHex(bytes) {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += (bytes[i] >> 4).toString(16) + (bytes[i] & 0xf).toString(16);
    }
    return hex;
}
// ─── Canonical request & query sorting (#813) ─────────────────────────────────
/**
 * URL-decode a single query component the way Go's `url.ParseQuery` does:
 * `+` is decoded to a space, and `%XX` sequences to their byte values.
 * Falls back to the raw input if the string contains an invalid `%`-escape
 * (matching Go's lenient behaviour of leaving such input untouched rather than
 * throwing). @internal
 */
function _queryDecode(s) {
    try {
        return decodeURIComponent(s.replace(/\+/g, ' '));
    }
    catch (_a) {
        return s;
    }
}
/**
 * URL-encode a single query component to be byte-compatible with Go's
 * `url.QueryEscape` (used by `url.Values.Encode`). `encodeURIComponent` already
 * leaves exactly `A-Za-z0-9-_.!~*'()` unescaped; Go leaves only
 * `A-Za-z0-9-_.~` (plus `+` for space). So we additionally:
 *   (a) turn `%20` into `+`, and
 *   (b) percent-encode the five chars Go escapes but encodeURIComponent keeps:
 *       `!  *  '  (  )`.
 * @internal
 */
function _queryEncode(s) {
    return encodeURIComponent(s)
        .replace(/%20/g, '+')
        .replace(/!/g, '%21')
        .replace(/\*/g, '%2A')
        .replace(/'/g, '%27')
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29');
}
/**
 * Sort a raw query string and re-encode it so the result is byte-for-byte
 * identical to the server's `reqsign.SortRawQuery` (which delegates to Go's
 * `url.Values.Encode`). Returns "" for an empty/missing query string.
 *
 * Algorithm (mirrors `reqsign.SortRawQuery` byte-for-byte):
 *   1. Strip a leading "?"; an empty remainder yields "".
 *   2. Split on "&", dropping empty segments. Each segment splits on the FIRST
 *      "=" into key/value (a segment with no "=" has an empty value).
 *   3. URL-decode key and value (so encoding differences normalise).
 *   4. Group values by key; sort each key's values ascending (codepoint), then
 *      sort the keys ascending (codepoint).
 *   5. Re-encode each key/value with a Go-`QueryEscape`-compatible encoder and
 *      emit "key=value" pairs joined by "&".
 *
 * Note: no current SDK endpoint sends a query string, so this is correctness
 * insurance for future signed GETs.
 * @internal
 */
function sortQuery(rawQuery) {
    const q = rawQuery.replace(/^\?/, '');
    if (!q)
        return '';
    // Group decoded values by decoded key.
    const groups = new Map();
    for (const segment of q.split('&')) {
        if (segment.length === 0)
            continue;
        const eq = segment.indexOf('=');
        const rawKey = eq === -1 ? segment : segment.slice(0, eq);
        const rawVal = eq === -1 ? '' : segment.slice(eq + 1);
        const key = _queryDecode(rawKey);
        const val = _queryDecode(rawVal);
        const bucket = groups.get(key);
        if (bucket)
            bucket.push(val);
        else
            groups.set(key, [val]);
    }
    if (groups.size === 0)
        return '';
    // Sort keys ascending (codepoint), and each key's values ascending.
    const keys = Array.from(groups.keys()).sort();
    const out = [];
    for (const key of keys) {
        const encKey = _queryEncode(key);
        const values = groups.get(key).slice().sort();
        for (const val of values) {
            out.push(`${encKey}=${_queryEncode(val)}`);
        }
    }
    return out.join('&');
}
/**
 * Build the canonical string for request signing.
 *
 * Field order (MUST match server byte-for-byte):
 *   method\npath\nsortedQuery\nbodySHA256Hex\ntimestamp\nnonce\ndeviceId
 *
 * @param method        - HTTP method (e.g. "POST")
 * @param path          - URL path only (e.g. "/v1/devices/register")
 * @param sortedQuery   - Sorted+re-encoded query string ("" when none)
 * @param bodySHA256Hex - Lowercase hex SHA-256 of the raw request body
 * @param timestamp     - Unix seconds as string
 * @param nonce         - Random nonce string
 * @param deviceId      - Per-install device ID
 * @internal
 */
function buildCanonical(method, path, sortedQuery, bodySHA256Hex, timestamp, nonce, deviceId) {
    return [method, path, sortedQuery, bodySHA256Hex, timestamp, nonce, deviceId].join('\n');
}
/** In-memory KeyStore — used in tests and as the last fallback, when no persistent store is installed. */
class MemoryKeyStore {
    constructor() {
        this._store = new Map();
    }
    getItem(key) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            return (_a = this._store.get(key)) !== null && _a !== void 0 ? _a : null;
        });
    }
    setItem(key, value) {
        return __awaiter(this, void 0, void 0, function* () {
            this._store.set(key, value);
        });
    }
}
exports.MemoryKeyStore = MemoryKeyStore;
/** ExpoSecureKeyStore — wraps expo-secure-store (optional peer dep). */
class ExpoSecureKeyStore {
    constructor(secureStore) {
        this._secureStore = secureStore;
    }
    /** The `expo-secure-store` module itself: two wrappers of it are one storage. @internal */
    get backing() {
        return this._secureStore;
    }
    getItem(key) {
        return __awaiter(this, void 0, void 0, function* () {
            return this._secureStore.getItemAsync(key);
        });
    }
    setItem(key, value) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this._secureStore.setItemAsync(key, value);
        });
    }
}
exports.ExpoSecureKeyStore = ExpoSecureKeyStore;
/**
 * AsyncStorageKeyStore — wraps @react-native-async-storage/async-storage (optional peer dep).
 * The KeyStore holds only the device id and the PUBLIC key of request signing (the private
 * key stays inside the native signer), so it does not need secure storage; it needs to
 * survive a cold start, so the device id does not change on every launch.
 */
class AsyncStorageKeyStore {
    constructor(_storage) {
        this._storage = _storage;
    }
    /** The async-storage module itself: two wrappers of it are one storage. @internal */
    get backing() {
        return this._storage;
    }
    getItem(key) {
        return __awaiter(this, void 0, void 0, function* () {
            return this._storage.getItem(key);
        });
    }
    setItem(key, value) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this._storage.setItem(key, value);
        });
    }
}
exports.AsyncStorageKeyStore = AsyncStorageKeyStore;
// ─── Optional peers, required once when this module loads (BUG-4) ─────────────
//
// An optional peer is required HERE, at the top level of the module, inside a `try`, and never from a function that
// runs later. Metro gives the `require` of a package that is not installed a module id and defines nothing under it,
// so loading that id throws "Requiring unknown module". While a module factory runs, Metro's runtime lets the
// module's own `try/catch` see that error. A `require` made later, from a function the app calls after the bundle has
// loaded, runs outside that guard: the runtime passes the error to `ErrorUtils.reportFatalError` before any
// `try/catch` of ours sees it, and a Hermes release build aborts. The `try` also makes Metro treat the package as
// optional, so the bundle builds without it. `optional-peers-load.test.ts` holds both rules.
let OptSecureStore = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    OptSecureStore = require('expo-secure-store');
}
catch ( /* not installed */_j) { /* not installed */ }
let OptAsyncStorage = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    OptAsyncStorage = require('@react-native-async-storage/async-storage');
}
catch ( /* not installed */_k) { /* not installed */ }
let OptSecureSign = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    OptSecureSign = require('react-native-secure-sign');
}
catch ( /* not installed */_l) { /* not installed */ }
let OptIosAppAttest = null;
try {
    // Static specifier: Metro resolves only string-literal requires.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    OptIosAppAttest = require('react-native-ios-appattest');
}
catch ( /* not installed */_m) { /* not installed */ }
let OptAppCheck = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    OptAppCheck = require('@react-native-firebase/app-check');
}
catch ( /* not installed */_o) { /* not installed */ }
/**
 * Resolve the KeyStore: expo-secure-store, else AsyncStorage (both persist across cold
 * starts), else memory with a warning that says what that costs.
 */
function resolveKeyStore() {
    var _a;
    const SecureStore = OptSecureStore;
    if ((SecureStore === null || SecureStore === void 0 ? void 0 : SecureStore.getItemAsync) && (SecureStore === null || SecureStore === void 0 ? void 0 : SecureStore.setItemAsync)) {
        return new ExpoSecureKeyStore(SecureStore);
    }
    const storage = (_a = OptAsyncStorage === null || OptAsyncStorage === void 0 ? void 0 : OptAsyncStorage.default) !== null && _a !== void 0 ? _a : OptAsyncStorage;
    if ((storage === null || storage === void 0 ? void 0 : storage.getItem) && (storage === null || storage === void 0 ? void 0 : storage.setItem)) {
        return new AsyncStorageKeyStore(storage);
    }
    if (process.env.NODE_ENV !== 'test') {
        console.warn('[espresso-notify] Neither expo-secure-store nor @react-native-async-storage/async-storage is available; ' +
            'the device id and the public key of request signing are kept in memory only, so they change on every cold start ' +
            'and the device registers again with a new id. Install one of them to keep them.');
    }
    return new MemoryKeyStore();
}
/** Resolve the Signer: wraps react-native-secure-sign, returns null when absent. */
function resolveSecureSign() {
    var _a;
    try {
        const mod = (_a = OptSecureSign === null || OptSecureSign === void 0 ? void 0 : OptSecureSign.default) !== null && _a !== void 0 ? _a : OptSecureSign;
        if (!mod)
            return null;
        return {
            generate(keyId) {
                return __awaiter(this, void 0, void 0, function* () {
                    // react-native-secure-sign 0.0.2 exports `generate(keyId, options?)`, which resolves to the public key.
                    // Its default, when options are left out, is a key that asks for the user's biometrics on every use (Android);
                    // the SDK signs requests in the background, with nobody to ask, so it says no.
                    return mod.generate(keyId, { requireUserAuthentication: false });
                });
            },
            sign(keyId, dataBase64) {
                return __awaiter(this, void 0, void 0, function* () {
                    return mod.sign(keyId, dataBase64);
                });
            },
            getPublicKey(keyId) {
                return __awaiter(this, void 0, void 0, function* () {
                    try {
                        return yield mod.getPublicKey(keyId);
                    }
                    catch (_a) {
                        return null;
                    }
                });
            },
            isSupported() {
                return __awaiter(this, void 0, void 0, function* () {
                    try {
                        return !!(yield mod.checkHardwareSupport());
                    }
                    catch (_a) {
                        return false;
                    }
                });
            },
        };
    }
    catch (_b) {
        return null;
    }
}
// ─── Crypto-random device ID generation (#813) ────────────────────────────────
/**
 * Generate a random hex string of `byteLen` bytes: the device id (16 bytes) and the nonce of a signed request (8).
 *
 * Hermes has no `crypto.getRandomValues`, so the bytes come from the first of these that the app has:
 *   1. `crypto.getRandomValues`;
 *   2. the `randomBytes` of the SDK's own native module (`SecureRandom` on Android, `SecRandomCopyBytes` on iOS);
 *   3. `expo-crypto`;
 *   4. `Math.random`, with one warning per app run (reduced entropy), only when none of the above exists.
 *
 * A source that throws, rejects or answers the wrong size (the module's answer must be exactly `2 x byteLen` lowercase
 * hex characters) hands over to the next one, so a wrong answer never becomes an id. The text of the warning carries no
 * value of the caller. The function is asynchronous because the native module answers with a promise; both callers are
 * already asynchronous. An id that is stored is read back and never drawn again. The sources and the order are in
 * `random.ts`.
 *
 * Callers: `_stableDeviceId` (the install id, created once and stored) and `SigningTransport.request` (the nonce). A
 * failing source never blocks a request, because the last resort always answers. Event ids and the session id of the
 * registration tracker are not secrets and keep their own synchronous fallback.
 * @internal
 */
function _randomHex(byteLen) {
    return (0, random_1.randomHex)(byteLen);
}
// ─── Base64 encoding for canonical string (#813) ──────────────────────────────
/**
 * Encode a string to base64. Works in both Node (Buffer) and browser/RN (btoa).
 * @internal
 */
function _toBase64(input) {
    var _a, _b;
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(input, 'binary').toString('base64');
    }
    if (typeof btoa !== 'undefined') {
        return btoa(input);
    }
    // Manual base64 — last resort
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = '';
    const bytes = _toUtf8Bytes(input);
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = (_a = bytes[i + 1]) !== null && _a !== void 0 ? _a : 0;
        const b2 = (_b = bytes[i + 2]) !== null && _b !== void 0 ? _b : 0;
        result += chars[b0 >> 2];
        result += chars[((b0 & 3) << 4) | (b1 >> 4)];
        result += i + 1 < bytes.length ? chars[((b1 & 0xf) << 2) | (b2 >> 6)] : '=';
        result += i + 2 < bytes.length ? chars[b2 & 0x3f] : '=';
    }
    return result;
}
// ─── Signing session (#813) ───────────────────────────────────────────────────
const SIGNING_KEY_ID = 'espresso-signing-key';
const SIGNING_DEVICE_ID_KEY = 'espresso.deviceId';
const SIGNING_PUBKEY_KEY = 'espresso.signingPublicKey';
/**
 * SigningSession — lazy-initialized per-install identity.
 * Generates + persists deviceId and ECDSA-P256 key pair on first use.
 * @internal
 */
class SigningSession {
    constructor(_keyStore, _signer) {
        this._keyStore = _keyStore;
        this._signer = _signer;
        this._deviceId = null;
        this._publicKey = null;
        this._initialized = false;
    }
    ensureInitialized() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._initialized)
                return;
            this._initialized = true;
            // Restore or generate deviceId (CREATE-ONLY: once set, never overwrite)
            // (the offline queue reads the same id through the same promise: see `_stableDeviceId`)
            this._deviceId = yield _stableDeviceId(this._keyStore);
            // Restore or generate signing key pair
            let pubKey = yield this._keyStore.getItem(SIGNING_PUBKEY_KEY);
            if (!pubKey) {
                try {
                    pubKey = yield this._signer.generate(SIGNING_KEY_ID);
                    yield this._keyStore.setItem(SIGNING_PUBKEY_KEY, pubKey);
                }
                catch (_a) {
                    pubKey = null;
                }
            }
            this._publicKey = pubKey;
        });
    }
    get deviceId() { return this._deviceId; }
    get publicKey() { return this._publicKey; }
}
/**
 * NullAttestationProvider — no-op provider. `isSupported()` is always false, so
 * `Devices.attest()` short-circuits to `{ attested: false }`. Used when neither
 * the iOS nor the Android native module is available (e.g. web/test/Expo Go).
 */
class NullAttestationProvider {
    isSupported() {
        return false;
    }
    attest(_challenge) {
        return __awaiter(this, void 0, void 0, function* () {
            throw new Error('[espresso-notify] attestation is not supported on this device');
        });
    }
}
exports.NullAttestationProvider = NullAttestationProvider;
/**
 * ExpoAppAttestProvider — iOS App Attest provider.
 *
 * Like `react-native-secure-sign` (#813), the underlying native module is an
 * integrator-supplied OPTIONAL peer dependency: the SDK lazy-requires it and
 * degrades gracefully (provider resolves to Null) when it is absent. The default
 * module is `react-native-ios-appattest`, loaded with a static `require` so Metro
 * can resolve it. To use another App Attest package, import it in your app and
 * pass it as `nativeModule` (a module name computed at runtime never resolves
 * under Metro).
 *
 * The expected native surface is the one `react-native-ios-appattest` exports:
 *   generateKeys(): Promise<string>                          // → keyId
 *   attestKeys(keyId, challengeHashBase64): Promise<string>  // → base64 CBOR attestation
 * `challengeHashBase64` is the base64 of the SHA-256 of the challenge (Apple's `clientDataHash`); the provider
 * computes it from the UTF-8 bytes of the challenge string, which is what the backend hashes when it verifies.
 *
 * `attest()` returns `{ provider: 'apple-appattest', keyId, attestation }`.
 * `isSupported()` is true only when the module resolves AND the platform is iOS.
 */
class ExpoAppAttestProvider {
    constructor(options) {
        var _a;
        this._loaded = false;
        this._nativeModule = (_a = options === null || options === void 0 ? void 0 : options.nativeModule) !== null && _a !== void 0 ? _a : null;
    }
    _resolveModule() {
        var _a, _b, _c;
        if (this._loaded)
            return this._module;
        this._loaded = true;
        try {
            const mod = (_a = this._nativeModule) !== null && _a !== void 0 ? _a : OptIosAppAttest;
            this._module = (_c = (_b = mod === null || mod === void 0 ? void 0 : mod.default) !== null && _b !== void 0 ? _b : mod) !== null && _c !== void 0 ? _c : null;
        }
        catch (_d) {
            this._module = null;
        }
        return this._module;
    }
    isSupported() {
        if ((RNPlatform === null || RNPlatform === void 0 ? void 0 : RNPlatform.OS) !== 'ios')
            return false;
        return !!this._resolveModule();
    }
    attest(challenge) {
        return __awaiter(this, void 0, void 0, function* () {
            const mod = this._resolveModule();
            if (!mod) {
                throw new Error('[espresso-notify] iOS App Attest native module is not available');
            }
            const keyId = yield mod.generateKeys();
            const attestation = yield mod.attestKeys(keyId, _challengeHashBase64(challenge));
            return { provider: 'apple-appattest', keyId, attestation };
        });
    }
}
exports.ExpoAppAttestProvider = ExpoAppAttestProvider;
/**
 * FirebaseAppCheckProvider — Android Play Integrity provider, backed by
 * `@react-native-firebase/app-check` (the REAL standard package). Lazy-required
 * as an OPTIONAL peer dep; absent → provider resolves to Null (graceful).
 *
 * `attest()` calls `getToken(forceRefresh?)` and returns
 * `{ provider: 'play-integrity', appCheckToken }`. `isSupported()` is true when
 * the module resolves (and, defensively, the platform is not iOS).
 */
class FirebaseAppCheckProvider {
    constructor(options) {
        var _a;
        this._loaded = false;
        this._forceRefresh = (_a = options === null || options === void 0 ? void 0 : options.forceRefresh) !== null && _a !== void 0 ? _a : false;
    }
    _resolveModule() {
        if (this._loaded)
            return this._appCheck;
        this._loaded = true;
        try {
            const mod = OptAppCheck;
            // v20 to v25: the default export is a factory, appCheck() → module instance. v26 removed it and has only the
            // modular functions (getToken(appCheck, forceRefresh)). The instance they take comes from
            // initializeAppCheck(app?, options?); both arguments are optional in the v26 types, but there is no default
            // export to ask for an instance, and an instance made without the app's provider options has no provider to get
            // a token from (a call from the SDK would also set App Check up again over the app's own setup). So the SDK stays
            // off and says so, instead of calling the module with the wrong arguments.
            this._appCheck = typeof (mod === null || mod === void 0 ? void 0 : mod.default) === 'function' ? mod.default : typeof mod === 'function' ? mod : null;
            if (mod && !this._appCheck && process.env.NODE_ENV !== 'test') {
                console.warn('[espresso-notify] @react-native-firebase/app-check is installed but has no default export, which is how ' +
                    'version 26 and newer ship; Play Integrity attestation needs version 25 or older (>=20.5.0 <26).');
            }
        }
        catch (_a) {
            this._appCheck = null;
        }
        return this._appCheck;
    }
    isSupported() {
        if ((RNPlatform === null || RNPlatform === void 0 ? void 0 : RNPlatform.OS) === 'ios')
            return false;
        return !!this._resolveModule();
    }
    attest(_challenge) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const factory = this._resolveModule();
            if (!factory) {
                throw new Error('[espresso-notify] @react-native-firebase/app-check is not available');
            }
            const instance = typeof factory === 'function' ? factory() : factory;
            const result = yield instance.getToken(this._forceRefresh);
            const appCheckToken = typeof result === 'string' ? result : (_a = result === null || result === void 0 ? void 0 : result.token) !== null && _a !== void 0 ? _a : '';
            return { provider: 'play-integrity', appCheckToken };
        });
    }
}
exports.FirebaseAppCheckProvider = FirebaseAppCheckProvider;
/**
 * Resolve the AttestationProvider for the current platform.
 *   ios     → ExpoAppAttestProvider
 *   android → FirebaseAppCheckProvider
 *   else    → NullAttestationProvider
 * Any lazy-load/construction failure resolves to NullAttestationProvider —
 * this function NEVER throws (mirrors resolveSecureSign's graceful-null contract).
 */
function resolveAttestationProvider(platform, override) {
    if (override)
        return override;
    try {
        if (platform === 'ios')
            return new ExpoAppAttestProvider();
        if (platform === 'android')
            return new FirebaseAppCheckProvider();
        return new NullAttestationProvider();
    }
    catch (_a) {
        return new NullAttestationProvider();
    }
}
// ─── Expo lazy-load ───────────────────────────────────────────────────────────
// Try to load expo-notifications to verify installation
let Notifications;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Notifications = require("expo-notifications");
}
catch (error) {
    Notifications = null;
}
// expo-constants — source of the EAS project id for getExpoPushTokenAsync().
// Ships with expo-notifications; optional so bare apps need not install it.
let ExpoConstants = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const c = require("expo-constants");
    ExpoConstants = (_b = (_a = c === null || c === void 0 ? void 0 : c.default) !== null && _a !== void 0 ? _a : c) !== null && _b !== void 0 ? _b : null;
}
catch ( /* not installed — bare RN or test env */_p) { /* not installed — bare RN or test env */ }
// ─── Firebase / React-Native lazy-load (bare RN, #803) ────────────────────────
// FirebaseMessaging: a factory `FirebaseMessaging()` → messaging instance, with
// `AuthorizationStatus` on it, whatever the installed major:
//   - RNFirebase <= 21: the default export is that factory (namespaced API).
//   - RNFirebase >= 22: modular API only (v26 has no default export); the
//     instance comes from `getMessaging()`. It is called lazily, because it
//     throws when there is no default Firebase app.
// Only available in bare React Native projects — treated as optional.
function loadFirebaseMessaging(mod) {
    if (!mod)
        return null;
    if (typeof mod.default === 'function')
        return mod.default;
    if (typeof mod.getMessaging === 'function') {
        const factory = () => mod.getMessaging();
        factory.AuthorizationStatus = mod.AuthorizationStatus;
        return factory;
    }
    if (typeof mod === 'function')
        return mod;
    return null;
}
let FirebaseMessaging, firebaseLoadError = null; // the error, when messaging is installed but did not load
/** The module itself: the modular functions (`onNotificationOpenedApp(messaging, listener)`) live on it. */
let FirebaseMessagingModule = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    FirebaseMessagingModule = require("@react-native-firebase/messaging");
    FirebaseMessaging = loadFirebaseMessaging(FirebaseMessagingModule);
}
catch (err) {
    FirebaseMessaging = null;
    FirebaseMessagingModule = null;
    firebaseLoadError = _firebaseLoadError(err);
}
// RNPlatform + PermissionsAndroid + AppState from react-native.
// hooks.ts already lazy-requires Platform from react-native — same pattern here.
let RNPlatform = null;
let PermissionsAndroid = null;
let RNAppState = null;
let RNLinking = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rn = require("react-native");
    RNPlatform = (_c = rn.Platform) !== null && _c !== void 0 ? _c : null;
    PermissionsAndroid = (_d = rn.PermissionsAndroid) !== null && _d !== void 0 ? _d : null;
    RNAppState = (_e = rn.AppState) !== null && _e !== void 0 ? _e : null;
    RNLinking = (_f = rn.Linking) !== null && _f !== void 0 ? _f : null;
}
catch ( /* not available — web/test env */_q) { /* not available — web/test env */ }
// react-native-notify-kit — bare-RN display engine (maintained Notifee fork;
// Notifee itself was archived 2026-04-07). Used by BareDisplayAdapter.
let NotifyKit = null;
let NotifyKitEventType = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nk = require("react-native-notify-kit");
    NotifyKit = (_g = nk.default) !== null && _g !== void 0 ? _g : null;
    NotifyKitEventType = (_h = nk.EventType) !== null && _h !== void 0 ? _h : null;
}
catch ( /* not available — bare RN without notify-kit, or web/test env */_r) { /* not available — bare RN without notify-kit, or web/test env */ }
// react-native-ssl-public-key-pinning — optional TLS public-key pinning (#808).
// Patches the global networking layer once at init; no per-call changes needed.
let SslPinning = null;
/** True while the pins are set in the library, which pins the calls made through `fetch` (see enableCertificatePinning). @internal */
let _libraryPinsActive = false;
/** True while the pins are set in the native module, which pins the calls it sends (see enableCertificatePinning). @internal */
let _nativePinsActive = false;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    SslPinning = require("react-native-ssl-public-key-pinning");
}
catch ( /* not installed — pinning disabled */_s) { /* not installed — pinning disabled */ }
// Lazy-load Expo device APIs — available in React Native / Expo environments
let Localization = null;
let Application = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Localization = require("expo-localization");
}
catch ( /* not available — web/test env */_t) { /* not available — web/test env */ }
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Application = require("expo-application");
}
catch ( /* not available — web/test env */_u) { /* not available — web/test env */ }
let Device = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Device = require("expo-device");
}
catch ( /* not available */_v) { /* not available */ }
// ─── Concrete adapter implementations ─────────────────────────────────────────
/**
 * The error a Devices method that throws hands to the app: the message names the
 * operation, and an HTTP failure keeps its `status` and `code`.
 * @internal
 */
function _operationError(operation, error) {
    if (error instanceof errors_1.EspressoNotifyHttpError) {
        // Whatever transport raised it, the path in the message and in `path` ends before any query string or fragment.
        const path = error.path === undefined ? undefined : (0, transport_1.redactPath)(error.path);
        const inner = error.path !== undefined && path !== error.path ? error.message.split(error.path).join(path !== null && path !== void 0 ? path : '') : error.message;
        return new errors_1.EspressoNotifyHttpError(`[espresso-notify] ${operation} failed: ${inner}`, error.status, error.code, path, error.retryAfter);
    }
    const message = `[espresso-notify] ${operation} failed: ${error instanceof Error ? error.message : String(error)}`;
    if (error instanceof errors_1.EspressoNotifyError) {
        return new errors_1.EspressoNotifyError(error.code, message);
    }
    return Object.assign(new Error(message), { network: true }); // no answer from the server: the hooks may try again (retry.ts)
}
/**
 * FetchTransport — default Transport implementation.
 * Wraps fetch with Bearer auth, Content-Type header, and error handling.
 */
class FetchTransport {
    constructor(baseURL, projectId) {
        this.baseURL = baseURL;
        this.projectId = projectId;
    }
    request(path_1) {
        return __awaiter(this, arguments, void 0, function* (path, options = {}) {
            var _a, _b;
            const url = `${this.baseURL}${path}`;
            const headers = Object.assign({ Authorization: `Bearer ${this.projectId}`, "Content-Type": "application/json" }, options.headers);
            const response = yield fetch(url, Object.assign(Object.assign({}, options), { headers }));
            if (!response.ok) {
                // The body and the header are read as text; whatever is unusable counts as absent (buildHttpError never throws).
                let bodyText = "";
                let retryAfter;
                try {
                    if (typeof response.text === "function")
                        bodyText = yield response.text();
                }
                catch ( /* an unreadable body is no body */_c) { /* an unreadable body is no body */ }
                try {
                    const raw = (_b = (_a = response.headers) === null || _a === void 0 ? void 0 : _a.get) === null || _b === void 0 ? void 0 : _b.call(_a, "Retry-After");
                    if (typeof raw === "string")
                        retryAfter = raw;
                }
                catch ( /* an unusable header is no header */_d) { /* an unusable header is no header */ }
                throw (0, transport_1.buildHttpError)(response.status, response.statusText, path, bodyText, retryAfter);
            }
            return (0, transport_1.parseJsonBody)(yield response.text());
        });
    }
}
/**
 * The transport of `privateTransport: 'native'` when the native module cannot be used: every call raises
 * `NATIVE_TRANSPORT_UNAVAILABLE` and nothing is sent.
 * @internal
 */
class UnavailableTransport {
    constructor(reason) {
        this.reason = reason;
    }
    request() {
        return __awaiter(this, void 0, void 0, function* () {
            throw new errors_1.EspressoNotifyError('NATIVE_TRANSPORT_UNAVAILABLE', "[espresso-notify] privateTransport is 'native' but the native transport is not usable (" +
                (this.reason === 'version' ? 'contract version not supported' : 'module not linked') +
                '), so the request was not sent. Rebuild the app after installing the SDK, or set privateTransport to \'auto\' or \'js\'.');
        });
    }
}
/** True once the fallback of `'auto'` to `fetch` was logged: it shows once per app run. @internal */
let _nativeFallbackWarned = false;
/**
 * Logs ONE warning per app run when `privateTransport` is `'auto'` and the native module cannot be used, so the calls
 * of the SDK will show in the network inspectors. Development only (`__DEV__` is true and not in a test run).
 * The text names the reason and no URL. Never throws.
 * @internal
 */
function warnNativeFallbackOnce(reason) {
    try {
        if (_nativeFallbackWarned)
            return;
        if (typeof __DEV__ === "undefined" || __DEV__ !== true)
            return;
        if (process.env.NODE_ENV === "test")
            return;
        _nativeFallbackWarned = true;
        console.warn('[espresso-notify] The native transport is not used (' +
            (reason === 'version' ? 'contract version not supported' : 'module not linked') +
            '), so the requests of the SDK go through fetch and show in the network inspectors. ' +
            "Rebuild the app after installing the SDK, or set privateTransport to 'js' to hide this warning. " +
            '(This warning shows once per app run, in development only.)');
    }
    catch ( /* a warning must never break the app */_a) { /* a warning must never break the app */ }
}
/**
 * PinningGuardTransport — refuses a request while certificate pinning is not active
 * (`ClientConfig.requirePinning`). Nothing reaches the network.
 * @internal
 */
class PinningGuardTransport {
    /**
     * `kind` is the transport it guards: the native transport needs the native pins, any other (`fetch` or your own) the
     * pins of the library, as before.
     */
    constructor(_inner, _kind) {
        this._inner = _inner;
        this._kind = _kind;
    }
    request(path, options) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!(this._kind === 'native' ? _nativePinsActive : _libraryPinsActive)) {
                throw new errors_1.EspressoNotifyError('PINNING_NOT_ACTIVE', '[espresso-notify] Certificate pinning is not active, and requirePinning is on, so the request was not sent. ' +
                    'Call `await enableEspressoPinning([...pins])` before the first call, and check that react-native-ssl-public-key-pinning is installed.');
            }
            return this._inner.request(path, options);
        });
    }
}
/**
 * SigningTransport — wraps another Transport and injects X-KM-* signing headers
 * on EVERY request (all HTTP methods, GET included) when signing is enabled.
 *
 * Rationale: the server enforces request signing on all public-token paths when
 * `project.require_signing=true`, with the sole exception of the bootstrap
 * `POST /v1/devices/register`. A public-token GET (e.g. fetching notification
 * categories) therefore MUST be signed or the server returns 401
 * `signature_required`. Signing the register POST as well is harmless because
 * the server exempts that path from verification.
 *
 * Signing is best-effort: if the signer or session is unavailable, the request
 * proceeds without signing headers (a warning is logged; the call never throws
 * from the signing path so app boot is never blocked).
 * @internal
 */
class SigningTransport {
    constructor(_inner, _session, _signer) {
        this._inner = _inner;
        this._session = _session;
        this._signer = _signer;
    }
    request(path_1) {
        return __awaiter(this, arguments, void 0, function* (path, options = {}) {
            var _a, _b;
            const method = ((_a = options.method) !== null && _a !== void 0 ? _a : 'GET').toUpperCase();
            // Sign EVERY method (GET included) — see class doc-comment for rationale.
            try {
                yield this._session.ensureInitialized();
                const deviceId = this._session.deviceId;
                const publicKey = this._session.publicKey;
                if (deviceId && publicKey) {
                    const bodyStr = typeof options.body === 'string' ? options.body : '';
                    const bodyHash = sha256HexUtf8(bodyStr);
                    const ts = String(Math.floor(Date.now() / 1000));
                    const nonce = yield _randomHex(8);
                    // Split path into the URL path and its query string. `path` may be a
                    // bare path segment ("/v1/...") or a full URL; either way we sign the
                    // path WITHOUT the query and pass the sorted query as canonical field 3.
                    const rawPath = path.startsWith('/') ? path : new URL(path).pathname + new URL(path).search;
                    const qIdx = rawPath.indexOf('?');
                    const urlPath = qIdx === -1 ? rawPath : rawPath.slice(0, qIdx);
                    const rawQuery = qIdx === -1 ? '' : rawPath.slice(qIdx + 1);
                    const sortedQuery = sortQuery(rawQuery);
                    const canonical = buildCanonical(method, urlPath, sortedQuery, bodyHash, ts, nonce, deviceId);
                    // The signer signs the base64 of the canonical string.
                    // react-native-secure-sign hashes internally with SHA-256 (ES256).
                    const canonicalB64 = _toBase64(canonical);
                    const sig = yield this._signer.sign(SIGNING_KEY_ID, canonicalB64);
                    const signingHeaders = {
                        'X-KM-Device-Id': deviceId,
                        'X-KM-Timestamp': ts,
                        'X-KM-Nonce': nonce,
                        'X-KM-Signature': sig,
                        'X-KM-Sig-Alg': 'ES256',
                    };
                    const mergedOptions = Object.assign(Object.assign({}, options), { headers: Object.assign(Object.assign({}, signingHeaders), ((_b = options.headers) !== null && _b !== void 0 ? _b : {})) });
                    return this._inner.request(path, mergedOptions);
                }
            }
            catch (_c) {
                // Signing failed — warn and fall through to send unsigned. App boot must
                // never be blocked by the signing path; the server will reject the request
                // if require_signing is enabled.
                // eslint-disable-next-line no-console
                // A fixed message with a code: the text of the signer's error is never logged (it can carry internals of the
                // native module), so `err` is not read.
                console.warn('[espresso-notify] request signing failed (SIGNING_FAILED); sending unsigned ' +
                    '(server will reject if require_signing is enabled).');
            }
            return this._inner.request(path, options);
        });
    }
}
/**
 * The language tag and the IANA time zone of the device. Current `expo-localization` has
 * `getLocales()` and `getCalendars()`; the old `locale` and `timezone` fields are the fallback
 * for a version that still has them. Each field falls back on its own. Never throws.
 */
function readLocalization() {
    var _a, _b, _c, _d, _e, _f;
    const out = {};
    if (!Localization)
        return out;
    try {
        const tag = (_c = (_b = (_a = Localization.getLocales) === null || _a === void 0 ? void 0 : _a.call(Localization)) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.languageTag;
        if (typeof tag === "string" && tag)
            out.locale = tag;
    }
    catch ( /* the native module can be unavailable: use the fallback */_g) { /* the native module can be unavailable: use the fallback */ }
    try {
        const zone = (_f = (_e = (_d = Localization.getCalendars) === null || _d === void 0 ? void 0 : _d.call(Localization)) === null || _e === void 0 ? void 0 : _e[0]) === null || _f === void 0 ? void 0 : _f.timeZone;
        if (typeof zone === "string" && zone)
            out.timezone = zone;
    }
    catch ( /* same */_h) { /* same */ }
    if (!out.locale && typeof Localization.locale === "string" && Localization.locale)
        out.locale = Localization.locale;
    if (!out.timezone && typeof Localization.timezone === "string" && Localization.timezone)
        out.timezone = Localization.timezone;
    return out;
}
/**
 * ExpoDeviceInfo — DeviceInfoAdapter backed by expo-localization/application/device.
 */
class ExpoDeviceInfo {
    collect() {
        const meta = {};
        let appVersion;
        let osVersion;
        try {
            const { locale, timezone } = readLocalization();
            if (locale)
                meta.locale = locale;
            if (timezone)
                meta.timezone = timezone;
            const version = Application === null || Application === void 0 ? void 0 : Application.nativeApplicationVersion;
            if (version) {
                meta.app_version = version;
                appVersion = version;
            }
            const osVer = Device === null || Device === void 0 ? void 0 : Device.osVersion;
            if (osVer) {
                meta.os_version = osVer;
                osVersion = osVer;
            }
        }
        catch ( /* best-effort */_a) { /* best-effort */ }
        return { meta, appVersion, osVersion };
    }
}
/** The data of a push as an object; `{}` when the library gave none; the wrapper of Expo is opened (end of file). @internal */
function _pushData(raw, dataString) {
    return _unwrapPushData(raw, dataString);
}
/** The notification id a push carries (`notificationId`, else `notification_id`). @internal */
function _idOfData(data) {
    var _a;
    const id = (_a = data.notificationId) !== null && _a !== void 0 ? _a : data.notification_id;
    return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}
/** The identity of an expo-notifications response, for the launch read; undefined when it has none. @internal */
function _expoResponseKey(response) {
    var _a, _b, _c, _d;
    const id = (_b = (_a = response === null || response === void 0 ? void 0 : response.notification) === null || _a === void 0 ? void 0 : _a.request) === null || _b === void 0 ? void 0 : _b.identifier;
    const date = (_c = response === null || response === void 0 ? void 0 : response.notification) === null || _c === void 0 ? void 0 : _c.date;
    if (id === undefined && date === undefined)
        return undefined;
    return `${String(id !== null && id !== void 0 ? id : '')}|${String((_d = response === null || response === void 0 ? void 0 : response.actionIdentifier) !== null && _d !== void 0 ? _d : '')}|${String(date !== null && date !== void 0 ? date : '')}`;
}
/**
 * Identities of the expo-notifications responses already handed to a client in this app run, so that a client built
 * later (a remount) does not hand the same last response again. Bounded. @internal
 */
const _deliveredExpoResponses = [];
function _rememberExpoResponse(key) {
    _deliveredExpoResponses.push(key);
    if (_deliveredExpoResponses.length > 50)
        _deliveredExpoResponses.shift();
}
/**
 * The calls of `@react-native-firebase/messaging` that report a tap: the modular functions when the module exports
 * them (22 and later), the methods of the messaging instance otherwise. Null when neither exists. Never throws.
 * @internal
 */
function _fcmOpenedApi() {
    if (!FirebaseMessaging)
        return null;
    try {
        const mod = FirebaseMessagingModule;
        const messaging = FirebaseMessaging();
        if (mod && typeof mod.onNotificationOpenedApp === 'function' && typeof mod.getInitialNotification === 'function') {
            return {
                onOpened: (listener) => mod.onNotificationOpenedApp(messaging, listener),
                getInitial: () => mod.getInitialNotification(messaging),
            };
        }
        if (messaging && typeof messaging.onNotificationOpenedApp === 'function') {
            return {
                onOpened: (listener) => messaging.onNotificationOpenedApp(listener),
                getInitial: () => typeof messaging.getInitialNotification === 'function' ? messaging.getInitialNotification() : Promise.resolve(null),
            };
        }
    }
    catch ( /* the messaging instance can throw without a default Firebase app */_a) { /* the messaging instance can throw without a default Firebase app */ }
    return null;
}
/**
 * ExpoDisplayAdapter — DisplayAdapter backed by expo-notifications.
 * Wraps addNotificationResponseReceivedListener and setNotificationCategoryAsync.
 */
class ExpoDisplayAdapter {
    onResponse(cb) {
        try {
            const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
                var _a, _b;
                const data = _expoContentData((_b = (_a = response === null || response === void 0 ? void 0 : response.notification) === null || _a === void 0 ? void 0 : _a.request) === null || _b === void 0 ? void 0 : _b.content);
                const notificationId = _idOfData(data);
                const actionId = response === null || response === void 0 ? void 0 : response.actionIdentifier;
                cb({ notificationId, actionId });
            });
            return () => { var _a; return (_a = subscription === null || subscription === void 0 ? void 0 : subscription.remove) === null || _a === void 0 ? void 0 : _a.call(subscription); };
        }
        catch (_a) {
            return () => { };
        }
    }
    /**
     * The taps with their data: the live listener, and the response that launched the app
     * (`getLastNotificationResponseAsync`). The same response can reach both, and expo-notifications keeps
     * answering with the last one, so a response is handed to the app once.
     */
    onOpened(cb) {
        const unsubs = [(0, image_push_1.subscribeImagePushTaps)((info) => cb(info))]; // taps on the push images notify-kit draws (image-push.ts)
        let launchKey;
        const toInfo = (response, coldStart) => {
            var _a, _b;
            const data = _expoContentData((_b = (_a = response === null || response === void 0 ? void 0 : response.notification) === null || _a === void 0 ? void 0 : _a.request) === null || _b === void 0 ? void 0 : _b.content);
            const actionId = response === null || response === void 0 ? void 0 : response.actionIdentifier;
            const dismissId = Notifications === null || Notifications === void 0 ? void 0 : Notifications.DISMISS_ACTION_IDENTIFIER;
            const info = { notificationId: _idOfData(data), actionId, data, coldStart };
            if (dismissId && actionId === dismissId)
                info.dismissed = true;
            return info;
        };
        try {
            const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
                if (_isLauncherOnlyResponse(response))
                    return; // a launch from the icon is no tap (end of file)
                const key = _expoResponseKey(response);
                if (key !== undefined) {
                    if (key === launchKey) {
                        launchKey = undefined;
                        return;
                    } // the launch read already handed this one over
                    _rememberExpoResponse(key);
                }
                cb(toInfo(response, false));
            });
            unsubs.push(() => { var _a; return (_a = subscription === null || subscription === void 0 ? void 0 : subscription.remove) === null || _a === void 0 ? void 0 : _a.call(subscription); });
        }
        catch ( /* best-effort */_a) { /* best-effort */ }
        try {
            Promise.resolve(_lastExpoResponse())
                .then((response) => {
                if (!response || _isLauncherOnlyResponse(response))
                    return; // no tap, and it keeps the launch place free
                const key = _expoResponseKey(response);
                if (key !== undefined) {
                    if (_deliveredExpoResponses.includes(key))
                        return; // a live tap, or an earlier client, already had it
                    launchKey = key;
                    _rememberExpoResponse(key);
                }
                cb(toInfo(response, true));
            })
                .catch(() => { });
        }
        catch ( /* best-effort */_b) { /* best-effort */ }
        return () => { for (const u of unsubs) {
            try {
                u();
            }
            catch ( /* best-effort */_a) { /* best-effort */ }
        } };
    }
    onReceived(cb) {
        try {
            const subscription = Notifications.addNotificationReceivedListener((n) => {
                var _a;
                const notificationId = _idOfData(_expoContentData((_a = n === null || n === void 0 ? void 0 : n.request) === null || _a === void 0 ? void 0 : _a.content));
                cb({ notificationId });
            });
            return () => { var _a; return (_a = subscription === null || subscription === void 0 ? void 0 : subscription.remove) === null || _a === void 0 ? void 0 : _a.call(subscription); };
        }
        catch (_a) {
            return () => { };
        }
    }
    // Full dismiss tracking on Expo is platform-limited. On iOS,
    // DISMISS_ACTION_IDENTIFIER fires when the user explicitly dismisses a
    // notification from the notification tray — but it requires the user to
    // swipe and select "Clear" (not just swipe away). On Android, Expo does
    // not expose a dismiss callback at all. This is the best-effort approach.
    onDismissed(cb) {
        const dismissId = Notifications === null || Notifications === void 0 ? void 0 : Notifications.DISMISS_ACTION_IDENTIFIER;
        if (!dismissId)
            return () => { };
        try {
            const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
                var _a, _b;
                if ((response === null || response === void 0 ? void 0 : response.actionIdentifier) === dismissId) {
                    const data = _expoContentData((_b = (_a = response === null || response === void 0 ? void 0 : response.notification) === null || _a === void 0 ? void 0 : _a.request) === null || _b === void 0 ? void 0 : _b.content);
                    const notificationId = _idOfData(data);
                    cb({ notificationId });
                }
            });
            return () => { var _a; return (_a = subscription === null || subscription === void 0 ? void 0 : subscription.remove) === null || _a === void 0 ? void 0 : _a.call(subscription); };
        }
        catch (_a) {
            return () => { };
        }
    }
    supportsCategories() {
        return !!(Notifications === null || Notifications === void 0 ? void 0 : Notifications.setNotificationCategoryAsync);
    }
    setCategories(categories) {
        return __awaiter(this, void 0, void 0, function* () {
            for (const category of categories) {
                yield Notifications.setNotificationCategoryAsync(category.identifier, category.actions.map((a) => {
                    var _a, _b;
                    return ({
                        identifier: a.identifier,
                        buttonTitle: a.buttonTitle,
                        options: {
                            opensAppToForeground: (_a = a.opensAppToForeground) !== null && _a !== void 0 ? _a : true,
                            isDestructive: (_b = a.isDestructive) !== null && _b !== void 0 ? _b : false,
                        },
                    });
                }));
            }
        });
    }
}
/**
 * NullDisplayAdapter — DisplayAdapter no-op for environments where
 * expo-notifications is absent.
 */
/**
 * BareDisplayAdapter — DisplayAdapter backed by react-native-notify-kit
 * (maintained Notifee fork) for bare React Native (no expo-notifications).
 *
 * NOTE: only foreground taps + cold-start are wired here. Background/quit-state
 * tap events require the host app to register notify-kit's `onBackgroundEvent`
 * at startup (before AppRegistry) and forward them — that wiring is a follow-up
 * (task #811) and is intentionally not done here.
 */
class BareDisplayAdapter {
    onResponse(cb) {
        var _a;
        if (!(NotifyKit === null || NotifyKit === void 0 ? void 0 : NotifyKit.onForegroundEvent))
            return () => { };
        // Cold-start: a notification that launched the app from the quit state.
        try {
            (_a = NotifyKit.getInitialNotification) === null || _a === void 0 ? void 0 : _a.call(NotifyKit).then((initial) => {
                var _a, _b, _c;
                if (initial === null || initial === void 0 ? void 0 : initial.notification) {
                    const data = (_a = initial.notification) === null || _a === void 0 ? void 0 : _a.data;
                    cb({
                        notificationId: (_b = data === null || data === void 0 ? void 0 : data.notificationId) !== null && _b !== void 0 ? _b : data === null || data === void 0 ? void 0 : data.notification_id,
                        actionId: (_c = initial === null || initial === void 0 ? void 0 : initial.pressAction) === null || _c === void 0 ? void 0 : _c.id,
                    });
                }
            }).catch(() => { });
        }
        catch ( /* best-effort */_b) { /* best-effort */ }
        try {
            const unsubscribe = NotifyKit.onForegroundEvent(({ type, detail }) => {
                var _a, _b, _c;
                const data = (_a = detail === null || detail === void 0 ? void 0 : detail.notification) === null || _a === void 0 ? void 0 : _a.data;
                const notificationId = (_b = data === null || data === void 0 ? void 0 : data.notificationId) !== null && _b !== void 0 ? _b : data === null || data === void 0 ? void 0 : data.notification_id;
                if (type === (NotifyKitEventType === null || NotifyKitEventType === void 0 ? void 0 : NotifyKitEventType.ACTION_PRESS)) {
                    cb({ notificationId, actionId: (_c = detail === null || detail === void 0 ? void 0 : detail.pressAction) === null || _c === void 0 ? void 0 : _c.id });
                }
                else if (type === (NotifyKitEventType === null || NotifyKitEventType === void 0 ? void 0 : NotifyKitEventType.PRESS)) {
                    cb({ notificationId });
                }
            });
            return typeof unsubscribe === "function" ? unsubscribe : () => { };
        }
        catch (_c) {
            return () => { };
        }
    }
    /**
     * The taps with their data, from both sources of this mode: react-native-notify-kit (a notification it
     * displays: foreground presses, and the one that launched the app) and @react-native-firebase/messaging (a push
     * the system displayed: `onNotificationOpenedApp`, and `getInitialNotification` for the one that launched the
     * app). Either may be absent. The launch tap is handed over once, whichever source reports it first.
     */
    onOpened(cb) {
        var _a;
        const unsubs = [];
        let launchDelivered = false;
        const launchKeys = new Set();
        const liveKeys = [];
        const deliver = (info, key, launch) => {
            if (launch) {
                if (launchDelivered || (key !== undefined && liveKeys.includes(key)))
                    return;
                launchDelivered = true;
                if (key !== undefined)
                    launchKeys.add(key);
                cb(Object.assign(Object.assign({}, info), { coldStart: true }));
                return;
            }
            if (key !== undefined) {
                if (launchKeys.delete(key))
                    return; // the launch read already handed this one over
                liveKeys.push(key);
                if (liveKeys.length > 20)
                    liveKeys.shift();
            }
            cb(info);
        };
        if (NotifyKit === null || NotifyKit === void 0 ? void 0 : NotifyKit.onForegroundEvent) {
            const infoOf = (notification, actionId) => {
                const data = _pushData(notification === null || notification === void 0 ? void 0 : notification.data);
                const info = { notificationId: _idOfData(data), data };
                if (actionId !== undefined)
                    info.actionId = actionId;
                return info;
            };
            const keyOf = (notification, actionId) => (notification === null || notification === void 0 ? void 0 : notification.id) === undefined ? undefined : `nk|${String(notification.id)}|${String(actionId !== null && actionId !== void 0 ? actionId : '')}`;
            try {
                Promise.resolve((_a = NotifyKit.getInitialNotification) === null || _a === void 0 ? void 0 : _a.call(NotifyKit))
                    .then((initial) => {
                    var _a;
                    if (!(initial === null || initial === void 0 ? void 0 : initial.notification))
                        return;
                    const actionId = (_a = initial === null || initial === void 0 ? void 0 : initial.pressAction) === null || _a === void 0 ? void 0 : _a.id;
                    deliver(infoOf(initial.notification, actionId), keyOf(initial.notification, actionId), true);
                })
                    .catch(() => { });
            }
            catch ( /* best-effort */_b) { /* best-effort */ }
            try {
                const unsubscribe = NotifyKit.onForegroundEvent(({ type, detail }) => {
                    var _a;
                    const notification = detail === null || detail === void 0 ? void 0 : detail.notification;
                    if (type === (NotifyKitEventType === null || NotifyKitEventType === void 0 ? void 0 : NotifyKitEventType.ACTION_PRESS)) {
                        const actionId = (_a = detail === null || detail === void 0 ? void 0 : detail.pressAction) === null || _a === void 0 ? void 0 : _a.id;
                        deliver(infoOf(notification, actionId), keyOf(notification, actionId), false);
                    }
                    else if (type === (NotifyKitEventType === null || NotifyKitEventType === void 0 ? void 0 : NotifyKitEventType.PRESS)) {
                        deliver(infoOf(notification), keyOf(notification), false);
                    }
                });
                if (typeof unsubscribe === 'function')
                    unsubs.push(unsubscribe);
            }
            catch ( /* best-effort */_c) { /* best-effort */ }
        }
        const fcm = _fcmOpenedApi();
        if (fcm) {
            const infoOf = (message) => {
                const data = _pushData(message === null || message === void 0 ? void 0 : message.data);
                return { notificationId: _idOfData(data), data };
            };
            const keyOf = (message) => ((message === null || message === void 0 ? void 0 : message.messageId) === undefined ? undefined : `fcm|${String(message.messageId)}`);
            try {
                Promise.resolve(fcm.getInitial())
                    .then((message) => {
                    if (message)
                        deliver(infoOf(message), keyOf(message), true);
                })
                    .catch(() => { });
            }
            catch ( /* best-effort */_d) { /* best-effort */ }
            try {
                const unsubscribe = fcm.onOpened((message) => {
                    if (message)
                        deliver(infoOf(message), keyOf(message), false);
                });
                if (typeof unsubscribe === 'function')
                    unsubs.push(unsubscribe);
            }
            catch ( /* best-effort */_e) { /* best-effort */ }
        }
        return () => { for (const u of unsubs) {
            try {
                u();
            }
            catch ( /* best-effort */_a) { /* best-effort */ }
        } };
    }
    onReceived(cb) {
        if (!(NotifyKit === null || NotifyKit === void 0 ? void 0 : NotifyKit.onForegroundEvent))
            return () => { };
        try {
            const unsubscribe = NotifyKit.onForegroundEvent(({ type, detail }) => {
                var _a, _b;
                if (type === (NotifyKitEventType === null || NotifyKitEventType === void 0 ? void 0 : NotifyKitEventType.DELIVERED)) {
                    const data = (_a = detail === null || detail === void 0 ? void 0 : detail.notification) === null || _a === void 0 ? void 0 : _a.data;
                    const notificationId = (_b = data === null || data === void 0 ? void 0 : data.notificationId) !== null && _b !== void 0 ? _b : data === null || data === void 0 ? void 0 : data.notification_id;
                    cb({ notificationId });
                }
            });
            return typeof unsubscribe === 'function' ? unsubscribe : () => { };
        }
        catch (_a) {
            return () => { };
        }
    }
    onDismissed(cb) {
        if (!(NotifyKit === null || NotifyKit === void 0 ? void 0 : NotifyKit.onForegroundEvent))
            return () => { };
        try {
            const unsubscribe = NotifyKit.onForegroundEvent(({ type, detail }) => {
                var _a, _b;
                if (type === (NotifyKitEventType === null || NotifyKitEventType === void 0 ? void 0 : NotifyKitEventType.DISMISSED)) {
                    const data = (_a = detail === null || detail === void 0 ? void 0 : detail.notification) === null || _a === void 0 ? void 0 : _a.data;
                    const notificationId = (_b = data === null || data === void 0 ? void 0 : data.notificationId) !== null && _b !== void 0 ? _b : data === null || data === void 0 ? void 0 : data.notification_id;
                    cb({ notificationId });
                }
            });
            return typeof unsubscribe === 'function' ? unsubscribe : () => { };
        }
        catch (_a) {
            return () => { };
        }
    }
    supportsCategories() {
        return !!(NotifyKit === null || NotifyKit === void 0 ? void 0 : NotifyKit.setNotificationCategories);
    }
    setCategories(categories) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!(NotifyKit === null || NotifyKit === void 0 ? void 0 : NotifyKit.setNotificationCategories))
                return;
            try {
                yield NotifyKit.setNotificationCategories(categories.map((category) => ({
                    id: category.identifier,
                    actions: category.actions.map((a) => {
                        var _a, _b;
                        return ({
                            id: a.identifier,
                            title: a.buttonTitle,
                            foreground: (_a = a.opensAppToForeground) !== null && _a !== void 0 ? _a : true,
                            destructive: (_b = a.isDestructive) !== null && _b !== void 0 ? _b : false,
                        });
                    }),
                })));
            }
            catch (_a) {
                // best-effort, silent — never breaks app boot
            }
        });
    }
}
exports.BareDisplayAdapter = BareDisplayAdapter;
class NullDisplayAdapter {
    onResponse(_cb) {
        return () => { };
    }
    onReceived(_cb) {
        return () => { };
    }
    onDismissed(_cb) {
        return () => { };
    }
    supportsCategories() {
        return false;
    }
    setCategories(_categories) {
        return __awaiter(this, void 0, void 0, function* () {
            // no-op
        });
    }
}
/**
 * Resolves the appropriate DisplayAdapter:
 * 1. ExpoDisplayAdapter when expo-notifications resolves (each method guards its
 *    own specific API).
 * 2. BareDisplayAdapter when expo absent but react-native-notify-kit or @react-native-firebase/messaging is present.
 * 3. NullDisplayAdapter (no-op) otherwise.
 * Explicit override is task #805.
 */
function resolveDisplayAdapter() {
    if (Notifications) {
        return new ExpoDisplayAdapter();
    }
    if (NotifyKit || FirebaseMessaging) {
        return new BareDisplayAdapter();
    }
    return new NullDisplayAdapter();
}
/** Resolves the appropriate DeviceInfoAdapter. Always available (no dep check needed). */
function resolveDeviceInfo() {
    return new ExpoDeviceInfo();
}
/**
 * Introspect which native integrations the SDK detected at runtime. Useful for
 * debugging (e.g. "why is my push token null?") across Expo vs bare React Native.
 * Explicit override of any adapter is still available via ClientConfig
 * (`transport`/`displayAdapter`/`deviceInfo`) and the hook's `provider` option.
 */
function capabilities() {
    const nativeTransport = (0, transport_1.inspectNativeModule)().module !== null;
    return {
        expoNotifications: !!Notifications,
        firebaseMessaging: !!FirebaseMessaging,
        notifyKit: !!NotifyKit,
        pushProvider: Notifications ? "expo" : FirebaseMessaging ? "bare" : "none",
        displayAdapter: Notifications ? "expo" : NotifyKit || FirebaseMessaging ? "bare" : "none",
        sslPinning: !!(SslPinning === null || SslPinning === void 0 ? void 0 : SslPinning.initializeSslPinning) || nativeTransport,
        pinningActive: _defaultPathPinned(),
        nativeTransport,
    };
}
const QUEUE_DEFAULT_MAX_ITEMS = 200;
const QUEUE_MAX_ITEMS_LIMIT = 1000;
/** An event older than this is not worth sending any more (3 days). @internal */
const QUEUE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const QUEUE_BACKOFF_BASE_MS = 5000;
const QUEUE_BACKOFF_CAP_MS = 15 * 60 * 1000;
/** The longest a `Retry-After` pauses the queue (1 hour). @internal */
const QUEUE_RETRY_AFTER_CAP_MS = 60 * 60 * 1000;
/** SecureStore keeps values over 2048 bytes unreliably; 600 characters stay under it even at 3 bytes each. @internal */
const QUEUE_CHUNK_CHARS = 600;
/** A pass over the queue stops after this many failures in a row: the network or the server is down. @internal */
const QUEUE_PASS_FAILURE_LIMIT = 3;
/**
 * The device id being read or created right now, per backing storage (`KeyStore.backing`, or the store itself when it
 * names none), and the store it is read from. An entry lives only while its read or write is in flight, so a read that
 * never settles holds back its own storage and no other.
 * @internal
 */
const _deviceIdLoads = new WeakMap();
/**
 * The `espresso.deviceId` of the install: read, or created once and kept (create-only). Request signing and the offline
 * queue both ask for it here, and whoever asks while the id is being read or written gets that same promise, so a
 * fresh install never gets two ids, whichever of the two starts first. The two usually hold two `KeyStore` objects over
 * one storage (they name it in `backing`); a caller with another object over that storage waits for the id, then makes
 * sure its own store holds it. Callers over two different storages never share an id.
 * @internal
 */
function _stableDeviceId(store) {
    var _a;
    const storage = (_a = store.backing) !== null && _a !== void 0 ? _a : store;
    const current = _deviceIdLoads.get(storage);
    if (current) {
        if (current.store === store)
            return current.promise;
        return current.promise.then((created) => __awaiter(this, void 0, void 0, function* () {
            const stored = yield store.getItem(SIGNING_DEVICE_ID_KEY);
            if (stored)
                return stored;
            yield store.setItem(SIGNING_DEVICE_ID_KEY, created);
            return created;
        }));
    }
    const promise = (() => __awaiter(this, void 0, void 0, function* () {
        let deviceId = yield store.getItem(SIGNING_DEVICE_ID_KEY);
        if (!deviceId) {
            deviceId = yield _randomHex(16);
            yield store.setItem(SIGNING_DEVICE_ID_KEY, deviceId);
        }
        return deviceId;
    }))();
    const load = { store, promise };
    _deviceIdLoads.set(storage, load);
    const settled = () => { if (_deviceIdLoads.get(storage) === load)
        _deviceIdLoads.delete(storage); };
    promise.then(settled, settled);
    return promise;
}
/**
 * A lifecycle event can reach the server before the register of its token (a token rotation): the answer is 404
 * `token_not_found`. That refusal can pass, so the event is tried this many times in all before it counts as refused.
 * @internal
 */
const QUEUE_TOKEN_RACE_ATTEMPTS = 4;
/** The only routes the queue replays; a stored item for any other path is ignored. @internal */
const QUEUE_PATHS = new Set(['/v1/notifications/track', '/v1/devices/lifecycle']);
/** The only fields of a delivery event or a custom event that the store may hold. @internal */
const QUEUE_STORED_TRACK_FIELDS = new Set(['notification_id', 'event', 'push_token', 'event_id']);
/** The only fields of a permission change that the store may hold: a state before and after, no user, no token. @internal */
const QUEUE_STORED_LIFECYCLE_FIELDS = new Set(['push_token', 'kind', 'from', 'to', 'event_id']);
/**
 * Whether an event may be written to the store. The store (AsyncStorage) is not encrypted, so what names a user or
 * holds a push token stays in memory: a token rotation (`subscription`, `from` and `to` are push tokens), an identity
 * change (`identity`, a user id) and any lifecycle event that carries an `external_id`. Everything else is a state
 * name or a notification id; the field list is closed, so a field added later stays out of the store until it is
 * added here on purpose. @internal
 */
function _mayPersist(path, body) {
    const lifecycle = path === '/v1/devices/lifecycle';
    if (lifecycle && body.kind !== 'permission')
        return false;
    const allowed = lifecycle ? QUEUE_STORED_LIFECYCLE_FIELDS : QUEUE_STORED_TRACK_FIELDS;
    return Object.keys(body).every((key) => body[key] === undefined || allowed.has(key));
}
/** The warnings of the queue that already showed in this app run: each shows once. @internal */
const _queueWarned = new Set();
function _queueWarnOnce(key, message) {
    if (_queueWarned.has(key))
        return;
    _queueWarned.add(key);
    console.warn(message);
}
let _eventSeq = 0;
/** A new id for an event that may be sent again: time, randomness and a counter. 27 to 40 URL-safe characters. @internal */
function _newEventId() {
    let random = '';
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
            random = _bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
        }
    }
    catch ( /* fall back below */_a) { /* fall back below */ }
    if (!random) {
        for (let i = 0; i < 16; i++)
            random += Math.floor(Math.random() * 16).toString(16).slice(-1);
    }
    _eventSeq = (_eventSeq + 1) % 1679616;
    return Date.now().toString(16).padStart(11, '0') + random + _eventSeq.toString(36);
}
/** How the queue judges the failure of one send. @internal */
function _classifySendError(error) {
    if (error instanceof errors_1.EspressoNotifyHttpError) {
        const status = error.status;
        if (status === 408 || status === 429 || status >= 500) {
            const seconds = error.retryAfter;
            return {
                kind: 'retry',
                network: false,
                retryAfterMs: typeof seconds === 'number' && seconds >= 0 ? Math.min((0, retry_1.jitterRetryAfter)(seconds), QUEUE_RETRY_AFTER_CAP_MS) : undefined, // the header plus a random 0 to 25% (retry.ts)
            };
        }
        return { kind: 'refused', status, code: error.code };
    }
    if (error instanceof errors_1.EspressoNotifyError)
        return { kind: 'sdk' };
    return { kind: 'retry', network: true };
}
/**
 * `_classifySendError` for the route of the event: a 404 `token_not_found` on a lifecycle event is a race with the
 * register of its token, so it is kept for a few more tries (`attempt` is the number of this try, starting at 1).
 * @internal
 */
function _classifyForPath(path, error, attempt) {
    const outcome = _classifySendError(error);
    if (outcome.kind === 'refused' && outcome.status === 404 && outcome.code === 'token_not_found' &&
        path === '/v1/devices/lifecycle' && attempt < QUEUE_TOKEN_RACE_ATTEMPTS) {
        return { kind: 'retry', network: false, race: true };
    }
    return outcome;
}
/** The wait before attempt number `attempts` + 1: 5 s doubling to 15 min, jittered to between half and all of it. @internal */
function _queueBackoffMs(attempts) {
    const full = Math.min(QUEUE_BACKOFF_CAP_MS, QUEUE_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
    return Math.round(full * (0.5 + 0.5 * Math.random()));
}
/** Text with only ASCII characters, so a store never sees half of a surrogate pair. @internal */
function _asciiJson(value) {
    return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
/** Text in a KeyStore as chunks, writing only the chunks that changed. @internal */
class ChunkedTextStore {
    constructor(_store, _key) {
        this._store = _store;
        this._key = _key;
        this._written = [];
    }
    read() {
        return __awaiter(this, void 0, void 0, function* () {
            const count = Number(yield this._store.getItem(`${this._key}.n`));
            if (!Number.isInteger(count) || count <= 0 || count > 5000)
                return null;
            const parts = [];
            for (let i = 0; i < count; i++) {
                const part = yield this._store.getItem(`${this._key}.${i}`);
                if (part === null)
                    return null;
                parts.push(part);
            }
            this._written = parts;
            return parts.join('');
        });
    }
    write(text) {
        return __awaiter(this, void 0, void 0, function* () {
            const chunks = [];
            for (let i = 0; i < text.length; i += QUEUE_CHUNK_CHARS)
                chunks.push(text.slice(i, i + QUEUE_CHUNK_CHARS));
            for (let i = 0; i < chunks.length; i++) {
                if (this._written[i] !== chunks[i])
                    yield this._store.setItem(`${this._key}.${i}`, chunks[i]);
            }
            yield this._store.setItem(`${this._key}.n`, String(chunks.length));
            // A chunk past the new count is no longer read; blank it so that no text of an event already sent stays in the store.
            for (let i = chunks.length; i < this._written.length; i++) {
                if (this._written[i] !== '')
                    yield this._store.setItem(`${this._key}.${i}`, '');
            }
            this._written = chunks;
        });
    }
}
/**
 * The store of the queue: the one the SDK already resolves for the signing key. SecureStore first, then AsyncStorage,
 * then memory. No push token and no user id is stored (see `_mayPersist`); the queue is written in chunks of 600
 * characters because SecureStore keeps values over 2048 bytes unreliably.
 * @internal
 */
function resolveQueueStore() {
    var _a;
    const SecureStore = OptSecureStore;
    if ((SecureStore === null || SecureStore === void 0 ? void 0 : SecureStore.getItemAsync) && (SecureStore === null || SecureStore === void 0 ? void 0 : SecureStore.setItemAsync))
        return { store: new ExpoSecureKeyStore(SecureStore), persistent: true };
    const storage = (_a = OptAsyncStorage === null || OptAsyncStorage === void 0 ? void 0 : OptAsyncStorage.default) !== null && _a !== void 0 ? _a : OptAsyncStorage;
    if ((storage === null || storage === void 0 ? void 0 : storage.getItem) && (storage === null || storage === void 0 ? void 0 : storage.setItem))
        return { store: new AsyncStorageKeyStore(storage), persistent: true };
    return { store: new MemoryKeyStore(), persistent: false };
}
/**
 * The offline queue: sends an event now, keeps it when the send fails for a reason that can pass, and sends it again
 * later. Used by `Devices` for the events it reports (opens, clicks, conversions, custom and lifecycle events).
 * @internal
 */
class EventQueue {
    constructor(_request, _getToken, store, persistent, 
    /** `espresso.eventQueue.<projectId>`: the prefix of the key of the queue; the device id of the install follows it. */
    _storageKey, maxItems) {
        this._request = _request;
        this._getToken = _getToken;
        this._storageKey = _storageKey;
        /** The queue of this project and device id; null while the id cannot be read (`_attachStore`): memory only until then. */
        this._store = null;
        this._attaching = null;
        this._items = [];
        this._dropped = 0;
        this._loading = null;
        this._loadedOnce = false;
        this._chain = Promise.resolve();
        /** A `Retry-After` from the server: nothing is sent before this time, a forced flush excepted. */
        this._retryAfterUntil = 0;
        /** The wait of the last failure: the periodic retry does not start before it. */
        this._holdUntil = 0;
        this._timer = null;
        this._destroyed = false;
        this._keyStore = store;
        this._persistent = persistent;
        this._maxItems = maxItems;
    }
    /** Sends the event now; keeps it for later when it fails in a way that can pass. Never throws. */
    send(path, body, withEventId) {
        return __awaiter(this, void 0, void 0, function* () {
            // The request goes out at once (the store is read only when something has to be kept or sent again), so an
            // event leaves the app exactly when it did before the queue existed.
            const full = withEventId ? Object.assign(Object.assign({}, body), { event_id: _newEventId() }) : body;
            const paused = Date.now() < this._retryAfterUntil;
            let outcome = { kind: 'retry', network: false };
            if (!paused) {
                try {
                    yield this._request(path, { method: 'POST', body: JSON.stringify(full) });
                    outcome = { kind: 'ok' };
                }
                catch (error) {
                    outcome = _classifyForPath(path, error, 1);
                }
            }
            if (outcome.kind === 'ok') {
                // The network is back: the events that waited go too.
                if (!this._loadedOnce || this._items.length > 0)
                    void this._flush('due');
                return;
            }
            if (outcome.kind === 'sdk')
                return;
            if (outcome.kind === 'refused') {
                yield this._serial(() => __awaiter(this, void 0, void 0, function* () {
                    yield this._load();
                    this._countRefused(outcome);
                    yield this._persist();
                }));
                return;
            }
            yield this._keepRetry(path, full, outcome, paused);
        });
    }
    /** Keeps an event whose send failed in a way that can pass; `paused`: a Retry-After holds the queue, so no request was made. */
    _keepRetry(path, full, outcome, paused) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this._serial(() => __awaiter(this, void 0, void 0, function* () {
                yield this._load();
                const now = Date.now();
                const stored = Object.assign({}, full);
                if ('push_token' in stored)
                    stored.push_token = null; // the token is not kept: it is added when the event is sent
                const attempts = paused ? 0 : 1;
                let next = paused ? this._retryAfterUntil : now + _queueBackoffMs(1);
                if (!paused && outcome.retryAfterMs !== undefined) {
                    this._retryAfterUntil = Math.max(this._retryAfterUntil, now + outcome.retryAfterMs);
                    next = Math.max(next, this._retryAfterUntil);
                }
                // A race with the register of the token says nothing about the network: it holds back no other event.
                if (!paused && !outcome.race)
                    this._holdUntil = Math.max(this._holdUntil, next);
                // What names a user or holds a push token waits in memory and is never written (see `_mayPersist`).
                const memoryOnly = !_mayPersist(path, stored);
                this._items.push(Object.assign({ id: _newEventId(), path, body: stored, at: now, attempts, next }, (memoryOnly ? { memoryOnly: true } : {})));
                this._applyCap();
                yield this._persist();
                this._schedule();
            }));
        });
    }
    // ── What the batcher of the delivery events asks of the queue (track-batch.ts) ──────────────────────────────
    /** The time (ms) until which a `Retry-After` holds every request, or 0. */
    pausedUntil() {
        return this._retryAfterUntil;
    }
    /** Keeps an event for later with the outcome of the failure that held it (the events of a batch that failed). Never throws. */
    keep(path, body, outcome) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield this._keepRetry(path, body, outcome, false);
            }
            catch ( /* the event is best-effort */_a) { /* the event is best-effort */ }
        });
    }
    /** An event the server refused for good (status 200: rejected inside a batch it accepted; 0: an error of the SDK). Never throws. */
    refused(status, code) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield this._serial(() => __awaiter(this, void 0, void 0, function* () {
                    yield this._load();
                    if (status === 0)
                        this._dropped += 1;
                    else
                        this._countRefused({ status, code });
                    yield this._persist();
                }));
            }
            catch ( /* counted at best */_a) { /* counted at best */ }
        });
    }
    /** A request worked: the network is back, so the events that waited go too. */
    delivered() {
        if (!this._loadedOnce || this._items.length > 0)
            void this._flush('due');
    }
    /** Sends what waits. 'due': the items whose time came. 'foreground': all, but not through a Retry-After. 'force': all. */
    flush(mode) {
        return this._flush(mode);
    }
    /** Reads what the last run left, and arranges for it to be sent when its time comes. */
    start() {
        void this._load();
    }
    /** The client got a push token: what waited for one is sent when its time comes (now, if it is already due). */
    tokenSet() {
        if (this._getToken())
            void this._flush('due');
    }
    stats() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this._load();
            yield this._chain; // the work that is under way ends first
            return { pending: this._items.length, dropped: this._dropped };
        });
    }
    destroy() {
        this._destroyed = true;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }
    _flush(mode) {
        return this._serial(() => __awaiter(this, void 0, void 0, function* () {
            yield this._load();
            if (!this._store)
                yield this._attachStore(); // the id may be readable by now (a store that was locked at launch)
            yield this._pass(mode);
        })).catch(() => { });
    }
    _serial(fn) {
        const run = this._chain.then(fn, fn);
        this._chain = run.then(() => undefined, () => undefined);
        return run;
    }
    /**
     * The stored queue of this project and install: `<storageKey>.<device id>`, the device id being the
     * `espresso.deviceId` that request signing already keeps (created here when it is not there yet, and never replaced).
     * Throws when the id cannot be read (a locked store): there is then no key, and the queue stays in memory.
     */
    _openStore() {
        return __awaiter(this, void 0, void 0, function* () {
            const deviceId = yield _stableDeviceId(this._keyStore);
            const suffix = deviceId.replace(/[^A-Za-z0-9._-]/g, '_');
            return new ChunkedTextStore(this._keyStore, `${this._storageKey}.${suffix}`);
        });
    }
    /** The items and the dropped count of a stored text, safe to keep: see the comments inside. */
    _adopt(text) {
        const state = text ? JSON.parse(text) : null;
        if (!state || state.v !== 1 || !Array.isArray(state.items))
            return false;
        let rewrite = false;
        const valid = state.items.filter((i) => i && typeof i.id === 'string' && QUEUE_PATHS.has(i.path) && i.body && typeof i.body === 'object' &&
            Number.isFinite(i.at) && Number.isFinite(i.attempts) && Number.isFinite(i.next)).map((i) => (i.body.push_token != null ? ((rewrite = true), Object.assign(Object.assign({}, i), { body: Object.assign(Object.assign({}, i.body), { push_token: null }) })) : i));
        // An event that names a user or holds a token is not kept from disk, whoever wrote it: it is dropped, counted,
        // and the store is rewritten without it. A push token found in a body is blanked (the event goes out with the client's).
        const safe = valid.filter((i) => _mayPersist(i.path, i.body));
        // What the memory already holds wins over the same event id on disk (a queue opened late is merged, not doubled).
        const known = new Set(this._items.map((i) => i.id));
        const merged = [...safe.filter((i) => !known.has(i.id)), ...this._items];
        const cut = Math.max(0, merged.length - this._maxItems);
        this._items = merged.slice(cut);
        this._dropped += (Number.isFinite(state.dropped) ? state.dropped : 0) + (valid.length - safe.length) + cut;
        return rewrite || cut > 0 || valid.length > safe.length;
    }
    /**
     * Opens the stored queue and merges it with the memory (by event id), then writes it; true when open. Retried on each
     * send and flush while the device id cannot be read.
     */
    _attachStore() {
        if (this._store)
            return Promise.resolve(true);
        if (!this._attaching) {
            this._attaching = (() => __awaiter(this, void 0, void 0, function* () {
                let store;
                try {
                    store = yield this._openStore();
                }
                catch (_a) {
                    return false; // still unreadable: the queue stays in memory
                }
                this._store = store;
                let rewrite = this._items.some((i) => !i.memoryOnly);
                // What the memory holds is written even when the stored text is damaged (it is then replaced by the memory).
                try {
                    rewrite = this._adopt(yield store.read()) || rewrite;
                }
                catch ( /* damaged: the memory is kept */_b) { /* damaged: the memory is kept */ }
                if (rewrite)
                    yield this._persist();
                return true;
            }))().finally(() => { this._attaching = null; });
        }
        return this._attaching;
    }
    _load() {
        if (!this._loading) {
            this._loading = (() => __awaiter(this, void 0, void 0, function* () {
                let rewrite = false;
                try {
                    this._store = yield this._openStore();
                    rewrite = this._adopt(yield this._store.read());
                }
                catch ( /* damaged or unreadable: start empty (a locked store is opened again by `_attachStore`) */_a) { /* damaged or unreadable: start empty (a locked store is opened again by `_attachStore`) */ }
                this._loadedOnce = true;
                if (rewrite)
                    yield this._persist();
                this._schedule();
            }))();
        }
        return this._loading;
    }
    /** Writes the queue; false when the write did not land (the queue keeps working in memory). */
    _persist() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                if (!this._persistent) {
                    if (process.env.NODE_ENV !== 'test') {
                        _queueWarnOnce('memory', '[espresso-notify] offline queue: neither @react-native-async-storage/async-storage nor expo-secure-store is ' +
                            'installed, so the events that wait are kept in memory only and are lost when the app closes.');
                    }
                }
                if (!this._store && !(yield this._attachStore()))
                    return false; // never a key without the device id: memory only
                const state = { v: 1, items: this._items.filter((i) => !i.memoryOnly), dropped: this._dropped };
                yield this._store.write(_asciiJson(state));
                return true;
            }
            catch ( /* the queue keeps working in memory */_a) { /* the queue keeps working in memory */ }
            return false;
        });
    }
    _applyCap() {
        const over = this._items.length - this._maxItems;
        if (over > 0) {
            this._items.splice(0, over);
            this._dropped += over;
            _queueWarnOnce('full', `[espresso-notify] offline queue is full (${this._maxItems} events): the oldest events are dropped. ` +
                'Read client.queueStats().dropped to count them.');
        }
    }
    /** Drops the items past the age limit. */
    _expire() {
        const limit = Date.now() - QUEUE_MAX_AGE_MS;
        const kept = this._items.filter((i) => i.at >= limit);
        const gone = this._items.length - kept.length;
        if (gone > 0) {
            this._items = kept;
            this._dropped += gone;
        }
        return gone > 0;
    }
    _countRefused(outcome) {
        var _a;
        this._dropped += 1;
        _queueWarnOnce(`refused:${outcome.status}:${(_a = outcome.code) !== null && _a !== void 0 ? _a : ''}`, `[espresso-notify] offline queue: an event was dropped because the server refused it (HTTP ${outcome.status}` +
            `${outcome.code ? ` ${outcome.code}` : ''}). Retrying cannot fix it, so it will not be sent again.`);
    }
    _pass(mode) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._destroyed)
                return;
            let changed = this._expire();
            const start = Date.now();
            const blocked = (mode !== 'force' && start < this._retryAfterUntil) || (mode === 'due' && start < this._holdUntil);
            const token = this._getToken();
            if (blocked || !token || this._items.length === 0) {
                if (changed)
                    yield this._persist();
                this._schedule();
                return;
            }
            let failures = 0;
            for (const item of [...this._items]) {
                if (this._destroyed)
                    break;
                if (mode === 'due' && item.next > Date.now())
                    continue;
                let outcome;
                try {
                    const body = Object.assign({}, item.body);
                    if ('push_token' in body)
                        body.push_token = token;
                    yield this._request(item.path, { method: 'POST', body: JSON.stringify(body) });
                    outcome = { kind: 'ok' };
                }
                catch (error) {
                    outcome = _classifyForPath(item.path, error, item.attempts + 1);
                }
                const now = Date.now();
                if (outcome.kind === 'ok') {
                    this._items = this._items.filter((i) => i !== item);
                    this._holdUntil = 0;
                    failures = 0;
                    changed = true;
                }
                else if (outcome.kind === 'refused') {
                    this._items = this._items.filter((i) => i !== item);
                    this._countRefused(outcome);
                    changed = true;
                }
                else if (outcome.kind === 'sdk') {
                    this._items = this._items.filter((i) => i !== item);
                    this._dropped += 1;
                    changed = true;
                }
                else if (outcome.race) {
                    // The register of the token may not have arrived yet: try this one again later, and go on with the others.
                    item.attempts += 1;
                    item.next = now + _queueBackoffMs(item.attempts);
                    changed = true;
                }
                else {
                    item.attempts += 1;
                    item.next = now + _queueBackoffMs(item.attempts);
                    if (outcome.retryAfterMs !== undefined) {
                        this._retryAfterUntil = Math.max(this._retryAfterUntil, now + outcome.retryAfterMs);
                        item.next = Math.max(item.next, this._retryAfterUntil);
                    }
                    this._holdUntil = Math.max(this._holdUntil, item.next);
                    changed = true;
                    failures += 1;
                    if (outcome.retryAfterMs !== undefined || outcome.network || failures >= QUEUE_PASS_FAILURE_LIMIT)
                        break;
                }
            }
            if (changed)
                yield this._persist();
            this._schedule();
        });
    }
    /** One timer, for the soonest moment something can be sent. */
    _schedule() {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        // No token, nothing to send with: the timer stays off (a spin at 0 ms otherwise); `tokenSet()` starts it again.
        if (this._destroyed || this._items.length === 0 || !this._getToken())
            return;
        const soonest = Math.min(...this._items.map((i) => i.next));
        const at = Math.max(soonest, this._holdUntil, this._retryAfterUntil);
        const timer = setTimeout(() => { this._timer = null; void this._flush('due'); }, Math.max(0, at - Date.now()));
        if (timer && typeof timer.unref === 'function')
            timer.unref();
        this._timer = timer;
    }
}
/** The most characters of a link the SDK opens. @internal */
const MAX_DEEP_LINK_LENGTH = 2048;
/** Schemes that are never opened, whatever the allow-list says: code, local files, intents. @internal */
const REFUSED_LINK_SCHEMES = new Set(['javascript', 'data', 'file', 'vbscript', 'blob', 'about', 'intent', 'content']);
/** Parses an allow-list; an entry of another shape is dropped. @internal */
function _parseAllowList(list) {
    if (!Array.isArray(list))
        return [];
    const out = [];
    for (const raw of list) {
        if (typeof raw !== 'string')
            continue;
        const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/)?$/.exec(raw);
        if (scheme) {
            out.push({ scheme: scheme[1].toLowerCase() });
            continue;
        }
        const origin = /^https:\/\/([^/?#@\s]+)$/i.exec(raw);
        if (origin)
            out.push({ httpsAuthority: origin[1].toLowerCase() });
    }
    return out;
}
/** Decides whether `url` may be opened with this allow-list. Pure. @internal */
function _deepLinkVerdict(url, allow) {
    var _a;
    if (url.length > MAX_DEEP_LINK_LENGTH || /[\s\u0000-\u001f\u007f-\u009f]/.test(url))
        return 'refused';
    const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url);
    if (!m)
        return 'refused';
    const scheme = m[1].toLowerCase();
    if (REFUSED_LINK_SCHEMES.has(scheme))
        return 'refused';
    const authority = (_a = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(url)) === null || _a === void 0 ? void 0 : _a[1];
    if (scheme === 'https' || scheme === 'http') {
        if (!authority || authority.includes('@'))
            return 'refused';
    }
    for (const entry of allow) {
        if ('scheme' in entry && entry.scheme === scheme)
            return 'ok';
        if ('httpsAuthority' in entry && scheme === 'https' && (authority === null || authority === void 0 ? void 0 : authority.toLowerCase()) === entry.httpsAuthority)
            return 'ok';
    }
    return 'not_allowed';
}
/** The reasons already warned about in this app run: each warning shows once. @internal */
const _deepLinkWarned = new Set();
/**
 * True for the id a library reports when the notification itself was tapped, not an action button: no id, the
 * default action of expo-notifications, and the `default` press action of notify-kit.
 * @internal
 */
function _isDefaultAction(actionId) {
    if (actionId === undefined || actionId === null || actionId === '')
        return true;
    return actionId === 'default' || (!!(Notifications === null || Notifications === void 0 ? void 0 : Notifications.DEFAULT_ACTION_IDENTIFIER) && actionId === Notifications.DEFAULT_ACTION_IDENTIFIER);
}
/** What iOS reports when the user dismisses a push of a category registered with `customDismissAction`. @internal */
const APPLE_DISMISS_ACTION_IDENTIFIER = 'com.apple.UNNotificationDismissActionIdentifier';
/**
 * True for the response of a dismissal (a swipe away), not a tap: the Apple identifier, or the constant that
 * expo-notifications exports when a version of it does. A dismissal is never an open. @internal
 */
function _isDismissAction(actionId) {
    if (!actionId)
        return false;
    return actionId === APPLE_DISMISS_ACTION_IDENTIFIER || (!!(Notifications === null || Notifications === void 0 ? void 0 : Notifications.DISMISS_ACTION_IDENTIFIER) && actionId === Notifications.DISMISS_ACTION_IDENTIFIER);
}
class PushClient {
    constructor(config) {
        var _a, _b, _c, _d, _e, _f, _g;
        /** All active auto-tracking unsubscribes — cleaned up in destroy(). */
        this._trackingUnsubscribes = [];
        /** The handlers of onNotificationOpened, in the order they were registered. */
        this._openedHandlers = [];
        /** The tap that launched the app, when it arrived before any handler existed; the first handler gets it. */
        this._pendingLaunchTap = null;
        /** The last pushes whose dismissal was recorded, so that two listeners of one response record it once. */
        this._dismissedSeen = [];
        this._responseListening = false;
        this.warnMissingOptionalDeps();
        this.validateProjectId(config.projectId);
        const mode = config.privateTransport === undefined ? 'auto' : config.privateTransport;
        if (mode !== 'auto' && mode !== 'native' && mode !== 'js') {
            throw new Error("❌ Validation Error: 'privateTransport' must be 'auto', 'native' or 'js'.");
        }
        this.projectId = config.projectId;
        this._pushToken = config.pushToken;
        this._platform = config.platform;
        this._provider = config.provider;
        this.baseURL = (_a = config._apiUrl) !== null && _a !== void 0 ? _a : API_URL;
        // Resolve adapters — injected takes priority, then auto-select defaults
        let plainTransport;
        if (config.transport) {
            plainTransport = config.transport;
            this.transportKind = 'custom';
        }
        else if (mode === 'js') {
            plainTransport = new FetchTransport(this.baseURL, this.projectId);
            this.transportKind = 'js';
        }
        else {
            const { module: nativeModule, reason } = (0, transport_1.inspectNativeModule)();
            if (nativeModule) {
                plainTransport = new transport_1.NativeTransport(this.baseURL, this.projectId, nativeModule);
                this.transportKind = 'native';
            }
            else if (mode === 'native') {
                plainTransport = new UnavailableTransport(reason !== null && reason !== void 0 ? reason : 'not_linked');
                this.transportKind = 'js'; // nothing sends: the native transport is not the one in use
            }
            else {
                warnNativeFallbackOnce(reason !== null && reason !== void 0 ? reason : 'not_linked');
                plainTransport = new FetchTransport(this.baseURL, this.projectId);
                this.transportKind = 'js';
            }
        }
        const baseFetch = config.requirePinning ? new PinningGuardTransport(plainTransport, this.transportKind) : plainTransport;
        this._displayAdapter = (_b = config.displayAdapter) !== null && _b !== void 0 ? _b : resolveDisplayAdapter();
        const deviceInfo = (_c = config.deviceInfo) !== null && _c !== void 0 ? _c : resolveDeviceInfo();
        // ── Signing (#813) ──────────────────────────────────────────────────────
        let signingSession = null;
        if (config.enableSigning) {
            const keyStore = (_d = config._keyStore) !== null && _d !== void 0 ? _d : resolveKeyStore();
            const signer = (_e = config._signer) !== null && _e !== void 0 ? _e : resolveSecureSign();
            if (signer) {
                signingSession = new SigningSession(keyStore, signer);
                this._transport = new SigningTransport(baseFetch, signingSession, signer);
            }
            else {
                this._transport = baseFetch;
                _warnSigningUnavailable(); // signing requested but impossible: say so
            }
        }
        else {
            this._transport = baseFetch;
        }
        // ── Attestation (#814) ──────────────────────────────────────────────────
        // Total no-op unless explicitly enabled. Attestation needs the persisted
        // per-install device_id from the signing session, so resolve a provider only
        // when enabled (Devices.attest() additionally guards on signingSession).
        let attestationProvider = null;
        if (config.enableAttestation) {
            const resolvedPlatform = (_f = config.platform) !== null && _f !== void 0 ? _f : RNPlatform === null || RNPlatform === void 0 ? void 0 : RNPlatform.OS;
            attestationProvider = resolveAttestationProvider(resolvedPlatform, config._attestationProvider);
        }
        // ── Offline queue ───────────────────────────────────────────────────────
        const queueConfig = config.offlineQueue;
        if ((queueConfig === null || queueConfig === void 0 ? void 0 : queueConfig.enabled) === false) {
            this._queue = null;
        }
        else {
            const requested = queueConfig === null || queueConfig === void 0 ? void 0 : queueConfig.maxItems;
            const maxItems = typeof requested === 'number' && Number.isFinite(requested) && requested >= 1
                ? Math.min(Math.floor(requested), QUEUE_MAX_ITEMS_LIMIT)
                : QUEUE_DEFAULT_MAX_ITEMS;
            const resolved = config._queueStore ? { store: config._queueStore, persistent: true } : resolveQueueStore();
            this._queue = new EventQueue(this._transport.request.bind(this._transport), () => this._pushToken, resolved.store, resolved.persistent, `espresso.eventQueue.${this.projectId.replace(/[^A-Za-z0-9._-]/g, '_')}`, maxItems);
            this._queue.start();
        }
        this.registration = new registration_1.RegistrationTracker((_g = config._queueStore) !== null && _g !== void 0 ? _g : resolveQueueStore().store, `espresso.registration.${this.projectId.replace(/[^A-Za-z0-9._-]/g, '_')}`, { getAppVersion: () => deviceInfo.collect().appVersion });
        const queue = this._queue;
        this._batcher = queue
            ? new track_batch_1.TrackBatcher({
                request: this._transport.request.bind(this._transport),
                classify: _classifySendError,
                pausedUntil: () => queue.pausedUntil(),
                sendSingle: (path, body) => queue.send(path, body, false),
                keep: (path, body, outcome) => queue.keep(path, body, outcome),
                refused: (status, code) => { void queue.refused(status, code); },
                delivered: () => queue.delivered(),
            })
            : null;
        this.devices = new Devices(this._transport.request.bind(this._transport), () => this._pushToken, () => this._platform, () => this._provider, deviceInfo, this._displayAdapter, signingSession, attestationProvider, this._queue, this._batcher);
        this._autoTrack = config.autoTrack !== false;
        this._handleDeepLinks = config.handleDeepLinks === true;
        this._allowList = _parseAllowList(config.deepLinkAllowList);
        if (config.onNotificationOpened)
            this._openedHandlers.push(config.onNotificationOpened);
        if (this._autoTrack) {
            this._setupAutoTracking();
        }
        else {
            if (this._openedHandlers.length > 0)
                this._listenForTaps();
            if (this._queue)
                this._listenForForeground();
        }
    }
    /**
     * Sends every event the offline queue is holding, now: the wait of each event and a `Retry-After` do not hold it
     * back. Resolves when the pass ends and never rejects; an event that fails again stays queued. It does nothing
     * when the queue is turned off.
     */
    flush() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._batcher)
                yield this._batcher.flush();
            if (this._queue)
                yield this._queue.flush('force');
        });
    }
    /**
     * How many events wait in the offline queue, and how many it gave up on (over the cap, older than 3 days, or
     * refused by the server for good). Both are 0 when the queue is turned off.
     */
    queueStats() {
        return __awaiter(this, void 0, void 0, function* () {
            return this._queue ? this._queue.stats() : { pending: 0, dropped: 0 };
        });
    }
    /**
     * Calls `handler` once for every tap on a notification, with `{ notificationId, data, url, actionId }`, while the
     * app runs and for the tap that launched it. Returns a function that removes the handler.
     *
     * The tap that launched the app can arrive before your code runs (the hook creates its client after it
     * registered the device). When it arrived while no handler existed, the first handler registered gets it, once.
     * A tap while the app runs with no handler is not kept.
     *
     * Your handler's errors are swallowed and never reach the tracking. See `handleDeepLinks` to let the SDK open
     * the link of the notification.
     *
     * @example
     * const off = push.onNotificationOpened(({ data, url }) => router.push(url ?? `/orders/${data.orderId}`))
     */
    onNotificationOpened(handler) {
        if (typeof handler !== 'function')
            return () => { };
        this._openedHandlers.push(handler);
        this._listenForTaps();
        const pending = this._pendingLaunchTap;
        if (pending) {
            this._pendingLaunchTap = null;
            this._callHandler(handler, pending);
        }
        return () => {
            this._openedHandlers = this._openedHandlers.filter((h) => h !== handler);
        };
    }
    /** Starts the one listener for taps (tracking and handlers), if it is not running. */
    _listenForTaps() {
        if (this._responseListening)
            return;
        this._responseListening = true;
        const adapter = this._displayAdapter;
        const unsub = adapter.onOpened
            ? adapter.onOpened((info) => this._handleTap(info))
            : adapter.onResponse((info) => this._handleTap({ notificationId: info.notificationId, actionId: info.actionId }));
        this._trackingUnsubscribes.push(unsub);
    }
    /** Records `dismissed` for a push once, whichever listener reports it first (the dismissal listener or the response one). */
    _trackDismissedOnce(notificationId) {
        const key = String(notificationId);
        if (this._dismissedSeen.includes(key))
            return;
        this._dismissedSeen.push(key);
        if (this._dismissedSeen.length > 50)
            this._dismissedSeen.shift();
        this.devices.trackDismissed(notificationId);
    }
    /**
     * One response. A dismissal records `dismissed` (never `opened`) and reaches no handler. A tap: the tracking of
     * `opened` starts first, exactly as it did before the callback existed, then the handlers.
     */
    _handleTap(info) {
        var _a;
        if (info.dismissed || _isDismissAction(info.actionId)) {
            if (this._autoTrack && info.notificationId)
                this._trackDismissedOnce(info.notificationId);
            return;
        }
        if (this._autoTrack && info.notificationId) {
            this.devices.trackOpen(info.notificationId);
        }
        const data = (_a = info.data) !== null && _a !== void 0 ? _a : {};
        const rawUrl = data.url;
        const event = {
            notificationId: info.notificationId,
            data,
            url: typeof rawUrl === 'string' && rawUrl ? rawUrl : undefined,
            actionId: _isDefaultAction(info.actionId) ? undefined : info.actionId,
        };
        if (this._openedHandlers.length === 0) {
            if (info.coldStart)
                this._pendingLaunchTap = event;
        }
        else {
            for (const handler of [...this._openedHandlers])
                this._callHandler(handler, event);
        }
        if (this._handleDeepLinks && event.url && event.actionId === undefined)
            this._openLink(event.url);
    }
    /** Opens the link of a tap if the allow-list lets it; every failure ends here. */
    _openLink(url) {
        var _a;
        try {
            const verdict = _deepLinkVerdict(url, this._allowList);
            if (verdict !== 'ok') {
                if (!_deepLinkWarned.has(verdict)) {
                    _deepLinkWarned.add(verdict);
                    // Never the URL: it can carry a token. The scheme is enough to find the push.
                    console.warn(verdict === 'refused'
                        ? '[espresso-notify] handleDeepLinks: a notification link was not opened because its scheme is never opened ' +
                            '(javascript, data, file, vbscript, blob, about, intent, content), or it is too long, has spaces or carries credentials.'
                        : '[espresso-notify] handleDeepLinks: a notification link was not opened because its scheme or host is not in ' +
                            'deepLinkAllowList. Add its scheme (for example "myapp://") or its HTTPS origin to the list.');
                }
                return;
            }
            const opened = (_a = RNLinking === null || RNLinking === void 0 ? void 0 : RNLinking.openURL) === null || _a === void 0 ? void 0 : _a.call(RNLinking, url);
            if (opened && typeof opened.then === 'function')
                opened.then(undefined, () => { });
        }
        catch ( /* no app can open it */_b) { /* no app can open it */ }
    }
    /** Calls one handler; a throw or a rejection ends here. */
    _callHandler(handler, event) {
        try {
            const result = handler(event);
            if (result && typeof result.then === 'function') {
                result.then(undefined, () => { });
            }
        }
        catch ( /* the app's error is the app's */_a) { /* the app's error is the app's */ }
    }
    get pushToken() { return this._pushToken; }
    set pushToken(value) {
        var _a;
        this._pushToken = value;
        if (value)
            (_a = this._queue) === null || _a === void 0 ? void 0 : _a.tokenSet();
    }
    get platform() { return this._platform; }
    set platform(value) { this._platform = value; }
    get provider() { return this._provider; }
    set provider(value) { this._provider = value; }
    /**
     * Registers listeners that automatically track open/received/dismissed events
     * and app_opened (influenced-open) events. Called automatically unless
     * `autoTrack: false`.
     *
     * Requires the notification payload to include `notificationId`:
     * ```json
     * { "notificationId": 42 }
     * ```
     */
    _setupAutoTracking() {
        // Track notification taps / opens (the same listener feeds onNotificationOpened)
        this._listenForTaps();
        // Track foreground delivery (#811)
        const unsubReceived = this._displayAdapter.onReceived((info) => {
            if (!info.notificationId)
                return;
            this.devices.trackReceived(info.notificationId);
        });
        this._trackingUnsubscribes.push(unsubReceived);
        // Track notification dismissals (#811)
        const unsubDismissed = this._displayAdapter.onDismissed((info) => {
            if (!info.notificationId)
                return;
            this._trackDismissedOnce(info.notificationId);
        });
        this._trackingUnsubscribes.push(unsubDismissed);
        // Track app foregrounding — drives influenced_open correlation (#811), and retries the offline queue
        this._listenForForeground();
    }
    /**
     * One listener of the app state. On the way to the foreground it reports `app_opened` (with autoTrack) and gives
     * the offline queue a chance to send what waits. AppState is lazy-required from react-native; it may be absent in
     * a web or test environment.
     */
    _listenForForeground() {
        var _a;
        try {
            const AppState = RNAppState;
            if (AppState === null || AppState === void 0 ? void 0 : AppState.addEventListener) {
                let prevState = (_a = AppState.currentState) !== null && _a !== void 0 ? _a : 'unknown';
                const subscription = AppState.addEventListener('change', (nextState) => {
                    var _a;
                    if (nextState === 'active' && prevState !== 'active') {
                        if (this._autoTrack)
                            this.devices.trackAppOpened();
                        if (this._queue)
                            void this._queue.flush('foreground');
                    }
                    else if (nextState !== 'active' && prevState === 'active') {
                        void ((_a = this._batcher) === null || _a === void 0 ? void 0 : _a.flush()); // the app is leaving: the reports that wait their delay go now
                    }
                    prevState = nextState;
                });
                // AppState.addEventListener returns a subscription object with .remove() in RN >= 0.65
                this._trackingUnsubscribes.push(() => { var _a; return (_a = subscription === null || subscription === void 0 ? void 0 : subscription.remove) === null || _a === void 0 ? void 0 : _a.call(subscription); });
            }
        }
        catch ( /* AppState unavailable — web/test env; best-effort */_b) { /* AppState unavailable — web/test env; best-effort */ }
    }
    /**
     * Removes all auto-tracking listeners. Call this when unmounting your root
     * component if you need to clean up (e.g., during hot reload in development).
     */
    destroy() {
        var _a;
        for (const unsub of this._trackingUnsubscribes) {
            try {
                unsub();
            }
            catch ( /* best-effort */_b) { /* best-effort */ }
        }
        this._trackingUnsubscribes = [];
        this._openedHandlers = [];
        this._pendingLaunchTap = null;
        this._responseListening = false;
        if (this._batcher) {
            void this._batcher.handOff();
            this._batcher.destroy();
        } // what waits its delay goes to the queue
        (_a = this._queue) === null || _a === void 0 ? void 0 : _a.destroy();
    }
    validateProjectId(id) {
        if (!id) {
            throw new Error("❌ projectId is required");
        }
        if (id.startsWith("sk_")) {
            throw new Error("❌ Security Alert: You are using a Secret Key (sk_...) in the client-side SDK.\n" +
                "This is a severe security risk! Please use your Project ID (pk_...) instead.\n" +
                "You can find your Project ID in the Dashboard > Project Settings.");
        }
        if (!id.startsWith("pk_")) {
            console.warn("⚠️ Warning: projectId should typically start with 'pk_'. Ensure you are using the correct identifier.");
        }
    }
    warnMissingOptionalDeps() {
        warnMissingOptionalDepsOnce();
    }
}
exports.PushClient = PushClient;
/** True once the missing-optional-packages warning was logged: it shows once per app run. @internal */
let _optionalDepsWarned = false;
/**
 * Logs ONE warning per app run when `expo-localization`, `expo-application` or `expo-device`
 * is missing, naming the packages and the fields the device registers without. Development
 * only (`__DEV__` is true; a production build, or a place without `__DEV__`, never logs it).
 * Never throws, whatever `console.warn` does.
 * @internal
 */
function warnMissingOptionalDepsOnce() {
    try {
        if (_optionalDepsWarned)
            return;
        if (typeof __DEV__ === "undefined" || __DEV__ !== true)
            return;
        if (process.env.NODE_ENV === "test")
            return;
        // If none of the expo-* packages are available, this is likely a bare React
        // Native environment — skip the warning entirely so we don't print an Expo
        // CLI command that would be wrong/confusing for non-Expo projects.
        const noExpoAtAll = !Notifications && !Localization && !Application && !Device;
        if (noExpoAtAll)
            return;
        const missing = [];
        if (!Localization)
            missing.push({ pkg: "expo-localization", provides: "locale, timezone" });
        if (!Application)
            missing.push({ pkg: "expo-application", provides: "app_version" });
        if (!Device)
            missing.push({ pkg: "expo-device", provides: "os_version" });
        if (missing.length === 0)
            return;
        _optionalDepsWarned = true;
        const pkgList = missing.map((m) => m.pkg).join(", ");
        const fieldList = missing.map((m) => m.provides).join(", ");
        const timeZoneNote = Localization
            ? ""
            : `\nWithout expo-localization the time zone of the device is not sent, so best-hour sending and ` +
                `quiet hours by time zone do not apply to this app.`;
        console.warn(`[espresso-notify] Some device metadata fields will be missing (${fieldList}).\n` +
            `Install the following optional packages to enable automatic collection:\n` +
            `  npx expo install ${missing.map((m) => m.pkg).join(" ")}\n` +
            `Missing: ${pkgList}` +
            timeZoneNote +
            `\n(This warning shows once per app run, in development only.)`);
    }
    catch ( /* a warning must never break the app */_a) { /* a warning must never break the app */ }
}
// ─── Certificate / Public-Key Pinning (#808) ──────────────────────────────────
/**
 * Extracts the hostname from a URL string.
 * Returns null if the URL is empty or unparseable, which is what the build placeholder is: a build that was not given
 * a URL has no host to pin. This function must not name the placeholder: the build step writes the URL into the
 * `API_URL` constant only, and fails when the placeholder is anywhere else (BUG-1).
 * @internal
 */
function _extractHost(url) {
    if (!url)
        return null;
    try {
        return new URL(url).hostname || null;
    }
    catch (_a) {
        return null;
    }
}
/**
 * Enables TLS public-key pinning for the given hostnames.
 *
 * With the native module of the SDK linked, the pins go to the module, which pins the requests it sends, and to
 * `react-native-ssl-public-key-pinning` too when that is installed. Without the module only the library is used:
 * it patches the global networking layer once, and all subsequent `fetch` calls (including those made by
 * FetchTransport) are pinned.
 *
 * @param options - Map of hostname → pinning config (publicKeyHashes + optional
 *   includeSubdomains). publicKeyHashes are base64 SHA-256 of the cert SPKI.
 * @returns `true` if pinning was enabled (with the module linked: if the module accepted the pins), `false` if the
 *   library is absent and there is no module, or the pins were refused or failed to start (never throws).
 *
 * @example
 * await enableCertificatePinning({
 *   'api.espressonotify.com': {
 *     includeSubdomains: true,
 *     publicKeyHashes: ['abc123...', 'def456...'],
 *   },
 * });
 */
function enableCertificatePinning(options) {
    return __awaiter(this, void 0, void 0, function* () {
        const native = (0, transport_1.inspectNativeModule)().module;
        if (native)
            return enableNativePins(native, options);
        // No usable native module: the library alone, as before.
        if (!(SslPinning === null || SslPinning === void 0 ? void 0 : SslPinning.initializeSslPinning)) {
            console.warn('[espresso-notify] react-native-ssl-public-key-pinning is not installed; ' +
                'certificate pinning is disabled. Install it to enable pinning.');
            return false;
        }
        try {
            yield SslPinning.initializeSslPinning(options);
            _libraryPinsActive = true;
            return true;
        }
        catch (_a) {
            warnPinningInitFailed();
            return false;
        }
    });
}
/** The one warning for every way pinning fails to start: a fixed message with a code, never the text of another package. @internal */
function warnPinningInitFailed() {
    console.warn('[espresso-notify] Certificate pinning initialization failed (PINNING_INIT_FAILED); pinning stays off.');
}
/**
 * The pin entries the native module takes, from the options of `enableCertificatePinning`; null when the options have no
 * host, or a host without a list of hashes made of non-empty strings. The module checks the hashes themselves.
 * @internal
 */
function nativePinEntries(options) {
    if (options === null || typeof options !== 'object' || Array.isArray(options))
        return null;
    const entries = [];
    for (const [host, config] of Object.entries(options)) {
        const hashes = config === null || config === void 0 ? void 0 : config.publicKeyHashes;
        if (!host || !Array.isArray(hashes) || hashes.length === 0 || !hashes.every((h) => typeof h === 'string' && h !== ''))
            return null;
        entries.push({ host, includeSubdomains: config.includeSubdomains === true, pins: [...hashes] });
    }
    return entries.length === 0 ? null : entries;
}
/**
 * Pins with the native module (it pins the calls it sends) and, when the library is installed, with the library too (it
 * pins the calls made through `fetch`). Resolves true only when the module accepted the pins; a library that fails
 * after that only warns. The module's `setPins` finishes before this resolves, so a call made after `await` is pinned.
 * @internal
 */
function enableNativePins(native, options) {
    return __awaiter(this, void 0, void 0, function* () {
        const entries = nativePinEntries(options);
        let accepted = false;
        if (entries) {
            try {
                accepted = (yield native.setPins(entries)) === true;
            }
            catch ( /* the text of a native error is never logged; the closed answer is false */_a) { /* the text of a native error is never logged; the closed answer is false */ }
        }
        if (!accepted) {
            warnPinningInitFailed();
            return false;
        }
        _nativePinsActive = true;
        if (SslPinning === null || SslPinning === void 0 ? void 0 : SslPinning.initializeSslPinning) {
            try {
                yield SslPinning.initializeSslPinning(options);
                _libraryPinsActive = true;
            }
            catch (_b) {
                warnPinningInitFailed();
            }
        }
        return true;
    });
}
/** True when the pins are active on the path the SDK takes by default: the native module's when it is usable, else the library's. @internal */
function _defaultPathPinned() {
    return (0, transport_1.inspectNativeModule)().module ? _nativePinsActive : _libraryPinsActive;
}
/**
 * Convenience wrapper that pins the Espresso Notify API hostname derived from
 * the build-injected `API_URL`.
 *
 * Returns `false` (with a warning) if `API_URL` is still the build placeholder
 * or is otherwise unparseable — this is safe to call
 * before the URL is substituted; pinning simply won't be active.
 *
 * @param publicKeyHashes - Base64 SHA-256 hashes of the cert Subject Public Key Info.
 * @param includeSubdomains - Whether to pin subdomains too (default: `true`).
 * @returns `true` if pinning was enabled successfully, `false` otherwise.
 */
function enableEspressoPinning(publicKeyHashes_1) {
    return __awaiter(this, arguments, void 0, function* (publicKeyHashes, includeSubdomains = true) {
        const host = _extractHost(API_URL);
        if (!host) {
            console.warn('[espresso-notify] enableEspressoPinning: API_URL is a placeholder or unparseable; ' +
                'certificate pinning is disabled.');
            return false;
        }
        return enableCertificatePinning({ [host]: { includeSubdomains, publicKeyHashes } });
    });
}
/**
 * Disables TLS public-key pinning: clears the pins of the native module, when it is linked, and disables
 * `react-native-ssl-public-key-pinning` (if installed). No-op when neither is there.
 */
function disableCertificatePinning() {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        const native = (0, transport_1.inspectNativeModule)().module;
        if (native) {
            try {
                yield native.clearPins();
            }
            catch ( /* the text of a native error is never logged; the pins are reported off below */_b) { /* the text of a native error is never logged; the pins are reported off below */ }
        }
        _nativePinsActive = false;
        yield ((_a = SslPinning === null || SslPinning === void 0 ? void 0 : SslPinning.disableSslPinning) === null || _a === void 0 ? void 0 : _a.call(SslPinning));
        _libraryPinsActive = false;
    });
}
/** The limits of POST /v1/preferences: items per call and bytes of a category identifier. @internal */
const MAX_PREFERENCE_ITEMS = 50;
const MAX_CATEGORY_IDENTIFIER_BYTES = 64;
/** The most bytes of serialized metadata the server accepts on register, identify and updateMetadata. @internal */
const MAX_METADATA_BYTES = 4096;
/** The shape of a business event name the server accepts (`customEventNamePattern`). @internal */
const CUSTOM_EVENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
/** The names of the delivery lifecycle: they need a notification and are not business events. @internal */
const RESERVED_EVENT_NAMES = new Set(['opened', 'clicked', 'received', 'dismissed', 'converted', 'app_opened']);
class Devices {
    constructor(_request, _getToken, _getPlatform, _getProvider, _deviceInfo, _displayAdapter, _signingSession = null, _attestationProvider = null, _queue = null, _batcher = null) {
        this._request = _request;
        this._getToken = _getToken;
        this._getPlatform = _getPlatform;
        this._getProvider = _getProvider;
        this._deviceInfo = _deviceInfo;
        this._displayAdapter = _displayAdapter;
        this._signingSession = _signingSession;
        this._attestationProvider = _attestationProvider;
        this._queue = _queue;
        this._batcher = _batcher;
        /** One-shot warn guard so attest() never spams logs on every boot. */
        this._attestWarned = false;
    }
    /**
     * Reports a delivery event (opened, clicked, received, dismissed). With the offline queue it goes through the batcher:
     * `opened` and `clicked` at once, `received` and `dismissed` after a random 0 to 30 s, many in one request (track-batch.ts).
     * Without it, one request now, as before. Never throws.
     */
    _reportDelivery(body) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this._batcher)
                return this._report("/v1/notifications/track", body);
            try {
                yield this._batcher.add(body);
            }
            catch (_a) {
                // best-effort, silent
            }
        });
    }
    /**
     * Reports an event to a route that takes a POST. With the offline queue, a failure that can pass keeps the event
     * for later; without it, the one attempt is made and the error is dropped. Never throws.
     * `withEventId`: the route deduplicates on an `event_id` (custom and lifecycle events), which the queue adds.
     */
    _report(path_1, body_1) {
        return __awaiter(this, arguments, void 0, function* (path, body, withEventId = false) {
            if (!this._queue) {
                try {
                    yield this._request(path, { method: 'POST', body: JSON.stringify(body) });
                }
                catch (_a) {
                    // best-effort, silent
                }
                return;
            }
            try {
                yield this._queue.send(path, body, withEventId);
            }
            catch (_b) {
                // best-effort, silent
            }
        });
    }
    /**
     * Registers a device token with the CMS.
     * Call this when your app starts or when the token changes.
     */
    register(data) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            const pushToken = data.pushToken || this._getToken();
            const platform = data.platform || this._getPlatform();
            if (!pushToken || !platform) {
                throw new Error("❌ Validation Error: 'pushToken' and 'platform' are required either in the constructor or in the register method.");
            }
            if (data.user) {
                if (!data.user.name || !data.user.externalId) {
                    throw new Error("❌ Validation Error: Both 'name' and 'externalId' must be provided in the user object.");
                }
            }
            // Auto-collect device metadata and merge with developer-provided values.
            // Developer-provided values take precedence (spread last).
            const { meta: deviceMeta, appVersion: autoAppVersion, osVersion: autoOsVersion } = this._deviceInfo.collect();
            const finalMetadata = Object.keys(deviceMeta).length > 0 || data.metadata
                ? Object.assign(Object.assign({}, deviceMeta), data.metadata) : undefined;
            const resolvedProvider = data.provider || this._getProvider();
            const payload = {
                pushToken,
                platform,
                device_id: data.deviceId,
                app_version: (_a = data.appVersion) !== null && _a !== void 0 ? _a : autoAppVersion,
                os_version: (_b = data.osVersion) !== null && _b !== void 0 ? _b : autoOsVersion,
                metadata: finalMetadata,
                user: data.user
                    ? {
                        name: data.user.name,
                        external_id: data.user.externalId,
                    }
                    : undefined,
            };
            // Only include provider when it's a non-empty value (preserves backward compat
            // for backends that were registered before the field existed).
            if (resolvedProvider) {
                payload.provider = resolvedProvider;
            }
            // The proof that this identifier belongs to whoever is calling: only when the app has it.
            if ((_c = data.user) === null || _c === void 0 ? void 0 : _c.identityHash) {
                payload.identity_hash = data.user.identityHash;
            }
            // Include signing fields when signing is enabled (#813).
            // Initialise the session so the key is ready before the register POST goes out.
            if (this._signingSession) {
                try {
                    yield this._signingSession.ensureInitialized();
                    const signingDeviceId = this._signingSession.deviceId;
                    const signingPublicKey = this._signingSession.publicKey;
                    if (signingDeviceId && signingPublicKey) {
                        // device_id from signing overrides any caller-supplied value
                        payload.device_id = signingDeviceId;
                        payload.signing_public_key = signingPublicKey;
                        payload.signing_key_type = 'ecdsa_p256';
                    }
                }
                catch (_d) {
                    // best-effort: if key generation fails, proceed without signing fields
                }
            }
            try {
                const result = yield this._request("/v1/devices/register", {
                    method: "POST",
                    body: JSON.stringify(payload),
                });
                if (data.user)
                    this._externalId = data.user.externalId;
                return result;
            }
            catch (error) {
                throw _operationError('register', error);
            }
        });
    }
    /**
     * Identifies a user for the current device.
     * Call this after the user logs in.
     */
    identify(user, pushToken) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const token = pushToken || this._getToken();
            if (!token) {
                throw new Error("❌ Validation Error: 'pushToken' is required either in the constructor or in the identify method.");
            }
            // The server refuses user metadata over 4096 bytes (400 metadata_too_large); say so before the call.
            if (user.metadata !== undefined) {
                const size = _toUtf8Bytes((_a = JSON.stringify(user.metadata)) !== null && _a !== void 0 ? _a : '').length;
                if (size > MAX_METADATA_BYTES) {
                    throw new errors_1.EspressoNotifyError('METADATA_TOO_LARGE', `[espresso-notify] identify: the user metadata is ${size} bytes serialized; the limit is ${MAX_METADATA_BYTES}. Nothing was sent.`);
                }
            }
            const payload = {
                pushToken: token,
                user: {
                    external_id: user.externalId,
                    name: user.name,
                    metadata: user.metadata,
                },
            };
            if (user.identityHash) {
                payload.identity_hash = user.identityHash;
            }
            try {
                const result = yield this._request("/v1/devices/identify", {
                    method: "POST",
                    body: JSON.stringify(payload),
                });
                this._externalId = user.externalId;
                return result;
            }
            catch (error) {
                throw _operationError('identify', error);
            }
        });
    }
    /**
     * Moves the device to anonymous state (user_id = NULL).
     * Call this when the user logs out.
     *
     * The token is NOT deleted — the device continues receiving broadcast
     * notifications. Personalized sends (by user_id / external_id) are excluded
     * until `identify()` is called again on the next login.
     *
     * @example
     * // Logout
     * await push.devices.unregister();
     *
     * // Next login — no need to call register() again
     * await push.devices.identify({ externalId: user.id, name: user.name });
     */
    unregister(pushToken) {
        return __awaiter(this, void 0, void 0, function* () {
            const token = pushToken || this._getToken();
            if (!token) {
                throw new Error("❌ Validation Error: 'pushToken' is required either in the constructor or in the unregister method.");
            }
            try {
                const result = yield this._request("/v1/devices/unregister", {
                    method: "POST",
                    body: JSON.stringify({ pushToken: token }),
                });
                this._externalId = undefined;
                return result;
            }
            catch (error) {
                throw _operationError('unregister', error);
            }
        });
    }
    /**
     * Tracks when a user opens a push notification.
     * Call this inside your Expo `addNotificationResponseReceivedListener`.
     * Silent — never throws errors.
     *
     * @example
     * Notifications.addNotificationResponseReceivedListener(response => {
     *   const notifId = response.notification.request.content.data?.notificationId;
     *   if (notifId) push.devices.trackOpen(notifId);
     * });
     */
    trackOpen(notificationId, pushToken) {
        return __awaiter(this, void 0, void 0, function* () {
            const token = pushToken || this._getToken();
            if (!token || !notificationId)
                return;
            yield this._reportDelivery({
                notification_id: Number(notificationId),
                event: "opened",
                push_token: token,
            });
        });
    }
    /**
     * Tracks when a notification is delivered/displayed while the app is in
     * the foreground. Silent — never throws errors. (#811)
     *
     * With the offline queue on, the report waits a random 0 to 30 s, so a crowd of devices does not report in the same
     * second, and goes in one request with the other waiting delivery reports (at most 20 each). The app leaving the
     * foreground, `flush()` and `destroy()` do not wait for it.
     */
    trackReceived(notificationId, pushToken) {
        return __awaiter(this, void 0, void 0, function* () {
            const token = pushToken || this._getToken();
            if (!token || !notificationId)
                return;
            yield this._reportDelivery({
                notification_id: Number(notificationId),
                event: "received",
                push_token: token,
            });
        });
    }
    /**
     * Tracks when a user dismisses/swipes away a push notification.
     * Silent — never throws errors. (#811)
     *
     * Waits a random 0 to 30 s and is batched like `trackReceived`, with the offline queue on.
     */
    trackDismissed(notificationId, pushToken) {
        return __awaiter(this, void 0, void 0, function* () {
            const token = pushToken || this._getToken();
            if (!token || !notificationId)
                return;
            yield this._reportDelivery({
                notification_id: Number(notificationId),
                event: "dismissed",
                push_token: token,
            });
        });
    }
    /**
     * Tracks when the app is brought to the foreground (app_opened event).
     * Used by the backend to correlate influenced opens — no notification_id
     * is required; the backend matches by push_token + recent sends.
     * Silent — never throws errors. (#811)
     */
    trackAppOpened(pushToken) {
        return __awaiter(this, void 0, void 0, function* () {
            const token = pushToken || this._getToken();
            if (!token)
                return;
            try {
                yield this._request("/v1/notifications/track", {
                    method: "POST",
                    body: JSON.stringify({
                        notification_id: 0,
                        event: "app_opened",
                        push_token: token,
                    }),
                });
            }
            catch (_a) {
                // best-effort, silent
            }
        });
    }
    /**
     * Records a device lifecycle event (permission change, token rotation, identity change).
     * Silent — never throws errors. (#807)
     *
     * @param kind    - Event category: 'permission' | 'subscription' | 'identity'
     * @param from    - Previous state value
     * @param to      - New state value
     * @param externalId - User external ID (optional)
     * @param pushToken  - Override push token (optional; falls back to constructor token)
     */
    recordLifecycle(kind, from, to, externalId, pushToken) {
        return __awaiter(this, void 0, void 0, function* () {
            const token = pushToken || this._getToken();
            if (!token)
                return;
            yield this._report('/v1/devices/lifecycle', { push_token: token, kind, from, to, external_id: externalId }, true);
        });
    }
    /**
     * Tracks when a user clicks an action button in a push notification.
     * Call this when handling a specific notification action.
     * Silent — never throws errors.
     *
     * @example
     * Notifications.addNotificationResponseReceivedListener(response => {
     *   const notifId = response.notification.request.content.data?.notificationId;
     *   if (notifId && response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
     *     push.devices.trackClick(notifId);
     *   }
     * });
     */
    trackClick(notificationId, pushToken) {
        return __awaiter(this, void 0, void 0, function* () {
            const token = pushToken || this._getToken();
            if (!token || !notificationId)
                return;
            yield this._reportDelivery({
                notification_id: Number(notificationId),
                event: "clicked",
                push_token: token,
            });
        });
    }
    /**
     * Reports a business event of your app ("signed_up", "order.completed") to
     * Espresso Notify. It drives journeys (event triggers, waits and goals) and is
     * never counted on a notification. The name is 1 to 64 letters, digits, `_`,
     * `.`, `:` or `-`, starting with a letter or a digit; the six names of the
     * delivery lifecycle (opened, clicked, received, dismissed, converted,
     * app_opened) are refused. An invalid name sends nothing and logs a warning.
     * Silent — never throws errors, like the other track methods.
     *
     * @example
     * await push.devices.trackEvent('order.completed')
     */
    trackEvent(name, pushToken) {
        return __awaiter(this, void 0, void 0, function* () {
            if (typeof name !== 'string' || !CUSTOM_EVENT_NAME.test(name) || RESERVED_EVENT_NAMES.has(name)) {
                console.warn('[espresso-notify] trackEvent: the name passed is not a valid event name and was not sent. ' +
                    'Use 1 to 64 letters, digits, "_", ".", ":" or "-", starting with a letter or a digit, ' +
                    'and not one of opened, clicked, received, dismissed, converted or app_opened.');
                return;
            }
            const token = pushToken || this._getToken();
            if (!token)
                return;
            yield this._report("/v1/notifications/track", { event: name, push_token: token }, true);
        });
    }
    /**
     * Reports that the user did what a notification was sent for (bought, signed
     * up): the `converted` event, which adds to the conversion count of that
     * notification. It carries no amount: revenue is reported from your server
     * with the secret key, on `POST /v1/conversions`, because a secret key never
     * goes into an app. A value that is no numeric notification id is not sent (warning). Silent — never throws.
     */
    trackConversion(notificationId, pushToken) {
        return __awaiter(this, void 0, void 0, function* () {
            const token = pushToken || this._getToken(), id = conversionNotificationId(notificationId);
            if (!token || id === null)
                return;
            yield this._report("/v1/notifications/track", {
                notification_id: id,
                event: "converted",
                push_token: token,
            });
        });
    }
    /**
     * Erases this device and its data from Espresso Notify: the push token, the
     * events and delivery records of the device, its signing key, and the user
     * (external id and name) when no other device of the user is left. It is the
     * call behind a "delete my data" button (LGPD, GDPR). It cannot be undone.
     *
     * Sends the push token of the client (or `pushToken`), plus `deviceId` and
     * `identityHash` when you pass them. When the project asks for the proof of
     * identity, `identityHash` is the HMAC of the external id of the user of the
     * device, computed by your backend. Throws on any answer that is not 2xx
     * (`EspressoNotifyHttpError`, with `status` and `code`), including 404
     * `not_found` when nothing matched, and without a token or a `deviceId`.
     *
     * After it succeeds the client forgets the user, and the device is unknown to
     * the server: stop calling the client, or call `register` again for a new
     * device.
     *
     * @example
     * await push.devices.forgetDevice({ identityHash: await myBackend.identityHash(userId) })
     */
    forgetDevice() {
        return __awaiter(this, arguments, void 0, function* (options = {}) {
            const token = options.pushToken || this._getToken();
            if (!token && !options.deviceId) {
                throw new Error("❌ Validation Error: 'pushToken' (in the constructor or in the options) or 'deviceId' is required in forgetDevice.");
            }
            const payload = {};
            if (token)
                payload.push_token = token;
            if (options.deviceId)
                payload.device_id = options.deviceId;
            if (options.identityHash)
                payload.identity_hash = options.identityHash;
            try {
                yield this._request("/v1/devices", {
                    method: "DELETE",
                    body: JSON.stringify(payload),
                });
            }
            catch (error) {
                throw _operationError('forgetDevice', error);
            }
            this._externalId = undefined;
        });
    }
    /**
     * Reads the notification preferences of the user of this device: for each
     * category the user opted out of (or back into), `{ categoryIdentifier, optedOut }`.
     * The server only answers for a device that is linked to that user, so the
     * device must have been identified (or registered with a user) first.
     *
     * `externalId` is optional: without it the call uses the one of the last
     * successful `identify` or `register` of this client. Throws when there is no
     * external id or no push token, and when the call fails.
     *
     * @example
     * const prefs = await push.devices.getPreferences()
     * const muted = prefs.filter((p) => p.optedOut).map((p) => p.categoryIdentifier)
     */
    getPreferences(externalId, pushToken) {
        return __awaiter(this, void 0, void 0, function* () {
            const { id, token } = this._preferencesTarget('getPreferences', externalId, pushToken);
            try {
                // A POST with the two values in the body: they never go in a URL, which proxies and logs keep.
                const result = yield this._request('/v1/preferences/query', {
                    method: 'POST',
                    body: JSON.stringify({ external_id: id, push_token: token }),
                });
                if (!Array.isArray(result))
                    return [];
                return result.map((p) => {
                    var _a;
                    return ({
                        categoryIdentifier: String((_a = p === null || p === void 0 ? void 0 : p.category_identifier) !== null && _a !== void 0 ? _a : ''),
                        optedOut: (p === null || p === void 0 ? void 0 : p.opted_out) === true,
                    });
                });
            }
            catch (error) {
                throw _operationError('getPreferences', error);
            }
        });
    }
    /**
     * Writes the notification preferences of the user of this device: a category
     * with `optedOut: true` stops receiving sends of that category, and `false`
     * puts the user back in it. Up to 50 preferences per call, each identifier 1 to
     * 64 bytes; anything else throws before the call. Resolves with `{ updated }`,
     * the number of preferences written.
     *
     * `externalId` works as in `getPreferences`.
     *
     * @example
     * await push.devices.setPreferences([{ categoryIdentifier: 'promotions', optedOut: true }])
     */
    setPreferences(preferences, externalId, pushToken) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!Array.isArray(preferences) || preferences.length === 0 || preferences.length > MAX_PREFERENCE_ITEMS) {
                throw new Error(`❌ Validation Error: 'preferences' must have 1 to ${MAX_PREFERENCE_ITEMS} items.`);
            }
            for (const p of preferences) {
                const identifier = typeof (p === null || p === void 0 ? void 0 : p.categoryIdentifier) === 'string' ? p.categoryIdentifier : '';
                if (identifier.trim() === '' ||
                    _toUtf8Bytes(identifier).length > MAX_CATEGORY_IDENTIFIER_BYTES ||
                    typeof p.optedOut !== 'boolean') {
                    throw new Error(`❌ Validation Error: each preference needs a 'categoryIdentifier' of 1 to ${MAX_CATEGORY_IDENTIFIER_BYTES} bytes and a boolean 'optedOut'.`);
                }
            }
            const { id, token } = this._preferencesTarget('setPreferences', externalId, pushToken);
            try {
                const result = (yield this._request('/v1/preferences', {
                    method: 'POST',
                    body: JSON.stringify({
                        external_id: id,
                        push_token: token,
                        preferences: preferences.map((p) => ({
                            category_identifier: p.categoryIdentifier,
                            opted_out: p.optedOut,
                        })),
                    }),
                }));
                return { updated: typeof (result === null || result === void 0 ? void 0 : result.updated) === 'number' ? result.updated : preferences.length };
            }
            catch (error) {
                throw _operationError('setPreferences', error);
            }
        });
    }
    /** The external id and the token a preferences call is for; throws when either is missing. @internal */
    _preferencesTarget(operation, externalId, pushToken) {
        const id = externalId || this._externalId;
        if (!id) {
            throw new Error(`❌ Validation Error: 'externalId' is required in ${operation}, or identify the device first so the client knows it.`);
        }
        const token = pushToken || this._getToken();
        if (!token) {
            throw new Error(`❌ Validation Error: 'pushToken' is required either in the constructor or in the ${operation} method.`);
        }
        return { id, token };
    }
    /**
     * Fetches notification categories from the CMS and registers them on the
     * device using the DisplayAdapter (Expo's setNotificationCategoryAsync by default).
     * Call this once during app initialization, after register().
     * Silent — never throws errors to avoid breaking app boot.
     *
     * @example
     * await push.devices.registerCategories();
     */
    registerCategories() {
        return __awaiter(this, void 0, void 0, function* () {
            // Skip the network call entirely when the environment can't register
            // categories (no expo-notifications / bare RN without a display adapter).
            if (!this._displayAdapter.supportsCategories())
                return;
            try {
                const categories = (yield this._request("/v1/notifications/categories"));
                yield this._displayAdapter.setCategories(categories);
            }
            catch (_a) {
                // best-effort, silent — never breaks app boot
            }
        });
    }
    /**
     * Run the device attestation flow (#814): challenge → native attest → verify.
     *
     * FLAGS the existing per-install signing key (#813) as attested on the backend
     * (register-first; it does NOT replace the signing key). On iOS this uses Apple
     * App Attest; on Android it uses Play Integrity via Firebase App Check.
     *
     * SILENT best-effort — mirrors `registerCategories()`: it NEVER throws, so it
     * is safe to call during app boot. Any failure (no signing session, no/absent
     * provider, unsupported device, native error, network error) resolves to
     * `{ attested: false }` and at most logs one warning per client instance.
     *
     * @returns `{ attested, environment? }` — `attested:false` on any failure.
     *
     * @example
     * // Requires `enableSigning: true` and `enableAttestation: true`.
     * await push.devices.register({ pushToken, platform });
     * await push.devices.attest();
     */
    attest() {
        return __awaiter(this, void 0, void 0, function* () {
            // Guard 1: attestation needs the signing session's persisted device_id and a
            // supported provider. Warn at most once; never throw.
            const provider = this._attestationProvider;
            if (!this._signingSession || !provider) {
                return { attested: false, reason: 'attestation_disabled' };
            }
            let supported = false;
            try {
                supported = yield provider.isSupported();
            }
            catch (_a) {
                supported = false;
            }
            if (!supported) {
                if (!this._attestWarned) {
                    this._attestWarned = true;
                    console.warn('[espresso-notify] device attestation is not supported on this device/platform; ' +
                        'skipping attest(). Ensure the native attestation module is installed.');
                }
                return { attested: false, reason: 'unsupported' };
            }
            // Guard 2: resolve the persisted per-install device_id (bound by the backend).
            let deviceId = null;
            try {
                yield this._signingSession.ensureInitialized();
                deviceId = this._signingSession.deviceId;
            }
            catch (_b) {
                deviceId = null;
            }
            if (!deviceId) {
                return { attested: false, reason: 'no_device_id' };
            }
            // challenge → native attest → verify. Any failure is swallowed.
            try {
                const challengeResp = (yield this._request('/v1/attest/challenge', {
                    method: 'POST',
                    body: JSON.stringify({ device_id: deviceId }),
                }));
                const challenge = challengeResp === null || challengeResp === void 0 ? void 0 : challengeResp.challenge;
                if (!challenge) {
                    return { attested: false, reason: 'no_challenge' };
                }
                const att = yield provider.attest(challenge);
                const verifyResp = (yield this._request('/v1/attest/verify', {
                    method: 'POST',
                    body: JSON.stringify({
                        device_id: deviceId,
                        provider: att.provider,
                        key_id: att.keyId,
                        attestation: att.attestation,
                        app_check_token: att.appCheckToken,
                        challenge,
                    }),
                }));
                return {
                    attested: !!(verifyResp === null || verifyResp === void 0 ? void 0 : verifyResp.attested),
                    environment: verifyResp === null || verifyResp === void 0 ? void 0 : verifyResp.environment,
                };
            }
            catch (_c) {
                // A fixed message with a code: the text of the provider's or the request's error is never logged.
                console.warn('[espresso-notify] device attestation failed (ATTESTATION_FAILED); the device is reported as not attested.');
                return { attested: false, reason: 'error' };
            }
        });
    }
    /**
     * Updates user metadata (tags, preferences, etc).
     */
    updateMetadata(metadata, pushToken) {
        return __awaiter(this, void 0, void 0, function* () {
            const token = pushToken || this._getToken();
            if (!token) {
                throw new Error("❌ Validation Error: 'pushToken' is required either in the constructor or in the updateMetadata method.");
            }
            try {
                return yield this._request("/v1/devices/metadata", {
                    method: "PUT",
                    body: JSON.stringify({
                        push_token: token,
                        metadata,
                    }),
                });
            }
            catch (error) {
                throw _operationError('updateMetadata', error);
            }
        });
    }
}
exports.Devices = Devices;
let _signingUnavailableWarned = false;
/** One warning per process when `enableSigning` is on and `react-native-secure-sign` is missing. */
function _warnSigningUnavailable() {
    if (_signingUnavailableWarned)
        return;
    _signingUnavailableWarned = true;
    console.warn('[espresso-notify] enableSigning is on but react-native-secure-sign is not available; ' +
        'requests are sent unsigned. Install react-native-secure-sign to sign them.');
}
/**
 * The error message for "no push provider": `resolvePushProvider()` found neither `expo-notifications`
 * nor `@react-native-firebase/messaging`.
 *
 * In Expo mode the app has `expo-constants` (or another Expo module the SDK reads) and no Firebase
 * messaging: `expo-notifications` is required there. It stays an optional peer so that React Native CLI
 * apps do not get Expo modules installed, so the requirement is checked here, when the hook runs.
 * @internal
 */
function describeMissingPushProvider() {
    const expoMode = !!(ExpoConstants || Localization || Application || Device) && !FirebaseMessaging && firebaseLoadError === null;
    if (expoMode) {
        return ('[espresso-notify] `expo-notifications` is not installed, and it is required in an Expo app: ' +
            'it asks for the permission and returns the push token. Run `npx expo install expo-notifications` and rebuild the app.');
    }
    return ('[espresso-notify] No push provider found. In an Expo app run `npx expo install expo-notifications`. ' +
        'In a React Native CLI app install `@react-native-firebase/messaging` (see the requirements page of the docs).' + _firebaseLoadHint());
}
/**
 * The numeric id of the notification that `trackConversion` sends: a positive integer, or the digits of one in a string
 * (digits only: no space, sign, exponent or hexadecimal, which `Number` would read as another id).
 * Nothing at all (0, "", missing) answers null in silence, as before. Any other value answers null with a warning, because
 * `Number("abc")` would have sent `null` and the server refuses that with a 400 that nobody sees.
 * @internal
 */
function conversionNotificationId(value) {
    if (!value && !Number.isNaN(value))
        return null;
    const id = typeof value === "string" ? (/^\d+$/.test(value) ? Number(value) : NaN) : value;
    if (typeof id === "number" && Number.isSafeInteger(id) && id >= 1)
        return id;
    console.warn('[espresso-notify] trackConversion: the value passed is not a notification id and was not sent. ' +
        'Pass the numeric id of the notification (a positive integer, or digits in a string).');
    return null;
}
/**
 * The first line of the error when `@react-native-firebase/messaging` IS installed but its require threw (a dependency of
 * it is missing, or its own code failed); null when it simply is not installed, as in every Expo app. That app is not an
 * Expo app that lacks Firebase, so the "no push provider" message says so (G5 of the verification of expo-setup-simpler).
 * The wording of "not installed" differs between Node, Metro and bundlers, hence the three shapes.
 */
function _firebaseLoadError(err) {
    const name = "@react-native-firebase/messaging";
    const message = String(err && err.message ? err.message : err);
    const says = (err && err.code === "MODULE_NOT_FOUND") || /cannot find module|unable to resolve|unknown module/i.test(message);
    if (says) {
        // a module named in the message that is not messaging means messaging is there and a dependency of it is not
        const quoted = message.match(/['"]([^'"]+)['"]/);
        const unresolved = message.match(/unable to resolve module\s+(\S+)/i);
        if (quoted ? quoted[1] === name : !unresolved || unresolved[1] === name)
            return null;
    }
    return message.split("\n")[0];
}
/** The sentence that tells an app why Firebase messaging, which it has installed, did not load; empty when it did, or is absent. */
function _firebaseLoadHint() {
    return firebaseLoadError === null ? '' : ` \`@react-native-firebase/messaging\` is installed but did not load: ${firebaseLoadError}`;
}
// ─── Push data of a tap: the shapes of the libraries (kept at the end of the file) ───────────────────────
/** True for a plain object (not null, not an array). @internal */
function _isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
/** The object a value carries: the object itself, or the object a JSON string holds; undefined for anything else. @internal */
function _objectOf(value) {
    if (_isPlainObject(value))
        return value;
    if (typeof value !== 'string')
        return undefined;
    const text = value.trim();
    if (text.charAt(0) !== '{')
        return undefined;
    try {
        const parsed = JSON.parse(text);
        return _isPlainObject(parsed) ? parsed : undefined;
    }
    catch (_a) {
        return undefined;
    }
}
/**
 * The data of a push as an object; `{}` when the library gave none. One place for the live taps and the tap that
 * launched the app. The Expo push service sends the data of the push as one JSON object in the `body` key (Android
 * extras, `dataString` of expo-notifications) or the APNs `body` key (iOS), and expo-notifications normally unwraps
 * it; when a copy still carries it (`data.body`, `data.dataString`, or the `dataString` of the content), its keys are
 * merged in. A key that is already at the top level wins. @internal
 */
function _unwrapPushData(raw, dataString) {
    const base = _isPlainObject(raw) ? raw : {};
    const wrapped = [_objectOf(base.body), _objectOf(base.dataString), _objectOf(dataString)];
    if (wrapped.every((w) => w === undefined))
        return base;
    const out = Object.assign({}, base);
    for (const inner of wrapped) {
        if (!inner)
            continue;
        for (const key of Object.keys(inner))
            if (!(key in out))
                out[key] = inner[key];
    }
    return out;
}
/** The push data of an expo-notifications content (`data`, with `dataString` as a fallback). @internal */
function _expoContentData(content) {
    return _pushData(content === null || content === void 0 ? void 0 : content.data, content === null || content === void 0 ? void 0 : content.dataString);
}
/**
 * True for a response that no push produced: no request identifier and no notification id in the data. Android builds
 * a "response" from the extras of ANY launch intent (expo-notifications before SDK 57 does not check that the intent
 * came from FCM), so a launch from the icon on some devices gives `{ id: null, data: { start_reason: 3, ... } }`.
 * @internal
 */
function _isLauncherOnlyResponse(response) {
    var _a, _b, _c, _d;
    const id = (_b = (_a = response === null || response === void 0 ? void 0 : response.notification) === null || _a === void 0 ? void 0 : _a.request) === null || _b === void 0 ? void 0 : _b.identifier;
    const hasIdentifier = (typeof id === 'string' && id !== '') || typeof id === 'number';
    return !hasIdentifier && _idOfData(_expoContentData((_d = (_c = response === null || response === void 0 ? void 0 : response.notification) === null || _c === void 0 ? void 0 : _c.request) === null || _d === void 0 ? void 0 : _d.content)) === undefined;
}
/**
 * The last response of expo-notifications. `getLastNotificationResponseAsync` is deprecated in later releases in
 * favour of the synchronous `getLastNotificationResponse`: ask for whichever the installed one has. @internal
 */
function _lastExpoResponse() {
    var _a;
    const read = (_a = Notifications === null || Notifications === void 0 ? void 0 : Notifications.getLastNotificationResponseAsync) !== null && _a !== void 0 ? _a : Notifications === null || Notifications === void 0 ? void 0 : Notifications.getLastNotificationResponse;
    return typeof read === 'function' ? read.call(Notifications) : undefined;
}
// ─── Images in a push with the app open (kept at the end of the file: no cited line of this file moves) ─────────
const image_push_1 = require("./image-push");
const retry_1 = require("./retry");
const registration_1 = require("./registration");
const track_batch_1 = require("./track-batch");
const random_1 = require("./random");
var image_push_2 = require("./image-push");
Object.defineProperty(exports, "createNotificationHandler", { enumerable: true, get: function () { return image_push_2.createNotificationHandler; } });
Object.defineProperty(exports, "handleImagePushBackgroundEvent", { enumerable: true, get: function () { return image_push_2.handleImagePushBackgroundEvent; } });
Object.defineProperty(exports, "handleImagePushInitialNotification", { enumerable: true, get: function () { return image_push_2.handleImagePushInitialNotification; } });
Object.defineProperty(exports, "getForeignInitialNotification", { enumerable: true, get: function () { return image_push_2.getForeignInitialNotification; } });
