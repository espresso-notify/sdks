/**
 * Register and identify only on change or on a new session (send-scale SCALE-39, owner decision D-159).
 *
 * Why: every app open used to send a `register` and an `identify`. With thousands of devices that is most of the
 * traffic of a project, and almost all of it tells the server what it already knows. The rule (the one OneSignal
 * uses): after a call works, the SDK remembers WHAT it sent (a fingerprint of the token, the app version and the user)
 * and in WHICH session. It sends again only when the fingerprint differs, or when the call that is remembered belongs
 * to an earlier session. A session is one run of the app: a new one starts at a cold start, and when the app comes back
 * to the foreground after at least 30 seconds out of it.
 *
 * A call that fails is never remembered, so the next start or foreground tries it again.
 *
 * What is stored is a hash and a session id, never the token or the user id: the store (AsyncStorage) is not
 * encrypted, the same rule as the offline queue. A value left by an older SDK, or a damaged one, reads as "nothing was
 * sent yet": the call runs once, never an error.
 */
/** The two calls that are remembered. */
export type RegistrationKind = 'register' | 'identify';
/** The part of a `KeyStore` this module needs. */
export interface RegistrationStore {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}
/** What a call sends about the device and the user; the fingerprint is made of it. */
export interface RegistrationParts {
    token: string;
    /** Defaults to the app version the tracker was given. */
    appVersion?: string;
    /** The external id of the user, or null/undefined for an anonymous device. */
    userId?: string | null;
    /** `identify` only: the display name and the proof of identity sent with the user; a change of either is a change. */
    userName?: string | null;
    identityHash?: string | null;
}
/** The permission to run a call, given by {@link RegistrationTracker.plan} and handed back to `commit` when the call worked. */
export interface RegistrationTicket {
    readonly kind: RegistrationKind;
    readonly fingerprint: string;
    readonly session: string;
}
export interface RegistrationOptions {
    /** The clock, in ms. Default `Date.now`. */
    now?: () => number;
    /** The id of the session this run starts with. Default: a random one (a cold start is a new session). */
    sessionId?: string;
    /** The version of the app, added to every fingerprint. */
    getAppVersion?: () => string | undefined;
}
/** How long the app must be out of the foreground for its return to start a new session (30 seconds). */
export declare const SESSION_GAP_MS = 30000;
export declare class RegistrationTracker {
    private readonly _store;
    private readonly _key;
    private readonly _options;
    private _session;
    private _record;
    private _loading;
    private _chain;
    /** When the app left the foreground, or null while it is in it. */
    private _leftAt;
    private readonly _now;
    constructor(_store: RegistrationStore, _key: string, _options?: RegistrationOptions);
    /** The session the calls are being made in. */
    get sessionId(): string;
    /**
     * Tells the tracker that the app changed state (`active`, `inactive`, `background`). Coming back to `active` after at
     * least {@link SESSION_GAP_MS} out of it starts a new session.
     */
    noteAppState(state: string): void;
    /**
     * Whether the call has to run: a ticket when the server may not know this state, null when it is known (the same
     * fingerprint, remembered in this session). Never throws; a store that cannot be read means "run".
     */
    plan(kind: RegistrationKind, parts: RegistrationParts): Promise<RegistrationTicket | null>;
    /** Remembers a call that worked. Never throws; a store that cannot be written only means the call may run again. */
    commit(ticket: RegistrationTicket): Promise<void>;
    /** Forgets a call, so the next `plan` of it runs (the user logged out: the next login must identify again). */
    forget(kind: RegistrationKind): Promise<void>;
    private _fingerprint;
    private _read;
    /** The record of a stored text; anything that is not the expected shape (no value, an older SDK, damage) is empty. */
    private _parse;
    private _update;
}
