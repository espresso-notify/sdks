/**
 * A call the API answered with a status outside 2xx. `status` is the HTTP status and `code` is the `code` (else
 * the `error`) of the JSON body when it has one, such as `identity_verification_failed` or `user_not_found`, so a
 * site can branch on it instead of reading the message. It is the twin of the error of the React Native SDK.
 */
export declare class EspressoNotifyHttpError extends Error {
    readonly status: number;
    readonly code?: string;
    /** The route that answered, for example `/v1/web-push/device`. */
    readonly path?: string;
    /** Seconds the server asked to wait (the `Retry-After` header of the answer), when it sent a usable one. */
    readonly retryAfter?: number;
    constructor(message: string, status: number, code?: string, path?: string, retryAfter?: number);
}
/** The reasons a call is refused before it reaches the API. */
export type EspressoNotifyErrorCode = "no_subscription";
/** A call that cannot be made from this browser, such as erasing a device that has no subscription. */
export declare class EspressoNotifyError extends Error {
    readonly code: EspressoNotifyErrorCode;
    constructor(code: EspressoNotifyErrorCode, message: string);
}
