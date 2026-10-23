/**
 * @jest-environment node
 *
 * rn-sdk-v1-calls T12 (RNV-22, RNV-23): pinning that is visible, and `requirePinning`.
 */

const mockFetch = jest.fn();
globalThis.fetch = mockFetch;

function absent(name: string) {
  return () => {
    const err: any = new Error(`Cannot find module '${name}'`);
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  };
}

function load(options: { pinningLibrary?: { initializeSslPinning: jest.Mock; disableSslPinning: jest.Mock } } = {}) {
  jest.resetModules();
  jest.doMock('expo-notifications', () => ({}), { virtual: true });
  if (options.pinningLibrary) {
    jest.doMock('react-native-ssl-public-key-pinning', () => options.pinningLibrary, { virtual: true });
  } else {
    jest.doMock('react-native-ssl-public-key-pinning', absent('react-native-ssl-public-key-pinning'), { virtual: true });
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../src/index');
}

const library = () => ({
  initializeSslPinning: jest.fn().mockResolvedValue(undefined),
  disableSslPinning: jest.fn().mockResolvedValue(undefined),
});

const PINS = { 'api.example.com': { publicKeyHashes: ['a==', 'b=='] } };

describe('capabilities() and the state of pinning (RNV-22)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    jest.spyOn(console, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('reports no library and no pinning when react-native-ssl-public-key-pinning is absent', async () => {
    const sdk = load();
    expect(sdk.capabilities()).toMatchObject({ sslPinning: false, pinningActive: false });
    await expect(sdk.enableCertificatePinning(PINS)).resolves.toBe(false);
    expect(sdk.capabilities().pinningActive).toBe(false);
  });

  it('reports the library but no active pinning before anything is enabled', () => {
    const sdk = load({ pinningLibrary: library() });
    expect(sdk.capabilities()).toMatchObject({ sslPinning: true, pinningActive: false });
  });

  it('turns active after enableCertificatePinning succeeds and inactive after disableCertificatePinning', async () => {
    const lib = library();
    const sdk = load({ pinningLibrary: lib });

    await expect(sdk.enableCertificatePinning(PINS)).resolves.toBe(true);
    expect(lib.initializeSslPinning).toHaveBeenCalledWith(PINS);
    expect(sdk.capabilities().pinningActive).toBe(true);

    await sdk.disableCertificatePinning();
    expect(lib.disableSslPinning).toHaveBeenCalledTimes(1);
    expect(sdk.capabilities().pinningActive).toBe(false);
  });

  it('stays inactive when the library fails to initialize', async () => {
    const lib = library();
    lib.initializeSslPinning.mockRejectedValue(new Error('bad pin'));
    const sdk = load({ pinningLibrary: lib });

    await expect(sdk.enableCertificatePinning(PINS)).resolves.toBe(false);
    expect(sdk.capabilities().pinningActive).toBe(false);
  });

  it('enableEspressoPinning with the build placeholder URL does not activate pinning', async () => {
    const sdk = load({ pinningLibrary: library() });
    await expect(sdk.enableEspressoPinning(['a==', 'b=='])).resolves.toBe(false);
    expect(sdk.capabilities().pinningActive).toBe(false);
  });
});

describe('requirePinning (RNV-23)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve('{}') });
    jest.spyOn(console, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  const config = (extra: Record<string, unknown> = {}) => ({
    projectId: 'pk_live_test',
    pushToken: 'tok',
    platform: 'ios',
    autoTrack: false,
    ...extra,
  });

  it('refuses every call with PINNING_NOT_ACTIVE and makes no network call while pinning is not active', async () => {
    const sdk = load({ pinningLibrary: library() });
    const client = new sdk.PushClient(config({ requirePinning: true }));

    const err: any = await client.devices.identify({ externalId: 'u1' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(sdk.EspressoNotifyError);
    expect(err.code).toBe('PINNING_NOT_ACTIVE');
    expect(err.message).toMatch(/^\[espresso-notify\] identify failed:/);
    expect(err.message).toContain('enableEspressoPinning');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses the calls that never throw as well, by dropping them', async () => {
    const sdk = load({ pinningLibrary: library() });
    const client = new sdk.PushClient(config({ requirePinning: true }));

    await expect(client.devices.trackEvent('signed_up')).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('lets calls through once pinning is active', async () => {
    const sdk = load({ pinningLibrary: library() });
    const client = new sdk.PushClient(config({ requirePinning: true }));

    await sdk.enableCertificatePinning(PINS);
    await client.devices.identify({ externalId: 'u1' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses again after pinning is disabled', async () => {
    const sdk = load({ pinningLibrary: library() });
    const client = new sdk.PushClient(config({ requirePinning: true }));
    await sdk.enableCertificatePinning(PINS);
    await sdk.disableCertificatePinning();

    await expect(client.devices.identify({ externalId: 'u1' })).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('applies to an injected transport too', async () => {
    const sdk = load({ pinningLibrary: library() });
    const transport = { request: jest.fn().mockResolvedValue({}) };
    const client = new sdk.PushClient(config({ requirePinning: true, transport }));

    await expect(client.devices.identify({ externalId: 'u1' })).rejects.toThrow();
    expect(transport.request).not.toHaveBeenCalled();
  });

  it('without requirePinning the calls go out as today, with or without pinning', async () => {
    const sdk = load();
    const client = new sdk.PushClient(config());

    await client.devices.identify({ externalId: 'u1' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

export {};
