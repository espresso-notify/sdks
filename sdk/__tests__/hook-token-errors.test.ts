/**
 * @jest-environment jsdom
 *
 * SDKFIX-03 (sdk-launch-fixes), hook side: the hook passes `expoProjectId` to
 * the provider and never registers without a push token.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { usePushNotifications } from '../src/hooks'
import { EspressoNotifyError, EXPO_PROJECT_ID_MISSING_MESSAGE } from '../src/errors'

const mockRegister = jest.fn().mockResolvedValue({ success: true })
const mockResolvePushProvider = jest.fn()
const MockPushClient = jest.fn().mockImplementation(() => ({
  devices: { register: mockRegister, identify: jest.fn(), unregister: jest.fn() },
  destroy: jest.fn(),
}))

jest.mock('../src/index', () => ({
  PushClient: function (...a: any[]) { return MockPushClient(...a) },
  resolvePushProvider: (...a: any[]) => mockResolvePushProvider(...a),
}))

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }), { virtual: true })

function provider(token: string | null, lastError: EspressoNotifyError | null = null) {
  return {
    requestPermissions: jest.fn().mockResolvedValue('granted'),
    getToken: jest.fn().mockResolvedValue(token ? { token, provider: 'expo' } : null),
    lastError,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockRegister.mockResolvedValue({ success: true })
})

it('passes expoProjectId to resolvePushProvider (AC 1)', async () => {
  mockResolvePushProvider.mockReturnValue(provider('ExponentPushToken[ok]'))
  const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test', expoProjectId: 'eas-123' }))
  await waitFor(() => expect(result.current.isReady).toBe(true))
  expect(mockResolvePushProvider).toHaveBeenCalledWith({ tokenStrategy: 'expo', expoProjectId: 'eas-123' })
  expect(mockRegister).toHaveBeenCalledTimes(1)
})

it('surfaces EXPO_PROJECT_ID_MISSING and does not register (AC 4, AC 5)', async () => {
  const missing = new EspressoNotifyError('EXPO_PROJECT_ID_MISSING', EXPO_PROJECT_ID_MISSING_MESSAGE)
  mockResolvePushProvider.mockReturnValue(provider(null, missing))
  const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test' }))
  await waitFor(() => expect(result.current.error).not.toBeNull())
  const err = result.current.error as EspressoNotifyError
  expect(err.code).toBe('EXPO_PROJECT_ID_MISSING')
  expect(err.message).toContain('expoProjectId')
  expect(err.message).toContain('extra.eas.projectId')
  expect(result.current.isReady).toBe(false)
  expect(result.current.pushToken).toBeNull()
  expect(MockPushClient).not.toHaveBeenCalled()
  expect(mockRegister).not.toHaveBeenCalled()
})

it('surfaces PUSH_TOKEN_UNAVAILABLE when the provider gives no token and no reason (AC 6)', async () => {
  mockResolvePushProvider.mockReturnValue(provider(null))
  const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test' }))
  await waitFor(() => expect(result.current.error).not.toBeNull())
  expect((result.current.error as EspressoNotifyError).code).toBe('PUSH_TOKEN_UNAVAILABLE')
  expect(result.current.isReady).toBe(false)
  expect(mockRegister).not.toHaveBeenCalled()
})

it('surfaces the provider reason for other token failures (AC 6)', async () => {
  const cause = new EspressoNotifyError('PUSH_TOKEN_UNAVAILABLE', '[espresso-notify] Could not get a push token: network down')
  mockResolvePushProvider.mockReturnValue(provider(null, cause))
  const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test' }))
  await waitFor(() => expect(result.current.error).not.toBeNull())
  expect(result.current.error).toBe(cause)
  expect(mockRegister).not.toHaveBeenCalled()
})

it('registers with an explicit pushToken without asking a provider (edge case)', async () => {
  const { result } = renderHook(() =>
    usePushNotifications({ projectId: 'pk_test', pushToken: 'ExponentPushToken[explicit]' }),
  )
  await waitFor(() => expect(result.current.isReady).toBe(true))
  expect(mockResolvePushProvider).not.toHaveBeenCalled()
  expect(MockPushClient).toHaveBeenCalledWith(expect.objectContaining({ pushToken: 'ExponentPushToken[explicit]' }))
  expect(mockRegister).toHaveBeenCalledTimes(1)
})
