/**
 * @jest-environment jsdom
 *
 * SDKFIX-05 (sdk-launch-fixes): React Native Firebase 22+ ships the modular API
 * only. Version 26 exports `getMessaging`, the modular functions and
 * `AuthorizationStatus`, and has no `default` export
 * (@react-native-firebase/messaging/dist/module/index.js:386-395 in 26.4.0).
 */

const AUTH = { NOT_DETERMINED: -1, DENIED: 0, AUTHORIZED: 1, PROVISIONAL: 2, EPHEMERAL: 3 }

function makeInstance(overrides: Record<string, unknown> = {}) {
  return {
    getToken: jest.fn().mockResolvedValue('fcm-v26-token'),
    requestPermission: jest.fn().mockResolvedValue(AUTH.AUTHORIZED),
    hasPermission: jest.fn().mockResolvedValue(AUTH.AUTHORIZED),
    registerDeviceForRemoteMessages: jest.fn().mockResolvedValue(undefined),
    onTokenRefresh: jest.fn(() => () => {}),
    ...overrides,
  }
}

/** Module namespace shaped like @react-native-firebase/messaging 26.x. */
function makeV26Module(instance: ReturnType<typeof makeInstance>, getMessaging?: jest.Mock) {
  return {
    getMessaging: getMessaging ?? jest.fn(() => instance),
    getToken: jest.fn(),
    requestPermission: jest.fn(),
    AuthorizationStatus: AUTH,
    SDK_VERSION: '26.4.0',
  }
}

function load(fbModule: unknown, os: 'ios' | 'android' = 'android') {
  jest.resetModules()
  jest.doMock('@react-native-firebase/messaging', () => fbModule, { virtual: true })
  jest.doMock('expo-notifications', () => { throw new Error('not installed') }, { virtual: true })
  jest.doMock('react-native-notify-kit', () => { throw new Error('not installed') }, { virtual: true })
  jest.doMock('react-native', () => ({ Platform: { OS: os, Version: os === 'ios' ? '27.0' : 30 } }), { virtual: true })
  return require('../src/index')
}

describe('modular @react-native-firebase/messaging (v22+)', () => {
  it('capabilities() reports firebaseMessaging and the bare provider (AC 1)', () => {
    const { capabilities } = load(makeV26Module(makeInstance()))
    const caps = capabilities()
    expect(caps.firebaseMessaging).toBe(true)
    expect(caps.pushProvider).toBe('bare')
  })

  it('resolvePushProvider() selects BareProvider (AC 1)', () => {
    const { resolvePushProvider, BareProvider } = load(makeV26Module(makeInstance()))
    expect(resolvePushProvider()).toBeInstanceOf(BareProvider)
  })

  it('BareProvider.getToken() returns the token of the getMessaging() instance (AC 2)', async () => {
    const instance = makeInstance()
    const mod = makeV26Module(instance)
    const { BareProvider } = load(mod)
    await expect(new BareProvider().getToken()).resolves.toEqual({ token: 'fcm-v26-token', provider: 'fcm' })
    expect(mod.getMessaging).toHaveBeenCalled()
  })

  it.each([
    [AUTH.AUTHORIZED, 'granted'],
    [AUTH.PROVISIONAL, 'granted'],
    [AUTH.DENIED, 'denied'],
    [AUTH.NOT_DETERMINED, 'undetermined'],
  ])('maps iOS requestPermission() %p to %p with the module AuthorizationStatus (AC 3)', async (raw, expected) => {
    const instance = makeInstance({ requestPermission: jest.fn().mockResolvedValue(raw) })
    const { BareProvider } = load(makeV26Module(instance), 'ios')
    await expect(new BareProvider().requestPermissions()).resolves.toBe(expected)
    expect(instance.requestPermission).toHaveBeenCalledTimes(1)
  })

  it('maps with the module AuthorizationStatus values, not the v21 literals (AC 3)', async () => {
    // A module whose constants differ from the 1/2/0 fallbacks proves the
    // mapping reads the exported AuthorizationStatus.
    const custom = { NOT_DETERMINED: 10, DENIED: 11, AUTHORIZED: 12, PROVISIONAL: 13 }
    const instance = makeInstance({ requestPermission: jest.fn().mockResolvedValue(12) })
    const mod = { ...makeV26Module(instance), AuthorizationStatus: custom }
    const { BareProvider } = load(mod, 'ios')
    await expect(new BareProvider().requestPermissions()).resolves.toBe('granted')
  })

  it('keeps pushProvider "bare" and returns a null token when getMessaging() throws (AC 4)', async () => {
    const getMessaging = jest.fn(() => { throw new Error('No Firebase App [DEFAULT] has been created') })
    const { capabilities, BareProvider } = load(makeV26Module(makeInstance(), getMessaging))
    expect(capabilities().pushProvider).toBe('bare')
    await expect(new BareProvider().getToken()).resolves.toBeNull()
  })

  it('does not call getMessaging() just to detect the module (AC 4)', () => {
    const getMessaging = jest.fn(() => makeInstance())
    const { capabilities } = load(makeV26Module(makeInstance(), getMessaging))
    capabilities()
    expect(getMessaging).not.toHaveBeenCalled()
  })
})

describe('namespaced @react-native-firebase/messaging (v21 and earlier)', () => {
  it('keeps using the default export factory (AC 5)', async () => {
    const instance = makeInstance({ getToken: jest.fn().mockResolvedValue('fcm-v21-token') })
    const messaging: any = jest.fn(() => instance)
    messaging.AuthorizationStatus = AUTH
    const { capabilities, BareProvider } = load({ default: messaging })
    expect(capabilities().pushProvider).toBe('bare')
    await expect(new BareProvider().getToken()).resolves.toEqual({ token: 'fcm-v21-token', provider: 'fcm' })
    expect(messaging).toHaveBeenCalled()
  })
})

// Torna o arquivo um módulo: sem isso o ts-jest o trata como script global e
// nomes de topo repetidos entre testes colidem (TS2451) em cache frio.
export {}
