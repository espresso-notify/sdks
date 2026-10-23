/**
 * @jest-environment node
 *
 * rn-tap-and-offline-queue, T6 (OFQ-01 to OFQ-14): an event the SDK reports and cannot deliver is kept in a small
 * persistent queue and retried; the server refusals that retrying cannot fix drop the event. Storage and transport
 * are fakes, time is fake, native modules are virtual mocks.
 */

const T0 = 1_700_000_000_000
const SECOND = 1000
const DAY = 24 * 60 * 60 * SECOND
/** The key a queue of this project and install is stored under (`espresso.deviceId` below names the install). */
const OWN_DEVICE = 'feedfacefeedfacefeedfacefeedface'
const OWN_QUEUE = `espresso.eventQueue.pk_live_queue.${OWN_DEVICE}`

class FakeStore {
  readonly map = new Map<string, string>()
  setItemCalls = 0
  fail = false
  async getItem(key: string) {
    if (this.fail) throw new Error('store down')
    return this.map.get(key) ?? null
  }
  async setItem(key: string, value: string) {
    if (this.fail) throw new Error('store down')
    this.setItemCalls++
    this.map.set(key, value)
  }
  /** Everything stored, joined: for "nothing secret is on disk". */
  text() { return [...this.map.values()].join('\n') }
}

type Setup = { store?: FakeStore; token?: string | null; config?: Record<string, unknown>; appState?: any }

function boot(opts: Setup = {}) {
  jest.resetModules()
  const appStateListeners: Array<(s: string) => void> = []
  const appState = opts.appState ?? {
    currentState: 'background',
    addEventListener: jest.fn((_t: string, cb: (s: string) => void) => { appStateListeners.push(cb); return { remove: jest.fn() } }),
  }
  jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: 17 }, AppState: appState }), { virtual: true })
  const sdk = require('../src/index')
  const store = opts.store ?? new FakeStore()
  const transport = { request: jest.fn().mockResolvedValue({}) }
  const make = (config: Record<string, unknown> = {}) =>
    new sdk.PushClient({
      projectId: 'pk_live_queue',
      pushToken: opts.token === null ? undefined : (opts.token ?? 'ExponentPushToken[secret-device]'),
      platform: 'ios',
      transport,
      autoTrack: false,
      _queueStore: store,
      ...opts.config,
      ...config,
    })
  return { sdk, store, transport, make, client: make(), foreground: () => appStateListeners.forEach((l) => l('active')) }
}

const http = (sdk: any, status: number, code?: string, retryAfter?: number) =>
  new sdk.EspressoNotifyHttpError(`HTTP ${status}`, status, code, '/v1/notifications/track', retryAfter)
const network = () => new TypeError('Network request failed')

/** The bodies sent to the transport, parsed, in order. */
const sent = (transport: { request: jest.Mock }) => transport.request.mock.calls.map(([, init]) => JSON.parse(init.body))

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  jest.spyOn(Math, 'random').mockReturnValue(1) // full jitter unless a test says otherwise
})
/** jest's own stack mapping (source-map) hangs on a constant Math.random: give it the real one. */
const realRandom = () => (Math.random as jest.Mock).mockRestore?.()
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('what is kept (OFQ-01)', () => {
  it.each([
    ['a network error', () => network()],
    ['a 408', (sdk: any) => http(sdk, 408)],
    ['a 429', (sdk: any) => http(sdk, 429)],
    ['a 500', (sdk: any) => http(sdk, 500)],
    ['a 503', (sdk: any) => http(sdk, 503)],
  ])('keeps the event after %s and does not throw', async (_name, makeError) => {
    const { sdk, transport, client } = boot()
    transport.request.mockRejectedValueOnce(makeError(sdk))

    await expect(client.devices.trackOpen(42)).resolves.toBeUndefined()

    expect(await client.queueStats()).toEqual({ pending: 1, dropped: 0 })
  })

  it('keeps every kind of event that has a notification, a name or a lifecycle change', async () => {
    const { sdk, transport, client } = boot()
    transport.request.mockRejectedValue(network())

    await client.devices.trackOpen(1)
    await client.devices.trackReceived(2)
    await client.devices.trackDismissed(3)
    await client.devices.trackClick(4)
    await client.devices.trackConversion(5)
    await client.devices.trackEvent('order.completed')
    await client.devices.recordLifecycle('permission', 'undetermined', 'granted')
    await client.flush() // received and dismissed wait their random delay (T40); flush() sends them now

    expect(await client.queueStats()).toEqual({ pending: 7, dropped: 0 })
    void sdk
  })
})

