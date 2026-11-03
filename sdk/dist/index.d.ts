import { EspressoNotifyError } from './errors';
export { EspressoNotifyError, EspressoNotifyHttpError, EspressoNotifySigningError } from './errors';
export type { EspressoNotifyErrorCode } from './errors';
/**
 * Push notification permission status.
 * Shared between PushProvider and usePushNotifications.
 */
export type PermissionStatus = 'granted' | 'denied' | 'undetermined' | null;
/**
 * A token returned by a PushProvider — includes the raw token string and a
 * discriminator for the provider type so the backend can route it correctly.
 */
export interface PushProviderToken {
    token: string;
    provider: 'expo' | 'fcm' | 'apns';
}
/**
 * PushProvider — seam for #803 (bare-RN / Firebase push token acquisition).
 * Default implementation: ExpoPushProvider (expo-notifications).
 */
export interface PushProvider {
    /** Request push notification permissions. Returns the resulting status. */
    requestPermissions(): Promise<PermissionStatus>;
    /** Acquire the device push token. Returns null when unavailable. */
    getToken(): Promise<PushProviderToken | null>;
    /**
     * Subscribe to native token rotation events. (#807)
     * Returns an unsubscribe function. Optional — not all providers support it.
     */
    onTokenRefresh?(cb: (token: PushProviderToken) => void): () => void;
    /**
     * Read the CURRENT permission status WITHOUT prompting the user. (#807)
     * Optional — not all providers support it.
     */
    getPermissionStatus?(): Promise<PermissionStatus>;
    /**
     * Why the last `getToken()` returned null, when the provider knows. Optional.
     * The hook surfaces it as its `error` instead of registering without a token.
     */
    readonly lastError?: EspressoNotifyError | null;
}
/**
 * ExpoPushProvider — PushProvider backed by expo-notifications.
 * Mirrors the permission + token acquisition logic from the usePushNotifications
 * hook exactly (same API calls, same mapping).
 *
 * tokenStrategy (default 'expo'):
 *   'expo'   → getExpoPushTokenAsync({ projectId }) → provider 'expo'
 *   'device' → getDevicePushTokenAsync() → provider 'apns' (iOS) or 'fcm' (Android)
 *
 * The EAS project id for the 'expo' strategy comes from `expoProjectId`, else
 * from expo-constants (`expoConfig.extra.eas.projectId`, then
 * `easConfig.projectId`). When expo-constants is present and has neither, the
 * token request is skipped and `lastError.code` is 'EXPO_PROJECT_ID_MISSING'.
 */
export declare class ExpoPushProvider implements PushProvider {
    private readonly _tokenStrategy;
    private readonly _expoProjectId?;
    lastError: EspressoNotifyError | null;
    /** The last Expo push token this provider handed out; a rotation event delivers only a different one. */
    private _lastExpoToken;
    constructor(options?: {
        tokenStrategy?: 'expo' | 'device';
        expoProjectId?: string;
    });
    /**
     * string → use it; undefined → expo-constants is absent, let
     * getExpoPushTokenAsync() infer it; null → known to be missing.
     */
    private _resolveExpoProjectId;
    requestPermissions(): Promise<PermissionStatus>;
    getToken(): Promise<PushProviderToken | null>;
    /**
     * The Expo push token, asked again after the device token rotated. `null` when it did not change, when the EAS
     * project id is missing or when Expo does not answer (the next rotation event or the next start tries again).
     */
    private _changedExpoToken;
    onTokenRefresh(cb: (token: PushProviderToken) => void): () => void;
    getPermissionStatus(): Promise<PermissionStatus>;
}
/**
 * BareProvider — PushProvider backed by @react-native-firebase/messaging.
 * Used in bare React Native projects that do NOT use expo-notifications.
 *
 * Token refresh listeners are not added here — that is task #807.
 * Direct APNs token retrieval (messaging().getAPNSToken()) is a future option
 * for pure-APNs use cases but is not implemented here (task #803 scope).
 */
export declare class BareProvider implements PushProvider {
    requestPermissions(): Promise<PermissionStatus>;
    getToken(): Promise<PushProviderToken | null>;
    /**
     * Calls `cb` when Firebase issues a new FCM token. Nothing is registered by itself: with `usePushNotifications` the
     * hook does it, with a bare `PushClient` the app must, in this order: `await client.devices.register({ pushToken,
     * provider: 'fcm' })` with the new token, then set `client.pushToken` to it, then `await client.devices.identify({
     * externalId })` when a user is logged in (a token registered alone is anonymous and a send by `externalId` would not
     * reach it), and only then `client.devices.recordLifecycle('subscription', oldToken, newToken)`.
     */
    onTokenRefresh(cb: (token: PushProviderToken) => void): () => void;
    getPermissionStatus(): Promise<PermissionStatus>;
}
/**
 * Resolves the appropriate PushProvider:
 * 1. ExpoPushProvider when expo-notifications is present.
 * 2. BareProvider when expo absent but @react-native-firebase/messaging is present.
 * 3. null — no provider available.
 *
 * Explicit provider override + display auto-detection are task #805.
 */
export declare function resolvePushProvider(options?: {
    tokenStrategy?: 'expo' | 'device';
    expoProjectId?: string;
}): PushProvider | null;
/**
 * The opt-out of a user from one notification category: `optedOut: true` stops
 * the sends of that category to the user, `false` puts the user back in it.
 */
export interface NotificationPreference {
    categoryIdentifier: string;
    optedOut: boolean;
}
export interface PushUser {
    pushToken: string;
    platform: "ios" | "android";
    /** Push provider discriminator. Sent to the backend so it can route the token correctly. */
    provider?: 'expo' | 'fcm' | 'apns';
    deviceId?: string;
    appVersion?: string;
    osVersion?: string;
    user?: {
        name: string;
        externalId: string;
        /**
         * The proof of identity: a JWT (ES256) signed by YOUR backend for this user, with the
         * `externalId` as `sub` and the public id of the project as `aud` (the private key never
         * goes into the app). Sent as `identity_token`. Needed when the project asks for the proof.
         * When the server answers that it expired and the client has an `identityTokenProvider`,
         * the client asks it for a new one and repeats the call once.
         */
        identityToken?: string;
    };
    metadata?: Record<string, unknown>;
}
/**
 * Gives the client a new identity token for a user: your app asks YOUR backend, which signs it. The client calls
 * it with the `externalId` when the server answers 401 `identity_token_expired`, once per expired call (calls of the
 * same user that expire together share one call), and repeats the call once with what it returns.
 */
export type IdentityTokenProvider = (externalId: string) => Promise<string>;
/**
 * Transport abstraction — seam for #410 (custom fetch / mock in tests).
 * Default implementation: FetchTransport (fetch + Bearer auth + error wrapping).
 */
export interface Transport {
    request(path: string, options?: RequestInit): Promise<unknown>;
}
/**
 * Device info abstraction — seam for #803/#804 (bare-RN / Firebase adapters).
 * Default implementation: ExpoDeviceInfo (expo-localization/application/device).
 * ExpoDeviceInfo self-degrades to empty values when Expo device APIs are absent.
 */
export interface DeviceInfoAdapter {
    collect(): {
        meta: Record<string, string>;
        appVersion?: string;
        osVersion?: string;
    };
}
/**
 * Category definition passed to DisplayAdapter.setCategories().
 */
export interface CategoryDef {
    identifier: string;
    actions: Array<{
        identifier: string;
        buttonTitle: string;
        opensAppToForeground?: boolean;
        isDestructive?: boolean;
    }>;
}
/**
 * Display adapter abstraction — seam for #811 (onReceived/onDismissed).
 * Handles notification response listening and category registration.
 */
