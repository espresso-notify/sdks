/**
 * @jest-environment jsdom
 *
 * rn-tap-and-offline-queue, T4 (TAP-01 to TAP-09, DLK-07): onNotificationOpened receives every tap once, in Expo
 * mode and in React Native CLI mode, the tap that launched the app included, and the tracking of `opened` is the
 * one that ran before the callback existed. Native modules are virtual mocks.
 */

const flushPromises = () => new Promise((r) => setTimeout(r, 0))

const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT'
const DISMISS_ACTION = 'expo.modules.notifications.actions.DISMISS'
/** What iOS hands the app for a dismissal of a category registered with `customDismissAction`. */
const APPLE_DISMISS_ACTION = 'com.apple.UNNotificationDismissActionIdentifier'

/** An expo-notifications response, shaped as the library delivers it. */
function expoResponse(
  data: Record<string, unknown>,
  extra: { id?: string; action?: string; date?: number } = {},
) {
  return {
    actionIdentifier: extra.action ?? DEFAULT_ACTION,
    notification: { date: extra.date ?? 1_700_000_000, request: { identifier: extra.id ?? 'req-1', content: { data } } },
  }
}

function expoMock(opts: { last?: any } = {}) {
  const listeners: Array<(r: any) => void> = []
  const remove = jest.fn()
  const mod: any = {
    DEFAULT_ACTION_IDENTIFIER: DEFAULT_ACTION,
    DISMISS_ACTION_IDENTIFIER: DISMISS_ACTION,
    addNotificationResponseReceivedListener: jest.fn((cb: (r: any) => void) => {
      listeners.push(cb)
      return { remove }
    }),
    addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
    getLastNotificationResponseAsync: jest.fn().mockResolvedValue(opts.last ?? null),
  }
  return { mod, listeners, remove, fire: (r: any) => listeners.forEach((l) => l(r)) }
}

type Env = { expo?: ReturnType<typeof expoMock>; linking?: any; extra?: Record<string, any> }

const fetchMock = jest.fn()

function load(env: Env) {
  jest.resetModules()
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ ok: true, text: async () => '' })
  ;(globalThis as any).fetch = fetchMock
  if (env.expo) jest.doMock('expo-notifications', () => env.expo!.mod, { virtual: true })
  else jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
  jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: 17 }, AppState: null, Linking: env.linking }), { virtual: true })
  for (const [name, mod] of Object.entries(env.extra ?? {})) {
    jest.doMock(name, () => mod, { virtual: true })
  }
  return require('../src/index')
}

/** Every body posted to /v1/notifications/track. */
/** The delivery events sent so far, from the single route and from the batch route (T40: two taps in one tick share a request). */
function tracked(): any[] {
  return fetchMock.mock.calls.flatMap(([url, init]) => {
    if (String(url).endsWith('/v1/notifications/track')) return [JSON.parse(init.body)]
    if (String(url).endsWith('/v1/notifications/track/batch')) return JSON.parse(init.body).events
    return []
  })
}

function makeClient(env: Env, extra: Record<string, unknown> = {}) {
  const sdk = load(env)
  const client = new sdk.PushClient({ projectId: 'pk_live_test', pushToken: 'ExponentPushToken[abc]', platform: 'ios', ...extra })
  return { sdk, client }
}