describe('what is dropped (OFQ-06, OFQ-11)', () => {
  it.each([400, 401, 403, 404, 413, 422])('drops the event after a %s and counts it', async (status) => {
    const { sdk, transport, client } = boot()
    transport.request.mockRejectedValueOnce(http(sdk, status, 'unknown_device'))

    await client.devices.trackOpen(42)

    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 1 })
  })

  it('logs one warning per status and code per run', async () => {
    const { sdk, transport, client } = boot()
    transport.request.mockRejectedValue(http(sdk, 404, 'unknown_device'))

    await client.devices.trackOpen(1)
    await client.devices.trackOpen(2)
    transport.request.mockRejectedValue(http(sdk, 403, 'device_mismatch'))
    await client.devices.trackOpen(3)

    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 3 })
    const lines = (console.warn as jest.Mock).mock.calls.map((c) => String(c[0])).filter((l) => l.includes('offline queue'))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('404')
    expect(lines[0]).toContain('unknown_device')
    expect(lines[1]).toContain('403')
  })

  it('drops without queueing an SDK error such as PINNING_NOT_ACTIVE, and does not count it', async () => {
    const { sdk, transport, client } = boot()
    transport.request.mockRejectedValueOnce(new sdk.EspressoNotifyError('PINNING_NOT_ACTIVE', 'pin first'))

    await client.devices.trackOpen(42)

    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
  })

  it('does not queue what was never sent: no token, an invalid event name, a non-numeric conversion', async () => {
    const { transport, make } = boot({ token: null })
    const noToken = make()
    await noToken.devices.trackOpen(1)
    await noToken.devices.trackEvent('fine.name')
    const { transport: t2, client } = boot()
    await client.devices.trackEvent('not a name!')
    await client.devices.trackConversion('abc')

    expect(transport.request).not.toHaveBeenCalled()
    expect(t2.request).not.toHaveBeenCalled()
    expect(await noToken.queueStats()).toEqual({ pending: 0, dropped: 0 })
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
  })

  it('never queues app_opened', async () => {
    const { transport, client } = boot()
    transport.request.mockRejectedValue(network())

    await client.devices.trackAppOpened()

    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
  })

  it('does not queue a call that throws to the app: register, identify, unregister, updateMetadata', async () => {
    realRandom()
    const { transport, client } = boot()
    transport.request.mockRejectedValue(network())

    await expect(client.devices.register({})).rejects.toThrow()
    await expect(client.devices.identify({ externalId: 'u1' })).rejects.toThrow()
    await expect(client.devices.unregister()).rejects.toThrow()
    await expect(client.devices.updateMetadata({ a: 1 })).rejects.toThrow()

    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
  })
})

describe('what is on disk (OFQ-09, OFQ-12)', () => {
  it('stores the path, the fields and the times, and not the push token, a user id or any key', async () => {
    const { sdk, store, transport, client } = boot({ token: 'ExponentPushToken[secret-device]' })
    transport.request.mockRejectedValue(network())

    await client.devices.trackOpen(42)
    await client.devices.trackEvent('order.completed')
    await client.devices.recordLifecycle('permission', 'undetermined', 'granted')
    await client.devices.recordLifecycle('identity', 'user-alpha', 'user-beta', 'user-7')
    await client.devices.recordLifecycle('subscription', 'ExponentPushToken[old-rotated]', 'ExponentPushToken[new-rotated]')

    const text = store.text()
    expect(text).toContain('/v1/notifications/track')
    expect(text).toContain('order.completed')
    expect(text).toContain('permission')
    expect(text).not.toContain('ExponentPushToken')
    expect(text).not.toContain('secret-device')
    expect(text).not.toMatch(/old-rotated|new-rotated|user-alpha|user-beta|user-7|external_id/)
    expect(text).not.toMatch(/"kind":"(identity|subscription)"/)
    expect(text).not.toMatch(/Bearer|pk_live|sk_|identity_hash|identityHash|secret/i)
    // the two events that carry a token or a user id still wait, in memory
    expect(await client.queueStats()).toEqual({ pending: 5, dropped: 0 })
    void sdk
  })

  it('keeps a subscription or identity event in memory only: it is sent again in this run and gone after a restart (OFQ-09)', async () => {
    const { store, transport, make, client } = boot({ token: 'ExponentPushToken[secret-device]' })
    transport.request.mockRejectedValue(network())
    await client.devices.trackOpen(42)
    await client.devices.recordLifecycle('identity', 'user-alpha', 'user-beta', 'user-7')
    await client.devices.recordLifecycle('subscription', 'ExponentPushToken[old-rotated]', 'ExponentPushToken[new-rotated]')

    // a short outage: they go with the next flush, whole
    transport.request.mockReset()
    transport.request.mockResolvedValue({})
    await client.flush()
    const bodies = sent(transport)
    expect(bodies.find((b) => b.kind === 'identity')).toMatchObject({ from: 'user-alpha', to: 'user-beta', external_id: 'user-7' })
    expect(bodies.find((b) => b.kind === 'subscription')).toMatchObject({ from: 'ExponentPushToken[old-rotated]', to: 'ExponentPushToken[new-rotated]' })
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
    client.destroy()

    // an app that closes with them still waiting loses them, and never wrote them
    transport.request.mockReset()
    transport.request.mockRejectedValue(network())
    const first = make()
    await first.devices.trackOpen(43)
    await first.devices.recordLifecycle('identity', 'user-alpha', 'user-beta', 'user-7')
    first.destroy()
    expect(store.text()).not.toMatch(/user-alpha|user-7|external_id/)
    transport.request.mockReset()
    transport.request.mockResolvedValue({})
    const second = make()
    expect(await second.queueStats()).toEqual({ pending: 1, dropped: 0 })
    await second.flush()
    expect(sent(transport).map((b) => b.event)).toEqual(['opened'])
  })

  it('keeps a permission event that names a user, and an identity event with no user named, in memory only', async () => {
    const { store, transport, client } = boot()
    transport.request.mockRejectedValue(network())
    await client.devices.recordLifecycle('permission', 'undetermined', 'granted', 'user-7')
    await client.devices.recordLifecycle('identity', 'user-alpha', 'user-beta') // from and to are user ids even with no external_id
    expect(store.text()).not.toMatch(/user-7|user-alpha|user-beta|external_id/)
    expect(await client.queueStats()).toEqual({ pending: 2, dropped: 0 })
  })

  it('writes only the known fields of a delivery event or a permission change, whatever the kind', async () => {
    const { store, transport, client } = boot()
    transport.request.mockRejectedValue(network())
    await client.devices.trackOpen(1)
    await client.devices.trackReceived(2)
    await client.devices.trackDismissed(3)
    await client.devices.trackClick(4)
    await client.devices.trackConversion(5)
    await client.devices.trackEvent('order.completed')
    await client.devices.recordLifecycle('permission', 'undetermined', 'granted')
    await client.flush() // received and dismissed wait their random delay (T40); flush() sends them now

    const state = JSON.parse([...store.map.entries()].filter(([k]) => k.startsWith('espresso.eventQueue') && !k.endsWith('.n')).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([, v]) => v).join(''))
    expect(state.items).toHaveLength(7)
    const allowed = new Set(['notification_id', 'event', 'push_token', 'event_id', 'kind', 'from', 'to'])
    for (const item of state.items) {
      for (const key of Object.keys(item.body)) expect(allowed.has(key)).toBe(true)
      if ('push_token' in item.body) expect(item.body.push_token).toBeNull()
    }
  })

  it('removes from the store the subscription and identity events an earlier run wrote', async () => {
    const store = new FakeStore()
    const item = (body: Record<string, unknown>, path = '/v1/devices/lifecycle') => ({ id: `id-${Math.random()}`, path, body, at: T0, attempts: 1, next: T0 + 5 * SECOND })
    const state = {
      v: 1,
      dropped: 0,
      items: [
        item({ push_token: null, kind: 'identity', from: 'user-alpha', to: 'user-beta', external_id: 'user-7', event_id: 'e1' }),
        item({ push_token: null, kind: 'subscription', from: 'ExponentPushToken[old-rotated]', to: 'ExponentPushToken[new-rotated]', event_id: 'e2' }),
        item({ push_token: null, kind: 'permission', from: 'undetermined', to: 'granted', event_id: 'e3' }),
        item({ notification_id: 1, event: 'opened', push_token: null }, '/v1/notifications/track'),
      ],
    }
    store.map.set('espresso.deviceId', OWN_DEVICE)
    store.map.set(`${OWN_QUEUE}.n`, '1')
    store.map.set(`${OWN_QUEUE}.0`, JSON.stringify(state))
    const { client } = boot({ store })

    expect(await client.queueStats()).toEqual({ pending: 2, dropped: 2 })
    expect(store.text()).not.toMatch(/user-alpha|user-7|old-rotated|new-rotated|external_id/)
  })

  it('writes the queue in chunks small enough for SecureStore', async () => {
    const { store, transport, client } = boot()
    transport.request.mockRejectedValue(network())
    for (let i = 0; i < 40; i++) await client.devices.trackEvent(`evt.number.${i}`)

    const values = [...store.map.entries()].filter(([k]) => !k.endsWith('.n')).map(([, v]) => v)
    expect(values.length).toBeGreaterThan(3)
    for (const v of values) expect(v.length).toBeLessThanOrEqual(600)
    expect(await client.queueStats()).toEqual({ pending: 40, dropped: 0 })
  })

  it('leaves no text of a sent event in the chunks that the queue no longer uses', async () => {
    const { store, transport, client } = boot()
    transport.request.mockRejectedValue(network())
    for (let i = 0; i < 40; i++) await client.devices.trackEvent(`evt.number.${i}`)
    expect(store.text()).toContain('evt.number.39')
    transport.request.mockReset()
    transport.request.mockResolvedValue({})

    await client.flush()

    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
    expect(store.text()).not.toContain('evt.number')
  })

  it('keeps the key of the project in the storage key, not in the value', async () => {
    const { store, transport, client } = boot()
    transport.request.mockRejectedValue(network())
    await client.devices.trackOpen(1)
    // the queue keys, and the device id that names the queue of the install (a random id, not a secret of the project)
    expect([...store.map.keys()].every((k) => k.startsWith('espresso.eventQueue.pk_live_queue') || k === 'espresso.deviceId')).toBe(true)
  })
})

