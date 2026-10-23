/** One button of a notification, as the push carries it. */
export interface PushAction {
    /** The id the worker learns when the button is pressed. */
    action: string;
    title: string;
    /** Where the button goes; the link of the notification when it has none. */
    url?: string;
}
export interface PushPayload {
    title: string;
    body: string;
    icon?: string;
    image?: string;
    url?: string;
    notificationId?: number;
    /** The buttons of the notification, up to 3. */
    actions?: PushAction[];
    /** Replaces an earlier notification with the same tag instead of stacking. */
    tag?: string;
    /** The monochrome icon the system shows in its status bar. */
    badge?: string;
    /** The number the worker puts on the icon of an installed app. */
    badgeCount?: number;
}
import { EspressoNotifyError, EspressoNotifyHttpError } from "./errors";
import { ConsentInfo, NotificationPreference, isValidEventName, validatePreferences } from "./privacy";
import { PermissionState, SubscribeError, SubscribeResult, SupportInfo, getPermissionState, getSupport, isSupported, requestPermission } from "./support";
export { getPermissionState, getSupport, isSupported, requestPermission, SubscribeError };
export { EspressoNotifyError, EspressoNotifyHttpError, isValidEventName, validatePreferences };
export type { ConsentInfo, NotificationPreference };
export type { PermissionState, SubscribeFailureReason, SubscribeResult, SupportInfo, UnsupportedReason } from "./support";
export interface IdentifyOptions {
    name?: string;
    identityHash?: string;
}
export interface SubscribeOptions {
    /**
     * The record of the accept of the visitor: the version of the text they saw and where they accepted it. The API
     * stores it, with the time of the server, on the subscription. Pass it only when the visitor accepted; without it
     * nothing is recorded and a stored record is kept.
     */
    consent?: ConsentInfo;
}
export interface WebPushClientOptions {
    projectId: string;
    swPath?: string;
    swScope?: string;
    /**
     * The version of your site or app. A new value makes the next page load post the subscription again (and identify
     * again), so the server learns what changed. Optional.
     */
    appVersion?: string;
}
export declare class WebPushClient {
    private projectId;
    private apiUrl;
    private vapidPublicKey;
    private swPath;
    private swScope;
    private appVersion;
    private registration;
    private subscription;
    private tracker;
    constructor(options: WebPushClientOptions);
    private get registrationTracker();
    private registrationParts;
    private get headers();
    /** Whether this browser can do Web Push. Same as the exported `isSupported()`. */
    isSupported(): boolean;
    /** Whether this browser can do Web Push and, when it cannot, why (for example `ios_requires_installed_app`). */
    getSupport(): SupportInfo;
    /** `default`, `granted`, `denied` or `unsupported`. Does not prompt. */
    getPermissionState(): PermissionState;
    /**
     * Prompts for the permission and returns the state afterwards. Call it from a user gesture
     * (a click on "Enable notifications"); never on page load.
     */
    requestPermission(): Promise<PermissionState>;
    /** The subscription of this browser, or `null` when it has none. Does not prompt or register anything. */
    getSubscription(): Promise<PushSubscription | null>;
    /**
     * Subscribes this browser and says why when it cannot, instead of throwing. Call it from a user
     * gesture: when the permission is still `default` it asks for it first, and a browser only shows
     * that prompt for a click or a tap. A `denied` permission is not asked again.
     */
    trySubscribe(options?: SubscribeOptions): Promise<SubscribeResult>;
    /** Subscribes this browser. Resolves `false` when the browser has no service worker and throws on any other failure. */
    subscribe(options?: SubscribeOptions): Promise<boolean>;
    private register;
    private currentVapidKey;
    private keyOf;
    private sameKey;
    private moveToKey;
    /**
     * Links this browser to a user of your app. `externalId` is your own id for
     * the user (the same value you pass to the React Native SDK); the numeric id
     * Espresso Notify keeps internally is never needed.
     *
     * `identityHash` is HMAC-SHA256(externalId, project secret) as lower-case hex,
     * computed by YOUR backend. Send it when the project verifies identities.
     */
    identify(externalId: string, options?: IdentifyOptions): Promise<void>;
    updateMetadata(metadata: Record<string, unknown>): Promise<void>;
    private postSubscription;
    private request;
    unsubscribe(): Promise<void>;
    /**
     * Erases this browser and its data from Espresso Notify: the subscription, its delivery records, the events
     * stored under it and the user (external id and name) when no other device of the user is left. It is the call
     * behind a "delete my data" button (LGPD, GDPR) and cannot be undone. Only after the API confirmed does it drop
     * the record the service worker keeps and cancel the subscription of the browser, so a failed call can be tried
     * again.
     *
     * When the project asks for the proof of identity, pass `identityHash`: HMAC-SHA256(externalId, project secret)
     * as lower-case hex, computed by YOUR server. Rejects with `EspressoNotifyError` (`no_subscription`) without
     * calling the API when the browser has no subscription, and with `EspressoNotifyHttpError` (`status`, `code`)
     * on any answer outside 2xx, such as 404 `not_found` or 403 `identity_verification_failed`.
     */
    forgetDevice(options?: {
        identityHash?: string;
    }): Promise<void>;
    /**
     * Reads the category opt-outs of the person this browser is linked to (`identify`). Rejects
     * `EspressoNotifyHttpError` 404 `user_not_found` when `identify` was never called, and `EspressoNotifyError`
     * (`no_subscription`) without calling the API when the browser has no subscription.
     */
    getPreferences(): Promise<NotificationPreference[]>;
    /**
     * Saves the category opt-outs of the person this browser is linked to: 1 to 50 items, each a
     * `categoryIdentifier` of 1 to 64 bytes and a boolean `optedOut`. The check runs before any call. The API
     * refuses a category that does not exist (`unknown_category`) or that cannot be left
     * (`category_not_opt_outable`). Resolves `{ updated }`. Needs `identify` first (404 `user_not_found` otherwise).
     */
    setPreferences(preferences: NotificationPreference[]): Promise<{
        updated: number;
    }>;
    /**
     * Reports a business event of the person this browser is linked to (`identify`): `order.completed`, `signed_up`.
     * The name is 1 to 64 letters, digits, `_`, `.`, `:` or `-`, starting with a letter or a digit, and not one of the
     * six names of the delivery lifecycle (opened, clicked, received, dismissed, converted, app_opened); an invalid
     * name sends nothing and logs a warning. The event is recorded for the person, and journeys and goals react to it
     * when the person also has a mobile device. Silent: it never throws, has no queue and no retry, so an event the
     * network or the API refuses (404 `unknown_device`, 429 `rate_limited`) is lost and shows only in the debug
     * console. Each call carries its own `event_id`, which protects only against the same request arriving twice.
     */
    trackEvent(name: string): Promise<void>;
    /**
     * Reports that the visitor did what a notification was sent for (bought, signed up): the `converted` event, which
     * adds to the conversion count of that notification once for this browser, and only for a notification delivered
     * to it. It carries no amount: revenue is reported from your server with the secret key. Pass the numeric id of the
     * notification (a positive integer, or digits in a string); anything else sends nothing and logs a warning.
     * Silent: it never throws.
     */
    trackConversion(notificationId: number | string): Promise<void>;
    private logRefusal;
    private requireSubscription;
    private postJson;
    private httpError;
    onPush(handler: (data: PushPayload) => void): () => void;
    private urlBase64ToUint8Array;
}
