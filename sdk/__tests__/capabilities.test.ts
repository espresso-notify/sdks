/**
 * @jest-environment jsdom
 *
 * Unit tests for capabilities() (#805 — runtime introspection of which native
 * integrations the SDK detected). Virtual mocks — no device required.
 */

describe('capabilities()', () => {
  beforeEach(() => jest.resetModules());

  it('reports expo when expo-notifications is present', () => {
    jest.doMock('expo-notifications', () => ({ addNotificationResponseReceivedListener: jest.fn() }), { virtual: true });
    jest.doMock('@react-native-firebase/messaging', () => { throw new Error('x'); }, { virtual: true });
    jest.doMock('react-native-notify-kit', () => { throw new Error('x'); }, { virtual: true });
    const { capabilities } = require('../src/index');

    expect(capabilities()).toEqual({
      expoNotifications: true,
      firebaseMessaging: false,
      notifyKit: false,
      pushProvider: 'expo',
      displayAdapter: 'expo',
      sslPinning: false,
      pinningActive: false,
      nativeTransport: false, // SPEC_AMENDMENT (sdk-private-transport T21, SPT-10): the new key; every other value is unchanged
    });
  });

  it('reports bare when expo absent but firebase + notify-kit present', () => {
    jest.doMock('expo-notifications', () => { throw new Error('x'); }, { virtual: true });
    jest.doMock('@react-native-firebase/messaging', () => ({ default: jest.fn() }), { virtual: true });
    jest.doMock('react-native-notify-kit', () => ({ default: {}, EventType: {} }), { virtual: true });
    const { capabilities } = require('../src/index');

    expect(capabilities()).toEqual({
      expoNotifications: false,
      firebaseMessaging: true,
      notifyKit: true,
      pushProvider: 'bare',
      displayAdapter: 'bare',
      sslPinning: false,
      pinningActive: false,
      nativeTransport: false, // SPEC_AMENDMENT (sdk-private-transport T21, SPT-10): the new key; every other value is unchanged
    });
  });

  it('reports none when no native integration is available', () => {
    jest.doMock('expo-notifications', () => { throw new Error('x'); }, { virtual: true });
    jest.doMock('@react-native-firebase/messaging', () => { throw new Error('x'); }, { virtual: true });
    jest.doMock('react-native-notify-kit', () => { throw new Error('x'); }, { virtual: true });
    const { capabilities } = require('../src/index');

    expect(capabilities()).toEqual({
      expoNotifications: false,
      firebaseMessaging: false,
      notifyKit: false,
      pushProvider: 'none',
      displayAdapter: 'none',
      sslPinning: false,
      pinningActive: false,
      nativeTransport: false, // SPEC_AMENDMENT (sdk-private-transport T21, SPT-10): the new key; every other value is unchanged
    });
  });
});

describe('capabilities() and the native transport (sdk-private-transport T21, SPT-10, SPT-40)', () => {
  beforeEach(() => jest.resetModules());

  const linked = (contractVersion: number | null) => {
    const setPins = jest.fn().mockResolvedValue(true);
    jest.doMock(
      'react-native',
      () => ({
        TurboModuleRegistry: {
          get: () =>
            contractVersion === null
              ? null
              : { getConstants: () => ({ contractVersion }), request: jest.fn(), setPins, clearPins: jest.fn().mockResolvedValue(undefined) },
        },
      }),
      { virtual: true },
    );
    return setPins;
  };
  const library = () =>
    jest.doMock(
      'react-native-ssl-public-key-pinning',
      () => ({ initializeSslPinning: jest.fn().mockResolvedValue(undefined), disableSslPinning: jest.fn().mockResolvedValue(undefined) }),
      { virtual: true },
    );
  const load = () => require('../src/index');

  it('reports nativeTransport and sslPinning with the module of version 1, even without the pinning library', () => {
    linked(1);
    expect(load().capabilities()).toMatchObject({ nativeTransport: true, sslPinning: true, pinningActive: false });
  });

  it('reports both false with a module of version 2 and no library', () => {
    linked(2);
    expect(load().capabilities()).toMatchObject({ nativeTransport: false, sslPinning: false });
  });

  it('reports both false when the module is not linked and there is no library', () => {
    linked(null);
    expect(load().capabilities()).toMatchObject({ nativeTransport: false, sslPinning: false });
  });

  it('keeps sslPinning true with the library when the module is absent or of another version, and nativeTransport false', () => {
    library();
    linked(2);
    expect(load().capabilities()).toMatchObject({ nativeTransport: false, sslPinning: true });
  });

  it('reports pinningActive for the path in use: the native pins with the module, then false again after disable', async () => {
    const setPins = linked(1);
    const sdk = load();
    await sdk.enableCertificatePinning({ 'api.example.test': { publicKeyHashes: ['hashA=='] } });
    expect(setPins).toHaveBeenCalledTimes(1);
    expect(sdk.capabilities().pinningActive).toBe(true);
    await sdk.disableCertificatePinning();
    expect(sdk.capabilities().pinningActive).toBe(false);
  });
});

// Torna o arquivo um módulo: sem isso o ts-jest o trata como script global e
// nomes de topo repetidos entre testes colidem (TS2451) em cache frio.
export {}