describe('restart (OFQ-02)', () => {
  it('a new client over the same storage loads the items and sends them', async () => {
    const { transport, store, make } = boot()
    const first = make()
    transport.request.mockRejectedValue(network())
    await first.devices.trackOpen(42)
    await first.devices.trackEvent('order.completed')
    first.destroy()

    transport.request.mockReset()
    transport.request.mockResolvedValue({})
    const second = make()
    expect(await second.queueStats()).toEqual({ pending: 2, dropped: 0 })
    await second.flush()

    expect(sent(transport).map((b) => b.event)).toEqual(['opened', 'order.completed'])
    expect(await second.queueStats()).toEqual({ pending: 0, dropped: 0 })
    // and a third start finds nothing left
    const third = make()
    expect(await third.queueStats()).toEqual({ pending: 0, dropped: 0 })
    void store
  })

  it('starts empty when the stored value is damaged', async () => {
    const store = new FakeStore()
    store.map.set('espresso.deviceId', OWN_DEVICE)
    store.map.set(`${OWN_QUEUE}.n`, '2')
    store.map.set(`${OWN_QUEUE}.0`, '{"v":1,"items":[{"id"')
    store.map.set(`${OWN_QUEUE}.1`, 'garbage')
    const { client } = boot({ store })
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
  })

  it('ignores a stored item that is not one of the two routes it replays, or is malformed', async () => {
    const store = new FakeStore()
    const item = (over: Record<string, unknown>) => ({ id: 'abc', path: '/v1/notifications/track', body: { event: 'x.y', push_token: null }, at: T0, attempts: 1, next: T0, ...over })
    const state = { v: 1, dropped: 0, items: [item({ path: '/v1/devices/register' }), item({ path: 'https://evil.example/steal' }), item({ body: 'text' }), item({ id: 7 }), item({ at: 'yesterday' }), item({})] }
    store.map.set('espresso.deviceId', OWN_DEVICE)
    store.map.set(`${OWN_QUEUE}.n`, '1')
    store.map.set(`${OWN_QUEUE}.0`, JSON.stringify(state))
    const { client } = boot({ store })
    expect(await client.queueStats()).toEqual({ pending: 1, dropped: 0 })
  })

  it('keeps working in memory when the store throws', async () => {
    const store = new FakeStore()
    store.fail = true
    const { transport, client } = boot({ store })
    transport.request.mockRejectedValueOnce(network())

    await expect(client.devices.trackOpen(42)).resolves.toBeUndefined()
    expect(await client.queueStats()).toEqual({ pending: 1, dropped: 0 })
    transport.request.mockResolvedValue({})
    await client.flush()

    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
    expect(sent(transport)).toHaveLength(2)
  })
})

