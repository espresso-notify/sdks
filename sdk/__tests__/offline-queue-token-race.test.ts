/**
 * @jest-environment node
 *
 * A lifecycle event can reach the server before the register of its token does (a token rotation): the answer is
 * 404 token_not_found. That one refusal can pass, so the queue keeps the event and tries again a bounded number of
 * times; every other 4xx, and the same 404 on a delivery event, still drops it at once (acceptance defect D-B).
 */

// A module, so that its top-level names do not clash with the other test files that are scripts.
export {}

const T0 = 1_700_000_000_000
const SECOND = 1000

class FakeStore {
  readonly map = new Map<string, string>()
  async getItem(key: string) { return this.map.get(key) ?? null }
  async setItem(key: string, value: string) { this.map.set(key, value) }
}

function boot() {
  jest.resetModules()
  jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: 17 }, AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }), { virtual: true })
  const sdk = require('../src/index')
  const transport = { request: jest.fn().mockResolvedValue({}) }
  const client = new sdk.PushClient({
    projectId: 'pk_live_queue',
    pushToken: 'ExponentPushToken[new-token]',
    platform: 'ios',
    transport,
    autoTrack: false,
    _queueStore: new FakeStore(),
  })
  return { sdk, transport, client }
}

const http = (sdk: any, status: number, code?: string) =>
  new sdk.EspressoNotifyHttpError(`HTTP ${status}`, status, code, '/v1/devices/lifecycle')
const sent = (transport: { request: jest.Mock }) => transport.request.mock.calls.map(([path, init]) => ({ path, ...JSON.parse(init.body) }))

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  jest.spyOn(Math, 'random').mockReturnValue(1)
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

const rotate = (client: any) => client.devices.recordLifecycle('subscription', 'ExponentPushToken[old-token]', 'ExponentPushToken[new-token]')

describe('404 token_not_found on a lifecycle event', () => {
  it('keeps the event, counts nothing as dropped and warns about nothing', async () => {
    const { sdk, transport, client } = boot()
    transport.request.mockRejectedValueOnce(http(sdk, 404, 'token_not_found'))

    await rotate(client)

    expect(await client.queueStats()).toEqual({ pending: 1, dropped: 0 })
    expect((console.warn as jest.Mock).mock.calls.filter((c) => String(c[0]).includes('offline queue'))).toHaveLength(0)
  })

  it('sends it again by itself after the first wait, whole, with the token of the client', async () => {
    const { sdk, transport, client } = boot()
    transport.request.mockRejectedValueOnce(http(sdk, 404, 'token_not_found')).mockResolvedValue({})

    await rotate(client)
    await jest.advanceTimersByTimeAsync(6 * SECOND)

    const calls = sent(transport)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({
      path: '/v1/devices/lifecycle', kind: 'subscription', push_token: 'ExponentPushToken[new-token]',
      from: 'ExponentPushToken[old-token]', to: 'ExponentPushToken[new-token]',
    })
    expect(calls[1].event_id).toBe(calls[0].event_id)
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
  })

  it('gives up for good after 4 tries in all and counts the event once', async () => {
    const { sdk, transport, client } = boot()
    transport.request.mockRejectedValue(http(sdk, 404, 'token_not_found'))

    await rotate(client) // try 1
    await client.flush() // 2
    await client.flush() // 3
    expect(await client.queueStats()).toEqual({ pending: 1, dropped: 0 })
    await client.flush() // 4: refused for good
    await client.flush() // nothing left to send

    expect(transport.request).toHaveBeenCalledTimes(4)
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 1 })
    const lines = (console.warn as jest.Mock).mock.calls.map((c) => String(c[0])).filter((l) => l.includes('offline queue'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('token_not_found')
  })

  it('does not hold back the other events of the pass', async () => {
    const { sdk, transport, client } = boot()
    transport.request.mockRejectedValue(new TypeError('Network request failed'))
    await rotate(client)
    await client.devices.trackOpen(7)
    transport.request.mockReset()
    transport.request
      .mockRejectedValueOnce(http(sdk, 404, 'token_not_found'))
      .mockResolvedValue({})

    await client.flush()

    const calls = sent(transport)
    expect(calls.map((c) => c.path)).toEqual(['/v1/devices/lifecycle', '/v1/notifications/track'])
    expect(await client.queueStats()).toEqual({ pending: 1, dropped: 0 }) // only the lifecycle event waits
  })

  it('is dropped at once when the queue is turned off (one attempt, as before)', async () => {
    jest.resetModules()
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: 17 }, AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }), { virtual: true })
    const sdk = require('../src/index')
    const transport = { request: jest.fn().mockRejectedValue(http(sdk, 404, 'token_not_found')) }
    const client = new sdk.PushClient({
      projectId: 'pk_live_queue', pushToken: 'ExponentPushToken[t]', platform: 'ios', transport, autoTrack: false,
      offlineQueue: { enabled: false },
    })

    await expect(rotate(client)).resolves.toBeUndefined()

    expect(transport.request).toHaveBeenCalledTimes(1)
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 })
  })
})

