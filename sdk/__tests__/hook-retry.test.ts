/**
 * @jest-environment jsdom
 *
 * send-scale T38 (SCALE-27, SCALE-29): `register` and `identify` of the hooks are tried again when the failure can
 * pass, with the wait of the retry helper, and `isReady` turns true when `register` finally works.
 */
import { renderHook, act } from '@testing-library/react'
import { usePushNotifications, usePushIdentity } from '../src/hooks'
import { EspressoNotifyHttpError } from '../src/errors'

const mockRegister   = jest.fn()
const mockIdentify   = jest.fn()
const mockUnregister = jest.fn().mockResolvedValue({})
const mockDestroy    = jest.fn()

jest.mock('../src/index', () => ({
  PushClient: jest.fn().mockImplementation(() => ({
    devices: { register: mockRegister, identify: mockIdentify, unregister: mockUnregister },
    destroy: mockDestroy,
  })),
  resolvePushProvider: jest.fn(() => ({
    requestPermissions: async () => 'granted',
    getToken: async () => ({ token: 'ExponentPushToken[retry]', provider: 'expo' }),
  })),
}))
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }), { virtual: true })

const http = (status: number, retryAfter?: number) =>
  new EspressoNotifyHttpError(`HTTP ${status}`, status, undefined, '/v1/devices/register', retryAfter)
const network = () => Object.assign(new Error('[espresso-notify] register failed: offline'), { network: true })

beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  mockRegister.mockReset().mockResolvedValue({ success: true })
  mockIdentify.mockReset().mockResolvedValue({ success: true })
})
afterEach(() => jest.useRealTimers())

const flush = async (ms = 0) => { await act(async () => { await jest.advanceTimersByTimeAsync(ms) }) }

describe('register in the hook', () => {
  it('retries a 429 with Retry-After: 2 after 2 to 2.5 s, then succeeds and isReady is true', async () => {
    mockRegister.mockRejectedValueOnce(http(429, 2))
    const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test' }))

    await flush(1999)
    expect(mockRegister).toHaveBeenCalledTimes(1)
    expect(result.current.isReady).toBe(false)
    expect(result.current.error).toBeNull()

    await flush(501)
    expect(mockRegister).toHaveBeenCalledTimes(2)
    expect(result.current.isReady).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it('does not retry a 400: the error is set at once and the device is not ready', async () => {
    mockRegister.mockRejectedValue(http(400))
    const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test' }))

    await flush(60_000)
    expect(mockRegister).toHaveBeenCalledTimes(1)
    expect(result.current.isReady).toBe(false)
    expect(result.current.error).toMatchObject({ status: 400 })
  })

  it('ends with the error set after 6 failures of a server that stays down', async () => {
    mockRegister.mockRejectedValue(http(503))
    const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test' }))

    await flush(60_000)
    expect(mockRegister).toHaveBeenCalledTimes(6)
    expect(result.current.isReady).toBe(false)
    expect(result.current.error).toMatchObject({ status: 503 })
  })

  it('retries a failure of the transport and turns ready when it works', async () => {
    mockRegister.mockRejectedValueOnce(network()).mockRejectedValueOnce(network())
    const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test' }))

    await flush(10_000)
    expect(mockRegister).toHaveBeenCalledTimes(3)
    expect(result.current.isReady).toBe(true)
  })

  it('stops trying when the component unmounts', async () => {
    mockRegister.mockRejectedValue(http(503))
    const { unmount } = renderHook(() => usePushNotifications({ projectId: 'pk_test' }))
    await flush(0)
    expect(mockRegister).toHaveBeenCalledTimes(1)

    unmount()
    await flush(60_000)
    expect(mockRegister).toHaveBeenCalledTimes(1)
  })
})

describe('identify in the hooks', () => {
  it('usePushNotifications retries a 503 of identify', async () => {
    mockIdentify.mockRejectedValueOnce(http(503))
    const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test', externalId: 'u1' }))
    await flush(0)
    expect(result.current.isReady).toBe(true)
    await flush(0)
    expect(mockIdentify).toHaveBeenCalledTimes(1)

    await flush(1000) // the first back-off is at most 1 s
    expect(mockIdentify).toHaveBeenCalledTimes(2)
  })

  it('usePushNotifications does not retry a 4xx of identify', async () => {
    mockIdentify.mockRejectedValue(http(403))
    renderHook(() => usePushNotifications({ projectId: 'pk_test', externalId: 'u1' }))
    await flush(60_000)
    expect(mockIdentify).toHaveBeenCalledTimes(1)
  })

  it('usePushIdentity retries a 429 with Retry-After: 2 after 2 to 2.5 s', async () => {
    const client: any = { devices: { identify: mockIdentify, unregister: mockUnregister } }
    mockIdentify.mockRejectedValueOnce(http(429, 2))
    renderHook(() => usePushIdentity(client, 'u1'))

    await flush(1999)
    expect(mockIdentify).toHaveBeenCalledTimes(1)
    await flush(501)
    expect(mockIdentify).toHaveBeenCalledTimes(2)
  })
})