describe('cap and age (OFQ-03)', () => {
  it('drops the oldest beyond maxItems and counts them', async () => {
    const { transport, client } = boot({ config: { offlineQueue: { maxItems: 3 } } })
    transport.request.mockRejectedValue(network())
    for (const id of [1, 2, 3, 4, 5]) await client.devices.trackOpen(id)

    expect(await client.queueStats()).toEqual({ pending: 3, dropped: 2 })
    transport.request.mockReset()
    transport.request.mockResolvedValue({})
    await client.flush()
    expect(sent(transport).map((b) => b.notification_id)).toEqual([3, 4, 5])
  })

  it('uses 200 by default', async () => {
    const { transport, client } = boot()
    transport.request.mockRejectedValue(network())
    for (let i = 1; i <= 205; i++) await client.devices.trackOpen(i)
    expect(await client.queueStats()).toEqual({ pending: 200, dropped: 5 })
  })

  it.each([[0], [-4], [NaN], ['9' as any]])('falls back to 200 for maxItems %p', async (maxItems) => {
    const { transport, client } = boot({ config: { offlineQueue: { maxItems } } })
    transport.request.mockRejectedValue(network())
    for (let i = 1; i <= 201; i++) await client.devices.trackOpen(i)
    expect(await client.queueStats()).toEqual({ pending: 200, dropped: 1 })
  })

  it('caps maxItems at 1000', async () => {
    const { transport, client } = boot({ config: { offlineQueue: { maxItems: 50_000 } } })
    transport.request.mockRejectedValue(network())
    for (let i = 1; i <= 1002; i++) await client.devices.trackOpen(i)
    expect(await client.queueStats()).toEqual({ pending: 1000, dropped: 2 })
  })

  it('drops an item older than 3 days and counts it', async () => {
    const { transport, client } = boot()
    transport.request.mockRejectedValue(network())
    await client.devices.trackOpen(1)
    jest.setSystemTime(T0 + 2 * DAY)
    await client.devices.trackOpen(2)
    jest.setSystemTime(T0 + 3 * DAY + 1)

    transport.request.mockReset()
    transport.request.mockResolvedValue({})
    await client.flush()

    expect(sent(transport).map((b) => b.notification_id)).toEqual([2])
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 1 })
  })
})

describe('backoff (OFQ-04, OFQ-07)', () => {
  /** The times, in seconds after the first failure, at which the transport was called. */
  async function schedule(totalSeconds: number) {
    const { transport, client } = boot()
    transport.request.mockRejectedValue(network())
    await client.devices.trackOpen(42)
    const times: number[] = [0]
    transport.request.mockClear()
    transport.request.mockImplementation(async () => { times.push((Date.now() - T0) / SECOND); throw network() })
    for (let s = 0; s < totalSeconds; s++) await jest.advanceTimersByTimeAsync(SECOND)
    client.destroy()
    return times
  }

  it('waits 5 s, 10 s, 20 s, 40 s ... with full jitter (random = 1)', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(1)
    const times = await schedule(130)
    // first attempt at 0 (the failure), then +5 (2nd failure), +10, +20, +40, +80 ...
    expect(times).toEqual([0, 5, 15, 35, 75])
  })

  it('waits half of it at the lowest jitter (random = 0)', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0)
    const times = await schedule(40)
    // 2.5, then 5, then 10, then 20: 0, 2.5, 7.5, 17.5, 37.5
    expect(times).toEqual([0, 2.5, 7.5, 17.5, 37.5])
  })

  it('never waits more than 15 minutes', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(1)
    const { transport, client } = boot()
    transport.request.mockRejectedValue(network())
    await client.devices.trackOpen(42)
    const times: number[] = []
    transport.request.mockClear()
    transport.request.mockImplementation(async () => { times.push(Date.now()); throw network() })
    await jest.advanceTimersByTimeAsync(3 * 60 * 60 * SECOND)
    client.destroy()

    const gaps = times.slice(1).map((t, i) => t - times[i])
    expect(Math.max(...gaps)).toBe(15 * 60 * SECOND)
    expect(gaps.slice(-3)).toEqual([15 * 60 * SECOND, 15 * 60 * SECOND, 15 * 60 * SECOND])
  })

  it('sends nothing before the item is due when another SDK call comes (OFQ-07)', async () => {
    const { transport, client } = boot()
    transport.request.mockRejectedValueOnce(network())
    await client.devices.trackOpen(1)
    transport.request.mockClear()
    transport.request.mockResolvedValue({})

    await jest.advanceTimersByTimeAsync(2 * SECOND)
    await client.devices.trackOpen(2)

    expect(sent(transport).map((b) => b.notification_id)).toEqual([2])
    expect(await client.queueStats()).toEqual({ pending: 1, dropped: 0 })
  })

  it('sends the due items on the next SDK call that succeeds (OFQ-07)', async () => {
    const { transport, client } = boot()
    transport.request.mockRejectedValueOnce(network())
    await client.devices.trackOpen(1)
    transport.request.mockClear()
    transport.request.mockResolvedValue({})
    // block the timer so the next call is what finds the item due (clearAllTimers also resets the clock)
    jest.clearAllTimers()
    jest.setSystemTime(T0 + 6 * SECOND)

    await client.devices.trackOpen(2)

    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
    expect(sent(transport).map((b) => b.notification_id).sort()).toEqual([1, 2])
  })

  it('retries when the app returns to the foreground, before the backoff ends (OFQ-07)', async () => {
    const { transport, client, foreground } = boot()
    transport.request.mockRejectedValueOnce(network())
    await client.devices.trackOpen(1)
    transport.request.mockClear()
    transport.request.mockResolvedValue({})

    foreground()
    await jest.advanceTimersByTimeAsync(0)

    expect(sent(transport).map((b) => b.notification_id)).toEqual([1])
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
  })

  it('watches the foreground even with autoTrack off, and sends no app_opened for it', async () => {
    const { transport, client, foreground } = boot()
    transport.request.mockRejectedValueOnce(network())
    await client.devices.trackOpen(1)
    transport.request.mockClear()
    transport.request.mockResolvedValue({})
    foreground()
    await jest.advanceTimersByTimeAsync(0)
    expect(sent(transport).every((b) => b.event !== 'app_opened')).toBe(true)
  })

  it('stops the timer and the foreground retry on destroy() (OFQ-13)', async () => {
    const { transport, client, foreground } = boot()
    transport.request.mockRejectedValueOnce(network())
    await client.devices.trackOpen(1)
    transport.request.mockClear()
    transport.request.mockResolvedValue({})

    expect(jest.getTimerCount()).toBe(1) // the retry timer of the waiting item
    client.destroy()
    expect(jest.getTimerCount()).toBe(0)
    await jest.advanceTimersByTimeAsync(60 * SECOND)
    foreground()
    await jest.advanceTimersByTimeAsync(0)

    expect(transport.request).not.toHaveBeenCalled()
  })

  it('keeps the items and waits while the client has no token', async () => {
    const { transport, make } = boot({ token: null })
    const client = make()
    transport.request.mockRejectedValue(network())
    // an explicit token for the call reaches the queue; the client itself has none at flush time
    await client.devices.trackOpen(1, 'ExponentPushToken[explicit]')
    transport.request.mockReset()
    transport.request.mockResolvedValue({})

    await client.flush()

    expect(transport.request).not.toHaveBeenCalled()
    expect(await client.queueStats()).toEqual({ pending: 1, dropped: 0 })
    client.pushToken = 'ExponentPushToken[now]'
    await client.flush()
    expect(sent(transport)[0].push_token).toBe('ExponentPushToken[now]')
  })
})

