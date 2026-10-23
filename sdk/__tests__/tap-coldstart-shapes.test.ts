/**
 * @jest-environment jsdom
 *
 * The tap that launches a closed app, in the shapes expo-notifications hands over (read from its source, 0.32.16 and
 * 57.0.21: NotificationSerializer.toResponseBundleFromExtras, mapNotificationResponse, EXNotificationSerializer.m):
 * the Expo push service puts the data of the push in one JSON string `body` (Android) or in the APNs `body` object
 * (iOS), and the library unwraps it into `content.data`. The SDK reads the unwrapped shape and, when a copy still
 * carries the wrapper, unwraps it too. A launch from the icon is not a tap. Native modules are virtual mocks.
 */

const flushPromises = () => new Promise((r) => setTimeout(r, 0))

const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT'
const TOKEN = 'ExponentPushToken[abc]'

type Content = Record<string, unknown>

function response(content: Content, extra: { id?: string | null; date?: number } = {}) {
  return {
    actionIdentifier: DEFAULT_ACTION,
    notification: {
      date: extra.date ?? 1_700_000_000_000,
      request: { identifier: extra.id === undefined ? 'g-msg-1' : extra.id, content },
    },
  }
}

/** What an Expo push with `{ documentUuid, notificationId }` is once expo-notifications mapped it (the normal shape). */
const MAPPED = { documentUuid: 'doc-1', notificationId: '77' }
const BODY_STRING = JSON.stringify(MAPPED)

function expoMock(opts: { last?: any; sync?: boolean } = {}) {
  const listeners: Array<(r: any) => void> = []
  const mod: any = {
    DEFAULT_ACTION_IDENTIFIER: DEFAULT_ACTION,
    DISMISS_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DISMISS',
    addNotificationResponseReceivedListener: jest.fn((cb: (r: any) => void) => {
      listeners.push(cb)
      return { remove: jest.fn() }
    }),
    addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  }
  if (opts.sync) mod.getLastNotificationResponse = jest.fn(() => opts.last ?? null)
  else mod.getLastNotificationResponseAsync = jest.fn().mockResolvedValue(opts.last ?? null)
  return { mod, fire: (r: any) => listeners.forEach((l) => l(r)) }
}

const fetchMock = jest.fn()

function load(expo: ReturnType<typeof expoMock>) {
  jest.resetModules()
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ ok: true, text: async () => '' })
  ;(globalThis as any).fetch = fetchMock
  jest.doMock('expo-notifications', () => expo.mod, { virtual: true })
  jest.doMock('react-native', () => ({ Platform: { OS: 'android', Version: 34 }, AppState: null }), { virtual: true })
  return require('../src/index')
}

/** The delivery events sent so far, from the single route and from the batch route (T40). */
function tracked(): any[] {
  return fetchMock.mock.calls.flatMap(([url, init]) => {
    if (String(url).endsWith('/v1/notifications/track')) return [JSON.parse(init.body)]
    if (String(url).endsWith('/v1/notifications/track/batch')) return JSON.parse(init.body).events
    return []
  })
}

function makeClient(expo: ReturnType<typeof expoMock>, config: Record<string, unknown> = {}) {
  const sdk = load(expo)
  return new sdk.PushClient({ projectId: 'pk_live_test', pushToken: TOKEN, platform: 'android', ...config })
}

