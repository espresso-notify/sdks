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
exports.NativeTransport = exports.NATIVE_TIMEOUT_MS = exports.SUPPORTED_CONTRACTS = void 0;
exports.redactPath = redactPath;
exports.parseRetryAfter = parseRetryAfter;
exports.buildHttpError = buildHttpError;
exports.parseJsonBody = parseJsonBody;
exports.inspectNativeModule = inspectNativeModule;
exports.resolveNativeModule = resolveNativeModule;
/**
 * The helpers that both transports of the SDK share, so a request built through `fetch` and one sent through the
 * native module end in the same results and the same errors (sdk-private-transport, SPT-11 to SPT-14, SPT-51).
 *
 * This file imports nothing from `index.ts`: the transports sit above it, the helpers below.
 */
const errors_1 = require("./errors");
/**
 * The request path up to the first `?` or `#`: an identifier that a caller or a proxy put in a query string
 * never reaches an error message or the `path` of an error.
 * @internal
 */
function redactPath(path) {
    const end = path.search(/[?#]/);
    return end === -1 ? path : path.slice(0, end);
}
/**
 * The seconds a `Retry-After` header asks to wait, as whole seconds: a number of seconds, or an HTTP date turned into
 * the seconds until it. Undefined when the answer has no header or a value that is neither. Never throws.
 * @internal
 */
function parseRetryAfter(raw) {
    try {
        if (typeof raw !== 'string')
            return undefined;
        const value = raw.trim();
        if (/^\d{1,9}$/.test(value))
            return Number(value);
        if (/[A-Za-z]/.test(value)) {
            const when = Date.parse(value);
            if (Number.isFinite(when))
                return Math.max(0, Math.ceil((when - Date.now()) / 1000));
        }
    }
    catch ( /* an unusable header is no header */_a) { /* an unusable header is no header */ }
    return undefined;
}
/**
 * The `code` (else the `error`) of a JSON error body, or undefined when the body is empty, is not JSON or has neither.
 * Never throws.
 */
function readErrorCode(bodyText) {
    var _a;
    try {
        const body = JSON.parse(bodyText);
        const code = (_a = body === null || body === void 0 ? void 0 : body.code) !== null && _a !== void 0 ? _a : body === null || body === void 0 ? void 0 : body.error;
        return typeof code === 'string' && code ? code : undefined;
    }
    catch (_b) {
        return undefined;
    }
}
/**
 * The error of an answer with a status outside 2xx: the message names the status and the path without its query
 * string, `code` is the `code` (else the `error`) of the JSON body, `retryAfter` the seconds of the `Retry-After`
 * header. The message never carries the body.
 * @internal
 */
function buildHttpError(status, statusText, path, bodyText, retryAfterHeader) {
    const shown = redactPath(path);
    return new errors_1.EspressoNotifyHttpError(`[espresso-notify] HTTP ${status}: ${statusText || 'request failed'} — ${shown}`, status, readErrorCode(bodyText), shown, parseRetryAfter(retryAfterHeader));
}
/**
 * The parsed body of a 2xx answer: `{}` when it is empty. A body that is not JSON throws an `Error` that says so and
 * does not repeat the body.
 * @internal
 */
function parseJsonBody(text) {
    if (!text)
        return {};
    try {
        return JSON.parse(text);
    }
    catch (_a) {
        throw new Error('[espresso-notify] invalid JSON in the response');
    }
}
// ─── The native transport ─────────────────────────────────────────────────────
/** The closed list of failures the native module may report. Anything else is reported as `unknown`. */
const NATIVE_ERROR_CODES = [
    'timeout', 'no_connection', 'dns', 'tls', 'pin_mismatch', 'cancelled', 'response_too_large', 'invalid_request', 'unknown',
];
/** The versions of the JavaScript to native contract this SDK speaks. A module of another version counts as absent. */
exports.SUPPORTED_CONTRACTS = [1];
/** The time the native module gives one request, from the start of the call to the last byte of the answer. */
exports.NATIVE_TIMEOUT_MS = 30000;
/** The name the native module registers under. */
const NATIVE_MODULE_NAME = 'EspressoNotifyTransport';
/**
 * Looks for the native module and says why it cannot be used when it cannot. `react-native` is loaded here and nowhere
 * at import time. Never throws.
 * @internal
 */
function inspectNativeModule() {
    var _a, _b, _c, _d, _e, _f;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const rn = require('react-native');
        // On the New Architecture the registry finds it; on the old one it falls back to NativeModules.
        const found = (_e = (_c = (_b = (_a = rn === null || rn === void 0 ? void 0 : rn.TurboModuleRegistry) === null || _a === void 0 ? void 0 : _a.get) === null || _b === void 0 ? void 0 : _b.call(_a, NATIVE_MODULE_NAME)) !== null && _c !== void 0 ? _c : (_d = rn === null || rn === void 0 ? void 0 : rn.NativeModules) === null || _d === void 0 ? void 0 : _d[NATIVE_MODULE_NAME]) !== null && _e !== void 0 ? _e : null;
        if (!found || typeof found.getConstants !== 'function' || typeof found.request !== 'function') {
            return { module: null, reason: 'not_linked' };
        }
        const version = (_f = found.getConstants()) === null || _f === void 0 ? void 0 : _f.contractVersion;
        return typeof version === 'number' && exports.SUPPORTED_CONTRACTS.includes(version)
            ? { module: found, reason: null }
            : { module: null, reason: 'version' };
    }
    catch (_g) {
        return { module: null, reason: 'not_linked' };
    }
}
/**
 * The native module, or null when it is not linked, is of a contract version this SDK does not list, or `react-native`
 * cannot be loaded (Expo Go, the web, tests). Never throws.
 * @internal
 */
function resolveNativeModule() {
    return inspectNativeModule().module;
}
/** The code a rejection of the module carries, if it is one of the nine; `unknown` for anything else. */
function nativeErrorCode(rejection) {
    let code;
    try {
        code = rejection !== null && typeof rejection === 'object' && Object.prototype.hasOwnProperty.call(rejection, 'code')
            ? rejection.code
            : undefined;
    }
    catch (_a) {
        code = undefined;
    }
    return typeof code === 'string' && NATIVE_ERROR_CODES.includes(code) ? code : 'unknown';
}
/**
 * The flat list `name, value, name, value` the module takes: `Authorization` and `Content-Type` first, then the headers
 * of the caller (a plain object only; a `Headers` instance or an array counts as none). A name that repeats, in any case,
 * is sent once, with the value of the last one.
 */
function flattenHeaders(projectId, extra) {
    const merged = new Map();
    const add = (name, value) => merged.set(name.toLowerCase(), [name, value]);
    add('Authorization', `Bearer ${projectId}`);
    add('Content-Type', 'application/json');
    const plain = extra !== null && typeof extra === 'object' && !Array.isArray(extra) && Object.getPrototypeOf(extra) === Object.prototype;
    if (plain) {
        for (const [name, value] of Object.entries(extra)) {
            if (value === undefined || value === null)
                continue;
            add(name, String(value));
        }
    }
    const out = [];
    for (const [name, value] of merged.values())
        out.push(name, value);
    return out;
}
/**
 * NativeTransport: sends the request through the native module and gives back what `FetchTransport` gives, so the
 * offline queue, the retry of the hooks and the signer see no difference. Retry, signing and batching stay above it.
 * A failure with no HTTP answer is a plain `Error` that carries only one of the nine codes of the module.
 * @internal
 */
class NativeTransport {
    constructor(baseURL, projectId, native) {
        this.baseURL = baseURL;
        this.projectId = projectId;
        this.native = native;
    }
    request(path_1) {
        return __awaiter(this, arguments, void 0, function* (path, options = {}) {
            var _a;
            const url = `${this.baseURL}${path}`;
            if (!/^https?:\/\//i.test(url))
                throw new TypeError('[espresso-notify] unsupported URL scheme');
            const body = options.body;
            if (body !== undefined && typeof body !== 'string')
                throw new TypeError('[espresso-notify] request body must be a string');
            const method = ((_a = options.method) !== null && _a !== void 0 ? _a : 'GET').toUpperCase();
            const headers = flattenHeaders(this.projectId, options.headers);
            let answer;
            try {
                answer = yield this.native.request(method, url, headers, body !== null && body !== void 0 ? body : null, exports.NATIVE_TIMEOUT_MS);
            }
            catch (rejection) {
                throw new Error(`[espresso-notify] network request failed (${nativeErrorCode(rejection)})`);
            }
            const response = answer;
            if (response === null || typeof response !== 'object' || typeof response.status !== 'number') {
                throw new Error('[espresso-notify] network request failed (unknown)');
            }
            const text = typeof response.body === 'string' ? response.body : '';
            if (response.status < 200 || response.status >= 300) {
                throw buildHttpError(response.status, typeof response.statusText === 'string' ? response.statusText : '', path, text, typeof response.retryAfter === 'string' ? response.retryAfter : undefined);
            }
            return parseJsonBody(text);
        });
    }
}
exports.NativeTransport = NativeTransport;
