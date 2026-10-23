/**
 * @jest-environment node
 *
 * rn-sdk-v1-calls T11 (RNV-20, RNV-21): where the signing identity (device id and public key) is kept.
 */

const mockFetch = jest.fn();
globalThis.fetch = mockFetch;

// The shape react-native-secure-sign 0.0.2 exports (its published types): generate, sign, getPublicKey, removeKey,
// checkHardwareSupport. There is no `generateKeyPair`.
const signer = {
  generate: jest.fn(async () => 'SPKI_B64=='),
  removeKey: jest.fn(async () => undefined),
  sign: jest.fn(async () => 'SIG=='),
  getPublicKey: jest.fn(async () => 'SPKI_B64=='),
  checkHardwareSupport: jest.fn(async () => true),
};

function mapStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: jest.fn(async (k: string) => map.get(k) ?? null),
    setItem: jest.fn(async (k: string, v: string) => void map.set(k, v)),
  };
}

function absent(name: string) {
  return () => {
    const err: any = new Error(`Cannot find module '${name}'`);
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  };
}

/** A cold start: the modules are loaded again, the mocked storage survives. */
async function coldStartDeviceId(): Promise<string> {
  jest.resetModules();
  mockFetch.mockClear();
  mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve('{}') });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PushClient } = require('../src/index');
  const client = new PushClient({ projectId: 'pk_live_test', enableSigning: true, autoTrack: false });
  await client.devices.register({ pushToken: 'tok', platform: 'ios' });
  return JSON.parse(mockFetch.mock.calls[0][1].body).device_id;
}

describe('the signing identity without expo-secure-store (RNV-20, RNV-21)', () => {
  const env = process.env.NODE_ENV;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('react-native-secure-sign', () => signer, { virtual: true });
    process.env.NODE_ENV = 'development';
    warn = jest.spyOn(console, 'warn').mockImplementation();
  });
  afterEach(() => {
    process.env.NODE_ENV = env;
    warn.mockRestore();
  });

  it('keeps the device id in AsyncStorage across cold starts (AC 1)', async () => {
    const storage = mapStorage();
    jest.doMock('expo-secure-store', absent('expo-secure-store'), { virtual: true });
    jest.doMock('@react-native-async-storage/async-storage', () => ({ default: storage }), { virtual: true });

    const first = await coldStartDeviceId();
    const second = await coldStartDeviceId();

    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toBe(first);
    expect(storage.map.get('espresso.deviceId')).toBe(first);
    expect(storage.map.get('espresso.signingPublicKey')).toBe('SPKI_B64==');
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('memory only'));
  });

  it('accepts a CommonJS export without a default key', async () => {
    const storage = mapStorage();
    jest.doMock('expo-secure-store', absent('expo-secure-store'), { virtual: true });
    jest.doMock('@react-native-async-storage/async-storage', () => storage, { virtual: true });

    const first = await coldStartDeviceId();
    expect(await coldStartDeviceId()).toBe(first);
  });

  it('prefers expo-secure-store and does not touch AsyncStorage', async () => {
    const secure = new Map<string, string>();
    const asyncStorage = mapStorage();
    jest.doMock(
      'expo-secure-store',
      () => ({
        getItemAsync: async (k: string) => secure.get(k) ?? null,
        setItemAsync: async (k: string, v: string) => void secure.set(k, v),
      }),
      { virtual: true },
    );
    jest.doMock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }), { virtual: true });

    const first = await coldStartDeviceId();
    expect(await coldStartDeviceId()).toBe(first);
    expect(secure.get('espresso.deviceId')).toBe(first);
    expect(asyncStorage.getItem).not.toHaveBeenCalled();
    expect(asyncStorage.setItem).not.toHaveBeenCalled();
  });

  it('with neither store the device id changes on every cold start, and the warning says so (AC 2)', async () => {
    jest.doMock('expo-secure-store', absent('expo-secure-store'), { virtual: true });
    jest.doMock('@react-native-async-storage/async-storage', absent('@react-native-async-storage/async-storage'), { virtual: true });

    const first = await coldStartDeviceId();
    const second = await coldStartDeviceId();

    expect(second).not.toBe(first);
    const message = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('memory only'));
    expect(message).toBeDefined();
    expect(message).toMatch(/^\[espresso-notify\]/);
    expect(message).toContain('device id');
    expect(message).toContain('every cold start');
    expect(message).toContain('expo-secure-store');
    expect(message).toContain('@react-native-async-storage/async-storage');
    expect(message).not.toMatch(/protected/i);
  });
});

export {};
