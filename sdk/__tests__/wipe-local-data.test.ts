/**
 * @jest-environment node
 *
 * sdk-parity T71 (PAR-89, PAR-92): wipeLocalData deletes everything the SDK keeps on the device. The test reads the keys
 * from RN_STORAGE_KEYS, so a key added there without a deletion fails it (lesson L-419).
 *
 * feature: privacy.wipe-local-data
 */

// A module, so that its top-level names do not clash with the other test files that are scripts.
export {}


const T0 = 1_700_000_000_000

class FakeStore {
  readonly map = new Map<string, string>()
  async getItem(key: string) { return this.map.get(key) ?? null }
  async setItem(key: string, value: string) { this.map.set(key, value) }
  async removeItem(key: string) { this.map.delete(key) }
}

/** A store whose class has no `removeItem` at all, as a store written by an app against the older `KeyStore` has not. */
class LegacyStore {
  readonly map = new Map<string, string>()
  async getItem(key: string) { return this.map.get(key) ?? null }
  async setItem(key: string, value: string) { this.map.set(key, value) }
}

function boot(kind: 'removable' | 'legacy') {
  jest.resetModules()
  jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: 17 }, AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }), { virtual: true })
  const sdk = require('../src/index')
  const make = () => (kind === 'removable' ? new FakeStore() : new LegacyStore())
  const signingStore = make()
  const queueStore = make()
  const signer = {
    generate: jest.fn().mockResolvedValue('PUBLIC-KEY'),
    sign: jest.fn().mockResolvedValue('c2ln'),
    getPublicKey: jest.fn().mockResolvedValue(null),
    isSupported: jest.fn().mockResolvedValue(true),
    deleteKey: jest.fn().mockResolvedValue(undefined),
  }
  const transport = { request: jest.fn().mockRejectedValue(new TypeError('Network request failed')) }
  const client = new sdk.PushClient({
    projectId: 'pk_live_wipe',
    pushToken: 'ExponentPushToken[wipe-device]',
    platform: 'ios',
    transport,
    autoTrack: false,
    enableSigning: true,
    requireConsent: true,
    _keyStore: signingStore,
    _signer: signer,
    _queueStore: queueStore,
  })
  return { sdk, client, signer, transport, stores: [signingStore, queueStore] as Array<{ map: Map<string, string> }> }
}

/** A value is held when a key (or, for a prefix that ends in a dot, some key under it) has a non-empty text. */
function held(stores: Array<{ map: Map<string, string> }>, entry: string): boolean {
  return stores.some((store) =>
    [...store.map.entries()].some(([key, value]) => (entry.endsWith('.') ? key.startsWith(entry) : key === entry) && value !== ''),
  )
}

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe.each(['removable', 'legacy'] as const)('wipeLocalData with a %s store (PAR-89)', (kind) => {
  it('deletes every key of RN_STORAGE_KEYS and deletes the signing key through the native module', async () => {
    const { sdk, client, signer, stores } = boot(kind)
    // Fill every place: the consent, the queue (an event that cannot be sent), the install id and the public key (signing), the ledger.
    await client.setConsent(true)
    await client.devices.trackOpen(1)
    const ticket = await client.registration.plan('register', { token: 'ExponentPushToken[wipe-device]' })
    await client.registration.commit(ticket)
    await client.queueStats()
    for (const entry of Object.values(sdk.RN_STORAGE_KEYS) as string[]) {
      expect(held(stores, entry)).toBe(true) // the fixture really stored it: otherwise the wipe proves nothing
    }

    await expect(client.wipeLocalData()).resolves.toBeUndefined()

    for (const entry of Object.values(sdk.RN_STORAGE_KEYS) as string[]) {
      expect(held(stores, entry)).toBe(false)
    }
    expect(signer.deleteKey).toHaveBeenCalledWith('espresso-signing-key')
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
    expect(await client.registration.plan('register', { token: 'ExponentPushToken[wipe-device]' })).not.toBeNull()
  })

  it('forgets the user and the identity tokens held in memory, and keeps the push token', async () => {
    const { client, transport } = boot(kind)
    transport.request.mockResolvedValue({})
    await client.setConsent(true)
    await client.devices.identify({ externalId: 'user-1', identityToken: 'jwt-user-1' })
    expect(client.pushToken).toBe('ExponentPushToken[wipe-device]')
    transport.request.mockClear()
    await client.devices.getPreferences('user-1', 'ExponentPushToken[x]')
    expect(JSON.parse(transport.request.mock.calls[0][1].body).identity_token).toBe('jwt-user-1') // the control: it was kept

    await client.wipeLocalData()
    await client.setConsent(true) // the wipe took the consent away too

    expect(client.pushToken).toBe('ExponentPushToken[wipe-device]') // the SDK stores none; the one in memory stays
    await expect(client.devices.getPreferences(undefined, 'ExponentPushToken[x]')).rejects.toThrow(/externalId/) // no last user
    transport.request.mockClear()
    await client.devices.getPreferences('user-1', 'ExponentPushToken[x]')
    expect(JSON.parse(transport.request.mock.calls[0][1].body).identity_token).toBeUndefined()
  })

  it('makes a new install id and a new signing key at the next use', async () => {
    const { client, signer, stores, transport } = boot(kind)
    transport.request.mockResolvedValue({})
    await client.setConsent(true)
    await client.devices.trackOpen(1)
    const idOf = () => stores.map((s) => s.map.get('espresso.deviceId')).find(Boolean)
    const first = idOf()
    expect(first).toBeTruthy()
    expect(signer.generate).toHaveBeenCalledTimes(1)

    await client.wipeLocalData()
    await client.setConsent(true) // the wipe took the consent away too
    await client.devices.trackOpen(2)

    const second = idOf()
    expect(second).toBeTruthy()
    expect(second).not.toBe(first)
    expect(signer.generate).toHaveBeenCalledTimes(2)
  })

  it('never rejects when the store or the signer fail', async () => {
    const { client, signer, stores } = boot(kind)
    await client.setConsent(true)
    await client.devices.trackOpen(1)
    signer.deleteKey.mockRejectedValue(new Error('keystore locked'))
    for (const store of stores) {
      ;(store as any).removeItem = jest.fn().mockRejectedValue(new Error('store down'))
      ;(store as any).setItem = jest.fn().mockRejectedValue(new Error('store down'))
    }

    await expect(client.wipeLocalData()).resolves.toBeUndefined()
    expect(signer.deleteKey).toHaveBeenCalled()
  })
})