describe('what stays a refusal for good', () => {
  it.each([
    ['another code on a lifecycle event', '/v1/devices/lifecycle', 404, 'unknown_device'],
    ['no code on a lifecycle event', '/v1/devices/lifecycle', 404, undefined],
    ['a 400 on a lifecycle event', '/v1/devices/lifecycle', 400, 'invalid_lifecycle'],
    ['token_not_found on a delivery event', '/v1/notifications/track', 404, 'token_not_found'],
  ])('drops %s at once', async (_name, path, status, code) => {
    const { sdk, transport, client } = boot()
    transport.request.mockRejectedValueOnce(new sdk.EspressoNotifyHttpError(`HTTP ${status}`, status, code, path))

    if (path === '/v1/devices/lifecycle') await rotate(client)
    else await client.devices.trackOpen(42)

    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 1 })
  })
})

// The timer path (mode `due`) honours `_holdUntil`; `flush()` (mode `force`) ignores it, so these tests wait on the timer.
describe('a race holds back no due event', () => {
  const trackCalls = (t: { request: jest.Mock }) => t.request.mock.calls.filter(([p]: [string]) => p === '/v1/notifications/track').length

  it('on the first send: a race recorded after a network failure does not push the due time of the waiting event', async () => {
    const { sdk, transport, client } = boot()
    let trackFails = 1
    transport.request.mockImplementation(async (path: string) => {
      if (path === '/v1/devices/lifecycle') throw http(sdk, 404, 'token_not_found')
      if (trackFails-- > 0) throw new TypeError('Network request failed')
      return {}
    })
    await client.devices.trackOpen(7)               // T0: network failure, next T0+5s
    await jest.advanceTimersByTimeAsync(4 * SECOND)
    await rotate(client)                            // T0+4s: race, its own next is T0+9s
    await jest.advanceTimersByTimeAsync(2 * SECOND) // T0+6s
    expect(trackCalls(transport)).toBe(2)           // the open went out at T0+5s
  })

  it('in a pass: a race on its second try does not hold back an event due before it', async () => {
    const { sdk, transport, client } = boot()
    let trackFails = 1
    transport.request.mockImplementation(async (path: string) => {
      if (path === '/v1/devices/lifecycle') throw http(sdk, 404, 'token_not_found')
      if (trackFails-- > 0) throw new TypeError('Network request failed')
      return {}
    })
    await rotate(client)                            // T0: race, next T0+5s
    await jest.advanceTimersByTimeAsync(6 * SECOND) // T0+6s: the race was tried again at T0+5s, next T0+15s
    expect(transport.request.mock.calls.filter(([p]: [string]) => p === '/v1/devices/lifecycle').length).toBe(2)
    await client.devices.trackOpen(7)               // T0+6s: network failure, next T0+11s
    await jest.advanceTimersByTimeAsync(6 * SECOND) // T0+12s
    expect(trackCalls(transport)).toBe(2)           // the open went out at T0+11s
  })
})
