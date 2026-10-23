/**
 * @jest-environment node
 *
 * The persisted offline queue is keyed by the project and the stable device id of the install (the `espresso.deviceId`
 * that request signing already stores). There is no other key: the SDK was never released with a queue under the project
 * alone, and when the device id cannot be read the queue of that session stays in memory.
 */

// A module, so that its top-level names do not clash with the other test files that are scripts.
export {}

const T0 = 1_700_000_000_000
const SECOND = 1000
const LEGACY = 'espresso.eventQueue.pk_live_queue'

class FakeStore {
  readonly map = new Map<string, string>()
  fail = false
  /** Writes of the keys it matches fail: a write that does not land (a kill, a full disk). */
  failWrite: ((key: string) => boolean) | null = null
  async getItem(key: string) {
    if (this.fail) throw new Error('store down')
    return this.map.get(key) ?? null
  }
  async setItem(key: string, value: string) {
    if (this.fail || this.failWrite?.(key)) throw new Error('store down')
    this.map.set(key, value)
  }
  text() { return [...this.map.values()].join('\n') }
}

function boot(store: FakeStore = new FakeStore(), token = 'ExponentPushToken[secret-device]') {
  jest.resetModules()
  jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: 17 }, AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }), { virtual: true })
  const sdk = require('../src/index')
  const transport = { request: jest.fn().mockResolvedValue({}) }
  const make = () => new sdk.PushClient({ projectId: 'pk_live_queue', pushToken: token, platform: 'ios', transport, autoTrack: false, _queueStore: store })
  return { sdk, store, transport, make, client: make() }
}

