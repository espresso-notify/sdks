/**
 * @jest-environment node
 *
 * sdk-private-transport T20 (SPT-31, SPT-32, SPT-33, SPT-37, SPT-39): the pins go to the native module next to the
 * library, and `requirePinning` looks at the pins of the path the client uses.
 *
 * The native module is a fake that records `setPins` and `clearPins`; the pinning library is a fake too. `react-native`
 * answers from a variable, so a test can change what is linked between two calls.
 */

const API = 'https://api.example.test';
const PINS = { 'api.example.test': { includeSubdomains: true, publicKeyHashes: ['hashA==', 'hashB=='] } };

interface Native {
  setPins: jest.Mock;
  clearPins: jest.Mock;
  request: jest.Mock;
}

function makeNative(): Native {
  return {
    setPins: jest.fn().mockResolvedValue(true),
    clearPins: jest.fn().mockResolvedValue(undefined),
    request: jest.fn().mockResolvedValue({ status: 200, statusText: 'OK', retryAfter: '', body: '{}' }),
  };
}

const makeLibrary = () => ({
  initializeSslPinning: jest.fn().mockResolvedValue(undefined),
  disableSslPinning: jest.fn().mockResolvedValue(undefined),
});

function absent(name: string) {
  return () => {
    const err: any = new Error(`Cannot find module '${name}'`);
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  };
}

let warn: jest.SpyInstance;
const mockFetch = jest.fn();

/** What `react-native` answers for the module: a test sets it, also after the SDK is loaded. */
let linked: { module: Native | null; version: number };

function load(library?: ReturnType<typeof makeLibrary>) {
  jest.resetModules();
  jest.doMock('expo-notifications', () => ({}), { virtual: true });
  jest.doMock(
    'react-native',
    () => ({
      TurboModuleRegistry: {
        get: (name: string) =>
          name === 'EspressoNotifyTransport' && linked.module
            ? { getConstants: () => ({ contractVersion: linked.version }), ...linked.module }
            : null,
      },
    }),
    { virtual: true },
  );
  if (library) jest.doMock('react-native-ssl-public-key-pinning', () => library, { virtual: true });
  else jest.doMock('react-native-ssl-public-key-pinning', absent('react-native-ssl-public-key-pinning'), { virtual: true });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../src/index') as typeof import('../src/index');
}

