/**
 * Subscribe and identify only on change or on a new session (send-scale SCALE-39; owner decision D-196). The twin of
 * sdk/src/registration.ts.
 *
 * Why: every page load used to post the subscription and, for a signed-in visitor, post it again with `identify`.
 * With thousands of visitors that is most of the traffic of a project, and almost all of it tells the server what it
 * already knows. The rule: after a call works, the SDK remembers WHAT it sent (a hash of the subscription, the user and
 * the versions) and in WHICH session. It sends again only when the hash differs, or when the call that is remembered
 * belongs to an earlier session.
 *
 * A web session is one tab: its id lives in `sessionStorage`, so a reload or another page of the site keeps it, and a
 * new tab or a new window starts another. It also ends when the page is opened, or shown again, 30 minutes or more after
 * the last time it was seen (a tab that was left open overnight). Where the browser has no `sessionStorage` every page
 * load is a session, which is what the SDK did before this rule.
 *
 * A call that fails is never remembered, so the next page load tries it again.
 *
 * What is stored is a hash and session ids, never the endpoint, the keys, the user id, the name or the proof of
 * identity: `localStorage` can be read by any script of the site. A value left by an older SDK, or a damaged one, reads
 * as "nothing was sent yet": the call runs once, never an error. A storage that cannot be read or written (a private
 * window, a full disk) only means the call runs every time.
 */
/** The version of this package; `package.json` says the same (a test keeps the two equal). */
export declare const SDK_VERSION = "0.0.3";
/** The two calls that are remembered. */
export type RegistrationKind = "register" | "identify";
/** How long the page must be out of sight, or the tab untouched, for the next sight of it to start a new session (30 minutes). */
export declare const SESSION_GAP_MS: number;
/** How many sessions of one unchanged state are remembered (tabs that took turns); the oldest is forgotten first. */
export declare const REMEMBERED_SESSIONS = 8;
/** The part of a web storage this module needs. */
export interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
/** The part of `document` this module needs to know when the page is hidden and shown. */
export interface PageLike {
    visibilityState?: string;
    addEventListener(type: string, listener: () => void): void;
}
/** What a call sends about the browser and the user; the fingerprint is made of it. */
export interface RegistrationParts {
    endpoint: string;
    p256dh?: string;
    auth?: string;
    /** The VAPID key the subscription was made with. */
    vapidKey?: string;
    timezone?: string;
    /** `identify` only: the external id of the user, the display name and the proof of identity; a change of any is a change. */
    userId?: string | null;
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
    /** The key of the record in the storage. */
    key: string;
    /** The public key of the project; part of every fingerprint. */
    projectKey: string;
    /** The version of the app the site declares, part of every fingerprint. */
    appVersion?: string;
    /** Default {@link SDK_VERSION}. */
    sdkVersion?: string;
    /** Where the record lives. Default `localStorage` when it can be used; `null` for none (every plan runs). */
    storage?: StorageLike | null;
    /** Where the session lives. Default `sessionStorage` when it can be used; `null` for none (every page load is a session). */
    sessionStorage?: StorageLike | null;
    /** The clock, in ms. Default `Date.now`. */
    now?: () => number;
    /** The page whose visibility is watched. Default `document` when there is one; `null` for none. */
    page?: PageLike | null;
}
export declare class RegistrationTracker {
    private readonly options;
    private readonly store;
    private readonly sessionStore;
    private readonly now;
    private session;
    /** When the page left the screen, or null while it is on it. */
    private leftAt;
    constructor(options: RegistrationOptions);
    /** The session the calls are being made in. */
    get sessionId(): string;
    /**
     * Whether the call has to run: a ticket when the server may not know this state, null when it is known (the same
     * fingerprint, remembered in this session). `force` always gives a ticket (a call that carries a consent record, or
     * an endpoint to replace). Never throws; a store that cannot be read means "run".
     */
    plan(kind: RegistrationKind, parts: RegistrationParts, options?: {
        force?: boolean;
    }): Promise<RegistrationTicket | null>;
    /** Remembers a call that worked. Never throws; a store that cannot be written only means the call may run again. */
    commit(ticket: RegistrationTicket): Promise<void>;
    /** Forgets one call, or both, so the next `plan` runs (the browser was unsubscribed or erased). */
    forget(kind?: RegistrationKind): Promise<void>;
    private fingerprint;
    /** The record of the storage; anything that is not the expected shape (no value, an older SDK, damage) is empty. */
    private read;
    private write;
    /** The session this page load belongs to: the one of the tab when it was seen less than 30 minutes ago, else a new one. */
    private openSession;
    /** Writes the time the page was last seen with the session. */
    private touch;
    private watchPage;
}
