/**
 * @jest-environment jsdom
 *
 * Focused tests for the PushProvider seam (#802 follow-up / #806 SDK-RN-6).
 *
 * Covers:
 * 1. ExpoPushProvider.getToken() returns { token, provider: 'expo' } (default)
 * 2. ExpoPushProvider with tokenStrategy:'device' → 'apns' on iOS, 'fcm' on Android
 * 3. ExpoPushProvider.requestPermissions() maps the expo-notifications status correctly
 * 4. usePushNotifications acquires a token + registers via the provider path when
 *    an injected provider is supplied
 */

// ─── Mocks ─────────────────────────────────────────────────────────────────────

// We need expo-notifications to be present for ExpoPushProvider to activate.
const mockRequestPermissionsAsync  = jest.fn().mockResolvedValue({ status: 'granted' })
const mockGetExpoPushTokenAsync    = jest.fn().mockResolvedValue({ data: 'ExponentPushToken[provider-test]' })
const mockGetDevicePushTokenAsync  = jest.fn().mockResolvedValue({ type: 'ios', data: 'apns-raw-token-abc' })

jest.mock('expo-notifications', () => ({
  requestPermissionsAsync:  (...args: any[]) => mockRequestPermissionsAsync(...args),
  getExpoPushTokenAsync:    (...args: any[]) => mockGetExpoPushTokenAsync(...args),
  getDevicePushTokenAsync:  (...args: any[]) => mockGetDevicePushTokenAsync(...args),
}), { virtual: true })

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}), { virtual: true })

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { ExpoPushProvider, resolvePushProvider } from '../src/index'

// ─── ExpoPushProvider unit tests ───────────────────────────────────────────────

describe('ExpoPushProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRequestPermissionsAsync.mockResolvedValue({ status: 'granted' })
    mockGetExpoPushTokenAsync.mockResolvedValue({ data: 'ExponentPushToken[provider-test]' })
    mockGetDevicePushTokenAsync.mockResolvedValue({ type: 'ios', data: 'apns-raw-token-abc' })
  })

  describe('getToken() — default strategy (expo)', () => {
    it('returns { token, provider: "expo" } when expo-notifications is available', async () => {
      const provider = new ExpoPushProvider()
      const result = await provider.getToken()

      expect(result).toEqual({
        token: 'ExponentPushToken[provider-test]',
        provider: 'expo',
      })
      expect(mockGetExpoPushTokenAsync).toHaveBeenCalledTimes(1)
      expect(mockGetDevicePushTokenAsync).not.toHaveBeenCalled()
    })

    it('returns null when getExpoPushTokenAsync throws', async () => {
      mockGetExpoPushTokenAsync.mockRejectedValueOnce(new Error('no token'))
      const provider = new ExpoPushProvider()
      const result = await provider.getToken()
      expect(result).toBeNull()
    })

    it('explicit tokenStrategy:"expo" behaves identically to the default', async () => {
      const provider = new ExpoPushProvider({ tokenStrategy: 'expo' })
      const result = await provider.getToken()
      expect(result).toEqual({ token: 'ExponentPushToken[provider-test]', provider: 'expo' })
      expect(mockGetExpoPushTokenAsync).toHaveBeenCalledTimes(1)
    })
  })

  describe('getToken() — device strategy', () => {
    it('returns { token, provider: "apns" } on iOS (type === "ios")', async () => {
      mockGetDevicePushTokenAsync.mockResolvedValueOnce({ type: 'ios', data: 'apns-token-xyz' })
      const provider = new ExpoPushProvider({ tokenStrategy: 'device' })
      const result = await provider.getToken()

      expect(result).toEqual({ token: 'apns-token-xyz', provider: 'apns' })
      expect(mockGetDevicePushTokenAsync).toHaveBeenCalledTimes(1)
      expect(mockGetExpoPushTokenAsync).not.toHaveBeenCalled()
    })

    it('returns { token, provider: "fcm" } on Android (type === "android")', async () => {
      mockGetDevicePushTokenAsync.mockResolvedValueOnce({ type: 'android', data: 'fcm-token-abc123' })
      const provider = new ExpoPushProvider({ tokenStrategy: 'device' })
      const result = await provider.getToken()

      expect(result).toEqual({ token: 'fcm-token-abc123', provider: 'fcm' })
      expect(mockGetDevicePushTokenAsync).toHaveBeenCalledTimes(1)
    })

    it('returns null when getDevicePushTokenAsync throws', async () => {
      mockGetDevicePushTokenAsync.mockRejectedValueOnce(new Error('device token unavailable'))
      const provider = new ExpoPushProvider({ tokenStrategy: 'device' })
      const result = await provider.getToken()
      expect(result).toBeNull()
    })
  })

  describe('requestPermissions()', () => {
    it('returns "granted" when permission is granted', async () => {
      mockRequestPermissionsAsync.mockResolvedValueOnce({ status: 'granted' })
      const provider = new ExpoPushProvider()
      const status = await provider.requestPermissions()
      expect(status).toBe('granted')
    })

    it('returns "denied" when permission is denied', async () => {
      mockRequestPermissionsAsync.mockResolvedValueOnce({ status: 'denied' })
      const provider = new ExpoPushProvider()
      const status = await provider.requestPermissions()
      expect(status).toBe('denied')
    })

    it('returns "undetermined" when status is undefined/null', async () => {
      mockRequestPermissionsAsync.mockResolvedValueOnce({ status: undefined })
      const provider = new ExpoPushProvider()
      const status = await provider.requestPermissions()
      expect(status).toBe('undetermined')
    })

    it('returns null when requestPermissionsAsync throws', async () => {
      mockRequestPermissionsAsync.mockRejectedValueOnce(new Error('no permission'))
      const provider = new ExpoPushProvider()
      const status = await provider.requestPermissions()
      expect(status).toBeNull()
    })
  })
})