export interface DisplayAdapter {
    /** Subscribe to notification tap/action events. Returns an unsubscribe function. */
    onResponse(cb: (info: {
        notificationId?: string | number;
        actionId?: string;
    }) => void): () => void;
    /**
     * Like `onResponse`, with the push data, the tap that launched the app, and the dismiss action. The client uses
     * it for the tracking of `opened` and for `onNotificationOpened` when the adapter has it, and `onResponse`
     * otherwise (an adapter written before it existed keeps working, with an empty `data`).
     */
    onOpened?(cb: (info: OpenedInfo) => void): () => void;
    /**
     * Subscribe to notification delivery/display events (foreground).
     * Returns an unsubscribe function. (#811)
     */
    onReceived(cb: (info: {
        notificationId?: string | number;
    }) => void): () => void;
    /**
     * Subscribe to notification dismissed events.
     * Returns an unsubscribe function. (#811)
     */
    onDismissed(cb: (info: {
        notificationId?: string | number;
    }) => void): () => void;
    /** Whether this adapter can register notification categories in the current env. */
    supportsCategories(): boolean;
    /** Register notification categories on the device. */
    setCategories(categories: CategoryDef[]): Promise<void>;
}
/**
 * What a DisplayAdapter reports for one tap (`DisplayAdapter.onOpened`).
 */
export interface OpenedInfo {
    notificationId?: string | number;
    /** The id of the action button, or the default action of the library for a tap on the notification itself. */
    actionId?: string;
    /** The push data. Empty when the library gave none. */
    data?: Record<string, unknown>;
    /** True for the tap that launched the app from the closed state. */
    coldStart?: boolean;
    /** True for the dismiss action: tracked as before, but not a tap for the app. */
    dismissed?: boolean;
}
/**
 * What the app receives for a tap on a notification (`onNotificationOpened`).
 */
export interface NotificationOpenedEvent {
    /** The Espresso Notify id of the notification, from `data.notificationId`. */
    notificationId?: string | number;
    /** The data of the push: the `payload` of the send plus `notificationId`. */
    data: Record<string, unknown>;
    /** The `url` key of the data, when it is a non-empty string. Opened only if `handleDeepLinks` allows it. */
    url?: string;
    /** The id of the action button that was tapped; `undefined` for a tap on the notification itself. */
    actionId?: string;
}
export type NotificationOpenedHandler = (event: NotificationOpenedEvent) => void | Promise<void>;
/**
 * SHA-256 over the raw bytes of `input` (interpreted as a Latin-1 byte string
 * — each char code is one byte, 0-255). Used when the input is already binary
 * data encoded as a string. Returns lowercase hex digest.
 * @internal
 */
export declare function sha256Hex(input: string): string;
/**
 * SHA-256 over the UTF-8 encoding of `input`. Returns lowercase hex digest.
 * Use this for request body strings (which may contain non-ASCII).
 * @internal
 */
export declare function sha256HexUtf8(input: string): string;
/**
 * Sort a raw query string and re-encode it so the result is byte-for-byte
 * identical to the server's `reqsign.SortRawQuery` (which delegates to Go's
 * `url.Values.Encode`). Returns "" for an empty/missing query string.
 *
 * Algorithm (mirrors `reqsign.SortRawQuery` byte-for-byte):
 *   1. Strip a leading "?"; an empty remainder yields "".
 *   2. Split on "&", dropping empty segments. Each segment splits on the FIRST
 *      "=" into key/value (a segment with no "=" has an empty value).
 *   3. URL-decode key and value (so encoding differences normalise).
 *   4. Group values by key; sort each key's values ascending (codepoint), then
 *      sort the keys ascending (codepoint).
 *   5. Re-encode each key/value with a Go-`QueryEscape`-compatible encoder and
 *      emit "key=value" pairs joined by "&".
 *
 * Note: no current SDK endpoint sends a query string, so this is correctness
 * insurance for future signed GETs.
 * @internal
 */
export declare function sortQuery(rawQuery: string): string;
/**
 * Build the canonical string for request signing.
 *
 * Field order (MUST match server byte-for-byte):
 *   method\npath\nsortedQuery\nbodySHA256Hex\ntimestamp\nnonce\ndeviceId
 *
 * @param method        - HTTP method (e.g. "POST")
 * @param path          - URL path only (e.g. "/v1/devices/register")
 * @param sortedQuery   - Sorted+re-encoded query string ("" when none)
 * @param bodySHA256Hex - Lowercase hex SHA-256 of the raw request body
 * @param timestamp     - Unix seconds as string
 * @param nonce         - Random nonce string
 * @param deviceId      - Per-install device ID
 * @internal
 */
export declare function buildCanonical(method: string, path: string, sortedQuery: string, bodySHA256Hex: string, timestamp: string, nonce: string, deviceId: string): string;
/**
 * KeyStore — persistent key-value storage for signing identity.
 * Implementations: ExpoSecureKeyStore (expo-secure-store), AsyncStorageKeyStore
 * (@react-native-async-storage/async-storage), MemoryKeyStore (last fallback).
 */
export interface KeyStore {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    /**
     * Deletes the value of `key`. Optional: a store without it is wiped by writing an empty text, which every reader of
     * these keys treats as no value. `wipeLocalData` uses it. @internal
     */
    removeItem?(key: string): Promise<void>;
    /**
     * The storage object this store reads and writes (for example the `expo-secure-store` module). Two `KeyStore` objects
     * over one storage name the same object here, so the SDK knows they hold one device id; without it a store stands for
     * itself. @internal
     */
    readonly backing?: object;
}
/** In-memory KeyStore — used in tests and as the last fallback, when no persistent store is installed. */
export declare class MemoryKeyStore implements KeyStore {
    private readonly _store;
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    /** @internal */
    removeItem(key: string): Promise<void>;
}
/** ExpoSecureKeyStore — wraps expo-secure-store (optional peer dep). */
export declare class ExpoSecureKeyStore implements KeyStore {
    private readonly _secureStore;
    constructor(secureStore: {
        getItemAsync(key: string): Promise<string | null>;
        setItemAsync(key: string, value: string): Promise<void>;
        deleteItemAsync?(key: string): Promise<void>;
    });
    /** The `expo-secure-store` module itself: two wrappers of it are one storage. @internal */
    get backing(): object;
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    /** @internal */
    removeItem(key: string): Promise<void>;
}
/**
 * Signer — wraps react-native-secure-sign for hardware-bound ECDSA-P256 key ops.
 * All methods are null/throw-safe; `isSupported()` lets callers gate on hardware support.
 */
export interface Signer {
    /** Generate a new ECDSA-P256 key pair identified by keyId. Returns base64 SPKI public key. */
    generate(keyId: string): Promise<string>;
    /** Sign dataBase64 (base64-encoded data) with the key identified by keyId. Returns base64 P1363 sig. */
    sign(keyId: string, dataBase64: string): Promise<string>;
    /** Retrieve the stored public key for keyId, or null if not found. */
    getPublicKey(keyId: string): Promise<string | null>;
    /** Returns true when the device/platform supports hardware key storage. */
    isSupported(): Promise<boolean>;
    /**
     * Deletes the key pair identified by keyId. Optional: a signer without it leaves the key in the hardware, and the next
     * `generate` for the same id replaces it. `wipeLocalData` uses it. @internal
     */
    deleteKey?(keyId: string): Promise<void>;
}
/**
 * AsyncStorageKeyStore — wraps @react-native-async-storage/async-storage (optional peer dep).
 * The KeyStore holds only the device id and the PUBLIC key of request signing (the private
 * key stays inside the native signer), so it does not need secure storage; it needs to
 * survive a cold start, so the device id does not change on every launch.
 */
export declare class AsyncStorageKeyStore implements KeyStore {
    private readonly _storage;
    constructor(_storage: {
        getItem(key: string): Promise<string | null>;
        setItem(key: string, value: string): Promise<unknown>;
        removeItem?(key: string): Promise<unknown>;
    });
    /** The async-storage module itself: two wrappers of it are one storage. @internal */
    get backing(): object;
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    /** @internal */
    removeItem(key: string): Promise<void>;
}
/**
 * Every key the SDK writes to the storage of the app. `wipeLocalData` deletes each of them (the test enumerates this
 * constant, so a key added here without a deletion fails it). A value that ends in `.` is a prefix: the real key
 * follows it (the offline queue adds the project id, the device id and the chunk number).
 * @internal
 */
