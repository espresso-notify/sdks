import { useEffect, useRef, useState } from 'react'
import { PushClient, resolvePushProvider, describeMissingPushProvider } from './index'
import type { PushProvider, PermissionStatus, NotificationOpenedHandler, OfflineQueueConfig, PrivateTransportMode } from './index'
import { EspressoNotifyError } from './errors'
import { withRetry } from './retry'
import type { RegistrationKind, RegistrationParts } from './registration'

// Lazy-load react-native — used for platform auto-detection.
// expo-notifications is now accessed exclusively via PushProvider (index.ts).
let RNPlatform: { OS?: string } | null = null
try { RNPlatform = require('react-native').Platform } catch { /* web/test env */ }

/**
 * Runs `call` (a register or an identify) unless the client's tracker knows the server already has this state in this
 * session, and remembers it once it worked; a call that fails is not remembered. A client without a tracker always runs
 * it. Returns whether the call ran. See registration.ts (SCALE-39, D-159).
 */
async function runOnce(client: PushClient, kind: RegistrationKind, parts: RegistrationParts, call: () => Promise<unknown>): Promise<boolean> {
  const tracker = client.registration
  const ticket = tracker ? await tracker.plan(kind, parts) : undefined
  if (ticket === null) return false
  await call()
  if (tracker && ticket) await tracker.commit(ticket)
  return true
}

// Re-export so callers can import PermissionStatus from either file.
export type { PermissionStatus } from './index'

