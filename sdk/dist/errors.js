"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EXPO_PROJECT_ID_MISSING_MESSAGE = exports.EspressoNotifyHttpError = exports.EspressoNotifySigningError = exports.EspressoNotifyError = void 0;
class EspressoNotifyError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'EspressoNotifyError';
        this.code = code;
        Object.setPrototypeOf(this, EspressoNotifyError.prototype);
    }
}
exports.EspressoNotifyError = EspressoNotifyError;
/**
 * The request could not be signed while request signing is on (the signer or its key is unavailable), so it was not
 * sent: an unsigned request would be refused by a project that requires signing, and sending it would hide the
 * failure. A call you made rejects with it (`code` is `SIGNING_FAILED`); an event in the offline queue stays queued and
 * is tried again later. The text of the signer's own error is never part of the message.
 */
class EspressoNotifySigningError extends EspressoNotifyError {
    constructor(message) {
        super('SIGNING_FAILED', message);
        this.name = 'EspressoNotifySigningError';
        Object.setPrototypeOf(this, EspressoNotifySigningError.prototype);
    }
}
exports.EspressoNotifySigningError = EspressoNotifySigningError;
/**
 * A call the server answered with a status outside 2xx. `status` is the HTTP
 * status and `code` is the `code` (else the `error`) of the JSON body when it
 * has one, such as `identity_verification_failed` or `user_not_found`, so the
 * app can branch on it instead of reading the message.
 */
class EspressoNotifyHttpError extends Error {
    constructor(message, status, code, path, retryAfter) {
        super(message);
        this.name = 'EspressoNotifyHttpError';
        this.status = status;
        this.code = code;
        this.path = path;
        this.retryAfter = retryAfter;
        Object.setPrototypeOf(this, EspressoNotifyHttpError.prototype);
    }
}
exports.EspressoNotifyHttpError = EspressoNotifyHttpError;
exports.EXPO_PROJECT_ID_MISSING_MESSAGE = '[espresso-notify] No EAS project id for the Expo push token. ' +
    'Set "extra.eas.projectId" in app.json / app.config (`eas init` writes it), ' +
    'or pass `expoProjectId` to usePushNotifications (or ExpoPushProvider).';