export declare const RN_STORAGE_KEYS: {
    readonly deviceId: "espresso.deviceId";
    readonly signingPublicKey: "espresso.signingPublicKey";
    readonly eventQueue: "espresso.eventQueue.";
    readonly registration: "espresso.registration.";
    readonly consent: "espresso.consent";
};
/**
 * The key that `wipeLocalData` keeps on purpose: the choice of `disableSDK` holds until `enableSDK`, an erase included
 * (the iOS and Android SDKs do the same). @internal
 */
export declare const RN_KEPT_STORAGE_KEYS: {
    readonly disabled: "espresso.disabled";
};
/**
 * SigningSession — lazy-initialized per-install identity.
 * Generates + persists deviceId and ECDSA-P256 key pair on first use.
 * @internal
 */
declare class SigningSession {
    private readonly _keyStore;
    private readonly _signer;
    private _deviceId;
    private _publicKey;
    private _initialized;
    constructor(_keyStore: KeyStore, _signer: Signer);
    ensureInitialized(): Promise<void>;
    get deviceId(): string | null;
    get publicKey(): string | null;
    /** Forgets the id and the key held in memory, so the next use makes new ones (after `wipeLocalData`). */
    reset(): void;
}
/**
 * Result of a successful native attestation. The discriminator `provider` tells
 * the backend which verification path to run:
 *   - 'apple-appattest' → iOS App Attest. `keyId` = base64(SHA256(pubkey)),
 *     `attestation` = base64 CBOR attestation object.
 *   - 'play-integrity'  → Android Play Integrity (via Firebase App Check).
 *     `appCheckToken` = the App Check JWT.
 */
export interface AttestationResult {
    provider: 'apple-appattest' | 'play-integrity';
    /** iOS only — base64(SHA256(public key)) returned by the native module. */
    keyId?: string;
    /** iOS only — base64-encoded CBOR attestation object. */
    attestation?: string;
    /** Android only — Firebase App Check token (Play Integrity backed). */
    appCheckToken?: string;
}
/**
 * AttestationProvider — seam for #814 device attestation.
 *
 * Mirrors the request-signing (#813) `Signer` seam: the native module is an
 * integrator-supplied OPTIONAL peer dep. The SDK never hard-requires it; when a
 * provider is unavailable `isSupported()` returns false and `Devices.attest()`
 * degrades gracefully (no throw, no network call).
 *
 * Concrete implementations: NullAttestationProvider (always unsupported),
 * ExpoAppAttestProvider (iOS), FirebaseAppCheckProvider (Android).
 */
export interface AttestationProvider {
    /** Whether this device/platform can produce an attestation right now. */
    isSupported(): boolean | Promise<boolean>;
    /**
     * Run the native attestation flow for the given server challenge.
     * Returns the provider-specific material the backend's /v1/attest/verify needs.
     */
    attest(challenge: string): Promise<AttestationResult>;
}
/**
 * NullAttestationProvider — no-op provider. `isSupported()` is always false, so
 * `Devices.attest()` short-circuits to `{ attested: false }`. Used when neither
 * the iOS nor the Android native module is available (e.g. web/test/Expo Go).
 */
export declare class NullAttestationProvider implements AttestationProvider {
    isSupported(): boolean;
    attest(_challenge: string): Promise<AttestationResult>;
}
/**
 * ExpoAppAttestProvider — iOS App Attest provider.
 *
 * Like `react-native-secure-sign` (#813), the underlying native module is an
 * integrator-supplied OPTIONAL peer dependency: the SDK lazy-requires it and
 * degrades gracefully (provider resolves to Null) when it is absent. The default
 * module is `react-native-ios-appattest`, loaded with a static `require` so Metro
 * can resolve it. To use another App Attest package, import it in your app and
 * pass it as `nativeModule` (a module name computed at runtime never resolves
 * under Metro).
 *
 * The expected native surface is the one `react-native-ios-appattest` exports:
 *   generateKeys(): Promise<string>                          // → keyId
 *   attestKeys(keyId, challengeHashBase64): Promise<string>  // → base64 CBOR attestation
 * `challengeHashBase64` is the base64 of the SHA-256 of the challenge (Apple's `clientDataHash`); the provider
 * computes it from the UTF-8 bytes of the challenge string, which is what the backend hashes when it verifies.
 *
 * `attest()` returns `{ provider: 'apple-appattest', keyId, attestation }`.
 * `isSupported()` is true only when the module resolves AND the platform is iOS.
 */
export declare class ExpoAppAttestProvider implements AttestationProvider {
    private readonly _nativeModule;
    private _module;
    private _loaded;
    constructor(options?: {
        nativeModule?: unknown;
    });
    private _resolveModule;
    isSupported(): boolean;
    attest(challenge: string): Promise<AttestationResult>;
}
/**
 * FirebaseAppCheckProvider — Android Play Integrity provider, backed by
 * `@react-native-firebase/app-check` (the REAL standard package). Lazy-required
 * as an OPTIONAL peer dep; absent → provider resolves to Null (graceful).
 *
 * `attest()` calls `getToken(forceRefresh?)` and returns
 * `{ provider: 'play-integrity', appCheckToken }`. `isSupported()` is true when
 * the module resolves (and, defensively, the platform is not iOS).
 */
export declare class FirebaseAppCheckProvider implements AttestationProvider {
    private _appCheck;
    private _loaded;
    private readonly _forceRefresh;
    constructor(options?: {
        forceRefresh?: boolean;
    });
    private _resolveModule;
    isSupported(): boolean;
    attest(_challenge: string): Promise<AttestationResult>;
}
/** Which stack sends the requests of a client (`ClientConfig.privateTransport`). */
export type PrivateTransportMode = 'auto' | 'native' | 'js';
/** Which transport a client ended up with (`PushClient.transportKind`). */
export type TransportKind = 'native' | 'js' | 'custom';
/**
 * NullDisplayAdapter — DisplayAdapter no-op for environments where
 * expo-notifications is absent.
 */
/**
 * BareDisplayAdapter — DisplayAdapter backed by react-native-notify-kit
 * (maintained Notifee fork) for bare React Native (no expo-notifications).
 *
 * NOTE: only foreground taps + cold-start are wired here. Background/quit-state
 * tap events require the host app to register notify-kit's `onBackgroundEvent`
 * at startup (before AppRegistry) and forward them — that wiring is a follow-up
 * (task #811) and is intentionally not done here.
 */
export declare class BareDisplayAdapter implements DisplayAdapter {
    onResponse(cb: (info: {
        notificationId?: string | number;
        actionId?: string;
    }) => void): () => void;
    /**
     * The taps with their data, from both sources of this mode: react-native-notify-kit (a notification it
     * displays: foreground presses, and the one that launched the app) and @react-native-firebase/messaging (a push
     * the system displayed: `onNotificationOpenedApp`, and `getInitialNotification` for the one that launched the
     * app). Either may be absent. The launch tap is handed over once, whichever source reports it first.
     */
    onOpened(cb: (info: OpenedInfo) => void): () => void;
    onReceived(cb: (info: {
        notificationId?: string | number;
    }) => void): () => void;
    onDismissed(cb: (info: {
        notificationId?: string | number;
    }) => void): () => void;
    supportsCategories(): boolean;
    setCategories(categories: CategoryDef[]): Promise<void>;
}
export interface Capabilities {
    /** expo-notifications resolved at runtime. */
    expoNotifications: boolean;
    /** @react-native-firebase/messaging resolved at runtime. */
    firebaseMessaging: boolean;
    /** react-native-notify-kit resolved at runtime. */
    notifyKit: boolean;
    /** Which PushProvider auto-detection would select. */
    pushProvider: "expo" | "bare" | "none";
    /** Which DisplayAdapter auto-detection would select. */
    displayAdapter: "expo" | "bare" | "none";
    /**
     * Certificate pinning is possible: react-native-ssl-public-key-pinning resolved at runtime, or the native module of
     * the SDK is linked and speaks a contract version this SDK supports.
     */
    sslPinning: boolean;
    /**
     * Certificate pinning is on for the path the SDK takes by default (the native module's pins when it is usable, else
     * the library's): enableCertificatePinning or enableEspressoPinning succeeded and disableCertificatePinning has not
     * run since. Pinning is off by default, so this is false until the app turns it on.
     */
    pinningActive: boolean;
    /** The native module of the SDK is linked and speaks a contract version this SDK supports, so `'auto'` sends through it. */
    nativeTransport: boolean;
}
/**
 * Introspect which native integrations the SDK detected at runtime. Useful for
 * debugging (e.g. "why is my push token null?") across Expo vs bare React Native.
 * Explicit override of any adapter is still available via ClientConfig
 * (`transport`/`displayAdapter`/`deviceInfo`) and the hook's `provider` option.
 */
