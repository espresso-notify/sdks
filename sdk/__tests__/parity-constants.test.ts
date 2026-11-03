/**
 * @jest-environment jsdom
 *
 * sdk-parity T45 (PAR-46): the React Native SDK behaves as the shared constants say. The numbers come from the copy of
 * `sdk-parity/constants.json` (RN exceptions included: queue 200 under C16, pending taps 1 under C5), never from a
 * literal here.
 *
 * feature: queue.retry
 * feature: queue.offline
 * feature: tracking.batching
 * feature: metadata.size-limit
 * feature: tracking.tap-semantics
 * feature: tracking.pending-taps
 * feature: privacy.consent
 */
import { effective, keysFor } from './helpers/parityConstants'

const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT'
const DISMISS_ACTION = 'expo.modules.notifications.actions.DISMISS'

describe('the constants of rn', () => {
  it('lists the keys this SDK is tested against', () => {
    expect(keysFor('rn')).toEqual([
      'retry.attempts',
      'retry_after.cap_seconds',
      'retry_after.jitter_ratio',
      'queue.max_events',
      'batch.max_events',
      'batch.window_seconds',
      'metadata.max_bytes',
      'taps.pending_max',
      'consent.buffer_events',
      'action_id.max_length',
      'gesture_events',
    ])
  })
})

describe('retry (retry.attempts, retry_after.cap_seconds, retry_after.jitter_ratio)', () => {
  const retry = require('../src/retry')

  it('tries retry.attempts times in all', async () => {
    const fn = jest.fn().mockRejectedValue(Object.assign(new Error('offline'), { network: true }))
    jest.spyOn(globalThis, 'setTimeout').mockImplementation(((cb: () => void) => { cb(); return 0 as any }) as any)
    await expect(retry.withRetry(fn)).rejects.toThrow('offline')
    jest.restoreAllMocks()
    expect(fn).toHaveBeenCalledTimes(effective('retry.attempts', 'rn'))
    expect(retry.RETRY_ATTEMPTS).toBe(effective('retry.attempts', 'rn'))
  })

  it('obeys a Retry-After up to retry_after.cap_seconds and not beyond', () => {
    const cap = effective('retry_after.cap_seconds', 'rn')
    expect(retry.jitterRetryAfter(cap * 10, () => 0)).toBe(cap * 1000)
    expect(retry.jitterRetryAfter(cap * 10, () => 1)).toBe(cap * 1000)
    expect(retry.jitterRetryAfter(cap - 1, () => 0)).toBe((cap - 1) * 1000)
  })

  it('stretches a Retry-After by up to retry_after.jitter_ratio', () => {
    const ratio = effective('retry_after.jitter_ratio', 'rn')
    expect(retry.jitterRetryAfter(100, () => 0)).toBe(100_000)
    expect(retry.jitterRetryAfter(100, () => 1)).toBe(Math.round(100_000 * (1 + ratio)))
  })
})

describe('batching (batch.max_events, batch.window_seconds)', () => {
  const batch = require('../src/track-batch')

  it('carries batch.max_events events in one request', () => {
    expect(batch.BATCH_MAX_EVENTS).toBe(effective('batch.max_events', 'rn'))
  })

  it('spreads delayed events over batch.window_seconds', () => {
    expect(batch.SPREAD_WINDOW_MS).toBe(effective<number>('batch.window_seconds', 'rn') * 1000)
  })
})

describe('offline queue (queue.max_events)', () => {
  it('keeps queue.max_events events and counts the older ones as dropped', async () => {
    jest.resetModules()
    jest.useFakeTimers({ now: 1_700_000_000_000 })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: 17 }, AppState: null }), { virtual: true })
    const sdk = require('../src/index')
    const map = new Map<string, string>()
    const store = {
      getItem: async (k: string) => map.get(k) ?? null,
      setItem: async (k: string, v: string) => { map.set(k, v) },
      removeItem: async (k: string) => { map.delete(k) },
    }
    const transport = { request: jest.fn().mockRejectedValue(new TypeError('Network request failed')) }
    const client = new sdk.PushClient({
      projectId: 'pk_live_parity', pushToken: 'ExponentPushToken[p]', platform: 'ios', transport, autoTrack: false, _queueStore: store,
    })
    const max = effective('queue.max_events', 'rn')
    for (let i = 1; i <= max + 3; i++) await client.devices.trackOpen(i)

    expect(await client.queueStats()).toEqual({ pending: max, dropped: 3 })
    jest.useRealTimers()
  })
})

