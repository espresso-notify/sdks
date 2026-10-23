"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EspressoNotifyError = exports.EspressoNotifyHttpError = void 0;
/**
 * A call the API answered with a status outside 2xx. `status` is the HTTP status and `code` is the `code` (else
 * the `error`) of the JSON body when it has one, such as `identity_verification_failed` or `user_not_found`, so a
 * site can branch on it instead of reading the message. It is the twin of the error of the React Native SDK.
 */
class EspressoNotifyHttpError extends Error {
    constructor(message, status, code, path, retryAfter) {
        super(message);
        this.name = "EspressoNotifyHttpError";
        this.status = status;
        this.code = code;
        this.path = path;
        this.retryAfter = retryAfter;
        Object.setPrototypeOf(this, EspressoNotifyHttpError.prototype);
    }
}
exports.EspressoNotifyHttpError = EspressoNotifyHttpError;
/** A call that cannot be made from this browser, such as erasing a device that has no subscription. */
class EspressoNotifyError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "EspressoNotifyError";
        this.code = code;
        Object.setPrototypeOf(this, EspressoNotifyError.prototype);
    }
}
exports.EspressoNotifyError = EspressoNotifyError;