describe('Retry-After (OFQ-05)', () => {
  it('sends nothing, queued or new, before N seconds, then sends the queue', async () => {
    const { sdk, transport, client } = boot()
    ;(Math.random as jest.Mock).mockReturnValue(0) // no jitter on the Retry-After here: its 0 to 25% is covered by queue-retry-after-jitter.test.ts
    transport.request.mockRejectedValueOnce(http(sdk, 429, 'rate_limited', 30))
    await client.devices.trackOpen(1)
    transport.request.mockClear()
    transport.request.mockResolvedValue({})

    await jest.advanceTimersByTimeAsync(29 * SECOND)
    await client.devices.trackOpen(2) // a new event during the pause is kept, not sent
    expect(transport.request).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(2 * SECOND)

    expect(sent(transport).map((b) => b.notification_id)).toEqual([1, 2])
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
  })

  it('cuts a larger Retry-After to one hour', async () => {
    const { sdk, transport, client } = boot()
    transport.request.mockRejectedValueOnce(http(sdk, 429, 'rate_limited', 86_400))
    await client.devices.trackOpen(1)
    transport.request.mockClear()
    transport.request.mockResolvedValue({})

    await jest.advanceTimersByTimeAsync(3599 * SECOND)
    expect(transport.request).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(2 * SECOND)
    expect(transport.request).toHaveBeenCalledTimes(1)
  })

  it('the foreground does not break the pause, and flush() does', async () => {
    const { sdk, transport, client, foreground } = boot()
    transport.request.mockRejectedValueOnce(http(sdk, 429, 'rate_limited', 60))
    await client.devices.trackOpen(1)
    transport.request.mockClear()
    transport.request.mockResolvedValue({})

    foreground()
    await jest.advanceTimersByTimeAsync(0)
    expect(transport.request).not.toHaveBeenCalled()
    await client.flush()
    expect(transport.request).toHaveBeenCalledTimes(1)
  })

  it('a 429 without Retry-After backs off like any other failure', async () => {
    const { sdk, transport, client } = boot()
    transport.request.mockRejectedValueOnce(http(sdk, 429, 'rate_limited'))
    await client.devices.trackOpen(1)
    transport.request.mockClear()
    transport.request.mockResolvedValue({})

    await jest.advanceTimersByTimeAsync(4 * SECOND)
    expect(transport.request).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(2 * SECOND)
    expect(transport.request).toHaveBeenCalledTimes(1)
  })
})

