/**
 * @jest-environment jsdom
 *
 * Tests for usePushNotifications and usePushIdentity hooks.
 *
 * Mocking strategy:
 * - PushClient is mocked so no real HTTP requests are made
 * - expo-notifications is mocked to return a fake token
 * - react-native is mocked so Platform.OS is controllable
 * - renderHook from @testing-library/react drives useEffect
 */

import { renderHook, act, waitFor } from '@testing-library/react'
import { usePushNotifications, usePushIdentity } from '../src/hooks'

// ─── Mock PushClient ─────────────────────────────────────────────────────────
const mockRegister   = jest.fn().mockResolvedValue({ success: true })
const mockIdentify   = jest.fn().mockResolvedValue({ success: true })
const mockUnregister = jest.fn().mockResolvedValue({ success: true })
const mockDestroy    = jest.fn()

jest.mock('../src/index', () => ({
  PushClient: jest.fn().mockImplementation(() => ({
    devices: {
      register:   mockRegister,
      identify:   mockIdentify,
      unregister: mockUnregister,
    },
    destroy: mockDestroy,
  })),
  resolvePushProvider: jest.fn(() => ({
    requestPermissions: (...args: any[]) => mockRequestPermissions(...args).then((r: any) => r.status ?? 'undetermined'),
    getToken: (...args: any[]) => mockGetExpoPushToken(...args).then((r: any) => ({ token: r.data, provider: 'expo' })),
  })),
}))

// ─── Mock expo-notifications ──────────────────────────────────────────────────
const mockRequestPermissions = jest.fn().mockResolvedValue({ status: 'granted' })
const mockGetExpoPushToken   = jest.fn().mockResolvedValue({ data: 'ExponentPushToken[test123]' })

jest.mock('expo-notifications', () => ({
  requestPermissionsAsync: (...args: any[]) => mockRequestPermissions(...args),
  getExpoPushTokenAsync:   (...args: any[]) => mockGetExpoPushToken(...args),
}), { virtual: true })

// ─── Mock react-native ────────────────────────────────────────────────────────
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}), { virtual: true })