export declare function capabilities(): Capabilities;
/**
 * `ClientConfig.offlineQueue`: the queue that keeps the events the SDK could not deliver and sends them again.
 */
export interface OfflineQueueConfig {
    /** Keep and retry the events that fail. Default: true. With false, an event that fails is dropped, as it always was. */
    enabled?: boolean;
    /** The most events kept (1 to 1000); beyond it the oldest are dropped and counted. Default: 200. */
    maxItems?: number;
}
/** What `client.queueStats()` reports. */
export interface OfflineQueueStats {
    /** Events waiting to be sent. */
    pending: number;
    /** Events given up on since the queue was created: over the cap, older than 3 days, or refused by the server for good. */
    dropped: number;
}
type QueueOutcome = {
    kind: 'ok';
} | {
    kind: 'retry';
    network: boolean;
    retryAfterMs?: number;
    race?: true;
} | {
    kind: 'refused';
    status: number;
    code?: string;
} | {
    kind: 'sdk';
};
/** How the queue judges the failure of one send. @internal */
export declare function _classifySendError(error: unknown): QueueOutcome;
/**
 * How many events the SDK holds while the app has not given consent (`requireConsent`), the oldest dropped first. The
 * number is `consent.buffer_events` of `sdk-parity/constants.json`, the same as the iOS and Android SDKs.
 * @internal
 */
export declare const CONSENT_BUFFER_EVENTS = 100;
/**
 * Whether the client may use the network. Two things close it: `disableSDK` (until `enableSDK`) and, with `requireConsent`,
 * the lack of consent (until `setConsent(true)`). Both answers are kept in the store and read after the client was made;
 * `ready` settles when they were. Until then a gate that needs consent is closed, and a request waits for `ready`.
 * @internal
 */
declare class NetworkGate {
    private readonly _required;
    private readonly _store;
    private _consent;
    private _disabled;
    private _consentTouched;
    private _disabledTouched;
    private _loaded;
    readonly ready: Promise<void>;
    private readonly _openListeners;
    private readonly _disabledListeners;
    constructor(_required: boolean, _store: KeyStore);
    /** Reads the answers of an earlier run. A store that fails to answer leaves the gate as it is. */
    private _restore;
    /** True once the answers of an earlier run were read (or could not be). */
    get loaded(): boolean;
    get required(): boolean;
    get disabled(): boolean;
    isOpen(): boolean;
    /** Calls `listener` every time the gate goes from closed to open. */
    onOpen(listener: () => void): void;
    /** Calls `listener` when the SDK is turned off: with `disableSDK`, and when the stored answer says it was. */
    onDisabled(listener: () => void): void;
    private _notify;
    /** Records the answer of the user. Without `requireConsent` there is no gate, and nothing changes. Never throws. */
    setConsent(granted: boolean): Promise<void>;
    /** Turns the SDK off, and keeps that across restarts. Never throws. */
    disable(): Promise<void>;
    /** Turns the SDK on again. Never throws. */
    enable(): Promise<void>;
    /** Back to no consent, after `wipeLocalData`. The choice of `disableSDK` stays. */
    reset(): void;
}
/**
 * The offline queue: sends an event now, keeps it when the send fails for a reason that can pass, and sends it again
 * later. Used by `Devices` for the events it reports (opens, clicks, conversions, custom and lifecycle events).
 * @internal
 */