describe('the default transport reads Retry-After (OFQ-05)', () => {
  function withFetch(response: any) {
    jest.resetModules()
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: null }), { virtual: true })
    const fetchMock = jest.fn().mockResolvedValue(response)
    ;(globalThis as any).fetch = fetchMock
    const sdk = require('../src/index')
    const client = new sdk.PushClient({ projectId: 'pk_live_queue', pushToken: 'tok', platform: 'ios', autoTrack: false, _queueStore: new FakeStore() })
    return { sdk, fetchMock, client }
  }
  const tooMany = (header: string | null) => ({
    ok: false, status: 429, statusText: 'Too Many Requests',
    headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? header : null) },
    text: async () => '{"code":"rate_limited"}',
  })

  it('pauses for the seconds of the header', async () => {
    ;(Math.random as jest.Mock).mockReturnValue(0) // no jitter on the Retry-After here: its 0 to 25% is covered by queue-retry-after-jitter.test.ts
    const { fetchMock, client } = withFetch(tooMany('45'))
    await client.devices.trackOpen(1)
    fetchMock.mockClear()
    fetchMock.mockResolvedValue({ ok: true, text: async () => '' })

    await jest.advanceTimersByTimeAsync(44 * SECOND)
    expect(fetchMock).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(2 * SECOND)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('understands an HTTP date', async () => {
    const date = new Date(T0 + 20 * SECOND).toUTCString()
    ;(Math.random as jest.Mock).mockReturnValue(0) // no jitter on the Retry-After here: its 0 to 25% is covered by queue-retry-after-jitter.test.ts
    const { fetchMock, client } = withFetch(tooMany(date))
    await client.devices.trackOpen(1)
    fetchMock.mockClear()
    fetchMock.mockResolvedValue({ ok: true, text: async () => '' })

    await jest.advanceTimersByTimeAsync(18 * SECOND)
    expect(fetchMock).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(4 * SECOND)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('puts retryAfter on the error, and nothing when the header is absent or not usable', async () => {
    for (const [header, expected] of [['12', 12], [null, undefined], ['soon', undefined], ['-5', undefined]] as const) {
      const { sdk } = withFetch(tooMany(header))
      const transport = (new sdk.PushClient({ projectId: 'pk_live_queue', pushToken: 'tok', platform: 'ios', autoTrack: false, _queueStore: new FakeStore(), offlineQueue: { enabled: false } }))
      let err: any
      try { await transport.devices.identify({ externalId: 'u1' }) } catch (e) { err = e }
      expect(err.retryAfter).toBe(expected)
    }
  })

  it('works with a response that has no headers object', async () => {
    const { client, fetchMock } = withFetch({ ok: false, status: 500, statusText: 'x', text: async () => '' })
    await expect(client.devices.trackOpen(1)).resolves.toBeUndefined()
    expect(await client.queueStats()).toEqual({ pending: 1, dropped: 0 })
    void fetchMock
  })
})

describe('no duplicates (OFQ-08)', () => {
  it('sends an item once when two flushes overlap', async () => {
    const { transport, client } = boot()
    transport.request.mockRejectedValueOnce(network())
    await client.devices.trackOpen(1)
    transport.request.mockRejectedValueOnce(network())
    await client.devices.trackOpen(2)
    transport.request.mockReset()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    transport.request.mockImplementation(async () => { await gate; return {} })

    const a = client.flush()
    const b = client.flush()
    release()
    await Promise.all([a, b])

    expect(transport.request).toHaveBeenCalledTimes(2)
    expect(sent(transport).map((x) => x.notification_id).sort()).toEqual([1, 2])
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
  })

  it('keeps the event_id of a custom event and of a lifecycle event on every attempt, and none on the delivery events', async () => {
    const { sdk, transport, client } = boot()
    transport.request.mockRejectedValue(http(sdk, 503))
    await client.devices.trackEvent('order.completed')
    await client.devices.recordLifecycle('permission', 'undetermined', 'granted')
    await client.devices.trackOpen(7)
    const first = sent(transport)
    await client.flush()
    await client.flush()
    const all = sent(transport)

    expect(first[0].event_id).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(first[1].event_id).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(first[0].event_id).not.toBe(first[1].event_id)
    expect(first[2]).not.toHaveProperty('event_id')
    // three attempts of each event, the same id every time
    expect(all.filter((b) => b.event === 'order.completed').map((b) => b.event_id)).toEqual(Array(3).fill(first[0].event_id))
    expect(all.filter((b) => b.kind === 'permission').map((b) => b.event_id)).toEqual(Array(3).fill(first[1].event_id))
    expect(all.filter((b) => b.event === 'opened').every((b) => !('event_id' in b))).toBe(true)
  })

  it('gives each new event a new id', async () => {
    const { transport, client } = boot()
    await client.devices.trackEvent('a.b')
    await client.devices.trackEvent('a.b')
    const ids = sent(transport).map((b) => b.event_id)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('sends the event as before when nothing fails: same path, same fields, one call', async () => {
    const { transport, client } = boot()
    await client.devices.trackOpen(42)
    await client.devices.trackConversion(9)

    expect(transport.request).toHaveBeenCalledTimes(2)
    expect(transport.request.mock.calls[0][0]).toBe('/v1/notifications/track')
    expect(transport.request.mock.calls[0][1].method).toBe('POST')
    expect(sent(transport)).toEqual([
      { notification_id: 42, event: 'opened', push_token: 'ExponentPushToken[secret-device]' },
      { notification_id: 9, event: 'converted', push_token: 'ExponentPushToken[secret-device]' },
    ])
  })

  it('replays with the token the client has now', async () => {
    const { transport, client } = boot({ token: 'ExponentPushToken[old]' })
    transport.request.mockRejectedValueOnce(network())
    await client.devices.trackOpen(1)
    client.pushToken = 'ExponentPushToken[rotated]'
    transport.request.mockClear()
    transport.request.mockResolvedValue({})

    await client.flush()

    expect(sent(transport)[0].push_token).toBe('ExponentPushToken[rotated]')
  })
})

describe('turned off (OFQ-10)', () => {
  it('makes one attempt, drops the error, writes nothing and counts nothing', async () => {
    const { store, transport, client } = boot({ config: { offlineQueue: { enabled: false } } })
    transport.request.mockRejectedValue(network())

    await expect(client.devices.trackOpen(42)).resolves.toBeUndefined()
    await client.flush()

    expect(transport.request).toHaveBeenCalledTimes(1)
    expect(store.setItemCalls).toBe(0)
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
    await jest.advanceTimersByTimeAsync(60 * SECOND)
    expect(transport.request).toHaveBeenCalledTimes(1)
  })

  it('sends a custom event without an event_id', async () => {
    const { transport, client } = boot({ config: { offlineQueue: { enabled: false } } })
    await client.devices.trackEvent('order.completed')
    expect(sent(transport)[0]).toEqual({ event: 'order.completed', push_token: 'ExponentPushToken[secret-device]' })
  })

  it('adds no listener of the foreground', () => {
    const appState = { currentState: 'background', addEventListener: jest.fn(() => ({ remove: jest.fn() })) }
    boot({ appState, config: { offlineQueue: { enabled: false } } })
    expect(appState.addEventListener).not.toHaveBeenCalled()
  })

  it('adds one listener of the foreground when it is on, even with autoTrack off', () => {
    const appState = { currentState: 'background', addEventListener: jest.fn(() => ({ remove: jest.fn() })) }
    boot({ appState })
    expect(appState.addEventListener).toHaveBeenCalledTimes(1)
  })
})

describe('a client without a push token (G-2)', () => {
  /** Leaves two overdue items in the store and returns a client of the next run that has no token. */
  async function noTokenClient() {
    const { sdk, store, transport, make, client } = boot()
    transport.request.mockRejectedValue(network())
    await client.devices.trackOpen(1)
    await client.devices.trackOpen(2)
    client.destroy()
    jest.setSystemTime(T0 + 60 * SECOND) // both are long overdue
    transport.request.mockReset()
    transport.request.mockResolvedValue({})
    return { sdk, store, transport, next: make({ pushToken: undefined }) }
  }

  it('does not spin the timer while there is no token', async () => {
    const { transport, next } = await noTokenClient()
    expect(await next.queueStats()).toEqual({ pending: 2, dropped: 0 })
    const spy = jest.spyOn(globalThis, 'setTimeout')

    await jest.advanceTimersByTimeAsync(60 * SECOND)

    expect(spy.mock.calls.length).toBeLessThanOrEqual(3)
    expect(jest.getTimerCount()).toBe(0)
    expect(transport.request).not.toHaveBeenCalled()
    expect(await next.queueStats()).toEqual({ pending: 2, dropped: 0 })
  })

  it('does not spin on a flush() or a foreground either', async () => {
    const { next } = await noTokenClient()
    await next.flush()
    const spy = jest.spyOn(globalThis, 'setTimeout')
    await next.flush()
    await jest.advanceTimersByTimeAsync(60 * SECOND)
    expect(spy.mock.calls.length).toBeLessThanOrEqual(3)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('sends what waits as soon as the client gets its token', async () => {
    const { transport, next } = await noTokenClient()
    await next.queueStats()
    await jest.advanceTimersByTimeAsync(10 * SECOND)
    expect(transport.request).not.toHaveBeenCalled()

    next.pushToken = 'ExponentPushToken[late]'
    await jest.advanceTimersByTimeAsync(0)

    expect(sent(transport).map((b) => b.notification_id)).toEqual([1, 2])
    expect(sent(transport).every((b) => b.push_token === 'ExponentPushToken[late]')).toBe(true)
    expect(await next.queueStats()).toEqual({ pending: 0, dropped: 0 })
  })

  it('keeps an item that is not due yet waiting for its time when the token comes', async () => {
    const { sdk, store, transport, make, client } = boot()
    void sdk
    transport.request.mockRejectedValue(network())
    await client.devices.trackOpen(1)
    client.destroy()
    transport.request.mockReset()
    transport.request.mockResolvedValue({})
    const next = make({ pushToken: undefined })
    await next.queueStats()
    next.pushToken = 'ExponentPushToken[late]'
    await jest.advanceTimersByTimeAsync(1 * SECOND)
    expect(transport.request).not.toHaveBeenCalled() // the 5 s wait of the item is not over
    await jest.advanceTimersByTimeAsync(5 * SECOND)
    expect(sent(transport).map((b) => b.notification_id)).toEqual([1])
    void store
  })

  it('does not treat an empty token as one', async () => {
    const { transport, next } = await noTokenClient()
    await next.queueStats()
    next.pushToken = undefined
    await jest.advanceTimersByTimeAsync(10 * SECOND)
    expect(transport.request).not.toHaveBeenCalled()
  })
})

describe('the pass over the queue (G-4, G-5, G-6)', () => {
  async function seeded(count: number) {
    const ctx = boot()
    ctx.transport.request.mockRejectedValue(network())
    for (let i = 1; i <= count; i++) await ctx.client.devices.trackOpen(i)
    ctx.transport.request.mockReset()
    return ctx
  }

  it('stops at the first network error: one request for three waiting items', async () => {
    const { transport, client } = await seeded(3)
    transport.request.mockRejectedValue(network())
    await client.flush()
    expect(transport.request).toHaveBeenCalledTimes(1)
    expect(await client.queueStats()).toEqual({ pending: 3, dropped: 0 })
  })

  it('stops after three server errors in a row', async () => {
    const { sdk, transport, client } = await seeded(5)
    transport.request.mockRejectedValue(http(sdk, 503))
    await client.flush()
    expect(transport.request).toHaveBeenCalledTimes(3)
    expect(await client.queueStats()).toEqual({ pending: 5, dropped: 0 })
  })

  it('counts the server errors in a row: a success in between starts the count again', async () => {
    const { sdk, transport, client } = await seeded(6)
    const fail = () => Promise.reject(http(sdk, 503))
    transport.request
      .mockImplementationOnce(fail) // 1 failure
      .mockResolvedValueOnce({}) // success: back to 0
      .mockImplementationOnce(fail) // 1
      .mockImplementationOnce(fail) // 2
      .mockImplementationOnce(fail) // 3: stop
      .mockResolvedValue({})
    await client.flush()
    expect(transport.request).toHaveBeenCalledTimes(5)
    expect(await client.queueStats()).toEqual({ pending: 5, dropped: 0 })
  })

  it('keeps going past an item the server refuses for good', async () => {
    const { sdk, transport, client } = await seeded(3)
    transport.request.mockRejectedValueOnce(http(sdk, 404, 'unknown_device')).mockResolvedValue({})
    await client.flush()
    expect(transport.request).toHaveBeenCalledTimes(3)
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 1 })
  })

  it('honors a Retry-After met while the queue is replayed: the rest and new events wait', async () => {
    const { sdk, transport, client } = await seeded(3)
    ;(Math.random as jest.Mock).mockReturnValue(0) // no jitter on the Retry-After here: its 0 to 25% is covered by queue-retry-after-jitter.test.ts
    transport.request.mockRejectedValueOnce(http(sdk, 429, 'rate_limited', 30)).mockResolvedValue({})

    await client.flush()
    expect(transport.request).toHaveBeenCalledTimes(1) // the pass stopped at the head
    await client.devices.trackOpen(9) // a new event during the pause is kept, not sent
    expect(transport.request).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(29 * SECOND)
    expect(transport.request).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(2 * SECOND)

    expect(sent(transport).map((b) => b.notification_id)).toEqual([1, 1, 2, 3, 9])
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
  })

  it('loads the queue when the client is created and sends it on its own timer', async () => {
    const { make, transport, client } = await seeded(1)
    client.destroy()
    transport.request.mockResolvedValue({})

    make()
    await jest.advanceTimersByTimeAsync(6 * SECOND) // no other call of the SDK

    expect(sent(transport).map((b) => b.notification_id)).toEqual([1])
  })
})

describe('a smaller maxItems than the run before (G-9)', () => {
  it('counts the items that the load cuts, and writes what is left', async () => {
    const { make, transport, client } = boot({ config: { offlineQueue: { maxItems: 5 } } })
    transport.request.mockRejectedValue(network())
    for (let i = 1; i <= 5; i++) await client.devices.trackOpen(i)
    client.destroy()

    const smaller = make({ offlineQueue: { maxItems: 2 } })
    expect(await smaller.queueStats()).toEqual({ pending: 2, dropped: 3 })
    smaller.destroy()
    const again = make({ offlineQueue: { maxItems: 10 } })
    expect(await again.queueStats()).toEqual({ pending: 2, dropped: 3 })
    transport.request.mockReset()
    transport.request.mockResolvedValue({})
    await again.flush()
    expect(sent(transport).map((b) => b.notification_id)).toEqual([4, 5])
  })
})

describe('a store that an earlier run left (G-15, G-16)', () => {
  /** An earlier client keeps 40 events over several chunks; the next client starts over the same store. */
  async function earlierRun() {
    const first = boot()
    first.transport.request.mockRejectedValue(network())
    for (let i = 0; i < 40; i++) await first.client.devices.trackEvent(`evt.number.${i}`)
    first.client.destroy()
    expect(first.store.text()).toContain('evt.number.39')
    expect([...first.store.map.keys()].filter((k) => !k.endsWith('.n')).length).toBeGreaterThan(3)
    return first.store
  }

  it('leaves no text of the events it sends in the chunks of the earlier run', async () => {
    const store = await earlierRun()
    const { client, transport } = boot({ store })
    transport.request.mockResolvedValue({})

    await client.flush()

    expect(sent(transport)).toHaveLength(40)
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
    expect(store.text()).not.toContain('evt.number')
  })

  it('leaves no text of the events it drops in the chunks of the earlier run', async () => {
    const store = await earlierRun()
    const { sdk, client, transport } = boot({ store })
    transport.request.mockRejectedValue(http(sdk, 400, 'invalid_request'))

    await client.flush()

    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 40 })
    expect(store.text()).not.toContain('evt.number')
  })

  it('does not write back a push token that it finds on disk, and still sends the event', async () => {
    const store = new FakeStore()
    const state = {
      v: 1,
      dropped: 0,
      items: [
        { id: 'id-1', path: '/v1/notifications/track', body: { notification_id: 1, event: 'opened', push_token: 'ExponentPushToken[leaked-on-disk]' }, at: T0, attempts: 1, next: T0 + 5 * SECOND },
        { id: 'id-2', path: '/v1/devices/lifecycle', body: { kind: 'permission', from: 'undetermined', to: 'granted', push_token: 'ExponentPushToken[leaked-too]', event_id: 'e2' }, at: T0, attempts: 1, next: T0 + 5 * SECOND },
      ],
    }
    store.map.set('espresso.deviceId', OWN_DEVICE)
    store.map.set(`${OWN_QUEUE}.n`, '1')
    store.map.set(`${OWN_QUEUE}.0`, JSON.stringify(state))
    const { client, transport } = boot({ store })

    expect(await client.queueStats()).toEqual({ pending: 2, dropped: 0 })
    expect(store.text()).not.toMatch(/leaked/)
    transport.request.mockResolvedValue({})
    await client.flush()

    expect(sent(transport).map((b) => b.push_token)).toEqual(['ExponentPushToken[secret-device]', 'ExponentPushToken[secret-device]'])
    expect(store.text()).not.toMatch(/leaked/)
  })
})

// A module, so that its top-level names do not clash with the other test files that are scripts.
export {}
