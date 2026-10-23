/**
 * @jest-environment node
 *
 * send-scale T40 (SCALE-26, SCALE-29): the delivery events of the real client go through the batcher and the offline queue.
 * Storage and transport are fakes, time is fake, native modules are virtual mocks.
 */
const T0 = 1_700_000_000_000
const SECOND = 1000
const BATCH = '/v1/notifications/track/batch'
const SINGLE = '/v1/notifications/track'

class FakeStore {
  readonly map = new Map<string, string>()
  async getItem(key: string) { return this.map.get(key) ?? null }
  async setItem(key: string, value: string) { this.map.set(key, value) }
  text() { return [...this.map.values()].join('\n') }
}

function boot(opts: { store?: FakeStore; config?: Record<string, unknown> } = {}) {
  jest.resetModules()
  const listeners: Array<(s: string) => void> = []
  jest.doMock('react-native', () => ({
    Platform: { OS: 'ios', Version: 17 },
    AppState: { currentState: 'active', addEventListener: jest.fn((_t: string, cb: (s: string) => void) => { listeners.push(cb); return { remove: jest.fn() } }) },
  }), { virtual: true })
  const sdk = require('../src/index')
  const store = opts.store ?? new FakeStore()
  const transport = { request: jest.fn().mockResolvedValue({}) }
  const client = new sdk.PushClient({
    projectId: 'pk_live_batch', pushToken: 'ExponentPushToken[secret-device]', platform: 'ios', transport, autoTrack: false,
    _queueStore: store, ...opts.config,
  })
  return { sdk, store, transport, client, appState: (s: string) => listeners.forEach((l) => l(s)) }
}

type Req = { path: string; body: any }
const requests = (transport: { request: jest.Mock }): Req[] => transport.request.mock.calls.map(([path, init]) => ({ path, body: JSON.parse(init.body) }))
/** Every delivery event the transport got, from both routes, in order. */
const events = (transport: { request: jest.Mock }) => requests(transport).flatMap((r) => (r.path === BATCH ? r.body.events : r.path === SINGLE ? [r.body] : []))
const http = (sdk: any, status: number, code?: string, retryAfter?: number) =>
  new sdk.EspressoNotifyHttpError(`HTTP ${status}`, status, code, BATCH, retryAfter)

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('what the client sends', () => {
  it('45 received events go out as 3 requests to the batch route, with the token once per request', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0)
    const { transport, client } = boot()
    transport.request.mockImplementation(async (path: string, init: any) => (path === BATCH ? { recorded: JSON.parse(init.body).events.length, rejected: 0, results: [] } : {}))
    for (let i = 1; i <= 45; i++) await client.devices.trackReceived(i)
    await jest.advanceTimersByTimeAsync(0)

    const sent = requests(transport)
    expect(sent.map((r) => [r.path, r.body.events.length])).toEqual([[BATCH, 20], [BATCH, 20], [BATCH, 5]])
    expect(sent.every((r) => r.body.push_token === 'ExponentPushToken[secret-device]')).toBe(true)
    expect(sent[0].body.events[0]).toEqual({ notification_id: 1, event: 'received' })
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
  })

  it('an opened event goes at once, in the tick of the call, with the body the previous SDK sent', async () => {
    const { transport, client } = boot()
    const pending = client.devices.trackOpen(7)
    expect(transport.request).toHaveBeenCalledTimes(1) // before any await: the request left in the same tick
    await pending
    expect(requests(transport)).toEqual([{ path: SINGLE, body: { notification_id: 7, event: 'opened', push_token: 'ExponentPushToken[secret-device]' } }])
  })

  it('a received event waits its random delay and then goes alone to the single route', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5)
    const { transport, client } = boot()
    await client.devices.trackReceived(9)
    await jest.advanceTimersByTimeAsync(14 * SECOND)
    expect(transport.request).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(SECOND)
    expect(requests(transport)).toEqual([{ path: SINGLE, body: { notification_id: 9, event: 'received', push_token: 'ExponentPushToken[secret-device]' } }])
  })

  it('the app leaving the foreground sends what waits', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.9)
    const { transport, client, appState } = boot()
    await client.devices.trackReceived(1)
    await client.devices.trackDismissed(2)
    expect(transport.request).not.toHaveBeenCalled()

    appState('background')
    await jest.advanceTimersByTimeAsync(0)

    expect(requests(transport).map((r) => [r.path, r.body.events?.length])).toEqual([[BATCH, 2]])
  })

  it('conversions, custom events and lifecycle events are not delayed or batched', async () => {
    const { transport, client } = boot()
    await client.devices.trackConversion(3)
    await client.devices.trackEvent('order.completed')
    await client.devices.recordLifecycle('permission', 'undetermined', 'granted')
    expect(requests(transport).map((r) => r.path)).toEqual([SINGLE, SINGLE, '/v1/devices/lifecycle'])
  })

  it('with the offline queue off it is one request now, as before', async () => {
    const { transport, client } = boot({ config: { offlineQueue: { enabled: false } } })
    await client.devices.trackReceived(1)
    expect(requests(transport)).toEqual([{ path: SINGLE, body: { notification_id: 1, event: 'received', push_token: 'ExponentPushToken[secret-device]' } }])
  })
})

describe('a server without the batch route (SCALE-29)', () => {
  it('a 404 switches the session to single requests and loses no event', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0)
    const { sdk, transport, client } = boot()
    transport.request.mockImplementation(async (path: string) => { if (path === BATCH) throw http(sdk, 404); return {} })
    for (let i = 1; i <= 3; i++) await client.devices.trackReceived(i)
    await jest.advanceTimersByTimeAsync(0)
    for (let i = 4; i <= 6; i++) await client.devices.trackDismissed(i)
    await jest.advanceTimersByTimeAsync(5 * SECOND)

    expect(requests(transport).filter((r) => r.path === BATCH)).toHaveLength(1)
    expect(events(transport).filter((e) => e.push_token).map((e) => e.notification_id)).toEqual([1, 2, 3, 4, 5, 6])
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
  })
})