declare class EventQueue {
    private readonly _request;
    private readonly _getToken;
    /** `espresso.eventQueue.<projectId>`: the prefix of the key of the queue; the device id of the install follows it. */
    private readonly _storageKey;
    /** `requireConsent`: while it is closed nothing is sent and the events wait here, at most `CONSENT_BUFFER_EVENTS`. */
    private readonly _gate;
    /** The queue of this project and device id; null while the id cannot be read (`_attachStore`): memory only until then. */
    private _store;
    private _attaching;
    private readonly _keyStore;
    private readonly _maxItems;
    private readonly _persistent;
    private _items;
    private _dropped;
    private _loading;
    private _loadedOnce;
    private _chain;
    /** A `Retry-After` from the server: nothing is sent before this time, a forced flush excepted. */
    private _retryAfterUntil;
    /** The wait of the last failure: the periodic retry does not start before it. */
    private _holdUntil;
    private _timer;
    private _destroyed;
    constructor(_request: RequestFn, _getToken: TokenGetter, store: KeyStore, persistent: boolean, 
    /** `espresso.eventQueue.<projectId>`: the prefix of the key of the queue; the device id of the install follows it. */
    _storageKey: string, maxItems: number, 
    /** `requireConsent`: while it is closed nothing is sent and the events wait here, at most `CONSENT_BUFFER_EVENTS`. */
    _gate?: NetworkGate | null);
    /** Sends the event now; keeps it for later when it fails in a way that can pass. Never throws. */
    send(path: string, body: Record<string, unknown>, withEventId: boolean): Promise<void>;
    /**
     * Keeps an event until the app gives consent: in memory only, never written, and at most `CONSENT_BUFFER_EVENTS` of
     * them (the oldest go first). No request is made. Never throws.
     */
    private _hold;
    /** The app gave consent: what waited for it is sent now. Never throws. */
    release(): Promise<void>;
    /** Keeps an event whose send failed in a way that can pass; `paused`: a Retry-After holds the queue, so no request was made. */
    private _keepRetry;
    /** The time (ms) until which a `Retry-After` holds every request, or 0. */
    pausedUntil(): number;
    /** Keeps an event for later with the outcome of the failure that held it (the events of a batch that failed). Never throws. */
    keep(path: string, body: Record<string, unknown>, outcome: Extract<QueueOutcome, {
        kind: 'retry';
    }>): Promise<void>;
    /** An event the server refused for good (status 200: rejected inside a batch it accepted; 0: an error of the SDK). Never throws. */
    refused(status: number, code?: string): Promise<void>;
    /** A request worked: the network is back, so the events that waited go too. */
    delivered(): void;
    /** Sends what waits. 'due': the items whose time came. 'foreground': all, but not through a Retry-After. 'force': all. */
    flush(mode: 'due' | 'foreground' | 'force'): Promise<void>;
    /** Reads what the last run left, and arranges for it to be sent when its time comes. */
    start(): void;
    /** The client got a push token: what waited for one is sent when its time comes (now, if it is already due). */
    tokenSet(): void;
    stats(): Promise<OfflineQueueStats>;
    destroy(): void;
    /**
     * Drops every event that waits, in memory and in the store, and every wait the server asked for. The next use opens
     * the queue again under whatever device id the install has by then. Never throws.
     */
    wipe(): Promise<void>;
    private _flush;
    private _serial;
    /**
     * The stored queue of this project and install: `<storageKey>.<device id>`, the device id being the
     * `espresso.deviceId` that request signing already keeps (created here when it is not there yet, and never replaced).
     * Throws when the id cannot be read (a locked store): there is then no key, and the queue stays in memory.
     */
    private _openStore;
    /** The items and the dropped count of a stored text, safe to keep: see the comments inside. */
    private _adopt;
    /**
     * Opens the stored queue and merges it with the memory (by event id), then writes it; true when open. Retried on each
     * send and flush while the device id cannot be read.
     */
    private _attachStore;
    private _load;
    /** Writes the queue; false when the write did not land (the queue keeps working in memory). */
    private _persist;
    private _applyCap;
    /** Drops the items past the age limit. */
    private _expire;
    private _countRefused;
    private _pass;
    /** One timer, for the soonest moment something can be sent. */
    private _schedule;
}
export interface ClientConfig {
    projectId: string;
    /**
     * Sends nothing until the app calls `setConsent(true)`. While consent is missing the client makes no request:
     * the events it would report wait in memory (at most 100, the oldest dropped first) and are sent once consent is
     * given, and the other calls (`register`, `identify`, ...) reject with `EspressoNotifyError` of code
     * `CONSENT_REQUIRED`. The answer is kept across restarts. Default: false (no gate).
     */
    requireConsent?: boolean;
    pushToken?: string;
    platform?: "ios" | "android";
    /**
     * Push provider discriminator ('expo' | 'fcm' | 'apns').
     * Forwarded to register() so the backend can route the token correctly.
     * Defaults to 'expo' when unset and the token was acquired via ExpoPushProvider.
     */
    provider?: 'expo' | 'fcm' | 'apns';
    /**
     * Automatically track open events when the user taps a push notification.
     * Reads `notificationId` from the notification's data payload.
     * Default: true
     */
    autoTrack?: boolean;
    /**
     * Called once for every tap on a notification, with `{ notificationId, data, url, actionId }`: while the app
     * runs, and for the tap that launched it from the closed state. It is the same as
     * `client.onNotificationOpened(handler)`, registered before the first tap can arrive. The tracking of `opened`
     * does not depend on it, and an error it throws is swallowed.
     */
    onNotificationOpened?: NotificationOpenedHandler;
    /**
     * Let the SDK open the link of a tap: the `url` key of the push data, with `Linking.openURL`, after your
     * `onNotificationOpened` handler ran. Only the schemes and hosts of `deepLinkAllowList` open, never
     * `javascript:`, `data:`, `file:`, `vbscript:`, `blob:`, `about:`, `intent:` or `content:`, and only a tap on the
     * notification itself (not on an action button). With it off, nothing opens and your handler still gets `url`.
     *
     * Default: **false**.
     */
    handleDeepLinks?: boolean;
    /**
     * Where `handleDeepLinks` may send the app. Each entry is a scheme (`'myapp://'` or `'myapp:'`) or an HTTPS
     * origin (`'https://shop.example.com'`, a host and an optional port, no path, no wildcard). `'https://'` alone
     * allows every HTTPS URL; name a host instead. An entry of another shape is ignored. A URL that matches no entry
     * is not opened. Default: none, so nothing opens.
     */
    deepLinkAllowList?: string[];
    /**
     * The offline queue: an event the SDK reports (open, click, received, dismissed, conversion, custom event,
     * lifecycle event) and cannot deliver is kept, saved with the store the SDK finds (SecureStore, else AsyncStorage,
     * else memory), and sent again with a growing wait, when the app returns to the foreground, on the next call and
     * on `flush()`. A `Retry-After` is honored; a refusal that retrying cannot fix (a 4xx other than 408 and 429)
     * drops the event, except a lifecycle event answered 404 `token_not_found` (it can race the register of its token):
     * that one is tried 4 times in all. The store is keyed by the project and the device id of the install
     * (`espresso.deviceId`). A token rotation and an identity change hold push tokens or a user id, so they wait in
     * memory only and are never written to the store. `enabled: false` restores the old behavior: one attempt, the error dropped.
     *
     * Default: `{ enabled: true, maxItems: 200 }`.
     */
    offlineQueue?: OfflineQueueConfig;
    /** @internal Override the store of the offline queue for testing. */
    _queueStore?: KeyStore;
    /**
     * Asks your app for a new identity token when the server refuses one as expired (401 `identity_token_expired`).
     * The client calls it once with the `externalId` of the user, keeps the token it returns in memory, and repeats
     * the call once. Without it, a call with an expired token fails with that error. A provider that throws, or a
     * repeated call that fails again, also ends in the error, with no further try. Never called for any other error.
     */
    identityTokenProvider?: IdentityTokenProvider;
    /**
     * Optional custom Transport implementation (for testing or alternative HTTP stacks).
     * When not provided, FetchTransport is used.
     */
    transport?: Transport;
    /**
     * Which stack sends the requests of the SDK. `'auto'` (the default) sends through the native module of the SDK when
     * it is linked and speaks a contract version this SDK supports, and through `fetch` otherwise. `'native'` always uses
     * the native module and refuses every call with `NATIVE_TRANSPORT_UNAVAILABLE`, sending nothing, when it is not
     * usable. `'js'` always uses `fetch`. A `transport` of your own wins over all three. `client.transportKind` tells
     * which one a client uses.
     *
     * The native module keeps the calls of the SDK out of the JavaScript network inspectors (Reactotron, the React Native
     * DevTools Network panel, the Expo Network panel). It is not a security measure: a proxy or a native profiler still
     * sees the traffic.
     */
    privateTransport?: PrivateTransportMode;
    /**
     * @internal The API url, for the tests of the native path: the url is written into the build and the source has a
     * placeholder, which the native transport (it checks the scheme) does not accept.
     */
    _apiUrl?: string;
    /**
     * Optional custom DisplayAdapter (for testing or non-Expo environments).
     * When not provided, auto-selected based on expo-notifications availability.
     */
    displayAdapter?: DisplayAdapter;
    /**
     * Optional custom DeviceInfoAdapter (for testing or non-Expo environments).
     * When not provided, ExpoDeviceInfo is used (returns empty when Expo APIs absent).
     */
    deviceInfo?: DeviceInfoAdapter;
    /**
     * Enable hardware-bound request signing (#813).
     *
     * When true: generates a per-install ECDSA-P256 key pair (via
     * `react-native-secure-sign`, optional peer dep), persists it in
     * `expo-secure-store` (optional peer dep, falls back to memory), and signs
     * every request (all methods) with X-KM-* headers.
     * Also includes `signing_public_key`, `signing_key_type`, and `device_id`
     * in the `register()` payload.
     *
     * Default: **false** — behaviour is byte-identical to previous releases.
     * Requires the backend project to have `require_signing=true` to enforce
     * signature verification.
     *
     * Optional: supply your own `keyStore` and/or `signer` for testing.
     */
    enableSigning?: boolean;
    /**
     * Refuse every request while certificate pinning is not active.
     *
     * Pinning is off by default and `enableEspressoPinning` returns `false` (it never
     * throws) when the library is missing or the pins are refused, so an app that
     * forgot it would otherwise run unpinned without a sign. With `requirePinning:
     * true` each call fails with an `EspressoNotifyError` of code `PINNING_NOT_ACTIVE`
     * and nothing is sent, until `enableCertificatePinning` or `enableEspressoPinning`
     * succeeds. The calls that never throw (the tracking events) are dropped.
     * Applies to the default transport and to one you pass in `transport`.
     *
     * Default: **false**.
     */
    requirePinning?: boolean;
    /** @internal Override KeyStore for testing. */
    _keyStore?: KeyStore;
    /** @internal Override Signer for testing. */
    _signer?: Signer;
    /**
     * Enable device attestation orchestration (#814).
     *
     * When true: `devices.attest()` runs the native attestation flow
     * (challenge → native attest → verify) and FLAGS the existing per-install
     * signing key as attested on the backend (register-first; it does NOT replace
     * the signing key). On iOS this uses Apple App Attest; on Android it uses
     * Play Integrity via Firebase App Check. Both native modules are OPTIONAL peer
     * deps — when absent, `attest()` is a graceful no-op.
     *
     * **Requires `enableSigning: true`.** Attestation is bound to the persisted
     * per-install `device_id` (the same value sent as `X-KM-Device-Id`), which is
     * produced by the signing session. Without signing there is no stable
     * device_id to attest, so `attest()` no-ops.
     *
     * Default: **false** — total no-op; behaviour is byte-identical to releases
     * without attestation, and no network call is made.
     */
    enableAttestation?: boolean;
    /** @internal Override AttestationProvider for testing. */
    _attestationProvider?: AttestationProvider;
}
type RequestFn = (path: string, options?: RequestInit) => Promise<unknown>;
type TokenGetter = () => string | undefined;
type PlatformGetter = () => "ios" | "android" | undefined;
type ProviderGetter = () => 'expo' | 'fcm' | 'apns' | undefined;
export declare class PushClient {
    private readonly projectId;
    private readonly baseURL;
    private _pushToken?;
    private _platform?;
    private _provider?;
    /** All active auto-tracking unsubscribes — cleaned up in destroy(). */
    private _trackingUnsubscribes;
    private readonly _transport;
    /** Which stack sends the requests: `'native'` (the native module), `'custom'` (`ClientConfig.transport`) or `'js'` (`fetch`). */
    readonly transportKind: TransportKind;
    private readonly _displayAdapter;
    private readonly _autoTrack;
    /** The handlers of onNotificationOpened, in the order they were registered. */
    private _openedHandlers;
    /** The tap that launched the app, when it arrived before any handler existed; the first handler gets it. */
    private _pendingLaunchTap;
    /** The last pushes whose dismissal was recorded, so that two listeners of one response record it once. */
    private _dismissedSeen;
    private _responseListening;
    private readonly _handleDeepLinks;
    private readonly _allowList;
    private readonly _queue;
    /** The batcher of the delivery events; there with the offline queue, which keeps what it cannot send. */
    private readonly _batcher;
    /** The stores that hold the keys of `RN_STORAGE_KEYS` (the one of request signing, the one of the queue), each once. */
    private readonly _wipeStores;
    private _signingSession;
    private _signer;
    private readonly _gate;
    private readonly _gateTransport;
    readonly devices: Devices;
    /** @internal What the hooks sent that worked, by session: they register and identify only on a change or a new session. */
    readonly registration: RegistrationTracker;
    constructor(config: ClientConfig);
    /**
     * Sends every event the offline queue is holding, now: the wait of each event and a `Retry-After` do not hold it
     * back. Resolves when the pass ends and never rejects; an event that fails again stays queued. It does nothing
     * when the queue is turned off.
     */
    flush(): Promise<void>;
    /**
     * How many events wait in the offline queue, and how many it gave up on (over the cap, older than 3 days, or
     * refused by the server for good). Both are 0 when the queue is turned off.
     */
    queueStats(): Promise<OfflineQueueStats>;
    /**
     * Deletes everything the SDK keeps on this device, and nothing on the server: the events that wait in the offline
     * queue, the install id (`espresso.deviceId`), the request signing key, the record of what was registered, the user
     * and the identity tokens the client holds. The SDK stores no push token, and the one the client holds in memory stays,
     * so the next `register` needs no new one. It is the local half of `forgetDevice`, which calls it after the server
     * confirms the erase. Resolves when it is done and never rejects.
     *
     * The client stays usable: the next `register` makes a new install id.
     *
     * @example
     * await push.wipeLocalData()
     */
    wipeLocalData(): Promise<void>;
    /**
     * Tells the client whether the user gave consent. Only matters with `requireConsent`. `true` lets the client make
     * requests and sends the events that waited; it is kept across restarts. `false` closes the gate again and removes
     * the kept answer; what is already stored stays until it is sent or erased. Resolves when it is done and never
     * rejects.
     *
     * @example
     * await push.setConsent(true)
     */
    setConsent(granted: boolean): Promise<void>;
    /**
     * Turns the SDK off: it makes no request, reports nothing and holds no event, and the events that wait are deleted,
     * in memory and in the store. The choice is kept and holds after the app restarts, until `enableSDK()`. The calls
     * that need the server reject with `EspressoNotifyError` of code `SDK_DISABLED`. `wipeLocalData` and `forgetDevice`
     * leave the choice as it is. Resolves when it is done and never rejects.
     *
     * @example
     * await push.disableSDK()
     */
    disableSDK(): Promise<void>;
    /**
     * Turns the SDK on after `disableSDK()`: requests go out again, and what the app reports from now on is sent. What was
     * reported while it was off is gone. With `requireConsent`, consent is still asked for. Resolves when it is done and
     * never rejects.
     *
     * @example
     * await push.enableSDK()
     */
    enableSDK(): Promise<void>;
    /** The install id and the public key of request signing, in each store, and the signing key in the native signer. */
    private _eraseKeys;
    /**
     * Calls `handler` once for every tap on a notification, with `{ notificationId, data, url, actionId }`, while the
     * app runs and for the tap that launched it. Returns a function that removes the handler.
     *
     * The tap that launched the app can arrive before your code runs (the hook creates its client after it
     * registered the device). When it arrived while no handler existed, the first handler registered gets it, once.
     * A tap while the app runs with no handler is not kept.
     *
     * Your handler's errors are swallowed and never reach the tracking. See `handleDeepLinks` to let the SDK open
     * the link of the notification.
     *
     * @example
     * const off = push.onNotificationOpened(({ data, url }) => router.push(url ?? `/orders/${data.orderId}`))
     */
    onNotificationOpened(handler: NotificationOpenedHandler): () => void;
    /** Starts the one listener for taps (tracking and handlers), if it is not running. */
    private _listenForTaps;
    /** Records `dismissed` for a push once, whichever listener reports it first (the dismissal listener or the response one). */
    private _trackDismissedOnce;
    /**
     * One response. A dismissal records `dismissed` (never `opened`) and reaches no handler. A tap: the tracking of
     * `opened` starts first, exactly as it did before the callback existed, then the handlers.
     */
    private _handleTap;
    /** Opens the link of a tap if the allow-list lets it; every failure ends here. */
    private _openLink;
    /** Calls one handler; a throw or a rejection ends here. */
    private _callHandler;
    get pushToken(): string | undefined;
    set pushToken(value: string | undefined);
    get platform(): "ios" | "android" | undefined;
    set platform(value: "ios" | "android" | undefined);
    get provider(): 'expo' | 'fcm' | 'apns' | undefined;
    set provider(value: 'expo' | 'fcm' | 'apns' | undefined);
    /**
     * Registers listeners that automatically track open/received/dismissed events
     * and app_opened (influenced-open) events. Called automatically unless
     * `autoTrack: false`.
     *
     * Requires the notification payload to include `notificationId`:
     * ```json
     * { "notificationId": 42 }
     * ```
     */
    private _setupAutoTracking;
    /**
     * One listener of the app state. On the way to the foreground it reports `app_opened` (with autoTrack) and gives
     * the offline queue a chance to send what waits. AppState is lazy-required from react-native; it may be absent in
     * a web or test environment.
     */
    private _listenForForeground;
    /**
     * Removes all auto-tracking listeners. Call this when unmounting your root
     * component if you need to clean up (e.g., during hot reload in development).
     */
    destroy(): void;
    private validateProjectId;
    private warnMissingOptionalDeps;
}
/**
 * Extracts the hostname from a URL string.
 * Returns null if the URL is empty or unparseable, which is what the build placeholder is: a build that was not given
 * a URL has no host to pin. This function must not name the placeholder: the build step writes the URL into the
 * `API_URL` constant only, and fails when the placeholder is anywhere else (BUG-1).
 * @internal
 */
