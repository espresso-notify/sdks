/**
 * @jest-environment jsdom
 *
 * SDKFIX-04 (sdk-launch-fixes), provider side: ExpoPushProvider maps the iOS
 * permission responses of expo-notifications. Shapes copied from the responses
 * logged on an iPhone 17 Pro simulator, iOS 27.0, expo-notifications 57.0.21.
 */

const requestPermissionsAsync = jest.fn()
const getPermissionsAsync = jest.fn()

// Before the prompt (logged): status undetermined, ios.status 0 (NOT_DETERMINED).
const IOS_UNDETERMINED = {
  status: 'undetermined', granted: false, canAskAgain: true, expires: 'never',
  ios: { status: 0, allowsAlert: null, allowsBadge: null, allowsSound: null, alertStyle: 0 },
}
// After Allow (logged): status granted, granted true, ios.status 2 (AUTHORIZED).
const IOS_AUTHORIZED = {
  status: 'granted', granted: true, canAskAgain: true, expires: 'never',
  ios: { status: 2, allowsAlert: true, allowsBadge: true, allowsSound: true, alertStyle: 1 },
}
// Provisional: expo-notifications maps it to status 'undetermined', granted false.
const IOS_PROVISIONAL = {
  status: 'undetermined', granted: false, canAskAgain: true, expires: 'never',
  ios: { status: 3, allowsAlert: true, alertStyle: 0 },
}
const IOS_EPHEMERAL = { ...IOS_PROVISIONAL, ios: { status: 4 } }
const IOS_DENIED = {
  status: 'denied', granted: false, canAskAgain: false, expires: 'never', ios: { status: 1 },
}

function load(withGetPermissions = true) {
  jest.resetModules()
  jest.doMock('expo-notifications', () => ({
    requestPermissionsAsync: (...a: any[]) => requestPermissionsAsync(...a),
    ...(withGetPermissions ? { getPermissionsAsync: (...a: any[]) => getPermissionsAsync(...a) } : {}),
  }), { virtual: true })
  jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: '27.0' } }), { virtual: true })
  return new (require('../src/index').ExpoPushProvider)()
}

beforeEach(() => {
  requestPermissionsAsync.mockReset()
  getPermissionsAsync.mockReset()
})

describe('ExpoPushProvider.requestPermissions() on iOS', () => {
  it.each([
    ['AUTHORIZED (granted: true, ios.status 2)', IOS_AUTHORIZED],
    ['PROVISIONAL (ios.status 3)', IOS_PROVISIONAL],
    ['EPHEMERAL (ios.status 4)', IOS_EPHEMERAL],
    ['granted: true with a stale status string', { status: 'undetermined', granted: true, ios: { status: 0 } }],
    // Só o sinal ios.status 2: sem `granted` e sem a string, o mapeamento do AUTHORIZED precisa bastar.
    ['ios.status 2 alone', { status: 'undetermined', granted: false, ios: { status: 2 } }],
  ])('returns granted for %s (AC 1)', async (_label, response) => {
    requestPermissionsAsync.mockResolvedValue(response)
    await expect(load().requestPermissions()).resolves.toBe('granted')
    expect(getPermissionsAsync).not.toHaveBeenCalled()
  })

  it('returns denied for the denied response without re-reading', async () => {
    requestPermissionsAsync.mockResolvedValue(IOS_DENIED)
    await expect(load().requestPermissions()).resolves.toBe('denied')
    expect(getPermissionsAsync).not.toHaveBeenCalled()
  })

  it('re-reads with getPermissionsAsync when the request says undetermined (AC 2)', async () => {
    requestPermissionsAsync.mockResolvedValue(IOS_UNDETERMINED)
    getPermissionsAsync.mockResolvedValue(IOS_AUTHORIZED)
    await expect(load().requestPermissions()).resolves.toBe('granted')
    expect(getPermissionsAsync).toHaveBeenCalledTimes(1)
  })

  it('maps the re-read with the same rule (provisional → granted) (AC 2)', async () => {
    requestPermissionsAsync.mockResolvedValue(IOS_UNDETERMINED)
    getPermissionsAsync.mockResolvedValue(IOS_PROVISIONAL)
    await expect(load().requestPermissions()).resolves.toBe('granted')
  })

  it('stays undetermined when the re-read is still undetermined (AC 2)', async () => {
    requestPermissionsAsync.mockResolvedValue(IOS_UNDETERMINED)
    getPermissionsAsync.mockResolvedValue(IOS_UNDETERMINED)
    await expect(load().requestPermissions()).resolves.toBe('undetermined')
  })

  it('stays undetermined when getPermissionsAsync is not available (AC 2)', async () => {
    requestPermissionsAsync.mockResolvedValue(IOS_UNDETERMINED)
    await expect(load(false).requestPermissions()).resolves.toBe('undetermined')
  })
})

describe('ExpoPushProvider.getPermissionStatus() on iOS', () => {
  it('returns granted for PROVISIONAL (ios.status 3) (AC 4)', async () => {
    getPermissionsAsync.mockResolvedValue(IOS_PROVISIONAL)
    await expect(load().getPermissionStatus()).resolves.toBe('granted')
  })

  it.each([
    [IOS_AUTHORIZED, 'granted'],
    [IOS_DENIED, 'denied'],
    [IOS_UNDETERMINED, 'undetermined'],
  ])('maps %j to %s', async (response, expected) => {
    getPermissionsAsync.mockResolvedValue(response)
    await expect(load().getPermissionStatus()).resolves.toBe(expected)
  })
})

// Torna o arquivo um módulo: sem isso o ts-jest o trata como script global e
// nomes de topo repetidos entre testes colidem (TS2451) em cache frio.
export {}