describe('a batch that fails (the offline queue keeps it)', () => {
  it('keeps every event of a failed batch as a single event, on disk with the same fields and key as before', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0)
    const { sdk, store, transport, client } = boot()
    transport.request.mockRejectedValue(http(sdk, 503))
    for (let i = 1; i <= 3; i++) await client.devices.trackReceived(i)
    await jest.advanceTimersByTimeAsync(0)

    expect(await client.queueStats()).toEqual({ pending: 3, dropped: 0 })
    const key = [...store.map.keys()].find((k) => k.startsWith('espresso.eventQueue.pk_live_batch.') && !k.endsWith('.n'))
    expect(key).toBeDefined()
    const state = JSON.parse([...store.map.entries()].filter(([k]) => k.startsWith('espresso.eventQueue') && !k.endsWith('.n')).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([, v]) => v).join(''))
    expect(state.items.map((i: any) => [i.path, i.body.notification_id, i.body.event, i.body.push_token])).toEqual([
      [SINGLE, 1, 'received', null], [SINGLE, 2, 'received', null], [SINGLE, 3, 'received', null],
    ])
    expect(store.text()).not.toContain('secret-device')
  })

  it('sends them again, one by one, when the server is back', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0)
    const { sdk, transport, client } = boot()
    transport.request.mockRejectedValueOnce(http(sdk, 503))
    for (let i = 1; i <= 3; i++) await client.devices.trackReceived(i)
    await jest.advanceTimersByTimeAsync(0)
    transport.request.mockReset()
    transport.request.mockResolvedValue({})

    await client.flush()

    expect(requests(transport).map((r) => [r.path, r.body.notification_id])).toEqual([[SINGLE, 1], [SINGLE, 2], [SINGLE, 3]])
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
  })

  it('a 429 with Retry-After holds the batch and the queue: nothing else goes before the wait', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0)
    const { sdk, transport, client } = boot()
    transport.request.mockRejectedValueOnce(http(sdk, 429, 'rate_limited', 30))
    for (let i = 1; i <= 2; i++) await client.devices.trackReceived(i)
    await jest.advanceTimersByTimeAsync(0)
    transport.request.mockClear()
    transport.request.mockResolvedValue({})

    await client.devices.trackReceived(3)
    await client.devices.trackReceived(4) // two events: without the pause they would go together to the batch route
    await jest.advanceTimersByTimeAsync(29 * SECOND)
    expect(transport.request).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(2 * SECOND)
    expect(events(transport).map((e) => e.notification_id).sort()).toEqual([1, 2, 3, 4])
  })

  it('an error of the SDK itself (pinning not active) drops the events of the batch and counts them', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0)
    const { sdk, transport, client } = boot()
    transport.request.mockRejectedValue(new sdk.EspressoNotifyError('PINNING_NOT_ACTIVE', 'pinning'))
    for (let i = 1; i <= 3; i++) await client.devices.trackReceived(i)
    await jest.advanceTimersByTimeAsync(0)
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 3 })
    expect(console.warn).not.toHaveBeenCalled() // an SDK error is not a refusal of the server: no "HTTP 0" line
  })

  it('a batch that works sends the events the queue was holding when their time has come', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0)
    const { sdk, transport, client } = boot()
    transport.request.mockRejectedValueOnce(http(sdk, 503))
    await client.devices.trackOpen(100) // kept by the queue
    transport.request.mockReset()
    transport.request.mockResolvedValue({})
    // block the timer so that the success of the batch is what finds the held event due
    jest.clearAllTimers()
    jest.setSystemTime(T0 + 6 * SECOND)

    await client.devices.trackReceived(1)
    await client.devices.trackReceived(2)
    await jest.advanceTimersByTimeAsync(0)

    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
    expect(events(transport).map((e) => e.notification_id).sort((a, b) => a - b)).toEqual([1, 2, 100])
  })

  it('events refused for good inside a batch are counted as dropped', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0)
    const { transport, client } = boot()
    transport.request.mockResolvedValue({ recorded: 1, rejected: 1, results: [{ index: 0, status: 'recorded' }, { index: 1, status: 'rejected', code: 'unknown_notification' }] })
    await client.devices.trackReceived(1)
    await client.devices.trackReceived(2)
    await jest.advanceTimersByTimeAsync(0)
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 1 })
  })
})

describe('destroy() and flush()', () => {
  it('destroy() hands what waits to the queue, and the next client of the install sends it', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.9)
    const store = new FakeStore()
    const first = boot({ store })
    await first.client.devices.trackReceived(1)
    await first.client.devices.trackDismissed(2)
    first.client.destroy()
    await jest.advanceTimersByTimeAsync(0)
    expect(first.transport.request).not.toHaveBeenCalled()

    const second = boot({ store })
    await jest.advanceTimersByTimeAsync(6 * SECOND)
    expect(requests(second.transport).map((r) => [r.path, r.body.notification_id, r.body.event])).toEqual([[SINGLE, 1, 'received'], [SINGLE, 2, 'dismissed']])
  })

  it('flush() sends the delayed events first, then the queue', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.9)
    const { transport, client } = boot()
    await client.devices.trackReceived(1)
    await client.devices.trackReceived(2)
    await client.flush()
    expect(requests(transport).map((r) => [r.path, r.body.events?.length])).toEqual([[BATCH, 2]])
  })
})
