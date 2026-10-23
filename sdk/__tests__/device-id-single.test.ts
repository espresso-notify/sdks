/**
 * @jest-environment node
 *
 * One device id per install: request signing and the offline queue read `espresso.deviceId` through the same
 * create-only promise, so on a fresh install they never each create their own, whichever starts first and whatever the
 * store's latency (sdk-acceptance-2026-10-16, G1).
 */
jest.mock('expo-notifications', () => ({}), { virtual: true })
import type { Signer } from '../src/index'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Two wrappers over one backing map, as production has (the signing store and the queue store are two objects over one storage). */
function sharedStore(latency: { a: number; b: number }) {
  const map = new Map<string, string>()
  const writes: Array<[string, string]> = []
  const mk = (ms: number) => ({
    backing: map, // both wrappers name the one storage they sit on, as ExpoSecureKeyStore and AsyncStorageKeyStore do
    async getItem(k: string) { await wait(ms); return map.get(k) ?? null },
    async setItem(k: string, v: string) { await wait(ms); writes.push([k, v]); map.set(k, v) },
  })
  return { map, writes, a: mk(latency.a), b: mk(latency.b) }
}
const signer = (): Signer => ({
  generate: jest.fn().mockResolvedValue('SPKI=='),
  sign: jest.fn().mockResolvedValue('SIG=='),
  getPublicKey: jest.fn().mockResolvedValue('SPKI=='),
  isSupported: jest.fn().mockResolvedValue(true),
} as any)

function boot(latency: { a: number; b: number }) {
  jest.resetModules()
  const fetchMock = jest.fn().mockImplementation(async (u: string) => {
    if (u.includes('/track')) throw new TypeError('Network request failed')
    return { ok: true, text: () => Promise.resolve('{}') }
  })
  ;(globalThis as any).fetch = fetchMock
  const { PushClient } = require('../src/index')
  const store = sharedStore(latency)
  const client = new PushClient({
    projectId: 'pk_live_x', pushToken: 'tok', platform: 'ios', autoTrack: false, enableSigning: true,
    _keyStore: store.a, _signer: signer(), _queueStore: store.b,
  })
  return { client, fetchMock, ...store }
}

function expectOneId(t: ReturnType<typeof boot>) {
  const signed = t.fetchMock.mock.calls.find(([u]: [string]) => u.includes('/v1/devices/register'))![1].headers['X-KM-Device-Id']
  const stored = t.map.get('espresso.deviceId')
  const queueKeys = [...t.map.keys()].filter((k) => k.startsWith('espresso.eventQueue.'))
  expect(signed).toBe(stored)
  expect(queueKeys.length).toBeGreaterThan(0)
  expect(queueKeys.every((k) => k.startsWith(`espresso.eventQueue.pk_live_x.${stored}.`))).toBe(true)
  // the id is created once: no second write of another value
  expect(new Set(t.writes.filter(([k]) => k === 'espresso.deviceId').map(([, v]) => v)).size).toBe(1)
}

describe('a fresh install, request signing on', () => {
  it('queue first: the queue starts reading the id, then the first signed request starts', async () => {
    const t = boot({ a: 1, b: 5 })
    const queue = t.client.queueStats() // the queue opens its store (reads the id) ...
    await wait(1)
    await t.client.devices.register({}) // ... and the signing session reads it while the queue's read is in flight
    await queue
    await t.client.devices.trackOpen(1) // fails on the network: the event is kept under the key of the install
    await t.client.queueStats()
    expectOneId(t)
  })

  it('signing first: the first signed request starts reading the id, then the queue opens its store', async () => {
    const t = boot({ a: 5, b: 1 })
    const register = t.client.devices.register({})
    await wait(1)
    const queue = t.client.queueStats()
    await Promise.all([register, queue])
    await t.client.devices.trackOpen(1)
    await t.client.queueStats()
    expectOneId(t)
  })

  it('both start in the same tick', async () => {
    const t = boot({ a: 3, b: 3 })
    await Promise.all([t.client.queueStats(), t.client.devices.register({})])
    await t.client.devices.trackOpen(1)
    await t.client.queueStats()
    expectOneId(t)
  })

  it('a second client in the same process keeps the id of the first', async () => {
    const t = boot({ a: 1, b: 1 })
    await t.client.devices.register({})
    const first = t.map.get('espresso.deviceId')
    const { PushClient } = require('../src/index')
    const again = new PushClient({
      projectId: 'pk_live_x', pushToken: 'tok', platform: 'ios', autoTrack: false, enableSigning: true,
      _keyStore: t.a, _signer: signer(), _queueStore: t.b,
    })
    await Promise.all([again.queueStats(), again.devices.register({})])
    expect(t.map.get('espresso.deviceId')).toBe(first)
  })
})

