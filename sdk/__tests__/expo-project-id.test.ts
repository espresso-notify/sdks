/**
 * @jest-environment jsdom
 *
 * SDKFIX-03 (sdk-launch-fixes), provider side: the EAS project id for the Expo
 * push token comes from `expoProjectId`, else from expo-constants.
 */

const getExpoPushTokenAsync = jest.fn()
const getDevicePushTokenAsync = jest.fn()

function load(constants: unknown | 'absent') {
  jest.resetModules()
  jest.doMock('expo-notifications', () => ({
    getExpoPushTokenAsync: (...a: any[]) => getExpoPushTokenAsync(...a),
    getDevicePushTokenAsync: (...a: any[]) => getDevicePushTokenAsync(...a),
  }), { virtual: true })
  jest.doMock('expo-constants', () => {
    if (constants === 'absent') throw new Error('not installed')
    return { __esModule: true, default: constants }
  }, { virtual: true })
  jest.doMock('react-native', () => ({ Platform: { OS: 'android', Version: 34 } }), { virtual: true })
  return require('../src/index')
}

beforeEach(() => {
  getExpoPushTokenAsync.mockReset().mockResolvedValue({ data: 'ExponentPushToken[abc]' })
  getDevicePushTokenAsync.mockReset().mockResolvedValue({ type: 'android', data: 'fcm-raw' })
})

describe('ExpoPushProvider EAS project id', () => {
  it('passes expoProjectId as { projectId } (AC 1)', async () => {
    const { ExpoPushProvider } = load({ expoConfig: { extra: { eas: { projectId: 'from-constants' } } } })
    const p = new ExpoPushProvider({ expoProjectId: 'opt-123' })
    await expect(p.getToken()).resolves.toEqual({ token: 'ExponentPushToken[abc]', provider: 'expo' })
    expect(getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'opt-123' })
    expect(p.lastError).toBeNull()
  })

  it('resolvePushProvider forwards expoProjectId (AC 1)', async () => {
    const { resolvePushProvider } = load('absent')
    await resolvePushProvider({ expoProjectId: 'opt-456' }).getToken()
    expect(getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'opt-456' })
  })

  it('falls back to expoConfig.extra.eas.projectId (AC 2)', async () => {
    const { ExpoPushProvider } = load({
      expoConfig: { extra: { eas: { projectId: 'extra-eas-id' } } },
      easConfig: { projectId: 'eas-config-id' },
    })
    await new ExpoPushProvider().getToken()
    expect(getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'extra-eas-id' })
  })

  it('falls back to easConfig.projectId when extra.eas is missing (AC 3)', async () => {
    const { ExpoPushProvider } = load({ expoConfig: { extra: {} }, easConfig: { projectId: 'eas-config-id' } })
    await new ExpoPushProvider().getToken()
    expect(getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'eas-config-id' })
  })

  it('skips the token request and records EXPO_PROJECT_ID_MISSING when no id exists (AC 4)', async () => {
    const { ExpoPushProvider, EspressoNotifyError } = load({ expoConfig: { extra: {} }, easConfig: null })
    const p = new ExpoPushProvider()
    await expect(p.getToken()).resolves.toBeNull()
    expect(getExpoPushTokenAsync).not.toHaveBeenCalled()
    expect(p.lastError).toBeInstanceOf(EspressoNotifyError)
    expect(p.lastError.code).toBe('EXPO_PROJECT_ID_MISSING')
    expect(p.lastError.message).toContain('expoProjectId')
    expect(p.lastError.message).toContain('extra.eas.projectId')
  })

  it('maps ERR_NOTIFICATIONS_NO_EXPERIENCE_ID to EXPO_PROJECT_ID_MISSING (AC 5)', async () => {
    const { ExpoPushProvider } = load('absent')
    getExpoPushTokenAsync.mockRejectedValueOnce(
      Object.assign(new Error('No "projectId" found.'), { code: 'ERR_NOTIFICATIONS_NO_EXPERIENCE_ID' }),
    )
    const p = new ExpoPushProvider()
    await expect(p.getToken()).resolves.toBeNull()
    expect(p.lastError.code).toBe('EXPO_PROJECT_ID_MISSING')
  })

  it('records PUSH_TOKEN_UNAVAILABLE with the cause for other failures (AC 6)', async () => {
    const { ExpoPushProvider } = load({ expoConfig: { extra: { eas: { projectId: 'p' } } } })
    getExpoPushTokenAsync.mockRejectedValueOnce(new Error('network down'))
    const p = new ExpoPushProvider()
    await expect(p.getToken()).resolves.toBeNull()
    expect(p.lastError.code).toBe('PUSH_TOKEN_UNAVAILABLE')
    expect(p.lastError.message).toContain('network down')
  })

  it('calls getExpoPushTokenAsync() without arguments when expo-constants is absent (edge case)', async () => {
    const { ExpoPushProvider } = load('absent')
    await expect(new ExpoPushProvider().getToken()).resolves.toEqual({ token: 'ExponentPushToken[abc]', provider: 'expo' })
    expect(getExpoPushTokenAsync).toHaveBeenCalledWith()
  })

  it('does not need a project id for the device strategy (AC 7)', async () => {
    const { ExpoPushProvider } = load({ expoConfig: { extra: {} } })
    const p = new ExpoPushProvider({ tokenStrategy: 'device' })
    await expect(p.getToken()).resolves.toEqual({ token: 'fcm-raw', provider: 'fcm' })
    expect(getDevicePushTokenAsync).toHaveBeenCalledWith()
    expect(getExpoPushTokenAsync).not.toHaveBeenCalled()
    expect(p.lastError).toBeNull()
  })

  it('clears lastError after a later success', async () => {
    const { ExpoPushProvider } = load({ expoConfig: { extra: { eas: { projectId: 'p' } } } })
    getExpoPushTokenAsync.mockRejectedValueOnce(new Error('flaky'))
    const p = new ExpoPushProvider()
    await p.getToken()
    expect(p.lastError.code).toBe('PUSH_TOKEN_UNAVAILABLE')
    await p.getToken()
    expect(p.lastError).toBeNull()
  })
})

// Torna o arquivo um módulo: sem isso o ts-jest o trata como script global e
// nomes de topo repetidos entre testes colidem (TS2451) em cache frio.
export {}
