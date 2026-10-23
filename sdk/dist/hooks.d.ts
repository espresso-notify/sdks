import { PushClient } from './index';
import type { PushProvider, PermissionStatus, NotificationOpenedHandler, OfflineQueueConfig, PrivateTransportMode } from './index';
export type { PermissionStatus } from './index';
export interface UsePushNotificationsConfig {
    /** Your project public key (pk_live_...) */
    projectId: string;
    /**
     * Reactive auth state. Pass the current user's external ID or null.
     * null  → device is anonymous (receives broadcasts, not personalized sends)
     * value → device is identified (receives all sends for this user)
     *
     * The hook calls identify() on null→value and unregister() on value→null.
     * You never need to call these manually.
     */
    externalId?: string | null;
    /**
     * Optional display name for the user. Passed to identify() automatically
     * alongside externalId. No need to call identify() manually just to set the name.
     */
    userName?: string | null;
    /**
     * The proof of identity of `externalId`: HMAC-SHA256(externalId, identity secret
     * of the project) as lower-case hex, computed by YOUR backend and handed to the
     * app after the user logs in (the secret never goes into the app). Sent with
     * identify() as `identity_hash`. Needed when the project asks for the proof.
     * When it arrives after `externalId`, the hook identifies again with it; when it
     * goes away while the user stays, nothing is sent.
     */
    identityHash?: string | null;
    /** Device-level metadata sent on register() (locale, plan, etc.) */
    metadata?: Record<string, unknown>;
    /**
     * Push token. If omitted, the hook acquires it via the resolved PushProvider
     * (ExpoPushProvider by default). Useful for apps that already manage token
     * acquisition themselves.
     */
    pushToken?: string;
    /**
     * Push provider discriminator when supplying an explicit pushToken.
     * Optional — defaults to 'expo' to preserve backward-compatible behavior.
     */
    pushTokenProvider?: 'expo' | 'fcm' | 'apns';
    /** Device platform. If omitted, auto-detected from react-native Platform. */
    platform?: 'ios' | 'android';
    /**
     * Whether to call requestPermissionsAsync() automatically before acquiring
     * the push token. Default: true.
     * Set to false if your app controls the permission prompt timing.
     */
    autoRequestPermission?: boolean;
    /**
     * Token acquisition strategy for ExpoPushProvider.
     * 'expo'   → getExpoPushTokenAsync (default, backward-compatible)
     * 'device' → getDevicePushTokenAsync → raw APNs/FCM token
     * Has no effect when an explicit pushToken or provider is supplied.
     */
    tokenStrategy?: 'expo' | 'device';
    /**
     * EAS project id for the Expo push token (`getExpoPushTokenAsync({ projectId })`).
     * Default: `Constants.expoConfig.extra.eas.projectId`, then
     * `Constants.easConfig.projectId` (expo-constants). Without any of them the
     * hook does not register and `error.code` is 'EXPO_PROJECT_ID_MISSING'.
     */
    expoProjectId?: string;
    /**
     * Optional custom PushProvider (for testing or non-Expo environments).
     * When not provided, auto-selected based on expo-notifications availability.
     * Seam for #803 (bare-RN / Firebase provider).
     */
    provider?: PushProvider;
    /**
     * Hardware-bound request signing (#813). Same option, same default and same
     * behavior as `ClientConfig.enableSigning`: the client signs every request
     * (register carries the public key) with X-KM-* headers. Default: false.
     * Needs the optional peer `react-native-secure-sign`; without it the client
     * logs one warning and sends unsigned. Read once, when the hook starts.
     * The server only enforces it for projects with `require_signing`; a project
     * that does not require it accepts signed requests as well.
     */
    enableSigning?: boolean;
    /**
     * Device attestation (#814). Same option and default as
     * `ClientConfig.enableAttestation`. When true the hook calls
     * `client.devices.attest()` after register() and before `isReady` turns true,
     * so identity writes wait for it. A failed attestation never sets `error`.
     * Requires `enableSigning: true` (the hook warns once if it is missing).
     * Default: false.
     */
    enableAttestation?: boolean;
    /**
     * Called once for every tap on a notification, with `{ notificationId, data, url, actionId }`, while the app
     * runs and for the tap that launched it. Same as `client.onNotificationOpened`. The hook calls the latest
     * function you passed, so it can be an inline function. Pass it from the first render: the client registers it
     * when it is created. Errors it throws are swallowed and never stop the tracking of `opened`.
     */
    onNotificationOpened?: NotificationOpenedHandler;
    /**
     * Let the SDK open the link (`url` key of the push data) of a tap on a notification, with `Linking.openURL`, after
     * `onNotificationOpened` ran. Same option and default as `ClientConfig.handleDeepLinks`: off. Read once, when the
     * hook starts.
     */
    handleDeepLinks?: boolean;
    /**
     * The schemes (`'myapp://'`) and HTTPS origins (`'https://shop.example.com'`) `handleDeepLinks` may open. Same as
     * `ClientConfig.deepLinkAllowList`: with none, nothing opens. Read once, when the hook starts.
     */
    deepLinkAllowList?: string[];
    /**
     * The offline queue of the client: an event that fails (open, click, conversion, custom event, lifecycle event) is
     * kept and sent again. Same option and default as `ClientConfig.offlineQueue`: `{ enabled: true, maxItems: 200 }`.
     * Read once, when the hook starts.
     */
    offlineQueue?: OfflineQueueConfig;
    /**
     * Which stack sends the requests of the client: the native module of the SDK, `fetch`, or the native module with a
     * `fetch` fallback. Same option and default as `ClientConfig.privateTransport`: `'auto'`. Read once, when the hook
     * starts. A value other than `'auto'`, `'native'` and `'js'` is the `error` of the hook.
     */
    privateTransport?: PrivateTransportMode;
}
export interface UsePushNotificationsResult {
    /** true after register() succeeds (after its retries, if it needed them) — safe to use client */
    isReady: boolean;
    /** The Expo push token in use (null while initializing or on error) */
    pushToken: string | null;
    /** PushClient instance for advanced use (updateMetadata, registerCategories, etc.) */
    client: PushClient | null;
    /** Current push notification permission status */
    permissionStatus: PermissionStatus;
    /**
     * Non-null if initialization failed (permission denied, expo-notifications
     * missing, no push token, etc.). Token failures are `EspressoNotifyError` with
     * `code` 'EXPO_PROJECT_ID_MISSING' or 'PUSH_TOKEN_UNAVAILABLE'; the device is
     * not registered in that case.
     */
    error: Error | null;
}
/**
 * React hook that manages the full push notification device lifecycle.
 *
 * Place this once in your root layout (App.tsx or app/_layout.tsx with Expo Router),
 * inside your auth provider so it has access to the current userId.
 *
 * @example
 * // app/_layout.tsx
 * function RootLayout() {
 *   const { userId } = useAuth()
 *
 *   usePushNotifications({
 *     projectId: 'pk_live_...',
 *     externalId: userId ?? null,
 *   })
 *
 *   return <Stack />
 * }
 *
 * What happens automatically:
 *   mount                   → requestPermission + getToken + register (anonymous) [+ attest()]
 *                             register and identify are tried again when the failure can pass (no answer, 408, 429,
 *                             5xx): up to 6 tries in all, a random wait from 0 up to 1 s doubling to 5 min, or the
 *                             Retry-After of the server plus a random 0 to 25%. Any other 4xx is final.
 *   foreground               → register and identify again only when the token, the app version or the user changed, or
 *                             the app was out of the foreground for 30 s or more (a new session); a call that failed
 *                             is tried again here
 *   userId: null → "u1"     → identify("u1")
 *   userId: "u1" → null     → unregister() (token stays, anonymous state)
 *   userId: "u1" → "u2"     → identify("u2") — account switch, no unregister
 *   the provider rotates the token → register(new token, your metadata) → identify(current user) →
 *                             recordLifecycle('subscription'), one rotation after the other
 *   unmount                 → destroy() — cleanup listeners
 */
export declare function usePushNotifications({ projectId, externalId, userName, identityHash, metadata, pushToken: externalToken, pushTokenProvider: externalTokenProvider, platform: externalPlatform, autoRequestPermission, tokenStrategy, expoProjectId, provider: injectedProvider, enableSigning, enableAttestation, onNotificationOpened, handleDeepLinks, deepLinkAllowList, offlineQueue, privateTransport, }: UsePushNotificationsConfig): UsePushNotificationsResult;
/**
 * Lightweight hook for apps that manage PushClient manually and only want
 * reactive identity management (identify on login, unregister on logout).
 *
 * Pass `identityHash` (computed by your backend) when the project asks for the
 * proof of identity; see `UsePushNotificationsConfig.identityHash`.
 *
 * @example
 * const client = useMemo(() => new PushClient({ projectId: 'pk_...' }), [])
 * usePushIdentity(client, userId ?? null)
 */
export declare function usePushIdentity(client: PushClient | null, userId: string | null, identityHash?: string | null): void;