/** A storage of its own: nothing in common with another one (a second app storage, or two tests in one process). */
function ownStorage(read: (key: string) => Promise<string | null> | null) {
  const map = new Map<string, string>()
  return {
    map,
    async getItem(k: string) { const r = read(k); return r === null ? (map.get(k) ?? null) : r },
    async setItem(k: string, v: string) { await wait(1); map.set(k, v) },
  }
}

describe('two unrelated storages in one process (sdk-acceptance-2026-10-16, G8)', () => {
  function clientOn(sdk: any, queueStore: any) {
    return new sdk.PushClient({
      projectId: 'pk_live_x', pushToken: 'tok', platform: 'ios', autoTrack: false,
      transport: { request: jest.fn().mockRejectedValue(new TypeError('Network request failed')) },
      _queueStore: queueStore,
    })
  }

  it('never share an id: each storage gets the id it creates itself', async () => {
    jest.resetModules()
    const sdk = require('../src/index')
    const one = ownStorage(() => null)
    const two = ownStorage(() => null)
    const a = clientOn(sdk, one)
    const b = clientOn(sdk, two)
    await Promise.all([a.queueStats(), b.queueStats()]) // both read in the same tick
    const idOne = one.map.get('espresso.deviceId')
    const idTwo = two.map.get('espresso.deviceId')
    expect(idOne).toBeTruthy()
    expect(idTwo).toBeTruthy()
    expect(idOne).not.toBe(idTwo)
    a.destroy()
    b.destroy()
  })

  it('a read that never settles on one storage does not hold back another storage', async () => {
    jest.resetModules()
    const sdk = require('../src/index')
    const hung = ownStorage((k) => (k === 'espresso.deviceId' ? new Promise<string | null>(() => {}) : null))
    const healthy = ownStorage(() => null)
    const a = clientOn(sdk, hung)
    void a.queueStats() // never ends
    await wait(1)
    const b = clientOn(sdk, healthy)
    const outcome = await Promise.race([b.queueStats().then(() => 'done'), wait(300).then(() => 'blocked')])
    expect(outcome).toBe('done')
    expect(healthy.map.get('espresso.deviceId')).toBeTruthy()
    a.destroy()
    b.destroy()
  })

  it('a read that throws once does not stick to its storage: the next caller reads again (G8b)', async () => {
    jest.resetModules()
    const sdk = require('../src/index')
    const map = new Map<string, string>()
    let failOnce = true
    const store = {
      async getItem(k: string) {
        await wait(1)
        if (k === 'espresso.deviceId' && failOnce) { failOnce = false; throw new Error('locked') }
        return map.get(k) ?? null
      },
      async setItem(k: string, v: string) { await wait(1); map.set(k, v) },
    }
    const mk = () => new sdk.PushClient({
      projectId: 'pk_live_x', pushToken: 'tok', platform: 'ios', autoTrack: false,
      transport: { request: jest.fn().mockRejectedValue(new TypeError('Network request failed')) }, _queueStore: store,
    })
    const a = mk()
    await a.queueStats() // the id could not be read: the queue falls back to the project-only key
    a.destroy()
    const b = mk()
    await b.devices.trackOpen(1)
    await b.queueStats()
    b.destroy()
    const id = map.get('espresso.deviceId')
    expect(id).toBeTruthy()
    expect([...map.keys()].some((k) => k.startsWith(`espresso.eventQueue.pk_live_x.${id}.`))).toBe(true)
  })

  it('two wrappers that name the same backing storage still share one id', async () => {
    jest.resetModules()
    const sdk = require('../src/index')
    const t = sharedStore({ a: 1, b: 5 })
    const a = clientOn(sdk, t.a)
    const b = clientOn(sdk, t.b)
    await Promise.all([a.queueStats(), b.queueStats()])
    expect(new Set(t.writes.filter(([k]) => k === 'espresso.deviceId').map(([, v]) => v)).size).toBe(1)
    a.destroy()
    b.destroy()
  })
})

describe('the stores the SDK resolves name the storage they sit on', () => {
  it('ExpoSecureKeyStore and AsyncStorageKeyStore return the module they wrap', () => {
    jest.resetModules()
    const sdk = require('../src/index')
    const secure = { getItemAsync: jest.fn(), setItemAsync: jest.fn() }
    const async = { getItem: jest.fn(), setItem: jest.fn() }
    expect(new sdk.ExpoSecureKeyStore(secure).backing).toBe(secure)
    expect(new sdk.ExpoSecureKeyStore(secure).backing).toBe(new sdk.ExpoSecureKeyStore(secure).backing)
    expect(new sdk.AsyncStorageKeyStore(async).backing).toBe(async)
    expect(new sdk.MemoryKeyStore().backing).toBeUndefined()
  })
})
