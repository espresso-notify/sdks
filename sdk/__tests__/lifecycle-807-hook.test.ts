/**
 * @jest-environment jsdom
 *
 * Hook wiring tests for #807 (SDK-RN-7) lifecycle observers.
 *
 * This file is separate from lifecycle-807.test.ts because that file uses
 * jest.resetModules() + jest.doMock() per describe block, which conflicts
 * with the module-level jest.mock() hoisting used here for the hook tests.
 *
 * Tests:
 * 1. Token refresh callback → register() + recordLifecycle('subscription')
 * 2. AppState active → getPermissionStatus() → recordLifecycle('permission')
 * 3. Cleanup on unmount (token unsub + AppState unsub)
 * 4. Optional method guards (no crash when onTokenRefresh / getPermissionStatus absent)
 */

import { renderHook, act, waitFor } from '@testing-library/react'
import { usePushNotifications } from '../src/hooks'

// ─── Mock PushClient with recordLifecycle ─────────────────────────────────────
const mockRegister        = jest.fn().mockResolvedValue({ success: true })
const mockIdentify        = jest.fn().mockResolvedValue({ success: true })
const mockUnregister      = jest.fn().mockResolvedValue({ success: true })
const mockDestroy         = jest.fn()
const mockRecordLifecycle = jest.fn().mockResolvedValue(undefined)

let _clientPushToken: string | undefined
let _clientProvider: string | undefined

jest.mock('../src/index', () => ({
  PushClient: jest.fn().mockImplementation((config: any) => {
    _clientPushToken = config.pushToken
    _clientProvider  = config.provider
    return {
      get pushToken() { return _clientPushToken },
      set pushToken(v: string | undefined) { _clientPushToken = v },
      get provider() { return _clientProvider },
      set provider(v: string | undefined) { _clientProvider = v },
      devices: {
        register:         mockRegister,
        identify:         mockIdentify,
        unregister:       mockUnregister,
        recordLifecycle:  mockRecordLifecycle,
      },
      destroy: mockDestroy,
    }
  }),
  resolvePushProvider: jest.fn(() => null),
}))

// ─── AppState mock ─────────────────────────────────────────────────────────────
// We track listeners so we can fire foreground/background transitions manually.
let _appStateListeners: Array<{ cb: (state: string) => void; remove: jest.Mock }> = []
let _appStateCurrentState = 'background'

const mockAddEventListener = jest.fn((_event: string, cb: (state: string) => void) => {
  const removeMock = jest.fn(() => {
    _appStateListeners = _appStateListeners.filter(l => l.cb !== cb)
  })
  _appStateListeners.push({ cb, remove: removeMock })
  return { remove: removeMock }
})

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: {
    get currentState() { return _appStateCurrentState },
    addEventListener: (event: string, cb: (state: string) => void) =>
      mockAddEventListener(event, cb),
  },
}), { virtual: true })

function fireAppState(nextState: string) {
  _appStateCurrentState = nextState
  _appStateListeners.forEach(l => l.cb(nextState))
}

// ─── Setup ─────────────────────────────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks()
  _appStateListeners = []
  _appStateCurrentState = 'background'
  _clientPushToken = undefined
  _clientProvider  = undefined
  mockRegister.mockResolvedValue({ success: true })
  mockRecordLifecycle.mockResolvedValue(undefined)
})

// ═══════════════════════════════════════════════════════════════════════════════
// Token refresh wiring
// ═══════════════════════════════════════════════════════════════════════════════

