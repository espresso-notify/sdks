/**
 * @jest-environment node
 *
 * sdk-parity T74 (PAR-88, PAR-92): disableSDK stops all traffic, deletes what waits in the offline queue and holds
 * across restarts until enableSDK; an erase leaves the choice as it is.
 *
 * feature: privacy.disable-sdk
 */

// A module, so that its top-level names do not clash with the other test files that are scripts.
export {}

const T0 = 1_700_000_000_000

class FakeStore {
  readonly map = new Map<string, string>()
  async getItem(key: string) { return this.map.get(key) ?? null }
  async setItem(key: string, value: string) { this.map.set(key, value) }
  async removeItem(key: string) { this.map.delete(key) }
  keysUnder(prefix: string) { return [...this.map.keys()].filter((k) => k.startsWith(prefix) && this.map.get(k) !== '') }
}

function boot(store: FakeStore = new FakeStore(), config: Record<string, unknown> = {}) {
  jest.resetModules()
  jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: 17 }, AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }), { virtual: true })
  const sdk = require('../src/index')
  const transport = { request: jest.fn().mockResolvedValue({}) }
  const make = () =>
    new sdk.PushClient({
      projectId: 'pk_live_disable', pushToken: 'ExponentPushToken[disable-device]', platform: 'ios', transport, autoTrack: false,
      _queueStore: store, ...config,
    })
  return { sdk, store, transport, make, client: make() }
}

const sent = (transport: { request: jest.Mock }) => transport.request.mock.calls.map(([, init]) => JSON.parse(init.body))
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('disableSDK (PAR-88)', () => {
  it('stops all traffic: no report goes out and the calls that need the server reject with SDK_DISABLED', async () => {
    const { client, transport } = boot()
    await client.disableSDK()

    await client.devices.trackOpen(1)
    await client.devices.trackReceived(2)
    await client.devices.trackEvent('order.completed')
    await client.devices.recordLifecycle('permission', 'undetermined', 'granted')
    await client.flush()
    const refusals = await Promise.all([
      client.devices.register({}).catch((e: any) => e),
      client.devices.identify({ externalId: 'u1' }).catch((e: any) => e),
      client.devices.forgetDevice().catch((e: any) => e),
    ])

    expect(transport.request).not.toHaveBeenCalled()
    for (const error of refusals) expect(error.code).toBe('SDK_DISABLED')
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 }) // nothing is held for later
  })

  it('deletes the events that wait, in memory and in the store', async () => {
    const { client, transport, store } = boot()
    transport.request.mockRejectedValue(new TypeError('Network request failed'))
    await client.devices.trackOpen(1)
    await client.devices.trackEvent('order.completed')
    expect((await client.queueStats()).pending).toBeGreaterThan(0)
    expect(store.keysUnder('espresso.eventQueue.').length).toBeGreaterThan(0)

    await client.disableSDK()

    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
    expect(store.keysUnder('espresso.eventQueue.')).toEqual([])
    transport.request.mockClear()
    await client.flush()
    expect(transport.request).not.toHaveBeenCalled()
  })

  it('holds across a restart, and sends nothing of what an earlier launch left in the queue', async () => {
    const first = boot()
    first.transport.request.mockRejectedValue(new TypeError('Network request failed'))
    await first.client.devices.trackEvent('left.behind')
    expect(first.store.keysUnder('espresso.eventQueue.').length).toBeGreaterThan(0)
    // The earlier run was turned off after it wrote its queue (the order of the two writes is not the point).
    first.store.map.set('espresso.disabled', 'true')

    const second = boot(first.store)
    await tick()
    await second.client.flush()
    await second.client.devices.trackEvent('new.event')
    const refusal = await second.client.devices.updateMetadata({ plan: 'pro' }).catch((e: any) => e)

    expect(second.transport.request).not.toHaveBeenCalled()
    expect(refusal.code).toBe('SDK_DISABLED')
    expect(first.store.keysUnder('espresso.eventQueue.')).toEqual([])
    expect(await second.client.queueStats()).toEqual({ pending: 0, dropped: 0 })
  })

  it('a request made right after the client was created waits for the stored answer', async () => {
    const store = new FakeStore()
    store.map.set('espresso.disabled', 'true')
    const { client, transport } = boot(store)

    const refusal = await client.devices.updateMetadata({ plan: 'pro' }).catch((e: any) => e) // no tick: the store is still being read

    expect(refusal.code).toBe('SDK_DISABLED')
    expect(transport.request).not.toHaveBeenCalled()
  })

  it('persists the choice under espresso.disabled and keeps it through wipeLocalData', async () => {
    const { client, store, sdk } = boot()
    await client.disableSDK()
    expect(store.map.get('espresso.disabled')).toBe('true')
    expect(Object.values(sdk.RN_STORAGE_KEYS)).not.toContain('espresso.disabled') // the wipe does not list it

    await client.wipeLocalData()

    expect(store.map.get('espresso.disabled')).toBe('true')
    await expect(client.devices.updateMetadata({ plan: 'pro' })).rejects.toMatchObject({ code: 'SDK_DISABLED' })
  })
})

describe('enableSDK (PAR-88)', () => {
  it('resumes: requests go out again, what is reported from then on is sent, and the choice is gone from the store', async () => {
    const { client, transport, store } = boot()
    await client.disableSDK()
    await client.devices.trackEvent('while.off')

    await client.enableSDK()
    await client.devices.trackEvent('after.on')
    await client.devices.updateMetadata({ plan: 'pro' })

    expect(store.map.has('espresso.disabled')).toBe(false)
    expect(sent(transport).map((b) => b.event ?? 'metadata')).toEqual(['after.on', 'metadata'])
  })

  it('stays on across a restart', async () => {
    const first = boot()
    await first.client.disableSDK()
    await first.client.enableSDK()

    const second = boot(first.store)
    await second.client.devices.trackEvent('after.restart')

    expect(sent(second.transport).map((b) => b.event)).toEqual(['after.restart'])
  })

  it('does not give the consent back: with requireConsent the gate still asks for it', async () => {
    const { client, transport } = boot(new FakeStore(), { requireConsent: true })
    await client.setConsent(true)
    await client.disableSDK()
    await client.enableSDK()
    await client.devices.trackEvent('consent.kept')
    await client.flush()
    expect(sent(transport).map((b) => b.event)).toEqual(['consent.kept']) // the consent of before is still there

    await client.wipeLocalData() // an erase takes the consent away
    transport.request.mockClear()
    await client.devices.trackEvent('no.consent')
    expect(transport.request).not.toHaveBeenCalled()
  })

  it('does nothing when the SDK was not off', async () => {
    const { client, transport } = boot()
    await client.enableSDK()
    await client.devices.trackEvent('fine')
    expect(sent(transport).map((b) => b.event)).toEqual(['fine'])
  })
})