beforeEach(() => {
  linked = { module: null, version: 1 };
  mockFetch.mockReset().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve('{}') });
  globalThis.fetch = mockFetch;
  warn = jest.spyOn(console, 'warn').mockImplementation();
});
afterEach(() => warn.mockRestore());

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('enableCertificatePinning with a usable native module (SPT-31)', () => {
  it('awaits setPins, with the entries of the options, before it resolves', async () => {
    const native = makeNative();
    let accept!: (value: boolean) => void;
    native.setPins.mockReturnValue(new Promise<boolean>((resolve) => (accept = resolve)));
    linked.module = native;
    const sdk = load();

    let settled = false;
    const result = sdk.enableCertificatePinning(PINS).then((v) => ((settled = true), v));
    await flush();
    expect(native.setPins).toHaveBeenCalledTimes(1);
    expect(native.setPins).toHaveBeenCalledWith([{ host: 'api.example.test', includeSubdomains: true, pins: ['hashA==', 'hashB=='] }]);
    expect(settled).toBe(false);

    accept(true);
    await expect(result).resolves.toBe(true);
    expect(sdk.capabilities().pinningActive).toBe(true);
  });

  it('writes includeSubdomains as false when the option does not say, and keeps the order of the hosts', async () => {
    const native = makeNative();
    linked.module = native;
    const sdk = load();
    await sdk.enableCertificatePinning({ 'a.example.test': { publicKeyHashes: ['p1'] }, 'b.example.test': { includeSubdomains: false, publicKeyHashes: ['p2', 'p3'] } });
    expect(native.setPins).toHaveBeenCalledWith([
      { host: 'a.example.test', includeSubdomains: false, pins: ['p1'] },
      { host: 'b.example.test', includeSubdomains: false, pins: ['p2', 'p3'] },
    ]);
  });

  it('gives the options to the pinning library too when it is installed, and resolves true', async () => {
    const native = makeNative();
    const lib = makeLibrary();
    linked.module = native;
    const sdk = load(lib);
    await expect(sdk.enableCertificatePinning(PINS)).resolves.toBe(true);
    expect(native.setPins).toHaveBeenCalledTimes(1);
    expect(lib.initializeSslPinning).toHaveBeenCalledWith(PINS);
    expect(warn).not.toHaveBeenCalled();
  });

  it('resolves true without the library and without the "not installed" warning', async () => {
    linked.module = makeNative();
    const sdk = load();
    await expect(sdk.enableCertificatePinning(PINS)).resolves.toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('resolves false and warns once with a fixed text when the module says false; the library is left alone', async () => {
    const native = makeNative();
    native.setPins.mockResolvedValue(false);
    const lib = makeLibrary();
    linked.module = native;
    const sdk = load(lib);
    await expect(sdk.enableCertificatePinning(PINS)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toHaveLength(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/^\[espresso-notify\] .*PINNING_INIT_FAILED/);
    expect(lib.initializeSslPinning).not.toHaveBeenCalled();
    expect(sdk.capabilities().pinningActive).toBe(false);
  });

  it('never throws when the module rejects, and does not repeat what it raised', async () => {
    const native = makeNative();
    native.setPins.mockRejectedValue(Object.assign(new Error('SENTINEL native text'), { code: 'invalid_request' }));
    linked.module = native;
    const sdk = load();
    await expect(sdk.enableCertificatePinning(PINS)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toMatch(/SENTINEL/);
  });

  it.each([
    ['no host', {}],
    ['a host without hashes', { 'a.example.test': {} }],
    ['an empty list of hashes', { 'a.example.test': { publicKeyHashes: [] } }],
    ['a hash that is not a string', { 'a.example.test': { publicKeyHashes: [7] } }],
    ['hashes that are not a list', { 'a.example.test': { publicKeyHashes: 'abc' } }],
    ['options that are not an object', null],
  ])('%s: false, one fixed warning, the module not called', async (_name, options) => {
    const native = makeNative();
    linked.module = native;
    const sdk = load();
    await expect(sdk.enableCertificatePinning(options as never)).resolves.toBe(false);
    expect(native.setPins).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toHaveLength(1);
  });

  it('keeps the library pins when the module accepted them but the library failed, and warns once', async () => {
    const lib = makeLibrary();
    lib.initializeSslPinning.mockRejectedValue(new Error('SENTINEL library text'));
    linked.module = makeNative();
    const sdk = load(lib);
    await expect(sdk.enableCertificatePinning(PINS)).resolves.toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toMatch(/SENTINEL/);
  });
});

describe('enableCertificatePinning without a usable native module (SPT-32)', () => {
  it.each([
    ['not linked', null, 1],
    ['contract version 2', makeNative(), 2],
  ])('%s: only the library is used, as before', async (_name, module, version) => {
    linked = { module, version };
    const lib = makeLibrary();
    const sdk = load(lib);
    await expect(sdk.enableCertificatePinning(PINS)).resolves.toBe(true);
    expect(lib.initializeSslPinning).toHaveBeenCalledWith(PINS);
    if (module) expect(module.setPins).not.toHaveBeenCalled();
    await sdk.disableCertificatePinning();
    expect(lib.disableSslPinning).toHaveBeenCalledTimes(1);
    if (module) expect(module.clearPins).not.toHaveBeenCalled();
  });

  it('still says false and warns when the library is absent', async () => {
    const sdk = load();
    await expect(sdk.enableCertificatePinning(PINS)).resolves.toBe(false);
    expect(String(warn.mock.calls[0][0])).toContain('react-native-ssl-public-key-pinning is not installed');
  });
});

describe('disableCertificatePinning with a usable native module (SPT-37)', () => {
  it('clears the native pins and disables the library, and pinningActive turns false', async () => {
    const native = makeNative();
    const lib = makeLibrary();
    linked.module = native;
    const sdk = load(lib);
    await sdk.enableCertificatePinning(PINS);
    expect(sdk.capabilities().pinningActive).toBe(true);

    await sdk.disableCertificatePinning();
    expect(native.clearPins).toHaveBeenCalledTimes(1);
    expect(lib.disableSslPinning).toHaveBeenCalledTimes(1);
    expect(sdk.capabilities().pinningActive).toBe(false);
  });

  it('does not throw when clearPins rejects, and still clears the state', async () => {
    const native = makeNative();
    native.clearPins.mockRejectedValue(new Error('SENTINEL native text'));
    linked.module = native;
    const sdk = load();
    await sdk.enableCertificatePinning(PINS);
    await expect(sdk.disableCertificatePinning()).resolves.toBeUndefined();
    expect(sdk.capabilities().pinningActive).toBe(false);
  });
});

describe('requirePinning follows the pins of the path of the client (SPT-39)', () => {
  const client = (sdk: typeof import('../src/index'), privateTransport?: 'auto' | 'native' | 'js') =>
    new sdk.PushClient({
      projectId: 'pk_live_test',
      pushToken: 'tok',
      platform: 'ios',
      autoTrack: false,
      requirePinning: true,
      _apiUrl: API,
      ...(privateTransport ? { privateTransport } : {}),
    });

  const raised = async (call: Promise<unknown>) => {
    try {
      await call;
    } catch (e) {
      return e as { code?: string };
    }
    return undefined;
  };

  it('refuses with PINNING_NOT_ACTIVE before anything is sent while no pins are set, native path', async () => {
    const native = makeNative();
    linked.module = native;
    const sdk = load();
    const err = await raised(client(sdk).devices.identify({ externalId: 'u1' }));
    expect(err?.code).toBe('PINNING_NOT_ACTIVE');
    expect(native.request).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('lets the native path through after the native pins are set', async () => {
    const native = makeNative();
    linked.module = native;
    const sdk = load();
    const c = client(sdk);
    await sdk.enableCertificatePinning(PINS);
    expect(await raised(c.devices.identify({ externalId: 'u1' }))).toBeUndefined();
    expect(native.request).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses the native path again after disableCertificatePinning', async () => {
    linked.module = makeNative();
    const sdk = load();
    const c = client(sdk);
    await sdk.enableCertificatePinning(PINS);
    await sdk.disableCertificatePinning();
    expect((await raised(c.devices.identify({ externalId: 'u1' })))?.code).toBe('PINNING_NOT_ACTIVE');
  });

  it('does not count library pins for the native transport', async () => {
    // The library was pinned while the module was not linked; a client built after the module is linked uses it.
    const lib = makeLibrary();
    const sdk = load(lib);
    await sdk.enableCertificatePinning(PINS);
    expect(sdk.capabilities().pinningActive).toBe(true);
    const native = makeNative();
    linked.module = native;
    const err = await raised(client(sdk).devices.identify({ externalId: 'u1' }));
    expect(err?.code).toBe('PINNING_NOT_ACTIVE');
    expect(native.request).not.toHaveBeenCalled();
  });

  it('does not count native pins for the fetch transport (privateTransport js)', async () => {
    linked.module = makeNative();
    const sdk = load(); // no library
    await sdk.enableCertificatePinning(PINS);
    const err = await raised(client(sdk, 'js').devices.identify({ externalId: 'u1' }));
    expect(err?.code).toBe('PINNING_NOT_ACTIVE');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('lets the fetch transport through when the library is pinned', async () => {
    const lib = makeLibrary();
    linked.module = makeNative();
    const sdk = load(lib);
    await sdk.enableCertificatePinning(PINS);
    expect(await raised(client(sdk, 'js').devices.identify({ externalId: 'u1' }))).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('with the module not linked the guard looks at the library pins, as before', async () => {
    const lib = makeLibrary();
    const sdk = load(lib);
    const c = client(sdk);
    expect((await raised(c.devices.identify({ externalId: 'u1' })))?.code).toBe('PINNING_NOT_ACTIVE');
    await sdk.enableCertificatePinning(PINS);
    expect(await raised(c.devices.identify({ externalId: 'u1' }))).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
