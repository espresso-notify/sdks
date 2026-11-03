/**
 * Stable error codes the SDK surfaces to the app (for example in the hook's
 * `error`), so callers can branch on `error.code` instead of the message.
 */
export type EspressoNotifyErrorCode =
  | 'EXPO_PROJECT_ID_MISSING'
  | 'PUSH_TOKEN_UNAVAILABLE'
  | 'METADATA_TOO_LARGE'
  | 'UNSUPPORTED_PLATFORM'
  | 'PINNING_NOT_ACTIVE'
  | 'NATIVE_TRANSPORT_UNAVAILABLE'
  | 'SIGNING_FAILED'
  | 'CONSENT_REQUIRED'
  | 'SDK_DISABLED'

export class EspressoNotifyError extends Error {
  readonly code: EspressoNotifyErrorCode

  constructor(code: EspressoNotifyErrorCode, message: string) {
    super(message)
    this.name = 'EspressoNotifyError'
    this.code = code
    Object.setPrototypeOf(this, EspressoNotifyError.prototype)
  }
}

/**
 * The request could not be signed while request signing is on (the signer or its key is unavailable), so it was not
 * sent: an unsigned request would be refused by a project that requires signing, and sending it would hide the
 * failure. A call you made rejects with it (`code` is `SIGNING_FAILED`); an event in the offline queue stays queued and
 * is tried again later. The text of the signer's own error is never part of the message.
 */
export class EspressoNotifySigningError extends EspressoNotifyError {
  constructor(message: string) {
    super('SIGNING_FAILED', message)
    this.name = 'EspressoNotifySigningError'
    Object.setPrototypeOf(this, EspressoNotifySigningError.prototype)
  }
}

/**
 * A call the server answered with a status outside 2xx. `status` is the HTTP
 * status and `code` is the `code` (else the `error`) of the JSON body when it
 * has one, such as `identity_verification_failed` or `user_not_found`, so the
 * app can branch on it instead of reading the message.
 */
export class EspressoNotifyHttpError extends Error {
  readonly status: number
  readonly code?: string
  readonly path?: string
  /** Seconds the server asked to wait (the `Retry-After` header of the answer), when it sent a usable one. */
  readonly retryAfter?: number

  constructor(message: string, status: number, code?: string, path?: string, retryAfter?: number) {
    super(message)
    this.name = 'EspressoNotifyHttpError'
    this.status = status
    this.code = code
    this.path = path
    this.retryAfter = retryAfter
    Object.setPrototypeOf(this, EspressoNotifyHttpError.prototype)
  }
}

export const EXPO_PROJECT_ID_MISSING_MESSAGE =
  '[espresso-notify] No EAS project id for the Expo push token. ' +
  'Set "extra.eas.projectId" in app.json / app.config (`eas init` writes it), ' +
  'or pass `expoProjectId` to usePushNotifications (or ExpoPushProvider).'