export declare function _extractHost(url: string): string | null;
/**
 * Enables TLS public-key pinning for the given hostnames.
 *
 * With the native module of the SDK linked, the pins go to the module, which pins the requests it sends, and to
 * `react-native-ssl-public-key-pinning` too when that is installed. Without the module only the library is used:
 * it patches the global networking layer once, and all subsequent `fetch` calls (including those made by
 * FetchTransport) are pinned.
 *
 * @param options - Map of hostname → pinning config (publicKeyHashes + optional
 *   includeSubdomains). publicKeyHashes are base64 SHA-256 of the cert SPKI.
 * @returns `true` if pinning was enabled (with the module linked: if the module accepted the pins), `false` if the
 *   library is absent and there is no module, or the pins were refused or failed to start (never throws).
 *
 * @example
 * await enableCertificatePinning({
 *   'api.espressonotify.com': {
 *     includeSubdomains: true,
 *     publicKeyHashes: ['abc123...', 'def456...'],
 *   },
 * });
 */
export declare function enableCertificatePinning(options: Record<string, {
    includeSubdomains?: boolean;
    publicKeyHashes: string[];
}>): Promise<boolean>;
/**
 * Convenience wrapper that pins the Espresso Notify API hostname derived from
 * the build-injected `API_URL`.
 *
 * Returns `false` (with a warning) if `API_URL` is still the build placeholder
 * or is otherwise unparseable — this is safe to call
 * before the URL is substituted; pinning simply won't be active.
 *
 * @param publicKeyHashes - Base64 SHA-256 hashes of the cert Subject Public Key Info.
 * @param includeSubdomains - Whether to pin subdomains too (default: `true`).
 * @returns `true` if pinning was enabled successfully, `false` otherwise.
 */