const sent = (transport: { request: jest.Mock }) => transport.request.mock.calls.map(([, init]) => JSON.parse(init.body))
const network = () => new TypeError('Network request failed')
const item = (over: Record<string, unknown> = {}) => ({
  id: 'abc', path: '/v1/notifications/track', body: { notification_id: 1, event: 'opened', push_token: null }, at: T0, attempts: 1, next: T0, ...over,
})
const DEVICE = 'feedfacefeedfacefeedfacefeedface'
/** A queue stored under the per-install key, the way an earlier run of this SDK left it. */
function seedOwn(store: FakeStore, items: unknown[], dropped = 0) {
  store.map.set('espresso.deviceId', DEVICE)
  store.map.set(`${LEGACY}.${DEVICE}.n`, '1')
  store.map.set(`${LEGACY}.${DEVICE}.0`, JSON.stringify({ v: 1, dropped, items }))
}

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  jest.spyOn(Math, 'random').mockReturnValue(1)
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('the key of the stored queue', () => {
  it('holds the project and the device id, and the device id is stored once', async () => {
    const { store, transport, client } = boot()
    transport.request.mockRejectedValue(network())

    await client.devices.trackOpen(42)

    const deviceId = store.map.get('espresso.deviceId')
    expect(deviceId).toMatch(/^[0-9a-f]{32}$/)
    expect(store.map.get(`${LEGACY}.${deviceId}.n`)).toBe('1')
    expect(store.map.get(`${LEGACY}.${deviceId}.0`)).toContain('"opened"')
    // nothing is written under the old key
    expect(store.map.has(`${LEGACY}.n`)).toBe(false)
    // and the id stays when another client starts
    const again = boot(store)
    await again.client.queueStats()
    expect(store.map.get('espresso.deviceId')).toBe(deviceId)
  })

  it('uses the device id that is already stored and never replaces it', async () => {
    const store = new FakeStore()
    store.map.set('espresso.deviceId', 'feedfacefeedfacefeedfacefeedface')
    const { transport, client } = boot(store)
    transport.request.mockRejectedValue(network())

    await client.devices.trackOpen(42)

    expect(store.map.get('espresso.deviceId')).toBe('feedfacefeedfacefeedfacefeedface')
    expect(store.map.get(`${LEGACY}.feedfacefeedfacefeedfacefeedface.n`)).toBe('1')
  })

  it('does not read the queue of another device id', async () => {
    const store = new FakeStore()
    store.map.set('espresso.deviceId', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    store.map.set(`${LEGACY}.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.n`, '1')
    store.map.set(`${LEGACY}.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.0`, JSON.stringify({ v: 1, dropped: 0, items: [item()] }))
    const { transport, client } = boot(store)

    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
    await client.flush()
    expect(transport.request).not.toHaveBeenCalled()
  })

  it('writes no push token, no user id and no key into the store', async () => {
    const { store, transport, client } = boot()
    transport.request.mockRejectedValue(network())
    await client.devices.trackOpen(42)
    await client.devices.recordLifecycle('subscription', 'ExponentPushToken[old-rotated]', 'ExponentPushToken[new-rotated]')
    await client.devices.recordLifecycle('identity', 'user-alpha', 'user-beta', 'user-7')

    expect(store.text()).not.toMatch(/ExponentPushToken|secret-device|old-rotated|new-rotated|user-alpha|user-beta|user-7|external_id/)
  })

  it('keeps the queue in memory when the device id cannot be read, and keeps working', async () => {
    const store = new FakeStore()
    store.fail = true
    const { transport, client } = boot(store)
    transport.request.mockRejectedValueOnce(network())

    await client.devices.trackOpen(42)
    transport.request.mockResolvedValue({})
    await client.flush()

    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
  })
})

describe('a queue stored under the per-install key', () => {
  it('still blanks a push token or drops a user-bearing event found in it, and writes no token', async () => {
    const store = new FakeStore()
    seedOwn(store, [
      item({ id: 'a', body: { notification_id: 1, event: 'opened', push_token: 'ExponentPushToken[leaked-on-disk]' } }),
      item({ id: 'b', path: '/v1/devices/lifecycle', body: { kind: 'identity', from: 'user-alpha', to: 'user-beta', push_token: null } }),
    ])
    const { transport, client } = boot(store)

    expect(await client.queueStats()).toEqual({ pending: 1, dropped: 1 })
    expect(store.text()).not.toMatch(/leaked|user-alpha|user-beta/)
    transport.request.mockResolvedValue({})
    await client.flush()
    expect(sent(transport).map((b) => b.push_token)).toEqual(['ExponentPushToken[secret-device]'])
  })

  it('applies the cap of the run to what it reads', async () => {
    const store = new FakeStore()
    seedOwn(store, [item({ id: '1' }), item({ id: '2' }), item({ id: '3' })])
    jest.resetModules()
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: 17 }, AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }), { virtual: true })
    const sdk = require('../src/index')
    const client = new sdk.PushClient({
      projectId: 'pk_live_queue', pushToken: 'ExponentPushToken[t]', platform: 'ios', autoTrack: false,
      transport: { request: jest.fn().mockResolvedValue({}) }, _queueStore: store, offlineQueue: { maxItems: 2 },
    })
    expect(await client.queueStats()).toEqual({ pending: 2, dropped: 1 })
    void SECOND
  })

  it('never reads or writes a queue under the project alone (no SDK was released that wrote one)', async () => {
    const store = new FakeStore()
    store.map.set(`${LEGACY}.n`, '1')
    store.map.set(`${LEGACY}.0`, JSON.stringify({ v: 1, dropped: 2, items: [item({ id: 'old' })] }))
    const before = new Map(store.map)
    const { transport, client } = boot(store)
    transport.request.mockRejectedValue(network())
    await client.devices.trackOpen(42)

    expect(await client.queueStats()).toEqual({ pending: 1, dropped: 0 })
    for (const [k, v] of before) expect(store.map.get(k)).toBe(v)
  })
})