describe('resolvePushProvider()', () => {
  it('returns an ExpoPushProvider instance when expo-notifications is available', () => {
    const provider = resolvePushProvider()
    expect(provider).toBeInstanceOf(ExpoPushProvider)
  })
})

// ─── Hook integration via injected provider ────────────────────────────────────

// We test that the hook acquires a token + calls register() via an injected
// provider, without relying on the module-level Notifications variable.
const mockRegister   = jest.fn().mockResolvedValue({ success: true })
const mockIdentify   = jest.fn().mockResolvedValue({ success: true })
const mockUnregister = jest.fn().mockResolvedValue({ success: true })
const mockDestroy    = jest.fn()

jest.mock('../src/index', () => {
  const actual = jest.requireActual('../src/index')
  return {
    ...actual,
    PushClient: jest.fn().mockImplementation(() => ({
      devices: {
        register:   mockRegister,
        identify:   mockIdentify,
        unregister: mockUnregister,
      },
      destroy: mockDestroy,
    })),
  }
})

import { renderHook, waitFor } from '@testing-library/react'
import { usePushNotifications } from '../src/hooks'
import type { PushProvider, PushProviderToken } from '../src/index'

describe('usePushNotifications with injected PushProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRegister.mockResolvedValue({ success: true })
  })

  it('acquires token via injected provider and calls register()', async () => {
    const fakeProvider: PushProvider = {
      requestPermissions: jest.fn().mockResolvedValue('granted'),
      getToken: jest.fn().mockResolvedValue({ token: 'ExponentPushToken[injected]', provider: 'expo' } as PushProviderToken),
    }

    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', provider: fakeProvider })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))

    expect(fakeProvider.requestPermissions).toHaveBeenCalledTimes(1)
    expect(fakeProvider.getToken).toHaveBeenCalledTimes(1)
    expect(mockRegister).toHaveBeenCalledTimes(1)
    expect(result.current.pushToken).toBe('ExponentPushToken[injected]')
    expect(result.current.permissionStatus).toBe('granted')
    expect(result.current.error).toBeNull()
  })

  it('sets error when injected provider returns permission denied', async () => {
    const fakeProvider: PushProvider = {
      requestPermissions: jest.fn().mockResolvedValue('denied'),
      getToken: jest.fn().mockResolvedValue(null),
    }

    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', provider: fakeProvider })
    )

    await waitFor(() => expect(result.current.error).not.toBeNull())

    expect(result.current.isReady).toBe(false)
    expect(result.current.error?.message).toContain('denied')
    expect(result.current.permissionStatus).toBe('denied')
    expect(mockRegister).not.toHaveBeenCalled()
  })

  it('skips requestPermissions when autoRequestPermission=false', async () => {
    const fakeProvider: PushProvider = {
      requestPermissions: jest.fn().mockResolvedValue('granted'),
      getToken: jest.fn().mockResolvedValue({ token: 'ExponentPushToken[noperm]', provider: 'expo' } as PushProviderToken),
    }

    const { result } = renderHook(() =>
      usePushNotifications({
        projectId: 'pk_test',
        provider: fakeProvider,
        autoRequestPermission: false,
      })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))

    expect(fakeProvider.requestPermissions).not.toHaveBeenCalled()
    expect(fakeProvider.getToken).toHaveBeenCalledTimes(1)
    expect(mockRegister).toHaveBeenCalledTimes(1)
  })
})