// ─── Setup ────────────────────────────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks()
  mockRequestPermissions.mockResolvedValue({ status: 'granted' })
  mockGetExpoPushToken.mockResolvedValue({ data: 'ExponentPushToken[test123]' })
  mockRegister.mockResolvedValue({ success: true })
  mockIdentify.mockResolvedValue({ success: true })
  mockUnregister.mockResolvedValue({ success: true })
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('usePushNotifications', () => {
  it('registers device on mount (anonymous — no externalId)', async () => {
    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test' })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))

    expect(mockRequestPermissions).toHaveBeenCalledTimes(1)
    expect(mockGetExpoPushToken).toHaveBeenCalledTimes(1)
    expect(mockRegister).toHaveBeenCalledTimes(1)
    expect(mockIdentify).not.toHaveBeenCalled()
    expect(mockUnregister).not.toHaveBeenCalled()
    expect(result.current.pushToken).toBe('ExponentPushToken[test123]')
    expect(result.current.permissionStatus).toBe('granted')
    expect(result.current.error).toBeNull()
  })

  it('identifies user on first mount when externalId is already set', async () => {
    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', externalId: 'u1' })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))

    expect(mockIdentify).toHaveBeenCalledWith(
      { externalId: 'u1' },
      'ExponentPushToken[test123]'
    )
    expect(mockUnregister).not.toHaveBeenCalled()
  })

  it('identifies user when externalId changes from null to value', async () => {
    let externalId: string | null = null
    const { result, rerender } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', externalId })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(mockIdentify).not.toHaveBeenCalled()

    externalId = 'u1'
    rerender()

    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))
    expect(mockIdentify).toHaveBeenCalledWith(
      { externalId: 'u1' },
      'ExponentPushToken[test123]'
    )
  })

  it('unregisters when externalId changes from value to null', async () => {
    let externalId: string | null = 'u1'
    const { result, rerender } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', externalId })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))

    externalId = null
    rerender()

    await waitFor(() => expect(mockUnregister).toHaveBeenCalledTimes(1))
    expect(mockUnregister).toHaveBeenCalledWith('ExponentPushToken[test123]')
  })

  it('does NOT unregister on anonymous mount (externalId stays null)', async () => {
    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', externalId: null })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))

    expect(mockUnregister).not.toHaveBeenCalled()
    expect(mockIdentify).not.toHaveBeenCalled()
  })

  it('handles account switch (u1 → u2): identifies u2 without unregistering', async () => {
    let externalId: string | null = 'u1'
    const { result, rerender } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', externalId })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledWith(
      { externalId: 'u1' }, expect.any(String)
    ))

    externalId = 'u2'
    rerender()

    await waitFor(() => expect(mockIdentify).toHaveBeenCalledWith(
      { externalId: 'u2' }, expect.any(String)
    ))
    expect(mockUnregister).not.toHaveBeenCalled()
  })

  it('sets error when permission is denied', async () => {
    mockRequestPermissions.mockResolvedValueOnce({ status: 'denied' })

    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test' })
    )

    await waitFor(() => expect(result.current.error).not.toBeNull())

    expect(result.current.isReady).toBe(false)
    expect(result.current.error?.message).toContain('denied')
    expect(result.current.permissionStatus).toBe('denied')
    expect(mockRegister).not.toHaveBeenCalled()
  })

  it('uses provided pushToken and platform, skips auto-acquisition', async () => {
    const { result } = renderHook(() =>
      usePushNotifications({
        projectId:  'pk_test',
        pushToken:  'ExponentPushToken[manual]',
        platform:   'android',
      })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))

    expect(mockRequestPermissions).not.toHaveBeenCalled()
    expect(mockGetExpoPushToken).not.toHaveBeenCalled()
    expect(result.current.pushToken).toBe('ExponentPushToken[manual]')

    const { PushClient } = jest.requireMock('../src/index')
    expect(PushClient).toHaveBeenCalledWith(expect.objectContaining({
      pushToken: 'ExponentPushToken[manual]',
      platform:  'android',
    }))
  })

  it('calls destroy() on unmount', async () => {
    const { result, unmount } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test' })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))

    act(() => { unmount() })

    expect(mockDestroy).toHaveBeenCalledTimes(1)
  })

  it('passes metadata to register()', async () => {
    const meta = { plan: 'premium', locale: 'pt-BR' }
    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', metadata: meta })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))

    expect(mockRegister).toHaveBeenCalledWith({ metadata: meta })
  })

  it('passes userName to identify()', async () => {
    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', externalId: 'u1', userName: 'Alice' })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))

    expect(mockIdentify).toHaveBeenCalledWith(
      { externalId: 'u1', name: 'Alice' },
      'ExponentPushToken[test123]'
    )
  })

  it('re-identifies when userName changes (same externalId)', async () => {
    let userName: string | null = 'Alice'
    const { result, rerender } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', externalId: 'u1', userName })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))

    userName = 'Alice Updated'
    rerender()

    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(2))
    expect(mockIdentify).toHaveBeenLastCalledWith(
      { externalId: 'u1', name: 'Alice Updated' },
      'ExponentPushToken[test123]'
    )
    expect(mockUnregister).not.toHaveBeenCalled()
  })
})

// ─── usePushIdentity ──────────────────────────────────────────────────────────

describe('usePushIdentity', () => {
  it('full lifecycle: identify → unregister → identify again', async () => {
    const { PushClient } = jest.requireMock('../src/index')
    const client = new PushClient({ projectId: 'pk_test' })

    let externalId: string | null = null
    const { rerender } = renderHook(() => usePushIdentity(client, externalId))

    // Anonymous mount — no calls
    expect(mockIdentify).not.toHaveBeenCalled()
    expect(mockUnregister).not.toHaveBeenCalled()

    // Login
    externalId = 'u1'
    rerender()
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledWith({ externalId: 'u1' }))

    // Logout
    externalId = null
    rerender()
    await waitFor(() => expect(mockUnregister).toHaveBeenCalledTimes(1))

    // Re-login (same user)
    externalId = 'u1'
    rerender()
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(2))
  })

  it('does nothing when client is null', () => {
    renderHook(() => usePushIdentity(null, 'u1'))
    expect(mockIdentify).not.toHaveBeenCalled()
  })
})
