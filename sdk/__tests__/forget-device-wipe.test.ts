/**
 * @jest-environment node
 *
 * sdk-parity T72 (PAR-90, PAR-91): forgetDevice runs the local wipe after the server answered 2xx or 404, and keeps
 * everything on the device after a 403, a 5xx or a network failure.
 *
 * feature: privacy.erase
 */

// A module, so that its top-level names do not clash with the other test files that are scripts.
export {}


class FakeStore {
  readonly map = new Map<string, string>()
  async getItem(key: string) { return this.map.get(key) ?? null }
  async setItem(key: string, value: string) { this.map.set(key, value) }
  async removeItem(key: string) { this.map.delete(key) }
}

type Answer = { kind: 'ok' } | { kind: 'http'; status: number; code: string } | { kind: 'network' }

function boot(answer: Answer) {
  jest.resetModules()
  jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: 17 }, AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }), { virtual: true })
  const sdk = require('../src/index')
  const signingStore = new FakeStore()
  const queueStore = new FakeStore()
  const signer = {
    generate: jest.fn().mockResolvedValue('PUBLIC-KEY'),
    sign: jest.fn().mockResolvedValue('c2ln'),
    getPublicKey: jest.fn().mockResolvedValue(null),
    isSupported: jest.fn().mockResolvedValue(true),
    deleteKey: jest.fn().mockResolvedValue(undefined),
  }
  let erase: Answer = { kind: 'network' }
  const transport = {
    request: jest.fn(async (path: string, init: RequestInit = {}) => {
      if (init.method === 'DELETE' && path === '/v1/devices') {
        if (erase.kind === 'http') throw new sdk.EspressoNotifyHttpError(`HTTP ${erase.status}`, erase.status, erase.code, path)
        if (erase.kind === 'network') throw new TypeError('Network request failed')
        return {}
      }
      throw new TypeError('Network request failed') // every event stays in the queue
    }),
  }
  const client = new sdk.PushClient({
    projectId: 'pk_live_forget', pushToken: 'ExponentPushToken[forget-device]', platform: 'ios', transport, autoTrack: false,
    enableSigning: true, requireConsent: true, _keyStore: signingStore, _signer: signer, _queueStore: queueStore,
  })
  const stores = [signingStore, queueStore]
  const arm = () => { erase = answer }
  return { sdk, client, signer, stores, arm }
}

const held = (stores: FakeStore[], entry: string) =>
  stores.some((s) => [...s.map.entries()].some(([k, v]) => (entry.endsWith('.') ? k.startsWith(entry) : k === entry) && v !== ''))

async function fill(client: any, sdk: any, stores: FakeStore[]) {
  await client.setConsent(true)
  await client.devices.trackOpen(1) // signs the request (install id, public key) and queues the event
  const ticket = await client.registration.plan('register', { token: 'ExponentPushToken[forget-device]' })
  await client.registration.commit(ticket)
  await client.queueStats()
  for (const entry of Object.values(sdk.RN_STORAGE_KEYS) as string[]) expect(held(stores, entry)).toBe(true)
}

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe('forgetDevice and the local data (PAR-90, PAR-91)', () => {
  it('wipes everything after a 2xx', async () => {
    const { sdk, client, signer, stores, arm } = boot({ kind: 'ok' })
    await fill(client, sdk, stores)
    arm()

    await expect(client.devices.forgetDevice()).resolves.toBeUndefined()

    for (const entry of Object.values(sdk.RN_STORAGE_KEYS) as string[]) expect(held(stores, entry)).toBe(false)
    expect(signer.deleteKey).toHaveBeenCalledWith('espresso-signing-key')
    expect(client.pushToken).toBe('ExponentPushToken[forget-device]') // the SDK stores none; the one in memory stays
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
  })

  it('wipes everything after a 404 and still throws it', async () => {
    const { sdk, client, signer, stores, arm } = boot({ kind: 'http', status: 404, code: 'not_found' })
    await fill(client, sdk, stores)
    arm()

    const err: any = await client.devices.forgetDevice().catch((e: unknown) => e)

    expect(err).toBeInstanceOf(sdk.EspressoNotifyHttpError)
    expect(err.status).toBe(404)
    for (const entry of Object.values(sdk.RN_STORAGE_KEYS) as string[]) expect(held(stores, entry)).toBe(false)
    expect(signer.deleteKey).toHaveBeenCalled()
  })

  it.each([
    ['a 403', { kind: 'http', status: 403, code: 'identity_verification_failed' } as Answer],
    ['a 500', { kind: 'http', status: 500, code: 'erasure_failed' } as Answer],
    ['a 503', { kind: 'http', status: 503, code: 'identity_verification_unavailable' } as Answer],
    ['a network failure', { kind: 'network' } as Answer],
  ])('keeps everything on the device after %s and rethrows', async (_name, answer) => {
    const { sdk, client, signer, stores, arm } = boot(answer)
    await fill(client, sdk, stores)
    const queued = await client.queueStats()
    arm()

    await expect(client.devices.forgetDevice()).rejects.toThrow(/forgetDevice failed/)

    for (const entry of Object.values(sdk.RN_STORAGE_KEYS) as string[]) expect(held(stores, entry)).toBe(true)
    expect(signer.deleteKey).not.toHaveBeenCalled()
    expect(client.pushToken).toBe('ExponentPushToken[forget-device]')
    expect(await client.queueStats()).toEqual(queued)
  })
})