describe('the data of a launch tap', () => {
  it('reads the mapped shape of an Expo push on Android: id and data at the top level (regression)', async () => {
    const expo = expoMock({ last: response({ data: MAPPED }) })
    const handler = jest.fn()
    makeClient(expo, { onNotificationOpened: handler })
    await flushPromises()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0]).toMatchObject({ notificationId: '77', data: MAPPED })
    expect(tracked()).toEqual([{ notification_id: 77, event: 'opened', push_token: TOKEN }])
  })

  it('unwraps a JSON string `body` that stayed in the data (Android system-tray cold start)', async () => {
    const expo = expoMock({ last: response({ data: { body: BODY_STRING, title: 'Hi' } }) })
    const handler = jest.fn()
    makeClient(expo, { onNotificationOpened: handler })
    await flushPromises()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0]).toMatchObject({ notificationId: '77', data: { documentUuid: 'doc-1', notificationId: '77', title: 'Hi' } })
    expect(tracked()).toEqual([{ notification_id: 77, event: 'opened', push_token: TOKEN }])
  })

  it('unwraps the `dataString` of the content when `data` came without it', async () => {
    const expo = expoMock({ last: response({ data: {}, dataString: BODY_STRING }) })
    const handler = jest.fn()
    makeClient(expo, { onNotificationOpened: handler })
    await flushPromises()

    expect(handler.mock.calls[0][0]).toMatchObject({ notificationId: '77', data: { documentUuid: 'doc-1' } })
    expect(tracked()).toHaveLength(1)
  })

  it('unwraps the `body` object of an iOS Expo payload that stayed in the data', async () => {
    const expo = expoMock({ last: response({ data: { body: MAPPED } }) })
    const handler = jest.fn()
    makeClient(expo, { onNotificationOpened: handler })
    await flushPromises()

    expect(handler.mock.calls[0][0]).toMatchObject({ notificationId: '77', data: { documentUuid: 'doc-1' } })
    expect(tracked()).toEqual([{ notification_id: 77, event: 'opened', push_token: TOKEN }])
  })

  it('lets a key at the top level win over the same key in the wrapper, and ignores a body that is not an object', async () => {
    const expo = expoMock()
    const client = makeClient(expo)
    const handler = jest.fn()
    client.onNotificationOpened(handler)

    expo.fire(response({ data: { notificationId: '5', body: JSON.stringify({ notificationId: '99', extra: 1 }) } }, { id: 'a' }))
    expo.fire(response({ data: { notificationId: '6', body: 'just a sentence' } }, { id: 'b' }))
    expo.fire(response({ data: { notificationId: '7', body: '{not json' } }, { id: 'c' }))
    expo.fire(response({ data: { notificationId: '8', body: '[1,2]' } }, { id: 'd' }))
    await flushPromises()

    expect(handler.mock.calls.map(([e]) => e.notificationId)).toEqual(['5', '6', '7', '8'])
    expect(handler.mock.calls[0][0].data).toEqual({ notificationId: '5', body: JSON.stringify({ notificationId: '99', extra: 1 }), extra: 1 })
    expect(handler.mock.calls[1][0].data).toEqual({ notificationId: '6', body: 'just a sentence' })
  })

  it('reads the same data on the live path as on the launch read', async () => {
    const expo = expoMock()
    const client = makeClient(expo)
    const handler = jest.fn()
    client.onNotificationOpened(handler)

    expo.fire(response({ data: { body: BODY_STRING } }))
    await flushPromises()

    expect(handler.mock.calls[0][0]).toMatchObject({ notificationId: '77', data: { documentUuid: 'doc-1' } })
    expect(tracked()).toEqual([{ notification_id: 77, event: 'opened', push_token: TOKEN }])
  })

  it('hands one response that reaches both the launch read and the live listener once', async () => {
    const launch = response({ data: { body: BODY_STRING } })
    const expo = expoMock({ last: launch })
    const handler = jest.fn()
    makeClient(expo, { onNotificationOpened: handler })
    await flushPromises()
    expo.fire(launch)
    await flushPromises()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(tracked()).toHaveLength(1)
  })

  it('reads the launch response with the synchronous getLastNotificationResponse when that is all the library has', async () => {
    const expo = expoMock({ last: response({ data: MAPPED }), sync: true })
    const handler = jest.fn()
    makeClient(expo, { onNotificationOpened: handler })
    await flushPromises()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(tracked()).toHaveLength(1)
  })

  it('reads the id of a received push and of a dismissal from the wrapped data too', async () => {
    const received: Array<(n: any) => void> = []
    const expo = expoMock()
    expo.mod.addNotificationReceivedListener = jest.fn((cb: (n: any) => void) => { received.push(cb); return { remove: jest.fn() } })
    const client = makeClient(expo)
    received.forEach((cb) => cb({ request: { identifier: 'r', content: { data: { body: BODY_STRING } } } }))
    expo.fire({ actionIdentifier: expo.mod.DISMISS_ACTION_IDENTIFIER, notification: { date: 1, request: { identifier: 'r2', content: { data: { body: BODY_STRING } } } } })
    await flushPromises()
    await client.flush() // received and dismissed wait a random 0 to 30 s (T40); flush() sends them now

    expect(tracked().map((t) => t.event).sort()).toEqual(['dismissed', 'received'])
    expect(tracked().every((t) => t.notification_id === 77)).toBe(true)
  })
})

describe('a launch that is not a tap', () => {
  /** What getLastNotificationResponseAsync gave after a launch from the icon on a OnePlus (expo-notifications 0.32). */
  const LAUNCHER_ONLY = response(
    { data: { anim_not_finish: false, start_reason: 3, anim_from_item_click: true } },
    { id: null, date: 0 },
  )

  it('is not a tap: no handler call, no opened', async () => {
    const expo = expoMock({ last: LAUNCHER_ONLY })
    const handler = jest.fn()
    makeClient(expo, { onNotificationOpened: handler })
    await flushPromises()

    expect(handler).not.toHaveBeenCalled()
    expect(tracked()).toEqual([])
  })

  it('is not kept for a handler registered later, and does not use up the launch place', async () => {
    const expo = expoMock({ last: LAUNCHER_ONLY })
    const client = makeClient(expo)
    await flushPromises()
    const handler = jest.fn()
    client.onNotificationOpened(handler)
    expect(handler).not.toHaveBeenCalled()

    expo.fire(response({ data: MAPPED }, { id: 'real' }))
    await flushPromises()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0]).toMatchObject({ notificationId: '77' })
  })

  it('is not a tap on the live listener either (Android reports one for any intent that brings the app forward)', async () => {
    const expo = expoMock()
    const client = makeClient(expo)
    const handler = jest.fn()
    client.onNotificationOpened(handler)
    expo.fire(LAUNCHER_ONLY)
    await flushPromises()

    expect(handler).not.toHaveBeenCalled()
    expect(tracked()).toEqual([])
  })

  it('still hands a push that has an identifier but no notification id (a push sent by another service)', async () => {
    const expo = expoMock({ last: response({ data: { screen: 'cart' } }, { id: 'g-msg-9' }) })
    const handler = jest.fn()
    makeClient(expo, { onNotificationOpened: handler })
    await flushPromises()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0]).toMatchObject({ data: { screen: 'cart' } })
    expect(tracked()).toEqual([])
  })

  it('still hands a response with no identifier when its data carries a notification id', async () => {
    const expo = expoMock({ last: response({ data: MAPPED }, { id: null }) })
    const handler = jest.fn()
    makeClient(expo, { onNotificationOpened: handler })
    await flushPromises()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(tracked()).toHaveLength(1)
  })
})

// A module, not a script: ts-jest type-checks script files in one shared scope, where two of them declaring the same
// top-level name fail to compile.
export {};
