/**
 * Stable error codes the SDK surfaces to the app (for example in the hook's
 * `error`), so callers can branch on `error.code` instead of the message.
 */
export type EspressoNotifyErrorCode = 'EXPO_PROJECT_ID_MISSING' | 'PUSH_TOKEN_UNAVAILABLE' | 'METADATA_TOO_LARGE' | 'UNSUPPORTED_PLATFORM' | 'PINNING_NOT_ACTIVE' | 'NATIVE_TRANSPORT_UNAVAILABLE';
export declare class EspressoNotifyError extends Error {
    readonly code: EspressoNotifyErrorCode;
    constructor(code: EspressoNotifyErrorCode, message: string);
}
/**
 * A call the server answered with a status outside 2xx. `status` is the HTTP
 * status and `code` is the `code` (else the `error`) of the JSON body when it
 * has one, such as `identity_verification_failed` or `user_not_found`, so the
 * app can branch on it instead of reading the message.
 */
export declare class EspressoNotifyHttpError extends Error {
    readonly status: number;
    readonly code?: string;
    readonly path?: string;
    /** Seconds the server asked to wait (the `Retry-After` header of the answer), when it sent a usable one. */
    readonly retryAfter?: number;
    constructor(message: string, status: number, code?: string, path?: string, retryAfter?: number);
}
export declare const EXPO_PROJECT_ID_MISSING_MESSAGE: string;