describe('Expo mode', () => {
  it('calls the handler once for a warm tap with the id, the data, no url and no action (TAP-01)', async () => {
    const expo = expoMock()
    const { client } = makeClient({ expo })
    const handler = jest.fn()
    client.onNotificationOpened(handler)

    expo.fire(expoResponse({ notificationId: '42', screen: 'order' }))
    await flushPromises()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0]).toEqual({
      notificationId: '42',
      data: { notificationId: '42', screen: 'order' },
      url: undefined,
      actionId: undefined,
    })
    expect(Object.keys(handler.mock.calls[0][0]).sort()).toEqual(['actionId', 'data', 'notificationId', 'url'])
  })

  it('reads notification_id as a fallback and passes the action button id (TAP-01)', async () => {
    const expo = expoMock()
    const { client } = makeClient({ expo })
    const handler = jest.fn()
    client.onNotificationOpened(handler)

    expo.fire(expoResponse({ notification_id: 7 }, { action: 'reply' }))
    await flushPromises()

    expect(handler.mock.calls[0][0]).toMatchObject({ notificationId: 7, actionId: 'reply' })
  })

  it('gives url only when data.url is a non-empty string (DLK-07)', async () => {
    const expo = expoMock()
    const { client } = makeClient({ expo })
    const handler = jest.fn()
    client.onNotificationOpened(handler)

    expo.fire(expoResponse({ notificationId: '1', url: 'myapp://orders/1042' }))
    expo.fire(expoResponse({ notificationId: '2', url: 42 }))
    expo.fire(expoResponse({ notificationId: '3', url: '' }))
    expo.fire(expoResponse({ notificationId: '4' }))
    await flushPromises()

    expect(handler.mock.calls.map(([e]) => e.url)).toEqual(['myapp://orders/1042', undefined, undefined, undefined])
  })

  it('tracks opened exactly once per tap, with or without a handler (TAP-04)', async () => {
    const expo = expoMock()
    const { client } = makeClient({ expo })
    expo.fire(expoResponse({ notificationId: '42' }))
    await flushPromises()
    const withoutHandler = tracked()

    client.onNotificationOpened(jest.fn())
    expo.fire(expoResponse({ notificationId: '43' }))
    await flushPromises()

    expect(withoutHandler).toEqual([{ notification_id: 42, event: 'opened', push_token: 'ExponentPushToken[abc]' }])
    expect(tracked()).toEqual([
      { notification_id: 42, event: 'opened', push_token: 'ExponentPushToken[abc]' },
      { notification_id: 43, event: 'opened', push_token: 'ExponentPushToken[abc]' },
    ])
  })

  it('calls the handler once for the tap that launched the app, also when the listener sees it (TAP-02)', async () => {
    const launch = expoResponse({ notificationId: '9', screen: 'cart' }, { id: 'req-launch' })
    const expo = expoMock({ last: launch })
    const { client } = makeClient({ expo }, { onNotificationOpened: undefined })
    const handler = jest.fn()
    client.onNotificationOpened(handler)
    await flushPromises()
    expo.fire(launch) // the same response reaches the live listener late
    await flushPromises()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0]).toMatchObject({ notificationId: '9', data: { screen: 'cart' } })
    expect(tracked()).toHaveLength(1)
    expect(expo.mod.getLastNotificationResponseAsync).toHaveBeenCalledTimes(1)
  })

  it('calls the handler once when the listener sees the launch tap before the last response is read (TAP-02)', async () => {
    const launch = expoResponse({ notificationId: '9' }, { id: 'req-launch' })
    let resolveLast: (r: any) => void = () => {}
    const expo = expoMock()
    expo.mod.getLastNotificationResponseAsync = jest.fn(() => new Promise((r) => { resolveLast = r }))
    const { client } = makeClient({ expo })
    const handler = jest.fn()
    client.onNotificationOpened(handler)

    expo.fire(launch)
    resolveLast(launch)
    await flushPromises()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(tracked()).toHaveLength(1)
  })

  it('does not hand a tap again when a new client reads the last response (TAP-02)', async () => {
    const tap = expoResponse({ notificationId: '5' }, { id: 'req-5' })
    const expo = expoMock()
    const { sdk, client } = makeClient({ expo })
    const first = jest.fn()
    client.onNotificationOpened(first)
    expo.fire(tap)
    await flushPromises()
    client.destroy()

    // A remount builds a new client; expo-notifications still answers with the last response.
    expo.mod.getLastNotificationResponseAsync.mockResolvedValue(tap)
    const second = new sdk.PushClient({ projectId: 'pk_live_test', pushToken: 'ExponentPushToken[abc]', platform: 'ios' })
    const handler = jest.fn()
    second.onNotificationOpened(handler)
    await flushPromises()

    expect(first).toHaveBeenCalledTimes(1)
    expect(handler).not.toHaveBeenCalled()
  })

  it('still delivers two taps on the same notification that the listener reports (no over-deduplication)', async () => {
    const expo = expoMock()
    const { client } = makeClient({ expo })
    const handler = jest.fn()
    client.onNotificationOpened(handler)

    const tap = expoResponse({ notificationId: '5' }, { id: 'req-5' })
    expo.fire(tap)
    expo.fire(tap)
    await flushPromises()

    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('keeps the launch tap for the first handler registered later, once (TAP-05)', async () => {
    const launch = expoResponse({ notificationId: '9' }, { id: 'req-launch' })
    const expo = expoMock({ last: launch })
    const { client } = makeClient({ expo })
    await flushPromises() // the launch tap arrived and nobody listened

    const first = jest.fn()
    const second = jest.fn()
    client.onNotificationOpened(first)
    client.onNotificationOpened(second)

    expect(first).toHaveBeenCalledTimes(1)
    expect(first.mock.calls[0][0]).toMatchObject({ notificationId: '9' })
    expect(second).not.toHaveBeenCalled()
    expect(tracked()).toHaveLength(1)
  })

  it('does not keep a warm tap that arrived with no handler (TAP-05)', async () => {
    const expo = expoMock()
    const { client } = makeClient({ expo })
    expo.fire(expoResponse({ notificationId: '1' }))
    await flushPromises()

    const handler = jest.fn()
    client.onNotificationOpened(handler)

    expect(handler).not.toHaveBeenCalled()
  })

  it('receives the launch tap through the onNotificationOpened option of the client (TAP-06)', async () => {
    const launch = expoResponse({ notificationId: '9' }, { id: 'req-launch' })
    const expo = expoMock({ last: launch })
    const handler = jest.fn()
    makeClient({ expo }, { onNotificationOpened: handler })
    await flushPromises()

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('a handler that throws or rejects breaks neither the tracking nor the next handler (TAP-04)', async () => {
    const expo = expoMock()
    const { client } = makeClient({ expo })
    const throwing = jest.fn(() => { throw new Error('boom') })
    const rejecting = jest.fn(() => Promise.reject(new Error('later')))
    const last = jest.fn()
    client.onNotificationOpened(throwing)
    client.onNotificationOpened(rejecting)
    client.onNotificationOpened(last)

    expect(() => expo.fire(expoResponse({ notificationId: '42' }))).not.toThrow()
    await flushPromises()

    expect(throwing).toHaveBeenCalledTimes(1)
    expect(rejecting).toHaveBeenCalledTimes(1)
    expect(last).toHaveBeenCalledTimes(1)
    expect(tracked()).toHaveLength(1)
  })

  it('tracks before it calls the handler (TAP-04)', async () => {
    const expo = expoMock()
    const { client } = makeClient({ expo })
    let trackedWhenCalled = -1
    client.onNotificationOpened(() => { trackedWhenCalled = tracked().length })

    expo.fire(expoResponse({ notificationId: '42' }))

    expect(trackedWhenCalled).toBe(1)
  })

  it('delivers to a handler and tracks nothing when autoTrack is false (TAP-07)', async () => {
    const expo = expoMock()
    const { client } = makeClient({ expo }, { autoTrack: false })
    const handler = jest.fn()
    client.onNotificationOpened(handler)

    expo.fire(expoResponse({ notificationId: '42' }))
    await flushPromises()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('registers no listener with autoTrack false until a handler exists (TAP-07)', () => {
    const expo = expoMock()
    const { client } = makeClient({ expo }, { autoTrack: false })
    expect(expo.mod.addNotificationResponseReceivedListener).not.toHaveBeenCalled()
    client.onNotificationOpened(jest.fn())
    expect(expo.mod.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1)
    client.onNotificationOpened(jest.fn())
    expect(expo.mod.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1)
  })

  // TAP-08 pinned the bug of D-149: a dismissal response was recorded as `opened`. A dismissal is a `dismissed`, never an open.
  it('records a dismissal as dismissed, once, never as opened, and does not call the handler (TAP-08, D-149)', async () => {
    const expo = expoMock()
    const { client } = makeClient({ expo })
    const handler = jest.fn()
    client.onNotificationOpened(handler)

    expo.fire(expoResponse({ notificationId: '42' }, { action: DISMISS_ACTION }))
    await flushPromises()
    await client.flush() // dismissed waits a random 0 to 30 s (T40); flush() sends it now

    expect(handler).not.toHaveBeenCalled()
    expect(tracked().map((b) => b.event)).toEqual(['dismissed'])
  })

  it('reads the Apple dismissal identifier as a dismissal when expo-notifications exports no constant for it (D-149)', async () => {
    const expo = expoMock()
    delete expo.mod.DISMISS_ACTION_IDENTIFIER // expo-notifications 0.32 and 57 export none
    const { client } = makeClient({ expo })
    const handler = jest.fn()
    client.onNotificationOpened(handler)

    expo.fire(expoResponse({ notificationId: '42' }, { action: APPLE_DISMISS_ACTION }))
    await flushPromises()
    await client.flush() // dismissed waits a random 0 to 30 s (T40); flush() sends it now

    expect(handler).not.toHaveBeenCalled()
    expect(tracked().map((b) => b.event)).toEqual(['dismissed'])
    expect(tracked()[0]).toMatchObject({ notification_id: 42 })
  })

  it('records a dismissal that launched the app, and keeps it from being handed to a handler later (D-149)', async () => {
    const expo = expoMock({ last: expoResponse({ notificationId: '9' }, { action: APPLE_DISMISS_ACTION }) })
    delete expo.mod.DISMISS_ACTION_IDENTIFIER
    const { client } = makeClient({ expo })
    await flushPromises()
    const handler = jest.fn()
    client.onNotificationOpened(handler)
    await flushPromises()
    await client.flush() // dismissed waits a random 0 to 30 s (T40); flush() sends it now

    expect(handler).not.toHaveBeenCalled()
    expect(tracked().map((b) => b.event)).toEqual(['dismissed'])
  })

  it('tracks nothing and calls no handler for a dismissal with autoTrack off (D-149)', async () => {
    const expo = expoMock()
    delete expo.mod.DISMISS_ACTION_IDENTIFIER
    const { client } = makeClient({ expo }, { autoTrack: false })
    const handler = jest.fn()
    client.onNotificationOpened(handler)

    expo.fire(expoResponse({ notificationId: '42' }, { action: APPLE_DISMISS_ACTION }))
    await flushPromises()

    expect(handler).not.toHaveBeenCalled()
    expect(tracked()).toEqual([])
  })

  it('still records a real tap as opened next to a dismissal of another push (D-149)', async () => {
    const expo = expoMock()
    delete expo.mod.DISMISS_ACTION_IDENTIFIER
    const { client } = makeClient({ expo })
    const handler = jest.fn()
    client.onNotificationOpened(handler)

    expo.fire(expoResponse({ notificationId: '1' }, { action: APPLE_DISMISS_ACTION }))
    expo.fire(expoResponse({ notificationId: '2' }, { id: 'req-2' }))
    await flushPromises()
    await client.flush() // the dismissal waits its random delay (T40), the tap does not: so the tap is sent first

    expect(handler).toHaveBeenCalledTimes(1)
    expect(tracked().map((b) => [b.event, b.notification_id])).toEqual([['opened', 2], ['dismissed', 1]])
  })

  it('stops calling a handler after its unsubscribe and after destroy() (TAP-09)', async () => {
    const expo = expoMock()
    const { client } = makeClient({ expo })
    const a = jest.fn()
    const b = jest.fn()
    const offA = client.onNotificationOpened(a)
    client.onNotificationOpened(b)

    offA()
    expo.fire(expoResponse({ notificationId: '1' }))
    await flushPromises()
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)

    client.destroy()
    expect(expo.remove).toHaveBeenCalled()
    expo.fire(expoResponse({ notificationId: '2' }))
    await flushPromises()
    expect(b).toHaveBeenCalledTimes(1)
  })
})

describe('a custom adapter that only has onResponse', () => {
  it('keeps the tracking and gives the handler an empty data object', async () => {
    const sdk = load({})
    let respond: (i: any) => void = () => {}
    const adapter = {
      onResponse: jest.fn((cb: any) => { respond = cb; return () => {} }),
      onReceived: () => () => {},
      onDismissed: () => () => {},
      supportsCategories: () => false,
      setCategories: async () => {},
    }
    const client = new sdk.PushClient({ projectId: 'pk_live_test', pushToken: 'tok', platform: 'ios', displayAdapter: adapter })
    const handler = jest.fn()
    client.onNotificationOpened(handler)

    respond({ notificationId: 5, actionId: 'go' })
    await flushPromises()

    expect(handler).toHaveBeenCalledWith({ notificationId: 5, data: {}, url: undefined, actionId: 'go' })
    expect(tracked()).toEqual([{ notification_id: 5, event: 'opened', push_token: 'tok' }])
  })
})

// ─── React Native CLI mode ────────────────────────────────────────────────────

function fcmMessage(data: Record<string, unknown>, messageId = 'm-1') {
  return { messageId, data, notification: { title: 't' } }
}

/** @react-native-firebase/messaging with the namespaced instance API. */
function fcmInstanceMock(opts: { initial?: any } = {}) {
  const openedListeners: Array<(m: any) => void> = []
  const unsubscribe = jest.fn()
  const instance = {
    getToken: jest.fn().mockResolvedValue('fcm-token'),
    onNotificationOpenedApp: jest.fn((cb: (m: any) => void) => { openedListeners.push(cb); return unsubscribe }),
    getInitialNotification: jest.fn().mockResolvedValue(opts.initial ?? null),
  }
  const factory: any = jest.fn(() => instance)
  factory.AuthorizationStatus = { AUTHORIZED: 1, PROVISIONAL: 2, DENIED: 0 }
  return { mod: { default: factory }, instance, fire: (m: any) => openedListeners.forEach((l) => l(m)), unsubscribe }
}

function notifyKitMock(opts: { initial?: any } = {}) {
  const listeners: Array<(e: any) => void> = []
  const unsubscribe = jest.fn()
  const instance = {
    onForegroundEvent: jest.fn((cb: (e: any) => void) => { listeners.push(cb); return unsubscribe }),
    getInitialNotification: jest.fn().mockResolvedValue(opts.initial ?? null),
    setNotificationCategories: jest.fn().mockResolvedValue(undefined),
  }
  return {
    mod: { default: instance, EventType: { PRESS: 1, ACTION_PRESS: 2, DISMISSED: 3, DELIVERED: 4 } },
    fire: (e: any) => listeners.forEach((l) => l(e)),
    unsubscribe,
  }
}

describe('React Native CLI mode, @react-native-firebase/messaging', () => {
  it('reads the tap of a push shown by the system and tracks it as opened (TAP-03)', async () => {
    const fcm = fcmInstanceMock()
    const { client } = makeClient({ extra: { '@react-native-firebase/messaging': fcm.mod } })
    const handler = jest.fn()
    client.onNotificationOpened(handler)

    fcm.fire(fcmMessage({ notificationId: '42', screen: 'order', url: 'myapp://orders/42' }))
    await flushPromises()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0]).toEqual({
      notificationId: '42',
      data: { notificationId: '42', screen: 'order', url: 'myapp://orders/42' },
      url: 'myapp://orders/42',
      actionId: undefined,
    })
    expect(tracked()).toEqual([{ notification_id: 42, event: 'opened', push_token: 'ExponentPushToken[abc]' }])
  })

  it('reads the launch tap with getInitialNotification, once (TAP-02)', async () => {
    const message = fcmMessage({ notificationId: '9' }, 'm-launch')
    const fcm = fcmInstanceMock({ initial: message })
    const { client } = makeClient({ extra: { '@react-native-firebase/messaging': fcm.mod } })
    const handler = jest.fn()
    client.onNotificationOpened(handler)
    await flushPromises()
    fcm.fire(message) // the same message reaches onNotificationOpenedApp too

    expect(handler).toHaveBeenCalledTimes(1)
    expect(tracked()).toHaveLength(1)
  })

  it('hands over a launch tap that a live tap of the same message already delivered only once (TAP-02)', async () => {
    const message = fcmMessage({ notificationId: '9' }, 'm-launch')
    let resolveInitial: (m: any) => void = () => {}
    const fcm = fcmInstanceMock()
    fcm.instance.getInitialNotification.mockReturnValue(new Promise((r) => { resolveInitial = r }))
    const { client } = makeClient({ extra: { '@react-native-firebase/messaging': fcm.mod } })
    const handler = jest.fn()
    client.onNotificationOpened(handler)

    fcm.fire(message) // the live event comes first
    resolveInitial(message) // then the launch read returns the same message
    await flushPromises()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(tracked()).toHaveLength(1)
  })

  it('uses the modular functions when the module exports them (TAP-03)', async () => {
    const opened: Array<(m: any) => void> = []
    const messagingInstance = { getToken: jest.fn() }
    const mod: any = {
      getMessaging: jest.fn(() => messagingInstance),
      AuthorizationStatus: { AUTHORIZED: 1, PROVISIONAL: 2, DENIED: 0 },
      onNotificationOpenedApp: jest.fn((_m: any, cb: (m: any) => void) => { opened.push(cb); return jest.fn() }),
      getInitialNotification: jest.fn().mockResolvedValue(fcmMessage({ notificationId: '9' }, 'm-launch')),
    }
    const { client } = makeClient({ extra: { '@react-native-firebase/messaging': mod } })
    const handler = jest.fn()
    client.onNotificationOpened(handler)
    await flushPromises()
    opened.forEach((l) => l(fcmMessage({ notificationId: '10' }, 'm-2')))

    expect(mod.onNotificationOpenedApp).toHaveBeenCalledWith(messagingInstance, expect.any(Function))
    expect(mod.getInitialNotification).toHaveBeenCalledWith(messagingInstance)
    expect(handler.mock.calls.map(([e]) => e.notificationId)).toEqual(['9', '10'])
  })

  it('never throws when the module has neither API (TAP-03)', async () => {
    const { client } = makeClient({ extra: { '@react-native-firebase/messaging': { default: jest.fn(() => ({})) } } })
    expect(() => client.onNotificationOpened(jest.fn())).not.toThrow()
    await flushPromises()
  })

  it('reports the bare display adapter in capabilities() with Firebase alone', () => {
    const fcm = fcmInstanceMock()
    const sdk = load({ extra: { '@react-native-firebase/messaging': fcm.mod } })
    expect(sdk.capabilities().displayAdapter).toBe('bare')
  })
})

describe('React Native CLI mode, react-native-notify-kit', () => {
  it('gives the data of a foreground press and of an action press (TAP-01)', async () => {
    const nk = notifyKitMock()
    const { client } = makeClient({ extra: { 'react-native-notify-kit': nk.mod } })
    const handler = jest.fn()
    client.onNotificationOpened(handler)

    nk.fire({ type: 1, detail: { notification: { data: { notificationId: '42', screen: 'order' } } } })
    nk.fire({ type: 2, detail: { notification: { data: { notificationId: '43' } }, pressAction: { id: 'reply' } } })
    await flushPromises()

    expect(handler.mock.calls[0][0]).toEqual({ notificationId: '42', data: { notificationId: '42', screen: 'order' }, url: undefined, actionId: undefined })
    expect(handler.mock.calls[1][0]).toMatchObject({ notificationId: '43', actionId: 'reply' })
    expect(tracked().map((b) => b.notification_id)).toEqual([42, 43])
  })

  it('treats the default press action of the initial notification as no action (TAP-01)', async () => {
    const nk = notifyKitMock({ initial: { notification: { id: 'n1', data: { notificationId: '9' } }, pressAction: { id: 'default' } } })
    const { client } = makeClient({ extra: { 'react-native-notify-kit': nk.mod } })
    const handler = jest.fn()
    client.onNotificationOpened(handler)
    await flushPromises()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].actionId).toBeUndefined()
  })

  it('delivers a single launch tap when notify-kit and Firebase both report one (TAP-02)', async () => {
    const nk = notifyKitMock({ initial: { notification: { id: 'n1', data: { notificationId: '9' } }, pressAction: { id: 'default' } } })
    const fcm = fcmInstanceMock({ initial: fcmMessage({ notificationId: '9' }, 'm-launch') })
    const { client } = makeClient({ extra: { 'react-native-notify-kit': nk.mod, '@react-native-firebase/messaging': fcm.mod } })
    const handler = jest.fn()
    client.onNotificationOpened(handler)
    await flushPromises()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(tracked()).toHaveLength(1)
  })

  it('unsubscribes both sources on destroy() (TAP-09)', async () => {
    const nk = notifyKitMock()
    const fcm = fcmInstanceMock()
    const { client } = makeClient({ extra: { 'react-native-notify-kit': nk.mod, '@react-native-firebase/messaging': fcm.mod } })
    client.onNotificationOpened(jest.fn())
    client.destroy()

    expect(nk.unsubscribe).toHaveBeenCalled()
    expect(fcm.unsubscribe).toHaveBeenCalled()
  })
})

// A module, so that its top-level names do not clash with the other test files that are scripts.
export {}
