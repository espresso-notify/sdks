"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EXPO_PROJECT_ID_MISSING_MESSAGE = exports.EspressoNotifyHttpError = exports.EspressoNotifyError = void 0;
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
