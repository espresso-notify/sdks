/**
 * What the browser can do with Web Push, and where the permission stands.
 *
 * Every function here reads the browser and nothing else: none of them asks for a permission,
 * registers a worker or calls the network. The one that asks, `requestPermission()`, has to be
 * called from a user gesture (a click or a tap) and is never called by this package on its own:
 * browsers refuse a prompt that was not asked for by the user, and Safari and Firefox show nothing
 * at all for it.
 */
/** Why the browser cannot do Web Push. */
export type UnsupportedReason = "no_service_worker" | "no_push_manager" | "no_notification" | "ios_requires_installed_app";
export interface SupportInfo {
    supported: boolean;
    /** Set when `supported` is false. */
    reason?: UnsupportedReason;
}
/** The permission of the site: the three values of the browser, or `unsupported` when it has no Web Push. */
export type PermissionState = "default" | "granted" | "denied" | "unsupported";
/** Why `trySubscribe()` did not subscribe. */
export type SubscribeFailureReason = "unsupported" | "permission_denied" | "permission_dismissed" | "no_service_worker" | "vapid_key_missing" | "invalid_consent" | "server_error";
export type SubscribeResult = {
    ok: true;
} | {
    ok: false;
    reason: SubscribeFailureReason;
    message?: string;
};
/** Thrown by `subscribe()` (which keeps its throwing contract); `trySubscribe()` returns the same reason instead. */
export declare class SubscribeError extends Error {
    readonly reason: SubscribeFailureReason;
    /** The error the browser raised, when this one wraps it. */
    readonly original?: unknown;
    constructor(reason: SubscribeFailureReason, message: string, original?: unknown);
}
/**
 * Whether this browser can do Web Push, and if it cannot, why. On iOS and iPadOS (16.4 and later)
 * Web Push works only for a site added to the home screen: in a Safari tab the answer is
 * `ios_requires_installed_app`, and the page should tell the visitor to install it.
 */
export declare function getSupport(): SupportInfo;
/** True when `getSupport()` finds nothing missing. */
export declare function isSupported(): boolean;
/** The permission of the site, without asking for it. */
export declare function getPermissionState(): PermissionState;
/**
 * Asks the visitor for the permission and returns where it stands afterwards. Call it from a user
 * gesture, for example the click handler of an "Enable notifications" button; a call made on page
 * load is ignored or penalized by browsers. Resolves `unsupported` without prompting when the
 * browser cannot do Web Push.
 */
export declare function requestPermission(): Promise<PermissionState>;
