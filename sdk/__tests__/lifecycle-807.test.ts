/**
 * @jest-environment jsdom
 *
 * Tests for #807 (SDK-RN-7) lifecycle observers:
 *   - ExpoPushProvider.onTokenRefresh + getPermissionStatus
 *   - BareProvider.onTokenRefresh + getPermissionStatus
 *   - Devices.recordLifecycle
 *   - Hook wiring: token-refresh re-registers + records 'subscription' lifecycle
 *   - Hook wiring: AppState foreground transition records 'permission' lifecycle
 *
 * The provider-unit and Devices tests use jest.resetModules() + jest.doMock()
 * per describe block (same pattern as bare-provider.test.ts / dependency.test.ts).
 *
 * The hook-wiring tests are in a separate file (lifecycle-807-hook.test.ts) to
 * avoid the module-level jest.mock() hoisting conflicting with the resetModules
 * pattern used in the provider tests above.
 */

// ─── Shared fetch mock ────────────────────────────────────────────────────────
const mockFetch = jest.fn()
globalThis.fetch = mockFetch as any

/** Lets the promises that the code under test started run to the end. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function okFetch(body: unknown = {}) {
  return {
    ok: true,
    text: () => Promise.resolve(JSON.stringify(body)),
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ExpoPushProvider — onTokenRefresh
// ═══════════════════════════════════════════════════════════════════════════════

describe('ExpoPushProvider.onTokenRefresh()', () => {
  beforeEach(() => jest.resetModules())

  // SSF-01.1: expo-notifications delivers the raw DEVICE token (FCM or APNs) in this event, never an Expo token
  // (see expo-notifications/build/TokenEmitter.d.ts: `DevicePushToken = { type, data }`). In the default mode the SDK
  // asks Expo for the Expo token again and hands that one to the hook.
  it('asks Expo for the token again on the device-token event and fires cb with the Expo token (default strategy)', async () => {
    let capturedCb: ((t: any) => void) | null = null
    const mockRemove = jest.fn()
    const mockAddPushTokenListener = jest.fn((cb: (t: any) => void) => {
      capturedCb = cb
      return { remove: mockRemove }
    })
    const getExpoPushTokenAsync = jest.fn().mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[rotated]' })

    jest.doMock('expo-notifications', () => ({
      requestPermissionsAsync: jest.fn(),
      getExpoPushTokenAsync,
      addPushTokenListener: mockAddPushTokenListener,
    }), { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios' } }), { virtual: true })

    const { ExpoPushProvider } = require('../src/index')
    const provider = new ExpoPushProvider({ expoProjectId: 'eas-project' })

    const cb = jest.fn()
    const unsub = provider.onTokenRefresh(cb)

    expect(mockAddPushTokenListener).toHaveBeenCalledTimes(1)

    // The real event shape: the token of the device, here an APNs token
    capturedCb!({ type: 'ios', data: 'a1b2c3d4-apns-device-token' })
    await flush()

    expect(getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'eas-project' })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith({ token: 'ExponentPushToken[rotated]', provider: 'expo' })
    expect(JSON.stringify(cb.mock.calls)).not.toContain('apns-device-token')

    // Unsubscribe calls remove()
    unsub()
    expect(mockRemove).toHaveBeenCalledTimes(1)
  })

  describe('in the default strategy, when the Expo token has not changed or cannot be had (SSF-01.2, SSF-01.3, SSF-01.5)', () => {
    function setup(getExpoPushTokenAsync: jest.Mock, options: Record<string, unknown> = { expoProjectId: 'eas-project' }) {
      let capturedCb: ((t: any) => void) | null = null
      const remove = jest.fn()
      jest.doMock('expo-notifications', () => ({
        requestPermissionsAsync: jest.fn(),
        getExpoPushTokenAsync,
        addPushTokenListener: (cb: (t: any) => void) => { capturedCb = cb; return { remove } },
      }), { virtual: true })
      jest.doMock('react-native', () => ({ Platform: { OS: 'android' } }), { virtual: true })
      const { ExpoPushProvider } = require('../src/index')
      const provider = new ExpoPushProvider(options)
      const cb = jest.fn()
      const unsub = provider.onTokenRefresh(cb)
      return { provider, cb, unsub, emit: (t: any) => capturedCb!(t) }
    }

    it('does not fire cb when the Expo token is the one getToken() returned', async () => {
      const get = jest.fn().mockResolvedValue({ data: 'ExponentPushToken[same]' })
      const { provider, cb, emit } = setup(get)
      await provider.getToken()

      emit({ type: 'android', data: 'fcm-device-token-rotated' })
      await flush()

      expect(get).toHaveBeenCalledTimes(2)
      expect(cb).not.toHaveBeenCalled()
    })

    it('fires cb once for two events that end in the same new Expo token', async () => {
      const get = jest.fn().mockResolvedValue({ data: 'ExponentPushToken[new]' })
      const { cb, emit } = setup(get)

      emit({ type: 'android', data: 'fcm-1' })
      emit({ type: 'android', data: 'fcm-2' })
      await flush()

      expect(cb).toHaveBeenCalledTimes(1)
      expect(cb).toHaveBeenCalledWith({ token: 'ExponentPushToken[new]', provider: 'expo' })
    })

    it('does not fire cb, and does not throw, when getExpoPushTokenAsync rejects', async () => {
      const get = jest.fn().mockRejectedValue(new Error('network down'))
      const { cb, emit } = setup(get)

      expect(() => emit({ type: 'android', data: 'fcm-1' })).not.toThrow()
      await flush()

      expect(get).toHaveBeenCalledTimes(1)
      expect(cb).not.toHaveBeenCalled()
    })

    it('does not fire cb when the EAS project id cannot be resolved', async () => {
      jest.doMock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }), { virtual: true })
      const get = jest.fn().mockResolvedValue({ data: 'ExponentPushToken[x]' })
      const { cb, emit } = setup(get, {})

      emit({ type: 'android', data: 'fcm-1' })
      await flush()

      expect(get).not.toHaveBeenCalled()
      expect(cb).not.toHaveBeenCalled()
    })

    it('does not deliver a token whose request was still running when the app unsubscribed', async () => {
      let resolveToken!: (v: any) => void
      const get = jest.fn(() => new Promise((resolve) => { resolveToken = resolve }))
      const { cb, unsub, emit } = setup(get)

      emit({ type: 'android', data: 'fcm-1' })
      unsub()
      resolveToken({ data: 'ExponentPushToken[late]' })
      await flush()

      expect(cb).not.toHaveBeenCalled()
    })
  })

  it('fires cb with provider:"apns" on iOS when tokenStrategy is "device"', () => {
    let capturedCb: ((t: any) => void) | null = null
    const mockAddPushTokenListener = jest.fn((cb: (t: any) => void) => {
      capturedCb = cb
      return { remove: jest.fn() }
    })

    jest.doMock('expo-notifications', () => ({
      requestPermissionsAsync: jest.fn(),
      getDevicePushTokenAsync: jest.fn(),
      addPushTokenListener: mockAddPushTokenListener,
    }), { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios' } }), { virtual: true })

    const { ExpoPushProvider } = require('../src/index')
    const provider = new ExpoPushProvider({ tokenStrategy: 'device' })

    const cb = jest.fn()
    provider.onTokenRefresh(cb)

    capturedCb!({ data: 'apns-rotated-token', type: 'ios' })
    expect(cb).toHaveBeenCalledWith({ token: 'apns-rotated-token', provider: 'apns' })
  })

  it('fires cb with provider:"fcm" on Android when tokenStrategy is "device"', () => {
    let capturedCb: ((t: any) => void) | null = null
    const mockAddPushTokenListener = jest.fn((cb: (t: any) => void) => {
      capturedCb = cb
      return { remove: jest.fn() }
    })

    jest.doMock('expo-notifications', () => ({
      requestPermissionsAsync: jest.fn(),
      getDevicePushTokenAsync: jest.fn(),
      addPushTokenListener: mockAddPushTokenListener,
    }), { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'android' } }), { virtual: true })

    const { ExpoPushProvider } = require('../src/index')
    const provider = new ExpoPushProvider({ tokenStrategy: 'device' })

    const cb = jest.fn()
    provider.onTokenRefresh(cb)

    capturedCb!({ data: 'fcm-rotated-token', type: 'android' })
    expect(cb).toHaveBeenCalledWith({ token: 'fcm-rotated-token', provider: 'fcm' })
  })

  it('returns a no-op unsubscribe when addPushTokenListener is absent', () => {
    jest.doMock('expo-notifications', () => ({
      requestPermissionsAsync: jest.fn(),
      getExpoPushTokenAsync: jest.fn(),
      // addPushTokenListener intentionally absent
    }), { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios' } }), { virtual: true })

    const { ExpoPushProvider } = require('../src/index')
    const provider = new ExpoPushProvider()
    const cb = jest.fn()
    const unsub = provider.onTokenRefresh(cb)
    expect(() => unsub()).not.toThrow()
    expect(cb).not.toHaveBeenCalled()
  })

  it('returns a no-op unsubscribe when addPushTokenListener throws', () => {
    jest.doMock('expo-notifications', () => ({
      requestPermissionsAsync: jest.fn(),
      getExpoPushTokenAsync: jest.fn(),
      addPushTokenListener: () => { throw new Error('boom') },
    }), { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios' } }), { virtual: true })

    const { ExpoPushProvider } = require('../src/index')
    const provider = new ExpoPushProvider()
    const unsub = provider.onTokenRefresh(jest.fn())
    expect(() => unsub()).not.toThrow()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ExpoPushProvider — getPermissionStatus
// ═══════════════════════════════════════════════════════════════════════════════

describe('ExpoPushProvider.getPermissionStatus()', () => {
  beforeEach(() => jest.resetModules())

  it('maps "granted" status → "granted"', async () => {
    jest.doMock('expo-notifications', () => ({
      requestPermissionsAsync: jest.fn(),
      getExpoPushTokenAsync: jest.fn(),
      getPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
    }), { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios' } }), { virtual: true })

    const { ExpoPushProvider } = require('../src/index')
    const status = await new ExpoPushProvider().getPermissionStatus()
    expect(status).toBe('granted')
  })

  it('maps "denied" status → "denied"', async () => {
    jest.doMock('expo-notifications', () => ({
      requestPermissionsAsync: jest.fn(),
      getExpoPushTokenAsync: jest.fn(),
      getPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
    }), { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios' } }), { virtual: true })

    const { ExpoPushProvider } = require('../src/index')
    const status = await new ExpoPushProvider().getPermissionStatus()
    expect(status).toBe('denied')
  })

  it('maps undefined status → "undetermined"', async () => {
    jest.doMock('expo-notifications', () => ({
      requestPermissionsAsync: jest.fn(),
      getExpoPushTokenAsync: jest.fn(),
      getPermissionsAsync: jest.fn().mockResolvedValue({ status: undefined }),
    }), { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios' } }), { virtual: true })

    const { ExpoPushProvider } = require('../src/index')
    const status = await new ExpoPushProvider().getPermissionStatus()
    expect(status).toBe('undetermined')
  })

  it('returns null when getPermissionsAsync throws', async () => {
    jest.doMock('expo-notifications', () => ({
      requestPermissionsAsync: jest.fn(),
      getExpoPushTokenAsync: jest.fn(),
      getPermissionsAsync: jest.fn().mockRejectedValue(new Error('no perms')),
    }), { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios' } }), { virtual: true })

    const { ExpoPushProvider } = require('../src/index')
    const status = await new ExpoPushProvider().getPermissionStatus()
    expect(status).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// BareProvider — onTokenRefresh
// ═══════════════════════════════════════════════════════════════════════════════

function makeFirebaseMock(instanceOverrides: Record<string, any> = {}) {
  const instance = {
    getToken: jest.fn().mockResolvedValue('fcm-token'),
    requestPermission: jest.fn().mockResolvedValue(1),
    hasPermission: jest.fn().mockResolvedValue(1),
    onTokenRefresh: jest.fn().mockReturnValue(jest.fn()),
    ...instanceOverrides,
  }
  const messagingFn: any = jest.fn().mockReturnValue(instance)
  messagingFn.AuthorizationStatus = {
    AUTHORIZED: 1, PROVISIONAL: 2, DENIED: 0, NOT_DETERMINED: -1,
  }
  return { default: messagingFn, _instance: instance, _fn: messagingFn }
}

describe('BareProvider.onTokenRefresh()', () => {
  beforeEach(() => jest.resetModules())

  it('fires cb with { token, provider:"fcm" } when messaging().onTokenRefresh fires', () => {
    let capturedCb: ((token: string) => void) | null = null
    const mockUnsubscribe = jest.fn()
    const fbMock = makeFirebaseMock({
      onTokenRefresh: jest.fn((cb: (token: string) => void) => {
        capturedCb = cb
        return mockUnsubscribe
      }),
    })

    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'android', Version: 30 } }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const provider = new BareProvider()

    const cb = jest.fn()
    const unsub = provider.onTokenRefresh(cb)

    // Simulate FCM token rotation
    capturedCb!('new-fcm-token-xyz')

    expect(cb).toHaveBeenCalledWith({ token: 'new-fcm-token-xyz', provider: 'fcm' })

    // Unsubscribe
    unsub()
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1)
  })

  it('returns a no-op unsubscribe when FirebaseMessaging is absent', () => {
    jest.doMock('@react-native-firebase/messaging', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'android', Version: 30 } }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const provider = new BareProvider()
    const unsub = provider.onTokenRefresh(jest.fn())
    expect(() => unsub()).not.toThrow()
  })

  it('returns a no-op unsubscribe when onTokenRefresh throws', () => {
    const fbMock = makeFirebaseMock({
      onTokenRefresh: () => { throw new Error('boom') },
    })
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'android', Version: 30 } }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const provider = new BareProvider()
    const unsub = provider.onTokenRefresh(jest.fn())
    expect(() => unsub()).not.toThrow()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// BareProvider — getPermissionStatus
// ═══════════════════════════════════════════════════════════════════════════════

describe('BareProvider.getPermissionStatus() — iOS', () => {
  beforeEach(() => jest.resetModules())

  it('maps AUTHORIZED (1) → "granted"', async () => {
    const fbMock = makeFirebaseMock({ hasPermission: jest.fn().mockResolvedValue(1) })
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: '17.0' } }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const status = await new BareProvider().getPermissionStatus()
    expect(status).toBe('granted')
  })

  it('maps PROVISIONAL (2) → "granted"', async () => {
    const fbMock = makeFirebaseMock({ hasPermission: jest.fn().mockResolvedValue(2) })
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: '17.0' } }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const status = await new BareProvider().getPermissionStatus()
    expect(status).toBe('granted')
  })

  it('maps DENIED (0) → "denied"', async () => {
    const fbMock = makeFirebaseMock({ hasPermission: jest.fn().mockResolvedValue(0) })
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: '17.0' } }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const status = await new BareProvider().getPermissionStatus()
    expect(status).toBe('denied')
  })

  it('maps NOT_DETERMINED (-1) → "undetermined"', async () => {
    const fbMock = makeFirebaseMock({ hasPermission: jest.fn().mockResolvedValue(-1) })
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: '17.0' } }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const status = await new BareProvider().getPermissionStatus()
    expect(status).toBe('undetermined')
  })

  it('returns null when hasPermission() throws', async () => {
    const fbMock = makeFirebaseMock({ hasPermission: jest.fn().mockRejectedValue(new Error('err')) })
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: '17.0' } }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const status = await new BareProvider().getPermissionStatus()
    expect(status).toBeNull()
  })
})

describe('BareProvider.getPermissionStatus() — Android', () => {
  beforeEach(() => jest.resetModules())

  it('Android < 13: returns "granted" without calling PermissionsAndroid.check()', async () => {
    const fbMock = makeFirebaseMock()
    const mockCheck = jest.fn()
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({
      Platform: { OS: 'android', Version: 30 },
      PermissionsAndroid: {
        check: mockCheck,
        PERMISSIONS: { POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS' },
        RESULTS: { GRANTED: 'granted' },
      },
    }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const status = await new BareProvider().getPermissionStatus()
    expect(status).toBe('granted')
    expect(mockCheck).not.toHaveBeenCalled()
  })

  it('Android 33+: check() = true → "granted"', async () => {
    const fbMock = makeFirebaseMock()
    const mockCheck = jest.fn().mockResolvedValue(true)
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({
      Platform: { OS: 'android', Version: 33 },
      PermissionsAndroid: {
        check: mockCheck,
        PERMISSIONS: { POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS' },
        RESULTS: { GRANTED: 'granted' },
      },
    }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const status = await new BareProvider().getPermissionStatus()
    expect(status).toBe('granted')
    expect(mockCheck).toHaveBeenCalledWith('android.permission.POST_NOTIFICATIONS')
  })

  it('Android 33+: check() = false → "denied"', async () => {
    const fbMock = makeFirebaseMock()
    const mockCheck = jest.fn().mockResolvedValue(false)
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({
      Platform: { OS: 'android', Version: 33 },
      PermissionsAndroid: {
        check: mockCheck,
        PERMISSIONS: { POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS' },
        RESULTS: { GRANTED: 'granted' },
      },
    }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const status = await new BareProvider().getPermissionStatus()
    expect(status).toBe('denied')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Devices.recordLifecycle — uses actual PushClient (not mocked)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Devices.recordLifecycle()', () => {
  // These tests use the ACTUAL PushClient/Devices — no jest.mock('../src/index').
  // expo-notifications is mocked so PushClient can init without native modules.
  // Each test manages its own fetch mock.
  beforeEach(() => {
    jest.resetModules()
    mockFetch.mockReset()
    jest.doMock('expo-notifications', () => ({}), { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios' } }), { virtual: true })
  })

  it('POSTs the right body to /v1/devices/lifecycle for a subscription event', async () => {
    mockFetch.mockResolvedValue(okFetch({}))

    const { PushClient } = require('../src/index')
    const client = new PushClient({ projectId: 'pk_test', pushToken: 'tok-abc', platform: 'ios' })

    await client.devices.recordLifecycle('subscription', 'old-token', 'new-token')

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/devices/lifecycle'),
      expect.objectContaining({ method: 'POST' }),
    )
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body).toEqual({
      push_token: 'tok-abc',
      kind: 'subscription',
      from: 'old-token',
      to: 'new-token',
      external_id: undefined,
      // rn-tap-and-offline-queue: the id the server deduplicates a retry on
      event_id: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/),
    })
  })

  it('POSTs with external_id when provided', async () => {
    mockFetch.mockResolvedValue(okFetch({}))

    const { PushClient } = require('../src/index')
    const client = new PushClient({ projectId: 'pk_test', pushToken: 'tok-xyz', platform: 'android' })

    await client.devices.recordLifecycle('permission', 'undetermined', 'granted', 'user-99')

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.push_token).toBe('tok-xyz')
    expect(body.kind).toBe('permission')
    expect(body.from).toBe('undetermined')
    expect(body.to).toBe('granted')
    expect(body.external_id).toBe('user-99')
  })

  it('uses the provided pushToken override over the constructor token', async () => {
    mockFetch.mockResolvedValue(okFetch({}))

    const { PushClient } = require('../src/index')
    const client = new PushClient({ projectId: 'pk_test', pushToken: 'constructor-tok', platform: 'ios' })

    await client.devices.recordLifecycle('identity', '', 'user-1', undefined, 'override-tok')

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.push_token).toBe('override-tok')
  })

  it('is a no-op (no fetch) when no token is available', async () => {
    const { PushClient } = require('../src/index')
    // No pushToken in constructor
    const client = new PushClient({ projectId: 'pk_test', platform: 'ios' })

    await client.devices.recordLifecycle('subscription', 'a', 'b')

    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('is silent (does not throw) when the request fails', async () => {
    mockFetch.mockRejectedValue(new Error('network error'))

    const { PushClient } = require('../src/index')
    const client = new PushClient({ projectId: 'pk_test', pushToken: 'tok-abc', platform: 'ios' })

    await expect(
      client.devices.recordLifecycle('permission', 'granted', 'denied'),
    ).resolves.toBeUndefined()
  })
})

// Torna o arquivo um módulo: sem isso o ts-jest o trata como script global e
// nomes de topo repetidos entre testes colidem (TS2451) em cache frio.
export {}