export interface UsePushNotificationsConfig {
  /** Your project public key (pk_live_...) */
  projectId: string
  /**
   * Reactive auth state. Pass the current user's external ID or null.
   * null  → device is anonymous (receives broadcasts, not personalized sends)
   * value → device is identified (receives all sends for this user)
   *
   * The hook calls identify() on null→value and unregister() on value→null.
   * You never need to call these manually.
   */
  externalId?: string | null
  /**
   * Optional display name for the user. Passed to identify() automatically
   * alongside externalId. No need to call identify() manually just to set the name.
   */
  userName?: string | null
  /**
   * The proof of identity of `externalId`: HMAC-SHA256(externalId, identity secret
   * of the project) as lower-case hex, computed by YOUR backend and handed to the
   * app after the user logs in (the secret never goes into the app). Sent with
   * identify() as `identity_hash`. Needed when the project asks for the proof.
   * When it arrives after `externalId`, the hook identifies again with it; when it
   * goes away while the user stays, nothing is sent.
   */
  identityHash?: string | null
  /** Device-level metadata sent on register() (locale, plan, etc.) */
  metadata?: Record<string, unknown>
  /**
   * Push token. If omitted, the hook acquires it via the resolved PushProvider
   * (ExpoPushProvider by default). Useful for apps that already manage token
   * acquisition themselves.
   */
  pushToken?: string
  /**
   * Push provider discriminator when supplying an explicit pushToken.
   * Optional — defaults to 'expo' to preserve backward-compatible behavior.
   */
  pushTokenProvider?: 'expo' | 'fcm' | 'apns'
  /** Device platform. If omitted, auto-detected from react-native Platform. */
  platform?: 'ios' | 'android'
  /**
   * Whether to call requestPermissionsAsync() automatically before acquiring
   * the push token. Default: true.
   * Set to false if your app controls the permission prompt timing.
   */
  autoRequestPermission?: boolean
  /**
   * Token acquisition strategy for ExpoPushProvider.
   * 'expo'   → getExpoPushTokenAsync (default, backward-compatible)
   * 'device' → getDevicePushTokenAsync → raw APNs/FCM token
   * Has no effect when an explicit pushToken or provider is supplied.
   */
  tokenStrategy?: 'expo' | 'device'
  /**
   * EAS project id for the Expo push token (`getExpoPushTokenAsync({ projectId })`).
   * Default: `Constants.expoConfig.extra.eas.projectId`, then
   * `Constants.easConfig.projectId` (expo-constants). Without any of them the
   * hook does not register and `error.code` is 'EXPO_PROJECT_ID_MISSING'.
   */
  expoProjectId?: string
  /**
   * Optional custom PushProvider (for testing or non-Expo environments).
   * When not provided, auto-selected based on expo-notifications availability.
   * Seam for #803 (bare-RN / Firebase provider).
   */
  provider?: PushProvider
  /**
   * Hardware-bound request signing (#813). Same option, same default and same
   * behavior as `ClientConfig.enableSigning`: the client signs every request
   * (register carries the public key) with X-KM-* headers. Default: false.
   * Needs the optional peer `react-native-secure-sign`; without it the client
   * logs one warning and sends unsigned. Read once, when the hook starts.
   * The server only enforces it for projects with `require_signing`; a project
   * that does not require it accepts signed requests as well.
   */
  enableSigning?: boolean
  /**
   * Device attestation (#814). Same option and default as
   * `ClientConfig.enableAttestation`. When true the hook calls
   * `client.devices.attest()` after register() and before `isReady` turns true,
   * so identity writes wait for it. A failed attestation never sets `error`.
   * Requires `enableSigning: true` (the hook warns once if it is missing).
   * Default: false.
   */
  enableAttestation?: boolean
  /**
   * Called once for every tap on a notification, with `{ notificationId, data, url, actionId }`, while the app
   * runs and for the tap that launched it. Same as `client.onNotificationOpened`. The hook calls the latest
   * function you passed, so it can be an inline function. Pass it from the first render: the client registers it
   * when it is created. Errors it throws are swallowed and never stop the tracking of `opened`.
   */
  onNotificationOpened?: NotificationOpenedHandler
  /**
   * Let the SDK open the link (`url` key of the push data) of a tap on a notification, with `Linking.openURL`, after
   * `onNotificationOpened` ran. Same option and default as `ClientConfig.handleDeepLinks`: off. Read once, when the
   * hook starts.
   */
  handleDeepLinks?: boolean
  /**
   * The schemes (`'myapp://'`) and HTTPS origins (`'https://shop.example.com'`) `handleDeepLinks` may open. Same as
   * `ClientConfig.deepLinkAllowList`: with none, nothing opens. Read once, when the hook starts.
   */
  deepLinkAllowList?: string[]
  /**
   * The offline queue of the client: an event that fails (open, click, conversion, custom event, lifecycle event) is
   * kept and sent again. Same option and default as `ClientConfig.offlineQueue`: `{ enabled: true, maxItems: 200 }`.
   * Read once, when the hook starts.
   */
  offlineQueue?: OfflineQueueConfig
  /**
   * Which stack sends the requests of the client: the native module of the SDK, `fetch`, or the native module with a
   * `fetch` fallback. Same option and default as `ClientConfig.privateTransport`: `'auto'`. Read once, when the hook
   * starts. A value other than `'auto'`, `'native'` and `'js'` is the `error` of the hook.
   */
  privateTransport?: PrivateTransportMode
}

