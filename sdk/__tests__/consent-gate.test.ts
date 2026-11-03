/**
 * @jest-environment node
 *
 * sdk-parity T73 (PAR-87, PAR-92): with `requireConsent` the client makes no request and holds at most
 * `consent.buffer_events` events (the oldest dropped first) until the app calls `setConsent(true)`; the answer is kept
 * across restarts. The number comes from the copy of `sdk-parity/constants.json`.
 *
 * feature: privacy.consent
 */
import { effective } from './helpers/parityConstants'

const T0 = 1_700_000_000_000

class FakeStore {
  readonly map = new Map<string, string>()
  async getItem(key: string) { return this.map.get(key) ?? null }
  async setItem(key: string, value: string) { this.map.set(key, value) }
  async removeItem(key: string) { this.map.delete(key) }
  text() { return [...this.map.values()].join('\n') }
}

function boot(store: FakeStore = new FakeStore(), config: Record<string, unknown> = { requireConsent: true }) {
  jest.resetModules()
  jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: 17 }, AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }), { virtual: true })
  const sdk = require('../src/index')
  const transport = { request: jest.fn().mockResolvedValue({}) }
  const make = () =>
    new sdk.PushClient({
      projectId: 'pk_live_consent', pushToken: 'ExponentPushToken[consent-device]', platform: 'ios', transport, autoTrack: false,
      _queueStore: store, ...config,
    })
  return { sdk, store, transport, make, client: make() }
}

/** The bodies sent to the transport, in order. */
const sent = (transport: { request: jest.Mock }) => transport.request.mock.calls.map(([, init]) => JSON.parse(init.body))
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('without consent (PAR-87)', () => {
  it('makes no network call for any report or call, and the calls that are not events reject with CONSENT_REQUIRED', async () => {
    const { client, transport } = boot()
    await tick()

    await client.devices.trackOpen(1)
    await client.devices.trackReceived(2)
    await client.devices.trackClick(3)
    await client.devices.trackConversion(4)
    await client.devices.trackEvent('order.completed')
    await client.devices.recordLifecycle('permission', 'undetermined', 'granted')
    await client.flush()
    const refusals = await Promise.all([
      client.devices.register({}).catch((e: any) => e),
      client.devices.identify({ externalId: 'u1' }).catch((e: any) => e),
      client.devices.updateMetadata({ plan: 'pro' }).catch((e: any) => e),
      client.devices.forgetDevice().catch((e: any) => e),
    ])

    expect(transport.request).not.toHaveBeenCalled()
    for (const error of refusals) expect(error.code).toBe('CONSENT_REQUIRED')
    expect(await client.queueStats()).toEqual({ pending: 6, dropped: 0 })
  })

  it('holds at most consent.buffer_events events and drops the oldest first', async () => {
    const { sdk, client, transport } = boot()
    const limit = effective('consent.buffer_events', 'rn')
    expect(sdk.CONSENT_BUFFER_EVENTS).toBe(limit)

    for (let i = 0; i <= limit; i++) await client.devices.trackEvent(`event.${i}`)

    expect(await client.queueStats()).toEqual({ pending: limit, dropped: 1 })
    await client.setConsent(true)
    await client.flush() // the release started by setConsent is one pass; this waits for it to end
    const names = sent(transport).map((b) => b.event)
    expect(names).toHaveLength(limit)
    expect(names[0]).toBe('event.1') // event.0 was the oldest, and it went
    expect(names[limit - 1]).toBe(`event.${limit}`)
  })

  it('never writes a held event to the store', async () => {
    const { client, store } = boot()
    await client.devices.trackEvent('secret.purchase')
    await client.devices.trackOpen(7)
    await client.queueStats()

    expect(store.text()).not.toContain('secret.purchase')
    expect(store.text()).not.toContain('notification_id')
  })
})

describe('with consent (PAR-87)', () => {
  it('sends what waited when consent is given, and what comes after at once', async () => {
    const { client, transport } = boot()
    await client.devices.trackEvent('first')
    await client.devices.trackEvent('second')
    expect(transport.request).not.toHaveBeenCalled()

    await client.setConsent(true)
    await client.flush()

    expect(sent(transport).map((b) => b.event)).toEqual(['first', 'second'])
    expect(sent(transport)[0].push_token).toBe('ExponentPushToken[consent-device]') // the token is added when the event goes
    await client.devices.trackEvent('third')
    expect(sent(transport).map((b) => b.event)).toEqual(['first', 'second', 'third'])
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
  })

  it('lets the calls that are not events through once consent is given', async () => {
    const { client, transport } = boot()
    await client.setConsent(true)

    await client.devices.updateMetadata({ plan: 'pro' })

    expect(transport.request).toHaveBeenCalledTimes(1)
  })

  it('keeps the answer across a restart, and a new client holds events only until it has read it', async () => {
    const first = boot()
    await first.client.setConsent(true)
    expect(first.store.map.get('espresso.consent')).toBe('true')

    const second = boot(first.store)
    await second.client.devices.trackEvent('after.restart')
    await tick()
    await second.client.flush()

    expect(sent(second.transport).map((b) => b.event)).toEqual(['after.restart'])
  })

  it('takes the consent back with setConsent(false): the gate closes and the kept answer goes', async () => {
    const { client, transport, store } = boot()
    await client.setConsent(true)
    await client.devices.trackEvent('allowed')
    transport.request.mockClear()

    await client.setConsent(false)
    await client.devices.trackEvent('not.allowed')

    expect(transport.request).not.toHaveBeenCalled()
    expect(store.map.has('espresso.consent')).toBe(false)
    expect(await client.queueStats()).toEqual({ pending: 1, dropped: 0 })
  })

  it('does not gate anything without requireConsent, and setConsent changes nothing', async () => {
    const { client, transport, store } = boot(new FakeStore(), {})

    await client.devices.trackEvent('free')
    await client.setConsent(false)
    await client.devices.trackEvent('still.free')

    expect(sent(transport).map((b) => b.event)).toEqual(['free', 'still.free'])
    expect(store.map.has('espresso.consent')).toBe(false)
  })
})