describe('the device id cannot be read (a locked store at a background launch)', () => {
  /** The read of `espresso.deviceId` throws until `unlock()`; every other key reads normally. */
  function locked(store: FakeStore) {
    let isLocked = true
    const get = store.getItem.bind(store)
    store.getItem = async (k: string) => { if (k === 'espresso.deviceId' && isLocked) throw new Error('locked'); return get(k) }
    return { unlock: () => { isLocked = false } }
  }
  /** Every key ever written, in order. */
  function recordWrites(store: FakeStore) {
    const keys: string[] = []
    const set = store.setItem.bind(store)
    store.setItem = async (k: string, v: string) => { keys.push(k); return set(k, v) }
    return keys
  }
  const own = (store: FakeStore) => `${LEGACY}.${store.map.get('espresso.deviceId')}`
  const sends = (transport: { request: jest.Mock }, id: number) => sent(transport).filter((b) => b.notification_id === id).length

  it('P5 keeps the event in memory, writes it under the per-install key once the id is readable, and sends it once', async () => {
    const store = new FakeStore()
    // an earlier run: the key of the install exists and is empty
    const s1 = boot(store)
    await s1.client.queueStats()
    s1.client.destroy()
    const deviceId = store.map.get('espresso.deviceId')

    const lock = locked(store)
    const s2 = boot(store)
    s2.transport.request.mockRejectedValue(network())
    await s2.client.devices.trackOpen(42)
    expect(await s2.client.queueStats()).toEqual({ pending: 1, dropped: 0 })
    expect(store.map.get(`${LEGACY}.n`)).toBeUndefined() // nothing under the project alone

    lock.unlock()
    await s2.client.devices.trackOpen(43) // the next SDK call opens the stored queue and writes both
    expect(store.map.get(`${LEGACY}.${deviceId}.0`)).toContain('"notification_id":42')
    s2.client.destroy()

    const s3 = boot(store)
    expect(await s3.client.queueStats()).toEqual({ pending: 2, dropped: 0 })
    await s3.client.flush()
    expect(sends(s3.transport, 42)).toBe(1)
    expect(sends(s3.transport, 43)).toBe(1)
    s3.client.destroy()
    const s4 = boot(store)
    await s4.client.flush()
    expect(s4.transport.request).not.toHaveBeenCalled()
  })

  it('opens the stored queue again on the next foreground and merges it with the memory, by event id', async () => {
    const store = new FakeStore()
    seedOwn(store, [item({ id: 'disk', body: { notification_id: 7, event: 'opened', push_token: null } })])
    const lock = locked(store)
    const s = boot(store)
    s.transport.request.mockRejectedValue(network())
    await s.client.devices.trackOpen(42)
    expect(await s.client.queueStats()).toEqual({ pending: 1, dropped: 0 }) // the disk is not readable yet

    lock.unlock()
    s.transport.request.mockReset()
    s.transport.request.mockResolvedValue({})
    await s.client.flush() // a foreground flush: reads the disk, merges, sends all
    expect(sends(s.transport, 7)).toBe(1)
    expect(sends(s.transport, 42)).toBe(1)
    expect(await s.client.queueStats()).toEqual({ pending: 0, dropped: 0 })
    s.client.destroy()
    const again = boot(store)
    await again.client.flush()
    expect(again.transport.request).not.toHaveBeenCalled()
  })

  it('does not count or send an item twice when the memory and the disk hold the same event id', async () => {
    const store = new FakeStore()
    seedOwn(store, [item({ id: 'same', body: { notification_id: 7, event: 'opened', push_token: null } })])
    const lock = locked(store)
    const s = boot(store)
    s.transport.request.mockRejectedValue(network())
    await s.client.devices.trackOpen(42)
    ;(s.client as any)._queue._items.push(item({ id: 'same', body: { notification_id: 7, event: 'opened', push_token: null } }))
    lock.unlock()
    s.transport.request.mockResolvedValue({})
    await s.client.flush()
    expect(sends(s.transport, 7)).toBe(1)
  })

  it('writes nothing to a key without the device id, in any session', async () => {
    const store = new FakeStore()
    const writes = recordWrites(store)
    const lock = locked(store)
    const s = boot(store)
    s.transport.request.mockRejectedValue(network())
    await s.client.devices.trackOpen(42)
    await s.client.devices.trackEvent('order.completed')
    await s.client.queueStats()
    s.client.destroy()
    expect(writes.filter((k) => k.startsWith('espresso.eventQueue.'))).toEqual([]) // locked all the session: memory only

    lock.unlock()
    const s2 = boot(store)
    s2.transport.request.mockRejectedValue(network())
    await s2.client.devices.trackOpen(1)
    const id = store.map.get('espresso.deviceId')!
    for (const k of writes) expect(k === 'espresso.deviceId' || k.startsWith(`${LEGACY}.${id}.`)).toBe(true)
  })

  it('loses the memory queue when the app is killed before the id is readable, and the next start has nothing', async () => {
    const store = new FakeStore()
    const lock = locked(store)
    const s = boot(store)
    s.transport.request.mockRejectedValue(network())
    await s.client.devices.trackOpen(42)
    expect(await s.client.queueStats()).toEqual({ pending: 1, dropped: 0 })
    s.client.destroy() // killed

    lock.unlock()
    const next = boot(store)
    expect(await next.client.queueStats()).toEqual({ pending: 0, dropped: 0 })
    await next.client.flush()
    expect(next.transport.request).not.toHaveBeenCalled()
  })

  it('still sends from memory while the id is unreadable, and drops the item once sent', async () => {
    const store = new FakeStore()
    locked(store)
    const s = boot(store)
    s.transport.request.mockRejectedValueOnce(network())
    await s.client.devices.trackOpen(42)
    s.transport.request.mockResolvedValue({})
    await s.client.flush()
    expect(sends(s.transport, 42)).toBe(2)
    expect(await s.client.queueStats()).toEqual({ pending: 0, dropped: 0 })
    void own
  })

  it('adds the stored dropped count once, however many attaches failed before the one that worked', async () => {
    const store = new FakeStore()
    seedOwn(store, [item({ id: 'd1', body: { notification_id: 7, event: 'opened', push_token: null } })], 5)
    const lock = locked(store)
    const s = boot(store)
    s.transport.request.mockRejectedValue(network())
    await s.client.devices.trackOpen(1)
    await s.client.flush() // an attach that fails (persist and flush both try)
    await s.client.devices.trackOpen(2)
    await s.client.flush()
    expect(await s.client.queueStats()).toEqual({ pending: 2, dropped: 0 }) // the disk is not read: nothing is added yet

    lock.unlock()
    s.transport.request.mockReset()
    s.transport.request.mockResolvedValue({})
    await s.client.flush()
    expect(await s.client.queueStats()).toEqual({ pending: 0, dropped: 5 })
    expect([sends(s.transport, 7), sends(s.transport, 1), sends(s.transport, 2)]).toEqual([1, 1, 1])
    s.client.destroy()
    const next = boot(store)
    expect(await next.client.queueStats()).toEqual({ pending: 0, dropped: 5 })
    await next.client.flush()
    expect(next.transport.request).not.toHaveBeenCalled()
  })

  it('writes the memory queue on attach even when the disk needs no rewrite, so a kill after the unlock keeps it', async () => {
    const store = new FakeStore()
    seedOwn(store, [])
    const lock = locked(store)
    const s = boot(store)
    s.transport.request.mockRejectedValue(network())
    await s.client.devices.trackOpen(42)
    lock.unlock()
    // a foreground flush while a Retry-After holds: the pass sends nothing, so only the attach can write the event
    ;(s.client as any)._queue._retryAfterUntil = Date.now() + 600_000
    await (s.client as any)._queue.flush('foreground')
    expect(store.map.get(`${own(store)}.0`)).toContain('"notification_id":42')
    s.client.destroy() // killed

    const next = boot(store)
    await next.client.flush()
    expect(sends(next.transport, 42)).toBe(1)
  })
})