export interface UsePushNotificationsResult {
  /** true after register() succeeds (after its retries, if it needed them) — safe to use client */
  isReady: boolean
  /** The Expo push token in use (null while initializing or on error) */
  pushToken: string | null
  /** PushClient instance for advanced use (updateMetadata, registerCategories, etc.) */
  client: PushClient | null
  /** Current push notification permission status */
  permissionStatus: PermissionStatus
  /**
   * Non-null if initialization failed (permission denied, expo-notifications
   * missing, no push token, etc.). Token failures are `EspressoNotifyError` with
   * `code` 'EXPO_PROJECT_ID_MISSING' or 'PUSH_TOKEN_UNAVAILABLE'; the device is
   * not registered in that case.
   */
  error: Error | null
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
export function usePushNotifications({
  projectId,
  externalId = null,
  userName = null,
  identityHash = null,
  metadata,
  pushToken: externalToken,
  pushTokenProvider: externalTokenProvider,
  platform: externalPlatform,
  autoRequestPermission = true,
  tokenStrategy = 'expo',
  expoProjectId,
  provider: injectedProvider,
  enableSigning = false,
  enableAttestation = false,
  onNotificationOpened,
  handleDeepLinks,
  deepLinkAllowList,
  offlineQueue,
  privateTransport = 'auto',
}: UsePushNotificationsConfig): UsePushNotificationsResult {
  const [pushToken, setPushToken]           = useState<string | null>(externalToken ?? null)
  const [isReady, setIsReady]               = useState(false)
  const [error, setError]                   = useState<Error | null>(null)
  const [permissionStatus, setPermStatus]   = useState<PermissionStatus>(null)
  const clientRef          = useRef<PushClient | null>(null)
  // The latest onNotificationOpened of the component: the client calls it through this ref.
  const onOpenedRef        = useRef<NotificationOpenedHandler | undefined>(onNotificationOpened)
  onOpenedRef.current = onNotificationOpened
  const prevUserRef        = useRef<string | null>(null)
  const prevUserNameRef    = useRef<string | null>(null)
  const prevHashRef        = useRef<string | null>(null)
  const providerRef        = useRef<PushProvider | null>(null)
  const permStatusRef      = useRef<PermissionStatus>(null)
  // The latest identity and metadata of the component: a token rotation registers the new token with these, not with
  // the ones the hook started with.
  const latestRef          = useRef({ externalId, userName, identityHash, metadata })
  latestRef.current = { externalId, userName, identityHash, metadata }
  // The end of the token rotations under way: each one registers and identifies the new token before the next starts,
  // and an identity change waits for it (the server refuses to identify a token it has not registered yet).
  const rotationRef        = useRef<Promise<void> | null>(null)
  // Lifecycle subscription cleanup functions (#807)
  const unsubTokenRef      = useRef<(() => void) | null>(null)
  const unsubAppStateRef   = useRef<(() => void) | null>(null)
  // Set while the first permission answer was not 'granted': the AppState
  // re-check calls it once the provider reports 'granted' (SDKFIX-04).
  const resumeRef          = useRef<(() => void) | null>(null)
  // True from the unmount on: the retries of an identify stop with the component.
  const unmountedRef       = useRef(false)
  // What the app returning to the foreground runs: the register that failed for good, or the check of whether this
  // new session has to register and identify again (SCALE-39).
  const foregroundRef      = useRef<(() => void) | null>(null)

  // Phase 1 — Init: request permission → get token → create client → register()
  // Re-runs only if projectId changes (one-time setup per project).
  useEffect(() => {
    let cancelled = false

    // afterGrant: resumed by the AppState re-check after the user granted
    // permission outside the first request; the prompt is not shown again.
    const init = async (afterGrant = false) => {
      try {
        // A browser has its own SDK (@espresso-notify/web); never save it as an Android device.
        if (!externalPlatform && RNPlatform?.OS === 'web') {
          throw new EspressoNotifyError(
            'UNSUPPORTED_PLATFORM',
            '[espresso-notify] Platform.OS is "web", which this SDK does not register. ' +
            'For browsers use @espresso-notify/web, or pass `platform` explicitly.',
          )
        }
        let token    = externalToken
        let platform = externalPlatform
        // resolvedProvider tracks the discriminator ('expo'|'fcm'|'apns') for the token
        let resolvedProvider: 'expo' | 'fcm' | 'apns' | undefined =
          externalToken ? (externalTokenProvider ?? 'expo') : undefined

        let activeProvider: PushProvider | null = null

        if (!token) {
          const provider = injectedProvider ?? resolvePushProvider({ tokenStrategy, expoProjectId })

          if (!provider) {
            throw new Error(describeMissingPushProvider())
          }

          activeProvider = provider

          // Request system permission (iOS requires explicit prompt; Android auto-grants).
          if (autoRequestPermission && !afterGrant) {
            const status = await provider.requestPermissions()
            if (cancelled) return
            setPermStatus(status)
            permStatusRef.current = status
            if (status !== 'granted') {
              setError(new Error(`Push notification permission ${status}. Cannot register device.`))
              // Not final: the answer can arrive after this request resolved,
              // or the user can grant it in Settings. Keep the provider so the
              // foreground re-check below can resume the registration.
              providerRef.current = provider
              resumeRef.current = () => { init(true) }
              return
            }
          }

          const providerToken = await provider.getToken()
          token = providerToken?.token
          if (!token) {
            // Never register without a token: the register call would only fail
            // validation and hide the real cause.
            throw provider.lastError ?? new EspressoNotifyError(
              'PUSH_TOKEN_UNAVAILABLE',
              '[espresso-notify] The push provider returned no token, so the device was not registered.',
            )
          }
          // Capture the provider discriminator returned by getToken()
          if (providerToken?.provider) {
            resolvedProvider = providerToken.provider
          }
        }

        if (!platform) {
          platform = RNPlatform?.OS === 'ios' ? 'ios' : 'android'
        }

        if (cancelled) return

        if (enableAttestation && !enableSigning) {
          // Attestation is bound to the signing device_id; devices.attest() would
          // answer 'attestation_disabled'. Say so instead of doing nothing silently.
          console.warn(
            '[espresso-notify] enableAttestation has no effect without enableSigning: ' +
            'attestation is bound to the signing key. Set enableSigning: true.',
          )
        }

        const client = new PushClient({
          projectId,
          pushToken: token,
          platform,
          provider: resolvedProvider,
          enableSigning,
          enableAttestation,
          ...(handleDeepLinks !== undefined ? { handleDeepLinks } : {}),
          ...(deepLinkAllowList !== undefined ? { deepLinkAllowList } : {}),
          ...(offlineQueue !== undefined ? { offlineQueue } : {}),
          privateTransport,
          // Registered when the client is created, so the tap that launched the app reaches it.
          ...(onOpenedRef.current ? { onNotificationOpened: (event) => onOpenedRef.current?.(event) } : {}),
        })
        clientRef.current = client
        providerRef.current = activeProvider

        const stopped = { isCancelled: () => cancelled }
        let ready = false
        let busy = false

        // ── Token refresh listener (#807) ──────────────────────────────────
        const subscribeTokenRefresh = () => {
          if (!activeProvider?.onTokenRefresh) return
          // Mutable so the lifecycle `from` field + dedup stay accurate across
          // multiple consecutive token rotations within one session.
          let lastToken = token ?? ''
          unsubTokenRef.current = activeProvider.onTokenRefresh((newTok) => {
            if (!newTok?.token || newTok.token === lastToken) return
            const oldToken = lastToken
            const newToken = newTok.token
            const newProvider = newTok.provider
            lastToken = newToken
            // Update hook state
            setPushToken(newToken)
            // One rotation after the other, each in order: register the new token (with the metadata of the hook),
            // identify the current user on it, and only then record the `subscription` event. The server answers 404
            // token_not_found to an event or an identify of a token it has not stored yet, and a token registered
            // alone is anonymous, so a personalized send by externalId would not reach it.
            const step = async () => {
              if (cancelled) return
              const { externalId: id, userName: name, identityHash: hash, metadata: meta } = latestRef.current
              let registered = true
              try {
                await runOnce(client, 'register', { token: newToken, userId: id }, () => withRetry(
                  () => client.devices.register({ metadata: meta, pushToken: newToken, provider: newProvider }),
                  stopped,
                ))
              } catch { registered = false }
              if (cancelled) return
              // From here the client sends with the new token (its events, the queue, the calls without a token).
              // Until the server has it, they keep going to the old one, which the server still knows.
              client.pushToken = newToken
              client.provider = newProvider
              if (registered && id) {
                try {
                  await runOnce(client, 'identify', { token: newToken, userId: id, userName: name, identityHash: hash }, () => withRetry(() => client.devices.identify({
                    externalId: id,
                    ...(name ? { name } : {}),
                    ...(hash ? { identityHash: hash } : {}),
                  }, newToken), stopped))
                } catch { /* the next identity change or rotation tries again */ }
                if (cancelled) return
              }
              try { await client.devices.recordLifecycle('subscription', oldToken, newToken) } catch { /* best-effort */ }
            }
            const tail: Promise<void> = (rotationRef.current ?? Promise.resolve()).then(step).then(
              () => { if (rotationRef.current === tail) rotationRef.current = null },
              () => { if (rotationRef.current === tail) rotationRef.current = null },
            )
            rotationRef.current = tail
          })
        }

        // Registers (when the tracker says the server may not have this state), attests, turns ready and starts the token
        // listener. A failure that can pass (no network, 408, 429, 5xx) is tried again inside withRetry, up to 6 times.
        const complete = async () => {
          await runOnce(client, 'register', { token: client.pushToken ?? token ?? '', userId: latestRef.current.externalId },
            () => withRetry(() => client.devices.register({ metadata }), stopped))

          // Attest before isReady: the identity writes that follow (identify, unregister,
          // metadata) are gated by the attestation of the key that register just provisioned.
          // attest() never throws; a failure is not an init error.
          if (enableAttestation) {
            await client.devices.attest()
            if (cancelled) return
          }

          setPushToken(token ?? null)
          setPermStatus('granted')
          permStatusRef.current = 'granted'
          setIsReady(true)
          ready = true
          subscribeTokenRefresh()
        }

        // The app comes back to the foreground. A register that failed for good is tried again; once ready, a new
        // session (a return after 30 s or more) registers and identifies again, and a state that changed is sent.
        const onForeground = async () => {
          if (cancelled || busy) return
          busy = true
          try {
            if (!ready) {
              setError(null)
              try { await complete() } catch (err) { if (!cancelled) setError(err as Error) }
              return
            }
            if (!client.registration) return // nothing says what the server already has: do not repeat the calls on every foreground
            const pending = rotationRef.current
            if (pending) await pending
            if (cancelled) return
            const { externalId: id, userName: name, identityHash: hash, metadata: meta } = latestRef.current
            const current = client.pushToken ?? token ?? ''
            try {
              await runOnce(client, 'register', { token: current, userId: id }, () => withRetry(() => client.devices.register({ metadata: meta }), stopped))
            } catch { return } // the next foreground tries again
            if (!id || cancelled) return
            try {
              await runOnce(client, 'identify', { token: current, userId: id, userName: name, identityHash: hash }, () => withRetry(() => client.devices.identify({
                externalId: id,
                ...(name ? { name } : {}),
                ...(hash ? { identityHash: hash } : {}),
              }, current), stopped))
            } catch { /* the next foreground tries again */ }
          } finally {
            busy = false
          }
        }
        foregroundRef.current = () => { void onForeground() }

        busy = true
        try { await complete() } finally { busy = false }
      } catch (err) {
        if (!cancelled) setError(err as Error)
      }
    }

    init()
    return () => { cancelled = true }
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Phase 2 — Identity: react to externalId / userName changes.
  //
  // prevUserRef starts as null, so:
  //   anonymous mount (externalId=null): !externalId && prevId !== null → false → no-op ✅
  //   first identify (null→"u1"):        externalId && externalId !== prevId → identify() ✅
  //   logout ("u1"→null):                !externalId && prevId !== null → unregister() ✅
  //   account switch ("u1"→"u2"):        externalId && externalId !== prevId → identify("u2") ✅
  //   name change (same externalId):     userName !== prevUserName → identify() with new name ✅
  useEffect(() => {
    if (!isReady || !clientRef.current) return

    const client   = clientRef.current
    const token    = pushToken ?? undefined
    const prevId   = prevUserRef.current
    const prevName = prevUserNameRef.current
    const hash     = identityHash || null
    // A new hash for the same user (it arrived late, or was renewed) is sent; a hash that goes away is not.
    const hashChanged = hash !== null && hash !== prevHashRef.current

    // A token rotation under way registers the new token first; what the identity asks for waits for it.
    const send = (call: () => Promise<unknown>) => {
      const pending = rotationRef.current
      ;(pending ? pending.then(call) : call()).catch(() => {})
    }

    if (externalId && (externalId !== prevId || userName !== prevName || hashChanged)) {
      // Only when the server may not have this user in this session (registration.ts); a failed call is not remembered.
      send(() => runOnce(client, 'identify', { token: client.pushToken ?? token ?? '', userId: externalId, userName, identityHash: hash },
        () => withRetry(() => client.devices.identify({
          externalId,
          ...(userName ? { name: userName } : {}),
          ...(hash ? { identityHash: hash } : {}),
        }, token), { isCancelled: () => unmountedRef.current })))
    } else if (!externalId && prevId !== null) {
      // The device is anonymous again: the next login must identify, even as the same user in this session.
      send(() => client.devices.unregister(token).then(async (result) => { await client.registration?.forget('identify'); return result }))
    }

    prevUserRef.current     = externalId
    prevUserNameRef.current = userName ?? null
    prevHashRef.current     = hash
  }, [externalId, userName, identityHash, isReady]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── AppState permission re-check (#807) ──────────────────────────────────────
  // Only fires on foreground transitions; never duplicates the app_opened logic
  // in PushClient._setupAutoTracking().
  useEffect(() => {
    try {
      const AppState = require('react-native').AppState
      if (!AppState?.addEventListener) return

      let prevAppState: string = AppState.currentState ?? 'unknown'
      const subscription = AppState.addEventListener('change', (nextState: string) => {
        // The tracker decides what a new session is (30 s or more out of the foreground) before anything runs.
        clientRef.current?.registration?.noteAppState(nextState)
        if (nextState !== 'active' || prevAppState === 'active') {
          prevAppState = nextState
          return
        }
        prevAppState = nextState
        foregroundRef.current?.()

        const provider = providerRef.current
        if (!provider?.getPermissionStatus) return

        provider.getPermissionStatus().then((newStatus) => {
          const oldStatus = permStatusRef.current
          const resume = resumeRef.current
          if (newStatus === 'granted' && resume) {
            resumeRef.current = null
            setPermStatus('granted')
            permStatusRef.current = 'granted'
            setError(null)
            resume()
            return
          }
          if (newStatus !== oldStatus) {
            setPermStatus(newStatus)
            permStatusRef.current = newStatus
            const client = clientRef.current
            if (client) {
              client.devices.recordLifecycle(
                'permission',
                oldStatus ?? '',
                newStatus ?? '',
              ).catch(() => {})
            }
          }
        }).catch(() => { /* best-effort */ })
      })

      unsubAppStateRef.current = () => subscription?.remove?.()
    } catch { /* AppState unavailable — web/test env; best-effort */ }
  }, [])

  // Cleanup auto-tracking listener on unmount.
  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
      clientRef.current?.destroy()
      unsubTokenRef.current?.()
      unsubAppStateRef.current?.()
    }
  }, [])

  return {
    isReady,
    pushToken,
    client: clientRef.current,
    permissionStatus,
    error,
  }
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
export function usePushIdentity(
  client: PushClient | null,
  userId: string | null,
  identityHash?: string | null,
): void {
  const prevUserRef = useRef<string | null>(null)
  const prevHashRef = useRef<string | null>(null)

  useEffect(() => {
    if (!client) return

    const prevId = prevUserRef.current
    const hash   = identityHash || null
    const hashChanged = hash !== null && hash !== prevHashRef.current

    if (userId && (userId !== prevId || hashChanged)) {
      withRetry(() => client.devices.identify({ externalId: userId, ...(hash ? { identityHash: hash } : {}) })).catch(() => {})
    } else if (!userId && prevId !== null) {
      client.devices.unregister().catch(() => {})
    }

    prevUserRef.current = userId
    prevHashRef.current = hash
  }, [userId, identityHash, client])
}