describe('metadata (metadata.max_bytes)', () => {
  const fetchMock = jest.fn()
  const padded = (size: number) => ({ k: 'a'.repeat(size - '{"k":""}'.length) })

  beforeEach(() => {
    jest.resetModules()
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({ ok: true, text: () => Promise.resolve('{}') })
    ;(globalThis as any).fetch = fetchMock
    jest.doMock('expo-notifications', () => ({}), { virtual: true })
  })

  const identifyCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/devices/identify'))
  const client = () => {
    const { PushClient } = require('../src/index')
    return new PushClient({ projectId: 'pk_live_test', pushToken: 'tok-1', platform: 'ios', autoTrack: false })
  }

  it('takes exactly metadata.max_bytes and refuses one byte more before any request', async () => {
    const max = effective('metadata.max_bytes', 'rn')
    await client().devices.identify({ externalId: 'u1', metadata: padded(max) })
    expect(identifyCalls()).toHaveLength(1)

    fetchMock.mockClear()
    const err: any = await client().devices.identify({ externalId: 'u1', metadata: padded(max + 1) }).catch((e: any) => e)
    expect(err.code).toBe('METADATA_TOO_LARGE')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('taps (taps.pending_max, action_id.max_length, gesture_events)', () => {
  const fetchMock = jest.fn()

  function setup() {
    jest.resetModules()
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({ ok: true, text: async () => '' })
    ;(globalThis as any).fetch = fetchMock
    const listeners: Array<(r: any) => void> = []
    jest.doMock('expo-notifications', () => ({
      DEFAULT_ACTION_IDENTIFIER: DEFAULT_ACTION,
      DISMISS_ACTION_IDENTIFIER: DISMISS_ACTION,
      addNotificationResponseReceivedListener: (cb: (r: any) => void) => { listeners.push(cb); return { remove: jest.fn() } },
      addNotificationReceivedListener: () => ({ remove: jest.fn() }),
      getLastNotificationResponseAsync: jest.fn().mockResolvedValue(null),
    }), { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: 17 }, AppState: null, Linking: null }), { virtual: true })
    const sdk = require('../src/index')
    const client = new sdk.PushClient({ projectId: 'pk_live_test', pushToken: 'tok', platform: 'ios' })
    const tap = (id: string, action: string) =>
      listeners.forEach((l) => l({
        actionIdentifier: action,
        notification: { date: Math.random(), request: { identifier: `req-${Math.random()}`, content: { data: { notificationId: id } } } },
      }))
    return { client, tap }
  }

  const events = () =>
    fetchMock.mock.calls.flatMap(([url, init]) => {
      if (String(url).endsWith('/v1/notifications/track')) return [JSON.parse(init.body)]
      if (String(url).endsWith('/v1/notifications/track/batch')) return JSON.parse(init.body).events
      return []
    })

  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}))
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers() })

  it('keeps taps.pending_max launch tap for a handler that registers later', () => {
    const { client } = setup()
    const max = effective<number>('taps.pending_max', 'rn')
    for (let i = 1; i <= max + 2; i++) (client as any)._handleTap({ notificationId: String(i), coldStart: true })
    const handler = jest.fn()
    client.onNotificationOpened(handler)

    const total = max + 2
    expect(handler.mock.calls.map(([e]: any[]) => e.notificationId)).toEqual(
      Array.from({ length: max }, (_, i) => String(total - max + 1 + i)),
    )
  })

  it('sends an action id of action_id.max_length characters and leaves out one more', async () => {
    const { client } = setup()
    const max = effective<number>('action_id.max_length', 'rn')
    await client.devices.trackClick(1, undefined, 'a'.repeat(max))
    await client.devices.trackClick(2, undefined, 'a'.repeat(max + 1))

    const clicks = events().filter((e) => e.event === 'clicked')
    expect(clicks.find((e) => e.notification_id === 1).action_id).toBe('a'.repeat(max))
    expect(clicks.find((e) => e.notification_id === 2).action_id).toBeUndefined()
  })

  it('maps the body to gesture_events.body, a button to .button and a dismissal to .dismiss', async () => {
    const gestures = effective<{ body: string; button: string; dismiss: string }>('gesture_events', 'rn')
    const { client, tap } = setup()
    tap('1', DEFAULT_ACTION)
    tap('2', 'reply')
    tap('3', DISMISS_ACTION)
    await client.flush() // a dismissal waits its random delay; flush() sends it now

    const byId = (id: number) => events().filter((e) => e.notification_id === id).map((e) => e.event)
    expect(byId(1)).toEqual([gestures.body])
    expect(byId(2)).toEqual([gestures.button])
    expect(byId(3)).toEqual([gestures.dismiss])
  })
})
