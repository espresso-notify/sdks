/**
 * The helpers that both transports of the SDK share, so a request built through `fetch` and one sent through the
 * native module end in the same results and the same errors (sdk-private-transport, SPT-11 to SPT-14, SPT-51).
 *
 * This file imports nothing from `index.ts`: the transports sit above it, the helpers below.
 */
import { EspressoNotifyHttpError } from './errors';
import type { Transport } from './index';
/**
 * The request path up to the first `?` or `#`: an identifier that a caller or a proxy put in a query string
 * never reaches an error message or the `path` of an error.
 * @internal
 */
export declare function redactPath(path: string): string;
/**
 * The seconds a `Retry-After` header asks to wait, as whole seconds: a number of seconds, or an HTTP date turned into
 * the seconds until it. Undefined when the answer has no header or a value that is neither. Never throws.
 * @internal
 */
export declare function parseRetryAfter(raw: string | null | undefined): number | undefined;
/**
 * The error of an answer with a status outside 2xx: the message names the status and the path without its query
 * string, `code` is the `code` (else the `error`) of the JSON body, `retryAfter` the seconds of the `Retry-After`
 * header. The message never carries the body.
 * @internal
 */
export declare function buildHttpError(status: number, statusText: string, path: string, bodyText: string, retryAfterHeader: string | null | undefined): EspressoNotifyHttpError;
/**
 * The parsed body of a 2xx answer: `{}` when it is empty. A body that is not JSON throws an `Error` that says so and
 * does not repeat the body.
 * @internal
 */
export declare function parseJsonBody(text: string): unknown;
/** The closed list of failures the native module may report. Anything else is reported as `unknown`. */
declare const NATIVE_ERROR_CODES: readonly ["timeout", "no_connection", "dns", "tls", "pin_mismatch", "cancelled", "response_too_large", "invalid_request", "unknown"];
export type NativeErrorCode = typeof NATIVE_ERROR_CODES[number];
/** The versions of the JavaScript to native contract this SDK speaks. A module of another version counts as absent. */
export declare const SUPPORTED_CONTRACTS: number[];
/** The time the native module gives one request, from the start of the call to the last byte of the answer. */
export declare const NATIVE_TIMEOUT_MS = 30000;
/** One host of the pin set the native module holds. */
export interface NativePinEntry {
    host: string;
    includeSubdomains: boolean;
    pins: string[];
}
/** The module as the SDK uses it; it matches the codegen spec in `native/NativeEspressoNotifyTransport.ts`. */
export interface NativeTransportModule {
    getConstants(): {
        contractVersion: number;
    };
    request(method: string, url: string, headers: string[], body: string | null, timeoutMs: number): Promise<{
        status: number;
        statusText: string;
        retryAfter: string;
        body: string;
    }>;
    setPins(entries: NativePinEntry[]): Promise<boolean>;
    clearPins(): Promise<void>;
}
/** Why the native module is not usable: it is not linked (or broken), or it speaks a contract version this SDK does not list. */
export type NativeUnusable = 'not_linked' | 'version';
/**
 * Looks for the native module and says why it cannot be used when it cannot. `react-native` is loaded here and nowhere
 * at import time. Never throws.
 * @internal
 */
export declare function inspectNativeModule(): {
    module: NativeTransportModule | null;
    reason: NativeUnusable | null;
};
/**
 * The native module, or null when it is not linked, is of a contract version this SDK does not list, or `react-native`
 * cannot be loaded (Expo Go, the web, tests). Never throws.
 * @internal
 */
export declare function resolveNativeModule(): NativeTransportModule | null;
/**
 * NativeTransport: sends the request through the native module and gives back what `FetchTransport` gives, so the
 * offline queue, the retry of the hooks and the signer see no difference. Retry, signing and batching stay above it.
 * A failure with no HTTP answer is a plain `Error` that carries only one of the nine codes of the module.
 * @internal
 */
export declare class NativeTransport implements Transport {
    private readonly baseURL;
    private readonly projectId;
    private readonly native;
    constructor(baseURL: string, projectId: string, native: NativeTransportModule);
    request(path: string, options?: RequestInit): Promise<unknown>;
}
export {};
