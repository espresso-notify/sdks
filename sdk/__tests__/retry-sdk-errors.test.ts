/**
 * @jest-environment node
 *
 * send-scale T38 (SCALE-27): the errors `register` and `identify` raise are the ones the retry helper judges: a request
 * that got no answer is retryable, an answer is judged by its status, and a validation error is final.
 */
let isRetryable: (error: unknown) => boolean

function boot(request: jest.Mock) {
  jest.resetModules()
  jest.doMock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: null }), { virtual: true })
  const sdk = require('../src/index')
  isRetryable = require('../src/retry').isRetryable // from the same module registry as the error classes
  const client = new sdk.PushClient({
    projectId: 'pk_live_errors', pushToken: 'ExponentPushToken[e]', platform: 'ios', transport: { request },
    autoTrack: false, offlineQueue: { enabled: false },
  })
  return { sdk, client }
}

async function failure(call: () => Promise<unknown>): Promise<any> {
  try { await call() } catch (e) { return e }
  throw new Error('the call did not fail')
}

describe('what register and identify throw', () => {
  it('a request that got no answer is retryable and keeps the message', async () => {
    const { client } = boot(jest.fn().mockRejectedValue(new TypeError('Network request failed')))
    const error = await failure(() => client.devices.register({}))
    expect(error.message).toBe('[espresso-notify] register failed: Network request failed')
    expect(isRetryable(error)).toBe(true)
    expect(isRetryable(await failure(() => client.devices.identify({ externalId: 'u1' })))).toBe(true)
  })

  it('an answer is judged by its status', async () => {
    const request = jest.fn()
    const { sdk, client } = boot(request)
    const answer = (status: number, retryAfter?: number) =>
      new sdk.EspressoNotifyHttpError(`HTTP ${status}`, status, undefined, '/v1/devices/register', retryAfter)
    request.mockRejectedValueOnce(answer(503, 7))
    const retryable = await failure(() => client.devices.register({}))
    expect(retryable.status).toBe(503)
    expect(retryable.retryAfter).toBe(7)
    expect(isRetryable(retryable)).toBe(true)
    request.mockRejectedValueOnce(answer(400))
    expect(isRetryable(await failure(() => client.devices.register({})))).toBe(false)
  })

  it('a validation error is final', async () => {
    const { client } = boot(jest.fn())
    expect(isRetryable(await failure(() => client.devices.identify({ externalId: 'u1', metadata: { big: 'x'.repeat(5000) } })))).toBe(false)
  })
})

// A module, not a script: ts-jest type-checks script files in one shared scope, where two of them declaring the same
// top-level name fail to compile.
export {};
