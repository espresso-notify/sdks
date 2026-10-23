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
Object.defineProperty(exports, "__esModule", { value: true });
exports.hexToBytes = hexToBytes;
exports.secureRandomBytes = secureRandomBytes;
exports.randomHex = randomHex;
/**
 * The random bytes behind the device id and the nonce of a signed request (sdk-secure-device-id).
 *
 * Hermes has no `crypto.getRandomValues`, so the SDK takes the bytes from the first source the app has, in this order:
 *   1. `crypto.getRandomValues`, when the app (or a polyfill such as `react-native-get-random-values`) defines it;
 *   2. the `randomBytes` of the SDK's own native module (`SecureRandom` on Android, `SecRandomCopyBytes` on iOS);
 *   3. `expo-crypto`;
 *   4. `Math.random`, with one warning per app run (reduced entropy), only when none of the above exists.
 *
 * A source that throws, rejects or answers the wrong size hands over to the next one, so a wrong answer never becomes an
 * id. Nothing here logs a value: the one warning has a fixed text.
 *
 * This file imports nothing from `index.ts`; `index.ts` imports it.
 */
const transport_1 = require("./transport");
/**
 * `expo-crypto`, looked up once when the package loads, inside a `try` and at the top level: Metro gives a `require` of
 * an uninstalled optional peer a module id with no module behind it, and only a `require` that runs while the bundle
 * loads (inside a `try`) lets the SDK see the error. `optional-peers-load.test.ts` holds that rule.
 */
let OptExpoCrypto = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    OptExpoCrypto = require('expo-crypto');
}
catch ( /* not installed */_a) { /* not installed */ }
/** Lowercase hex digits, two per byte. */
const bytesToHex = (bytes) => {
    let out = '';
    for (let i = 0; i < bytes.length; i++)
        out += bytes[i].toString(16).padStart(2, '0');
    return out;
};
/**
 * `hex` as bytes, or null unless it is exactly `byteLen` bytes of lowercase hex.
 * @internal
 */
function hexToBytes(hex, byteLen) {
    if (typeof hex !== 'string' || hex.length !== byteLen * 2 || !/^[0-9a-f]+$/.test(hex))
        return null;
    const bytes = new Uint8Array(byteLen);
    for (let i = 0; i < byteLen; i++)
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
}
/**
 * `byteLen` bytes from a secure source, or null when there is none. Never throws.
 * @internal
 */
function secureRandomBytes(byteLen) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
                const bytes = new Uint8Array(byteLen);
                crypto.getRandomValues(bytes);
                return bytes;
            }
        }
        catch ( /* the next source */_a) { /* the next source */ }
        try {
            const native = (0, transport_1.resolveNativeModule)();
            if (native && typeof native.randomBytes === 'function') {
                const bytes = hexToBytes(yield native.randomBytes(byteLen), byteLen);
                if (bytes)
                    return bytes;
            }
        }
        catch ( /* the next source */_b) { /* the next source */ }
        try {
            const expoCrypto = OptExpoCrypto;
            const raw = typeof (expoCrypto === null || expoCrypto === void 0 ? void 0 : expoCrypto.getRandomBytesAsync) === 'function' ? yield expoCrypto.getRandomBytesAsync(byteLen)
                : typeof (expoCrypto === null || expoCrypto === void 0 ? void 0 : expoCrypto.getRandomBytes) === 'function' ? expoCrypto.getRandomBytes(byteLen)
                    : null;
            if (raw && raw.length === byteLen) {
                const bytes = Uint8Array.from(raw);
                if (bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255))
                    return bytes;
            }
        }
        catch ( /* no secure source */_c) { /* no secure source */ }
        return null;
    });
}
/** True once the `Math.random` warning has shown in this app run. */
let weakRandomWarned = false;
/**
 * A random hex string of `byteLen` bytes, from a secure source when the app has one, else from `Math.random` with one
 * warning per app run (none under test).
 * @internal
 */
function randomHex(byteLen) {
    return __awaiter(this, void 0, void 0, function* () {
        const secure = yield secureRandomBytes(byteLen);
        if (secure)
            return bytesToHex(secure);
        if (!weakRandomWarned && process.env.NODE_ENV !== 'test') {
            weakRandomWarned = true;
            console.warn('[espresso-notify] crypto.getRandomValues is not available and no secure random source was found ' +
                '(the native module, expo-crypto); device ID generated with Math.random (reduced entropy).');
        }
        const bytes = new Uint8Array(byteLen);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = Math.floor(Math.random() * 256);
        }
        return bytesToHex(bytes);
    });
}