export declare function enableEspressoPinning(publicKeyHashes: string[], includeSubdomains?: boolean): Promise<boolean>;
/**
 * Disables TLS public-key pinning: clears the pins of the native module, when it is linked, and disables
 * `react-native-ssl-public-key-pinning` (if installed). No-op when neither is there.
 */
export declare function disableCertificatePinning(): Promise<void>;
export declare class Devices {
    private readonly _request;
    private readonly _getToken;
    private readonly _getPlatform;
    private readonly _getProvider;
    private readonly _deviceInfo;
    private readonly _displayAdapter;
    private readonly _signingSession;
    private readonly _attestationProvider;
    private readonly _queue;
    private readonly _batcher;
    private readonly _identityTokenProvider;
    /** Where `espresso.deviceId` is kept: register reads (or creates) the install id there when the app passes none. */
    private readonly _idStore;
    /** `PushClient.wipeLocalData`: what `forgetDevice` runs once the server no longer holds the device. */
    private readonly _wipeLocal;
    /** `requireConsent`: while it is closed the delivery events go to the queue, which holds them, not to the batcher. */
    private readonly _gate;
    /** The way a fire-and-forget report leaves (`trackAppOpened`, and the reports with no queue): in the tick of the call. */
    private readonly _requestFast;
    constructor(_request: RequestFn, _getToken: TokenGetter, _getPlatform: PlatformGetter, _getProvider: ProviderGetter, _deviceInfo: DeviceInfoAdapter, _displayAdapter: DisplayAdapter, _signingSession?: SigningSession | null, _attestationProvider?: AttestationProvider | null, _queue?: EventQueue | null, _batcher?: TrackBatcher | null, _identityTokenProvider?: IdentityTokenProvider | null, 
    /** Where `espresso.deviceId` is kept: register reads (or creates) the install id there when the app passes none. */
    _idStore?: KeyStore | null, 
    /** `PushClient.wipeLocalData`: what `forgetDevice` runs once the server no longer holds the device. */
    _wipeLocal?: (() => Promise<void>) | null, 
    /** `requireConsent`: while it is closed the delivery events go to the queue, which holds them, not to the batcher. */
    _gate?: {
        isOpen(): boolean;
    } | null, 
    /** The way a fire-and-forget report leaves (`trackAppOpened`, and the reports with no queue): in the tick of the call. */
    _requestFast?: RequestFn | null);
    /**
     * The identity token of each user the app handed over or the provider renewed, by `externalId`. In memory only:
     * never written to a store, the offline queue or a log. Emptied by `unregister` and `forgetDevice`.
     */
    private readonly _identityTokens;
    /** The provider calls under way, by `externalId`: calls of one user that expire together share one. */
    private readonly _renewals;
    /** Changes at every logout, so a renewal that ends after it does not bring a token back. */
    private _identityEpoch;
    /**
     * Runs a call that carries an identity token. The token is the one the app passed, else the one kept for
     * `externalId`. A 401 `identity_token_expired` with a provider asks it for a new token once and repeats the call
     * once; any other error, no provider, a provider that fails or a second failure rethrows the error of the call.
     */
    private _withIdentityToken;
    /** One provider call per user at a time; null when it fails, returns no text, or a logout came meanwhile. */
    private _renewIdentityToken;
    /** The user and the tokens the client holds, for `wipeLocalData`. @internal */
    _eraseIdentity(): void;
    /** The logout: no token of any user stays in the client. */
    private _forgetIdentityTokens;
    /**
     * Reports a delivery event (opened, clicked, received, dismissed). With the offline queue it goes through the batcher:
     * `opened` and `clicked` at once, `received` and `dismissed` after a random 0 to 30 s, many in one request (track-batch.ts).
     * Without it, one request now, as before. Never throws.
     */
    private _reportDelivery;
    /**
     * Reports an event to a route that takes a POST. With the offline queue, a failure that can pass keeps the event
     * for later; without it, the one attempt is made and the error is dropped. Never throws.
     * `withEventId`: the route deduplicates on an `event_id` (custom and lifecycle events), which the queue adds.
     */
    private _report;
    /** One-shot warn guard so attest() never spams logs on every boot. */
    private _attestWarned;
    /**
     * The `externalId` of the last user this client linked to the device with a
     * successful `identify` or `register`; forgotten by `unregister` and
     * `forgetDevice`. `getPreferences` and `setPreferences` use it when the app
     * does not pass one.
     */
    private _externalId;
    /** The `espresso.deviceId` of the install, created once; undefined when the store cannot be read. Never throws. */
    private _installId;
    /**
     * Registers a device token with the CMS.
     * Call this when your app starts or when the token changes.
     */
    register(data: Partial<PushUser>): Promise<unknown>;
    /**
     * Identifies a user for the current device.
     * Call this after the user logs in.
     */
    identify(user: {
        externalId: string;
        name?: string;
        metadata?: Record<string, unknown>;
        /** The proof of identity, as in `PushUser.user.identityToken`. Sent as `identity_token`. */
        identityToken?: string;
    }, pushToken?: string): Promise<unknown>;
    /**
     * Tells the server who the device belongs to now (`user.identified`): one `identity` lifecycle event with the user
     * before and after, through the offline queue. A value over 255 bytes is refused by the server, so nothing
     * is sent for it. Silent — never throws.
     */
    private _recordIdentityChange;
    /**
     * Moves the device to anonymous state (user_id = NULL).
     * Call this when the user logs out.
     *
     * The token is NOT deleted — the device continues receiving broadcast
     * notifications. Personalized sends (by user_id / external_id) are excluded
     * until `identify()` is called again on the next login.
     *
     * @example
     * // Logout
     * await push.devices.unregister();
     *
     * // Next login — no need to call register() again
     * await push.devices.identify({ externalId: user.id, name: user.name });
     */
    unregister(pushToken?: string): Promise<unknown>;
    /**
     * Tracks when a user opens a push notification.
     * Call this inside your Expo `addNotificationResponseReceivedListener`.
     * Silent — never throws errors.
     *
     * @example
     * Notifications.addNotificationResponseReceivedListener(response => {
     *   const notifId = response.notification.request.content.data?.notificationId;
     *   if (notifId) push.devices.trackOpen(notifId);
     * });
     */
    trackOpen(notificationId: string | number, pushToken?: string): Promise<void>;
    /**
     * Tracks when a notification is delivered/displayed while the app is in
     * the foreground. Silent — never throws errors. (#811)
     *
     * With the offline queue on, the report waits a random 0 to 30 s, so a crowd of devices does not report in the same
     * second, and goes in one request with the other waiting delivery reports (at most 20 each). The app leaving the
     * foreground, `flush()` and `destroy()` do not wait for it.
     */
    trackReceived(notificationId: string | number, pushToken?: string): Promise<void>;
    /**
     * Tracks when a user dismisses/swipes away a push notification.
     * Silent — never throws errors. (#811)
     *
     * Waits a random 0 to 30 s and is batched like `trackReceived`, with the offline queue on.
     */
    trackDismissed(notificationId: string | number, pushToken?: string): Promise<void>;
    /**
     * Tracks when the app is brought to the foreground (app_opened event).
     * Used by the backend to correlate influenced opens — no notification_id
     * is required; the backend matches by push_token + recent sends.
     * Silent — never throws errors. (#811)
     */
    trackAppOpened(pushToken?: string): Promise<void>;
    /**
     * Records a device lifecycle event (permission change, token rotation, identity change).
     * Silent — never throws errors. (#807)
     *
     * @param kind    - Event category: 'permission' | 'subscription' | 'identity'
     * @param from    - Previous state value
     * @param to      - New state value
     * @param externalId - User external ID (optional)
     * @param pushToken  - Override push token (optional; falls back to constructor token)
     */
    recordLifecycle(kind: 'permission' | 'subscription' | 'identity', from: string, to: string, externalId?: string, pushToken?: string): Promise<void>;
    /**
     * Tracks when a user clicks an action button in a push notification: one `clicked` event, with the id of the
     * button as `action_id` when you pass `actionId`. With `autoTrack` on, the SDK calls it for the button taps it
     * sees, so you call it yourself only when you handle the response on your own. An `actionId` the server would
     * refuse (empty, over 64 characters, a control or format character) is left out and the click still counts.
     * Silent — never throws errors.
     *
     * @example
     * Notifications.addNotificationResponseReceivedListener(response => {
     *   const notifId = response.notification.request.content.data?.notificationId;
     *   if (notifId && response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
     *     push.devices.trackClick(notifId, undefined, response.actionIdentifier);
     *   }
     * });
     */
    trackClick(notificationId: string | number, pushToken?: string, actionId?: string): Promise<void>;
    /**
     * Reports a business event of your app ("signed_up", "order.completed") to
     * Espresso Notify. It drives journeys (event triggers, waits and goals) and is
     * never counted on a notification. The name is 1 to 64 letters, digits, `_`,
     * `.`, `:` or `-`, starting with a letter or a digit; the six names of the
     * delivery lifecycle (opened, clicked, received, dismissed, converted,
     * app_opened) are refused. An invalid name sends nothing and logs a warning.
     * Silent — never throws errors, like the other track methods.
     *
     * @example
     * await push.devices.trackEvent('order.completed')
     */
    trackEvent(name: string, pushToken?: string): Promise<void>;
    /**
     * Reports that the user did what a notification was sent for (bought, signed
     * up): the `converted` event, which adds to the conversion count of that
     * notification. It carries no amount: revenue is reported from your server
     * with the secret key, on `POST /v1/conversions`, because a secret key never
     * goes into an app. A value that is no numeric notification id is not sent (warning). Silent — never throws.
     */
    trackConversion(notificationId: string | number, pushToken?: string): Promise<void>;
    /**
     * Erases this device and its data from Espresso Notify: the push token, the
     * events and delivery records of the device, its signing key, and the user
     * (external id and name) when no other device of the user is left. It is the
     * call behind a "delete my data" button (LGPD, GDPR). It cannot be undone.
     *
     * Sends the push token of the client (or `pushToken`), plus `deviceId` and
     * `identityToken` when you pass them. When the project asks for the proof of
     * identity, `identityToken` is the JWT your backend signed for the user of the
     * device; without it the client sends the token it kept for that user. The user
     * is `externalId`, else the last one the client identified (renewing an expired
     * token needs it, and an app that restarted since the login must pass it). Throws on any answer that is not 2xx
     * (`EspressoNotifyHttpError`, with `status` and `code`), including 404
     * `not_found` when nothing matched, and without a token or a `deviceId`.
     *
     * After it succeeds, and also after a 404 (the server no longer knows the device, and the call still throws), the
     * client runs `wipeLocalData`: it forgets the user, the tokens, the offline queue, the install id and the signing
     * key. After any other failure it keeps all of that, so the call can be repeated. The device is unknown to the
     * server: stop calling the client, or call `register` again for a new device.
     *
     * @example
     * await push.devices.forgetDevice({ identityToken: await myBackend.identityToken(userId), externalId: userId })
     */
    forgetDevice(options?: {
        pushToken?: string;
        deviceId?: string;
        identityToken?: string;
        externalId?: string;
    }): Promise<void>;
    /**
     * Reads the notification preferences of the user of this device: for each
     * category the user opted out of (or back into), `{ categoryIdentifier, optedOut }`.
     * The server only answers for a device that is linked to that user, so the
     * device must have been identified (or registered with a user) first.
     *
     * `externalId` is optional: without it the call uses the one of the last
     * successful `identify` or `register` of this client. When the project asks
     * for the proof of identity, the call carries the `identityToken` of
     * `options`, else the token the client kept for that user. Throws when there
     * is no external id or no push token, and when the call fails.
     *
     * @example
     * const prefs = await push.devices.getPreferences()
     * const muted = prefs.filter((p) => p.optedOut).map((p) => p.categoryIdentifier)
     */
    getPreferences(externalId?: string, pushToken?: string, options?: {
        identityToken?: string;
    }): Promise<NotificationPreference[]>;
    /**
     * Writes the notification preferences of the user of this device: a category
     * with `optedOut: true` stops receiving sends of that category, and `false`
     * puts the user back in it. Up to 50 preferences per call, each identifier 1 to
     * 64 bytes; anything else throws before the call. Resolves with `{ updated }`,
     * the number of preferences written.
     *
     * `externalId` and the identity token of `options` work as in `getPreferences`.
     *
     * @example
     * await push.devices.setPreferences([{ categoryIdentifier: 'promotions', optedOut: true }])
     */
    setPreferences(preferences: NotificationPreference[], externalId?: string, pushToken?: string, options?: {
        identityToken?: string;
    }): Promise<{
        updated: number;
    }>;
    /** The external id and the token a preferences call is for; throws when either is missing. @internal */
    private _preferencesTarget;
    /**
     * Fetches notification categories from the CMS and registers them on the
     * device using the DisplayAdapter (Expo's setNotificationCategoryAsync by default).
     * Call this once during app initialization, after register().
     * Silent — never throws errors to avoid breaking app boot.
     *
     * @example
     * await push.devices.registerCategories();
     */
    registerCategories(): Promise<void>;
    /**
     * Run the device attestation flow (#814): challenge → native attest → verify.
     *
     * FLAGS the existing per-install signing key (#813) as attested on the backend
     * (register-first; it does NOT replace the signing key). On iOS this uses Apple
     * App Attest; on Android it uses Play Integrity via Firebase App Check.
     *
     * SILENT best-effort — mirrors `registerCategories()`: it NEVER throws, so it
     * is safe to call during app boot. Any failure (no signing session, no/absent
     * provider, unsupported device, native error, network error) resolves to
     * `{ attested: false }` and at most logs one warning per client instance.
     *
     * @returns `{ attested, environment? }` — `attested:false` on any failure.
     *
     * @example
     * // Requires `enableSigning: true` and `enableAttestation: true`.
     * await push.devices.register({ pushToken, platform });
     * await push.devices.attest();
     */
    attest(): Promise<{
        attested: boolean;
        environment?: string;
        reason?: string;
    }>;
    /**
     * Updates user metadata (tags, preferences, etc).
     */
    updateMetadata(metadata: Record<string, unknown>, pushToken?: string): Promise<unknown>;
}
/**
 * The error message for "no push provider": `resolvePushProvider()` found neither `expo-notifications`
 * nor `@react-native-firebase/messaging`.
 *
 * In Expo mode the app has `expo-constants` (or another Expo module the SDK reads) and no Firebase
 * messaging: `expo-notifications` is required there. It stays an optional peer so that React Native CLI
 * apps do not get Expo modules installed, so the requirement is checked here, when the hook runs.
 * @internal
 */
export declare function describeMissingPushProvider(): string;
import { RegistrationTracker } from './registration';
import { TrackBatcher } from './track-batch';
export { createNotificationHandler, handleImagePushBackgroundEvent, handleImagePushInitialNotification, getForeignInitialNotification } from './image-push';
export type { DefaultNotificationBehavior, ImagePushOptions, NotificationBehaviorLike, NotificationHandlerFn } from './image-push';
