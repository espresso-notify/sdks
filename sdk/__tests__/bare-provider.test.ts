/**
 * @jest-environment jsdom
 *
 * Unit tests for BareProvider (#803 — bare React Native push token provider).
 *
 * All native modules are virtual mocks — no device required.
 * Uses jest.resetModules() + jest.doMock() per describe block so each scenario
 * gets a fresh require of sdk/src/index, matching the dependency.test.ts style.
 */

// ─── Shared mock factories ─────────────────────────────────────────────────────

/** Build a minimal FirebaseMessaging instance mock. */
function makeMessagingInstance(overrides: Partial<{
  getToken: () => Promise<string>
  requestPermission: () => Promise<number>
  registerDeviceForRemoteMessages: () => Promise<void>
}> = {}) {
  return {
    getToken: jest.fn().mockResolvedValue('fcm-token'),
    requestPermission: jest.fn().mockResolvedValue(1 /* AUTHORIZED */),
    registerDeviceForRemoteMessages: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

/** Build the FirebaseMessaging module mock (default export is a callable that
 *  returns the instance; AuthorizationStatus constants live on the function). */
function makeFirebaseMessagingModule(instanceOverrides?: Parameters<typeof makeMessagingInstance>[0]) {
  const instance = makeMessagingInstance(instanceOverrides)
  const messagingFn: any = jest.fn().mockReturnValue(instance)
  messagingFn.AuthorizationStatus = {
    AUTHORIZED:     1,
    PROVISIONAL:    2,
    DENIED:         0,
    NOT_DETERMINED: -1,
  }
  return { default: messagingFn, _instance: instance, _fn: messagingFn }
}

// ─── getToken() ───────────────────────────────────────────────────────────────

describe('BareProvider.getToken()', () => {
  beforeEach(() => jest.resetModules())

  it('returns { token: "fcm-token", provider: "fcm" } when messaging is available', async () => {
    const fbMock = makeFirebaseMessagingModule()
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'android', Version: 30 } }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const provider = new BareProvider()
    const result = await provider.getToken()

    expect(result).toEqual({ token: 'fcm-token', provider: 'fcm' })
  })

  it('returns null when messaging().getToken() throws', async () => {
    const fbMock = makeFirebaseMessagingModule({
      getToken: jest.fn().mockRejectedValue(new Error('no FCM token')),
    })
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'android', Version: 30 } }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const provider = new BareProvider()
    const result = await provider.getToken()

    expect(result).toBeNull()
  })

  it('returns null when getToken() returns an empty string', async () => {
    const fbMock = makeFirebaseMessagingModule({
      getToken: jest.fn().mockResolvedValue(''),
    })
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'android', Version: 30 } }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const provider = new BareProvider()
    const result = await provider.getToken()

    expect(result).toBeNull()
  })

  it('returns null when FirebaseMessaging module is unavailable', async () => {
    jest.doMock('@react-native-firebase/messaging', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'android', Version: 30 } }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const provider = new BareProvider()
    const result = await provider.getToken()

    expect(result).toBeNull()
  })
})

// ─── requestPermissions() — iOS ───────────────────────────────────────────────

describe('BareProvider.requestPermissions() — iOS', () => {
  beforeEach(() => jest.resetModules())

  it('maps AUTHORIZED (1) → "granted"', async () => {
    const fbMock = makeFirebaseMessagingModule({ requestPermission: jest.fn().mockResolvedValue(1) })
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: '17.0' } }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const status = await new BareProvider().requestPermissions()
    expect(status).toBe('granted')
  })

  it('maps PROVISIONAL (2) → "granted"', async () => {
    const fbMock = makeFirebaseMessagingModule({ requestPermission: jest.fn().mockResolvedValue(2) })
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: '17.0' } }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const status = await new BareProvider().requestPermissions()
    expect(status).toBe('granted')
  })

  it('maps DENIED (0) → "denied"', async () => {
    const fbMock = makeFirebaseMessagingModule({ requestPermission: jest.fn().mockResolvedValue(0) })
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: '17.0' } }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const status = await new BareProvider().requestPermissions()
    expect(status).toBe('denied')
  })

  it('maps NOT_DETERMINED (-1) → "undetermined"', async () => {
    const fbMock = makeFirebaseMessagingModule({ requestPermission: jest.fn().mockResolvedValue(-1) })
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: '17.0' } }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const status = await new BareProvider().requestPermissions()
    expect(status).toBe('undetermined')
  })

  it('calls registerDeviceForRemoteMessages() on iOS before requesting permission', async () => {
    const registerFn = jest.fn().mockResolvedValue(undefined)
    const fbMock = makeFirebaseMessagingModule({ registerDeviceForRemoteMessages: registerFn })
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: '17.0' } }), { virtual: true })

    const { BareProvider } = require('../src/index')
    await new BareProvider().requestPermissions()
    expect(registerFn).toHaveBeenCalledTimes(1)
  })

  it('returns null when requestPermission() throws', async () => {
    const fbMock = makeFirebaseMessagingModule({
      requestPermission: jest.fn().mockRejectedValue(new Error('iOS permission error')),
    })
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: '17.0' } }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const status = await new BareProvider().requestPermissions()
    expect(status).toBeNull()
  })
})

