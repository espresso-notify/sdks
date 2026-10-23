"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.usePushNotifications = usePushNotifications;
exports.usePushIdentity = usePushIdentity;
const react_1 = require("react");
const index_1 = require("./index");
const errors_1 = require("./errors");
const retry_1 = require("./retry");
// Lazy-load react-native — used for platform auto-detection.
// expo-notifications is now accessed exclusively via PushProvider (index.ts).
let RNPlatform = null;
try {
    RNPlatform = require('react-native').Platform;
}
catch ( /* web/test env */_a) { /* web/test env */ }
/**
 * Runs `call` (a register or an identify) unless the client's tracker knows the server already has this state in this
 * session, and remembers it once it worked; a call that fails is not remembered. A client without a tracker always runs
 * it. Returns whether the call ran. See registration.ts (SCALE-39, D-159).
 */
function runOnce(client, kind, parts, call) {
    return __awaiter(this, void 0, void 0, function* () {
        const tracker = client.registration;
        const ticket = tracker ? yield tracker.plan(kind, parts) : undefined;
        if (ticket === null)
            return false;
        yield call();
        if (tracker && ticket)
            yield tracker.commit(ticket);
        return true;
    });
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
function usePushNotifications({ projectId, externalId = null, userName = null, identityHash = null, metadata, pushToken: externalToken, pushTokenProvider: externalTokenProvider, platform: externalPlatform, autoRequestPermission = true, tokenStrategy = 'expo', expoProjectId, provider: injectedProvider, enableSigning = false, enableAttestation = false, onNotificationOpened, handleDeepLinks, deepLinkAllowList, offlineQueue, privateTransport = 'auto', }) {
    const [pushToken, setPushToken] = (0, react_1.useState)(externalToken !== null && externalToken !== void 0 ? externalToken : null);
    const [isReady, setIsReady] = (0, react_1.useState)(false);
    const [error, setError] = (0, react_1.useState)(null);
    const [permissionStatus, setPermStatus] = (0, react_1.useState)(null);
    const clientRef = (0, react_1.useRef)(null);
    // The latest onNotificationOpened of the component: the client calls it through this ref.
    const onOpenedRef = (0, react_1.useRef)(onNotificationOpened);
    onOpenedRef.current = onNotificationOpened;
    const prevUserRef = (0, react_1.useRef)(null);
    const prevUserNameRef = (0, react_1.useRef)(null);
    const prevHashRef = (0, react_1.useRef)(null);
    const providerRef = (0, react_1.useRef)(null);
    const permStatusRef = (0, react_1.useRef)(null);
    // The latest identity and metadata of the component: a token rotation registers the new token with these, not with
    // the ones the hook started with.
    const latestRef = (0, react_1.useRef)({ externalId, userName, identityHash, metadata });
    latestRef.current = { externalId, userName, identityHash, metadata };
    // The end of the token rotations under way: each one registers and identifies the new token before the next starts,
    // and an identity change waits for it (the server refuses to identify a token it has not registered yet).
    const rotationRef = (0, react_1.useRef)(null);
    // Lifecycle subscription cleanup functions (#807)
    const unsubTokenRef = (0, react_1.useRef)(null);
    const unsubAppStateRef = (0, react_1.useRef)(null);
    // Set while the first permission answer was not 'granted': the AppState
    // re-check calls it once the provider reports 'granted' (SDKFIX-04).
    const resumeRef = (0, react_1.useRef)(null);
    // True from the unmount on: the retries of an identify stop with the component.
    const unmountedRef = (0, react_1.useRef)(false);
    // What the app returning to the foreground runs: the register that failed for good, or the check of whether this
    // new session has to register and identify again (SCALE-39).
    const foregroundRef = (0, react_1.useRef)(null);
    // Phase 1 — Init: request permission → get token → create client → register()
    // Re-runs only if projectId changes (one-time setup per project).
    (0, react_1.useEffect)(() => {
        let cancelled = false;
        // afterGrant: resumed by the AppState re-check after the user granted
        // permission outside the first request; the prompt is not shown again.
        const init = (...args_1) => __awaiter(this, [...args_1], void 0, function* (afterGrant = false) {
            var _a;
            try {
                // A browser has its own SDK (@espresso-notify/web); never save it as an Android device.
                if (!externalPlatform && (RNPlatform === null || RNPlatform === void 0 ? void 0 : RNPlatform.OS) === 'web') {
                    throw new errors_1.EspressoNotifyError('UNSUPPORTED_PLATFORM', '[espresso-notify] Platform.OS is "web", which this SDK does not register. ' +
                        'For browsers use @espresso-notify/web, or pass `platform` explicitly.');
                }
                let token = externalToken;
                let platform = externalPlatform;
                // resolvedProvider tracks the discriminator ('expo'|'fcm'|'apns') for the token
                let resolvedProvider = externalToken ? (externalTokenProvider !== null && externalTokenProvider !== void 0 ? externalTokenProvider : 'expo') : undefined;
                let activeProvider = null;
                if (!token) {
                    const provider = injectedProvider !== null && injectedProvider !== void 0 ? injectedProvider : (0, index_1.resolvePushProvider)({ tokenStrategy, expoProjectId });
                    if (!provider) {
                        throw new Error((0, index_1.describeMissingPushProvider)());
                    }
                    activeProvider = provider;
                    // Request system permission (iOS requires explicit prompt; Android auto-grants).
                    if (autoRequestPermission && !afterGrant) {
                        const status = yield provider.requestPermissions();
                        if (cancelled)
                            return;
                        setPermStatus(status);
                        permStatusRef.current = status;
                        if (status !== 'granted') {
                            setError(new Error(`Push notification permission ${status}. Cannot register device.`));
                            // Not final: the answer can arrive after this request resolved,
                            // or the user can grant it in Settings. Keep the provider so the
                            // foreground re-check below can resume the registration.
                            providerRef.current = provider;
                            resumeRef.current = () => { init(true); };
                            return;
                        }
                    }
                    const providerToken = yield provider.getToken();
                    token = providerToken === null || providerToken === void 0 ? void 0 : providerToken.token;
                    if (!token) {
                        // Never register without a token: the register call would only fail
                        // validation and hide the real cause.
                        throw (_a = provider.lastError) !== null && _a !== void 0 ? _a : new errors_1.EspressoNotifyError('PUSH_TOKEN_UNAVAILABLE', '[espresso-notify] The push provider returned no token, so the device was not registered.');
                    }
                    // Capture the provider discriminator returned by getToken()
                    if (providerToken === null || providerToken === void 0 ? void 0 : providerToken.provider) {
                        resolvedProvider = providerToken.provider;
                    }
                }
                if (!platform) {
                    platform = (RNPlatform === null || RNPlatform === void 0 ? void 0 : RNPlatform.OS) === 'ios' ? 'ios' : 'android';
                }
                if (cancelled)
                    return;
                if (enableAttestation && !enableSigning) {
                    // Attestation is bound to the signing device_id; devices.attest() would
                    // answer 'attestation_disabled'. Say so instead of doing nothing silently.
                    console.warn('[espresso-notify] enableAttestation has no effect without enableSigning: ' +
                        'attestation is bound to the signing key. Set enableSigning: true.');
                }
                const client = new index_1.PushClient(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({ projectId, pushToken: token, platform, provider: resolvedProvider, enableSigning,
                    enableAttestation }, (handleDeepLinks !== undefined ? { handleDeepLinks } : {})), (deepLinkAllowList !== undefined ? { deepLinkAllowList } : {})), (offlineQueue !== undefined ? { offlineQueue } : {})), { privateTransport }), (onOpenedRef.current ? { onNotificationOpened: (event) => { var _a; return (_a = onOpenedRef.current) === null || _a === void 0 ? void 0 : _a.call(onOpenedRef, event); } } : {})));
                clientRef.current = client;
                providerRef.current = activeProvider;
                const stopped = { isCancelled: () => cancelled };
                let ready = false;
                let busy = false;
                // ── Token refresh listener (#807) ──────────────────────────────────
                const subscribeTokenRefresh = () => {
                    if (!(activeProvider === null || activeProvider === void 0 ? void 0 : activeProvider.onTokenRefresh))
                        return;
                    // Mutable so the lifecycle `from` field + dedup stay accurate across
                    // multiple consecutive token rotations within one session.
                    let lastToken = token !== null && token !== void 0 ? token : '';
                    unsubTokenRef.current = activeProvider.onTokenRefresh((newTok) => {
                        var _a;
                        if (!(newTok === null || newTok === void 0 ? void 0 : newTok.token) || newTok.token === lastToken)
                            return;
                        const oldToken = lastToken;
                        const newToken = newTok.token;
                        const newProvider = newTok.provider;
                        lastToken = newToken;
                        // Update hook state
                        setPushToken(newToken);
                        // One rotation after the other, each in order: register the new token (with the metadata of the hook),
                        // identify the current user on it, and only then record the `subscription` event. The server answers 404
                        // token_not_found to an event or an identify of a token it has not stored yet, and a token registered
                        // alone is anonymous, so a personalized send by externalId would not reach it.
                        const step = () => __awaiter(this, void 0, void 0, function* () {
                            if (cancelled)
                                return;
                            const { externalId: id, userName: name, identityHash: hash, metadata: meta } = latestRef.current;
                            let registered = true;
                            try {
                                yield runOnce(client, 'register', { token: newToken, userId: id }, () => (0, retry_1.withRetry)(() => client.devices.register({ metadata: meta, pushToken: newToken, provider: newProvider }), stopped));
                            }
                            catch (_a) {
                                registered = false;
                            }
                            if (cancelled)
                                return;
                            // From here the client sends with the new token (its events, the queue, the calls without a token).
                            // Until the server has it, they keep going to the old one, which the server still knows.
                            client.pushToken = newToken;
                            client.provider = newProvider;
                            if (registered && id) {
                                try {
                                    yield runOnce(client, 'identify', { token: newToken, userId: id, userName: name, identityHash: hash }, () => (0, retry_1.withRetry)(() => client.devices.identify(Object.assign(Object.assign({ externalId: id }, (name ? { name } : {})), (hash ? { identityHash: hash } : {})), newToken), stopped));
                                }
                                catch ( /* the next identity change or rotation tries again */_b) { /* the next identity change or rotation tries again */ }
                                if (cancelled)
                                    return;
                            }
                            try {
                                yield client.devices.recordLifecycle('subscription', oldToken, newToken);
                            }
                            catch ( /* best-effort */_c) { /* best-effort */ }
                        });
                        const tail = ((_a = rotationRef.current) !== null && _a !== void 0 ? _a : Promise.resolve()).then(step).then(() => { if (rotationRef.current === tail)
                            rotationRef.current = null; }, () => { if (rotationRef.current === tail)
                            rotationRef.current = null; });
                        rotationRef.current = tail;
                    });
                };
                // Registers (when the tracker says the server may not have this state), attests, turns ready and starts the token
                // listener. A failure that can pass (no network, 408, 429, 5xx) is tried again inside withRetry, up to 6 times.
                const complete = () => __awaiter(this, void 0, void 0, function* () {
                    var _a, _b;
                    yield runOnce(client, 'register', { token: (_b = (_a = client.pushToken) !== null && _a !== void 0 ? _a : token) !== null && _b !== void 0 ? _b : '', userId: latestRef.current.externalId }, () => (0, retry_1.withRetry)(() => client.devices.register({ metadata }), stopped));
                    // Attest before isReady: the identity writes that follow (identify, unregister,
                    // metadata) are gated by the attestation of the key that register just provisioned.
                    // attest() never throws; a failure is not an init error.
                    if (enableAttestation) {
                        yield client.devices.attest();
                        if (cancelled)
                            return;
                    }
                    setPushToken(token !== null && token !== void 0 ? token : null);
                    setPermStatus('granted');
                    permStatusRef.current = 'granted';
                    setIsReady(true);
                    ready = true;
                    subscribeTokenRefresh();
                });
                // The app comes back to the foreground. A register that failed for good is tried again; once ready, a new
                // session (a return after 30 s or more) registers and identifies again, and a state that changed is sent.
                const onForeground = () => __awaiter(this, void 0, void 0, function* () {
                    var _a, _b;
                    if (cancelled || busy)
                        return;
                    busy = true;
                    try {
                        if (!ready) {
                            setError(null);
                            try {
                                yield complete();
                            }
                            catch (err) {
                                if (!cancelled)
                                    setError(err);
                            }
                            return;
                        }
                        if (!client.registration)
                            return; // nothing says what the server already has: do not repeat the calls on every foreground
                        const pending = rotationRef.current;
                        if (pending)
                            yield pending;
                        if (cancelled)
                            return;
                        const { externalId: id, userName: name, identityHash: hash, metadata: meta } = latestRef.current;
                        const current = (_b = (_a = client.pushToken) !== null && _a !== void 0 ? _a : token) !== null && _b !== void 0 ? _b : '';
                        try {
                            yield runOnce(client, 'register', { token: current, userId: id }, () => (0, retry_1.withRetry)(() => client.devices.register({ metadata: meta }), stopped));
                        }
                        catch (_c) {
                            return;
                        } // the next foreground tries again
                        if (!id || cancelled)
                            return;
                        try {
                            yield runOnce(client, 'identify', { token: current, userId: id, userName: name, identityHash: hash }, () => (0, retry_1.withRetry)(() => client.devices.identify(Object.assign(Object.assign({ externalId: id }, (name ? { name } : {})), (hash ? { identityHash: hash } : {})), current), stopped));
                        }
                        catch ( /* the next foreground tries again */_d) { /* the next foreground tries again */ }
                    }
                    finally {
                        busy = false;
                    }
                });
                foregroundRef.current = () => { void onForeground(); };
                busy = true;
                try {
                    yield complete();
                }
                finally {
                    busy = false;
                }
            }
            catch (err) {
                if (!cancelled)
                    setError(err);
            }
        });
        init();
        return () => { cancelled = true; };
    }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
    // Phase 2 — Identity: react to externalId / userName changes.
    //
    // prevUserRef starts as null, so:
    //   anonymous mount (externalId=null): !externalId && prevId !== null → false → no-op ✅
    //   first identify (null→"u1"):        externalId && externalId !== prevId → identify() ✅
    //   logout ("u1"→null):                !externalId && prevId !== null → unregister() ✅
    //   account switch ("u1"→"u2"):        externalId && externalId !== prevId → identify("u2") ✅
    //   name change (same externalId):     userName !== prevUserName → identify() with new name ✅
    (0, react_1.useEffect)(() => {
        if (!isReady || !clientRef.current)
            return;
        const client = clientRef.current;
        const token = pushToken !== null && pushToken !== void 0 ? pushToken : undefined;
        const prevId = prevUserRef.current;
        const prevName = prevUserNameRef.current;
        const hash = identityHash || null;
        // A new hash for the same user (it arrived late, or was renewed) is sent; a hash that goes away is not.
        const hashChanged = hash !== null && hash !== prevHashRef.current;
        // A token rotation under way registers the new token first; what the identity asks for waits for it.
        const send = (call) => {
            const pending = rotationRef.current;
            (pending ? pending.then(call) : call()).catch(() => { });
        };
        if (externalId && (externalId !== prevId || userName !== prevName || hashChanged)) {
            // Only when the server may not have this user in this session (registration.ts); a failed call is not remembered.
            send(() => {
                var _a, _b;
                return runOnce(client, 'identify', { token: (_b = (_a = client.pushToken) !== null && _a !== void 0 ? _a : token) !== null && _b !== void 0 ? _b : '', userId: externalId, userName, identityHash: hash }, () => (0, retry_1.withRetry)(() => client.devices.identify(Object.assign(Object.assign({ externalId }, (userName ? { name: userName } : {})), (hash ? { identityHash: hash } : {})), token), { isCancelled: () => unmountedRef.current }));
            });
        }
        else if (!externalId && prevId !== null) {
            // The device is anonymous again: the next login must identify, even as the same user in this session.
            send(() => client.devices.unregister(token).then((result) => __awaiter(this, void 0, void 0, function* () { var _a; yield ((_a = client.registration) === null || _a === void 0 ? void 0 : _a.forget('identify')); return result; })));
        }
        prevUserRef.current = externalId;
        prevUserNameRef.current = userName !== null && userName !== void 0 ? userName : null;
        prevHashRef.current = hash;
    }, [externalId, userName, identityHash, isReady]); // eslint-disable-line react-hooks/exhaustive-deps
    // ── AppState permission re-check (#807) ──────────────────────────────────────
    // Only fires on foreground transitions; never duplicates the app_opened logic
    // in PushClient._setupAutoTracking().
    (0, react_1.useEffect)(() => {
        var _a;
        try {
            const AppState = require('react-native').AppState;
            if (!(AppState === null || AppState === void 0 ? void 0 : AppState.addEventListener))
                return;
            let prevAppState = (_a = AppState.currentState) !== null && _a !== void 0 ? _a : 'unknown';
            const subscription = AppState.addEventListener('change', (nextState) => {
                var _a, _b, _c;
                // The tracker decides what a new session is (30 s or more out of the foreground) before anything runs.
                (_b = (_a = clientRef.current) === null || _a === void 0 ? void 0 : _a.registration) === null || _b === void 0 ? void 0 : _b.noteAppState(nextState);
                if (nextState !== 'active' || prevAppState === 'active') {
                    prevAppState = nextState;
                    return;
                }
                prevAppState = nextState;
                (_c = foregroundRef.current) === null || _c === void 0 ? void 0 : _c.call(foregroundRef);
                const provider = providerRef.current;
                if (!(provider === null || provider === void 0 ? void 0 : provider.getPermissionStatus))
                    return;
                provider.getPermissionStatus().then((newStatus) => {
                    const oldStatus = permStatusRef.current;
                    const resume = resumeRef.current;
                    if (newStatus === 'granted' && resume) {
                        resumeRef.current = null;
                        setPermStatus('granted');
                        permStatusRef.current = 'granted';
                        setError(null);
                        resume();
                        return;
                    }
                    if (newStatus !== oldStatus) {
                        setPermStatus(newStatus);
                        permStatusRef.current = newStatus;
                        const client = clientRef.current;
                        if (client) {
                            client.devices.recordLifecycle('permission', oldStatus !== null && oldStatus !== void 0 ? oldStatus : '', newStatus !== null && newStatus !== void 0 ? newStatus : '').catch(() => { });
                        }
                    }
                }).catch(() => { });
            });
            unsubAppStateRef.current = () => { var _a; return (_a = subscription === null || subscription === void 0 ? void 0 : subscription.remove) === null || _a === void 0 ? void 0 : _a.call(subscription); };
        }
        catch ( /* AppState unavailable — web/test env; best-effort */_b) { /* AppState unavailable — web/test env; best-effort */ }
    }, []);
    // Cleanup auto-tracking listener on unmount.
    (0, react_1.useEffect)(() => {
        unmountedRef.current = false;
        return () => {
            var _a, _b, _c;
            unmountedRef.current = true;
            (_a = clientRef.current) === null || _a === void 0 ? void 0 : _a.destroy();
            (_b = unsubTokenRef.current) === null || _b === void 0 ? void 0 : _b.call(unsubTokenRef);
            (_c = unsubAppStateRef.current) === null || _c === void 0 ? void 0 : _c.call(unsubAppStateRef);
        };
    }, []);
    return {
        isReady,
        pushToken,
        client: clientRef.current,
        permissionStatus,
        error,
    };
}
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
function usePushIdentity(client, userId, identityHash) {
    const prevUserRef = (0, react_1.useRef)(null);
    const prevHashRef = (0, react_1.useRef)(null);
    (0, react_1.useEffect)(() => {
        if (!client)
            return;
        const prevId = prevUserRef.current;
        const hash = identityHash || null;
        const hashChanged = hash !== null && hash !== prevHashRef.current;
        if (userId && (userId !== prevId || hashChanged)) {
            (0, retry_1.withRetry)(() => client.devices.identify(Object.assign({ externalId: userId }, (hash ? { identityHash: hash } : {})))).catch(() => { });
        }
        else if (!userId && prevId !== null) {
            client.devices.unregister().catch(() => { });
        }
        prevUserRef.current = userId;
        prevHashRef.current = hash;
    }, [userId, identityHash, client]);
}
