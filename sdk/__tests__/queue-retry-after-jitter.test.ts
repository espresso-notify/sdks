/**
 * @jest-environment node
 *
 * send-scale T38 (SCALE-28): the offline queue obeys a `Retry-After` and then adds a random 0 to 25% to it, capped at
 * one hour, so the devices told to wait the same time do not return together.
 */
const T0 = 1_700_000_000_000
const SECOND = 1000

class FakeStore {
  readonly map = new Map<string, string>()
  async getItem(key: string) { return this.map.get(key) ?? null }
  async setItem(key: string, value: string) { this.map.set(key, value) }
}

function boot() {
  jest.resetModules()
  jest.doMock('react-native', () => ({
    Platform: { OS: 'ios', Version: 17 },
    AppState: { currentState: 'background', addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  }), { virtual: true })
  const sdk = require('../src/index')
  const transport = { request: jest.fn().mockResolvedValue({}) }
  const client = new sdk.PushClient({
    projectId: 'pk_live_jitter', pushToken: 'ExponentPushToken[jitter]', platform: 'ios', transport,
    autoTrack: false, _queueStore: new FakeStore(),
  })
  return { sdk, transport, client }
}

const http = (sdk: any, status: number, retryAfter?: number) =>
  new sdk.EspressoNotifyHttpError(`HTTP ${status}`, status, 'rate_limited', '/v1/notifications/track', retryAfter)

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

/** The moment, in seconds after the 429, at which the queue sends the held event again. */
async function secondsUntilResend(random: number, retryAfter: number): Promise<number> {
  jest.spyOn(Math, 'random').mockReturnValue(random)
  const { sdk, transport, client } = boot()
  transport.request.mockRejectedValueOnce(http(sdk, 429, retryAfter))
  await client.devices.trackOpen(1)
  transport.request.mockClear()
  for (let s = 0; s <= 4000; s++) {
    await jest.advanceTimersByTimeAsync(SECOND)
    if (transport.request.mock.calls.length > 0) return s + 1
  }
  return Infinity
}

describe('the Retry-After wait of the queue', () => {
  it('is the header when the dice say 0', async () => {
    expect(await secondsUntilResend(0, 10)).toBe(10)
  })

  it('is the header plus 25% when the dice say 1', async () => {
    expect(await secondsUntilResend(1, 10)).toBe(13) // 12.5 s, the timer fires on the next whole second
  })

  it('is in between for a middle roll', async () => {
    expect(await secondsUntilResend(0.4, 20)).toBe(22) // 20 * 1.1
  })

  it('is cut at one hour even with the jitter', async () => {
    expect(await secondsUntilResend(1, 86_400)).toBe(3600)
  })
})
