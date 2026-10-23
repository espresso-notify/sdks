/**
 * @jest-environment node
 *
 * The peer-floor run of the Expo 53 compatibility test (2026-10-16): `@react-native-firebase/app-check` 26 has no
 * default export (v20 to v25 have it, and it is the factory `appCheck()`). Version 26 offers only the modular API, and
 * there is no function in it that returns an App Check instance without the provider options, which only the app has,
 * so the SDK cannot take a token from it. The provider says so and stays off; it must not call the module with the
 * wrong arguments.
 */

function freshProvider(appCheck: unknown, platform: 'android' | 'ios' = 'android') {
  jest.resetModules()
  jest.doMock('react-native', () => ({ Platform: { OS: platform, Version: 35 } }), { virtual: true })
  jest.doMock('@react-native-firebase/app-check', () => {
    if (!appCheck) throw new Error('not installed')
    return appCheck
  }, { virtual: true })
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../src/index').FirebaseAppCheckProvider
}

describe('FirebaseAppCheckProvider and the shape of @react-native-firebase/app-check', () => {
  let warn: jest.SpyInstance
  const env = process.env.NODE_ENV
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation()
    process.env.NODE_ENV = 'development'
  })
  afterEach(() => {
    warn.mockRestore()
    process.env.NODE_ENV = env
  })

  it('v20 to v25: the default export is the factory, and its instance gives the token', async () => {
    const getToken = jest.fn().mockResolvedValue({ token: 'APP_CHECK_TOKEN' })
    const factory = jest.fn(() => ({ getToken }))
    const Provider = freshProvider({ __esModule: true, default: factory })
    const p = new Provider({ forceRefresh: true })
    expect(p.isSupported()).toBe(true)
    await expect(p.attest('chal')).resolves.toEqual({ provider: 'play-integrity', appCheckToken: 'APP_CHECK_TOKEN' })
    expect(getToken).toHaveBeenCalledWith(true)
  })

  it('v26: no default export, so it is not supported, it says why once, and it never calls the module', async () => {
    const modular = {
      initializeAppCheck: jest.fn(),
      getToken: jest.fn(),
      getLimitedUseToken: jest.fn(),
      ReactNativeFirebaseAppCheckProvider: class {},
    }
    const Provider = freshProvider(modular)
    const p = new Provider()
    expect(p.isSupported()).toBe(false)
    expect(p.isSupported()).toBe(false)
    await expect(p.attest('chal')).rejects.toThrow('app-check')
    expect(modular.getToken).not.toHaveBeenCalled()
    const messages = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('app-check'))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('26')
    expect(messages[0]).toMatch(/default export/i)
  })

  it('is not supported on iOS, and not when the package is absent', () => {
    expect(new (freshProvider({ default: () => ({}) }, 'ios'))().isSupported()).toBe(false)
    expect(new (freshProvider(null))().isSupported()).toBe(false)
  })
})

export {}