describe('usePushNotifications — token refresh lifecycle wiring (#807)', () => {
  it('calls register() + recordLifecycle("subscription") when token rotates', async () => {
    let capturedRefreshCb: ((tok: any) => void) | null = null
    const mockOnTokenRefresh = jest.fn((cb: (tok: any) => void) => {
      capturedRefreshCb = cb
      return jest.fn() // unsubscribe
    })

    const fakeProvider = {
      requestPermissions: jest.fn().mockResolvedValue('granted'),
      getToken: jest.fn().mockResolvedValue({ token: 'ExponentPushToken[original]', provider: 'expo' }),
      onTokenRefresh: mockOnTokenRefresh,
      getPermissionStatus: jest.fn().mockResolvedValue('granted'),
    }

    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', provider: fakeProvider as any })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))

    // onTokenRefresh should have been subscribed during init
    expect(mockOnTokenRefresh).toHaveBeenCalledTimes(1)

    // Simulate a token rotation
    await act(async () => {
      capturedRefreshCb!({ token: 'ExponentPushToken[rotated]', provider: 'expo' })
    })

    // Hook state should update
    expect(result.current.pushToken).toBe('ExponentPushToken[rotated]')

    // Client token should be updated
    expect(_clientPushToken).toBe('ExponentPushToken[rotated]')

    // register() called twice: once at init, once at token refresh
    expect(mockRegister).toHaveBeenCalledTimes(2)

    // recordLifecycle called for subscription
    expect(mockRecordLifecycle).toHaveBeenCalledWith(
      'subscription',
      'ExponentPushToken[original]',
      'ExponentPushToken[rotated]',
    )
  })

  it('does not fire on same token (deduplication guard)', async () => {
    let capturedRefreshCb: ((tok: any) => void) | null = null

    const fakeProvider = {
      requestPermissions: jest.fn().mockResolvedValue('granted'),
      getToken: jest.fn().mockResolvedValue({ token: 'ExponentPushToken[same]', provider: 'expo' }),
      onTokenRefresh: jest.fn((cb: (tok: any) => void) => {
        capturedRefreshCb = cb
        return jest.fn()
      }),
      getPermissionStatus: jest.fn().mockResolvedValue('granted'),
    }

    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', provider: fakeProvider as any })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))

    await act(async () => {
      capturedRefreshCb!({ token: 'ExponentPushToken[same]', provider: 'expo' })
    })

    // register should only have been called once (init), not again
    expect(mockRegister).toHaveBeenCalledTimes(1)
    expect(mockRecordLifecycle).not.toHaveBeenCalled()
  })

  it('cleans up onTokenRefresh subscription on unmount', async () => {
    const mockUnsub = jest.fn()

    const fakeProvider = {
      requestPermissions: jest.fn().mockResolvedValue('granted'),
      getToken: jest.fn().mockResolvedValue({ token: 'tok-unmount', provider: 'expo' }),
      onTokenRefresh: jest.fn(() => mockUnsub),
      getPermissionStatus: jest.fn().mockResolvedValue('granted'),
    }

    const { result, unmount } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', provider: fakeProvider as any })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))

    act(() => { unmount() })

    expect(mockDestroy).toHaveBeenCalledTimes(1)
    expect(mockUnsub).toHaveBeenCalledTimes(1)
  })

  it('does not crash when provider lacks onTokenRefresh (optional method)', async () => {
    const fakeProvider = {
      requestPermissions: jest.fn().mockResolvedValue('granted'),
      getToken: jest.fn().mockResolvedValue({ token: 'tok-no-refresh', provider: 'expo' }),
      // onTokenRefresh intentionally absent
      getPermissionStatus: jest.fn().mockResolvedValue('granted'),
    }

    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', provider: fakeProvider as any })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(result.current.error).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Permission re-check via AppState
// ═══════════════════════════════════════════════════════════════════════════════

describe('usePushNotifications — permission re-check via AppState (#807)', () => {
  it('calls recordLifecycle("permission") when permission changes on foreground transition', async () => {
    // Track calls — first call (for safety) returns 'granted', subsequent ones 'denied'
    const mockGetPermissionStatus = jest.fn().mockResolvedValue('denied')

    const fakeProvider = {
      requestPermissions: jest.fn().mockResolvedValue('granted'),
      getToken: jest.fn().mockResolvedValue({ token: 'tok-perm', provider: 'expo' }),
      onTokenRefresh: jest.fn(() => jest.fn()),
      getPermissionStatus: mockGetPermissionStatus,
    }

    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', provider: fakeProvider as any })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))
    // After init, permissionStatus is 'granted' (set by the init flow)

    // AppState fires: background → active
    await act(async () => {
      fireAppState('background')
      fireAppState('active')
    })

    // Wait for the async getPermissionStatus + recordLifecycle to settle
    await waitFor(() => expect(mockRecordLifecycle).toHaveBeenCalled())

    expect(mockRecordLifecycle).toHaveBeenCalledWith(
      'permission',
      'granted',
      'denied',
    )
    expect(result.current.permissionStatus).toBe('denied')
  })

  it('does NOT call recordLifecycle when permission is unchanged', async () => {
    const mockGetPermissionStatus = jest.fn().mockResolvedValue('granted')

    const fakeProvider = {
      requestPermissions: jest.fn().mockResolvedValue('granted'),
      getToken: jest.fn().mockResolvedValue({ token: 'tok-same-perm', provider: 'expo' }),
      onTokenRefresh: jest.fn(() => jest.fn()),
      getPermissionStatus: mockGetPermissionStatus,
    }

    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', provider: fakeProvider as any })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))

    await act(async () => {
      fireAppState('background')
      fireAppState('active')
    })

    // Give async ops time to settle
    await new Promise(r => setTimeout(r, 50))

    // Same status → no lifecycle record
    expect(mockRecordLifecycle).not.toHaveBeenCalled()
  })

  it('cleans up AppState subscription on unmount', async () => {
    const fakeProvider = {
      requestPermissions: jest.fn().mockResolvedValue('granted'),
      getToken: jest.fn().mockResolvedValue({ token: 'tok-cleanup', provider: 'expo' }),
      onTokenRefresh: jest.fn(() => jest.fn()),
      getPermissionStatus: jest.fn().mockResolvedValue('granted'),
    }

    const { result, unmount } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', provider: fakeProvider as any })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))

    const countBefore = _appStateListeners.length
    expect(countBefore).toBeGreaterThan(0)

    act(() => { unmount() })

    // remove() on the subscription drains _appStateListeners
    expect(_appStateListeners.length).toBe(0)
  })

  it('does not crash when provider lacks getPermissionStatus (optional method)', async () => {
    const fakeProvider = {
      requestPermissions: jest.fn().mockResolvedValue('granted'),
      getToken: jest.fn().mockResolvedValue({ token: 'tok-no-perm-check', provider: 'expo' }),
      // getPermissionStatus intentionally absent
    }

    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', provider: fakeProvider as any })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))

    // Trigger AppState foreground — should not crash
    await act(async () => {
      fireAppState('background')
      fireAppState('active')
    })

    expect(result.current.error).toBeNull()
    expect(mockRecordLifecycle).not.toHaveBeenCalled()
  })
})