// ─── requestPermissions() — Android ──────────────────────────────────────────

describe('BareProvider.requestPermissions() — Android', () => {
  beforeEach(() => jest.resetModules())

  it('Android 33+: requests POST_NOTIFICATIONS and maps "granted" → "granted"', async () => {
    const fbMock = makeFirebaseMessagingModule()
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })

    const mockRequest = jest.fn().mockResolvedValue('granted')
    jest.doMock('react-native', () => ({
      Platform: { OS: 'android', Version: 33 },
      PermissionsAndroid: {
        request: mockRequest,
        PERMISSIONS: { POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS' },
        RESULTS: { GRANTED: 'granted' },
      },
    }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const status = await new BareProvider().requestPermissions()

    expect(mockRequest).toHaveBeenCalledWith('android.permission.POST_NOTIFICATIONS')
    expect(status).toBe('granted')
  })

  it('Android 33+: maps "denied" → "denied"', async () => {
    const fbMock = makeFirebaseMessagingModule()
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })

    const mockRequest = jest.fn().mockResolvedValue('never_ask_again')
    jest.doMock('react-native', () => ({
      Platform: { OS: 'android', Version: 34 },
      PermissionsAndroid: {
        request: mockRequest,
        PERMISSIONS: { POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS' },
        RESULTS: { GRANTED: 'granted' },
      },
    }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const status = await new BareProvider().requestPermissions()
    expect(status).toBe('denied')
  })

  it('Android < 33: returns "granted" without calling PermissionsAndroid.request()', async () => {
    const fbMock = makeFirebaseMessagingModule()
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })

    const mockRequest = jest.fn()
    jest.doMock('react-native', () => ({
      Platform: { OS: 'android', Version: 30 },
      PermissionsAndroid: {
        request: mockRequest,
        PERMISSIONS: { POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS' },
        RESULTS: { GRANTED: 'granted' },
      },
    }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const status = await new BareProvider().requestPermissions()

    expect(status).toBe('granted')
    expect(mockRequest).not.toHaveBeenCalled()
  })

  it('returns null when FirebaseMessaging is unavailable', async () => {
    jest.doMock('@react-native-firebase/messaging', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'android', Version: 33 } }), { virtual: true })

    const { BareProvider } = require('../src/index')
    const status = await new BareProvider().requestPermissions()
    expect(status).toBeNull()
  })
})

// ─── resolvePushProvider() fallback ───────────────────────────────────────────

describe('resolvePushProvider()', () => {
  beforeEach(() => jest.resetModules())

  it('returns a BareProvider when expo-notifications is absent but firebase is present', () => {
    const fbMock = makeFirebaseMessagingModule()
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'android', Version: 30 } }), { virtual: true })

    const { resolvePushProvider, BareProvider } = require('../src/index')
    const provider = resolvePushProvider()
    expect(provider).toBeInstanceOf(BareProvider)
  })

  it('returns an ExpoPushProvider (not BareProvider) when expo-notifications is present', () => {
    const fbMock = makeFirebaseMessagingModule()
    jest.doMock('@react-native-firebase/messaging', () => fbMock, { virtual: true })
    jest.doMock('expo-notifications', () => ({
      requestPermissionsAsync: jest.fn(),
      getExpoPushTokenAsync: jest.fn(),
    }), { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios' } }), { virtual: true })

    const { resolvePushProvider, ExpoPushProvider } = require('../src/index')
    const provider = resolvePushProvider()
    expect(provider).toBeInstanceOf(ExpoPushProvider)
  })

  it('returns null when both expo-notifications and firebase are absent', () => {
    jest.doMock('@react-native-firebase/messaging', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('expo-notifications', () => { throw new Error('not found') }, { virtual: true })
    jest.doMock('react-native', () => ({ Platform: { OS: 'android', Version: 30 } }), { virtual: true })

    const { resolvePushProvider } = require('../src/index')
    expect(resolvePushProvider()).toBeNull()
  })
})

// Torna o arquivo um módulo: sem isso o ts-jest o trata como script global e
// nomes de topo repetidos entre testes colidem (TS2451) em cache frio.
export {}
