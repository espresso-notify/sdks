/**
 * @jest-environment node
 *
 * sdk-private-transport T19 (SPT-01 to SPT-07, SPT-09): `privateTransport` chooses the transport.
 *
 * The client is built in every combination of the mode (`auto`, `native`, `js`), the native module (present with
 * contract version 1, absent, present with version 2) and a custom transport, and each case reads `transportKind`, which
 * transport got the call, how many times `fetch` ran and what the call raised.
 */
import type { PushClient as PushClientType } from '../src/index';

const API = 'https://api.example.test';

interface Env {
  module: 'v1' | 'absent' | 'v2';
  mode?: unknown;
  custom?: boolean;
  dev?: boolean;
  nodeEnv?: string;
}

const OK = { status: 200, statusText: 'OK', retryAfter: '', body: '{}' };

let warn: jest.SpyInstance;
let mockFetch: jest.Mock;
const savedNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  jest.resetModules();
  mockFetch = jest.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve('{}') });
  globalThis.fetch = mockFetch;
  warn = jest.spyOn(console, 'warn').mockImplementation();
  // The optional Expo packages are present, so the warning about missing device metadata (another warning, development
  // only) stays out of the console these cases read.
  for (const name of ['expo-notifications', 'expo-localization', 'expo-application', 'expo-device']) {
    jest.doMock(name, () => ({}), { virtual: true });
  }
});

afterEach(() => {
  warn.mockRestore();
  delete (globalThis as { __DEV__?: boolean }).__DEV__;
  process.env.NODE_ENV = savedNodeEnv;
  jest.dontMock('react-native');
});

/** A fresh copy of the SDK with `react-native` mocked as the case says. */
function load(env: Env) {
  const nativeRequest = jest.fn().mockResolvedValue(OK);
  if (env.module !== 'absent') {
    const version = env.module === 'v1' ? 1 : 2;
    jest.doMock(
      'react-native',
      () => ({
        TurboModuleRegistry: {
          get: (name: string) =>
            name === 'EspressoNotifyTransport'
              ? { getConstants: () => ({ contractVersion: version }), request: nativeRequest, setPins: jest.fn(), clearPins: jest.fn() }
              : null,
        },
      }),
      { virtual: true },
    );
  }
  (globalThis as { __DEV__?: boolean }).__DEV__ = env.dev;
  if (env.nodeEnv !== undefined) process.env.NODE_ENV = env.nodeEnv;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdk = require('../src/index') as typeof import('../src/index');
  const customRequest = jest.fn().mockResolvedValue({});
  const make = (): PushClientType =>
    new sdk.PushClient({
      projectId: 'pk_live_test',
      pushToken: 'tok',
      platform: 'ios',
      autoTrack: false,
      _apiUrl: API,
      ...(env.mode !== undefined ? { privateTransport: env.mode as 'auto' } : {}),
      ...(env.custom ? { transport: { request: customRequest } } : {}),
    });
  return { sdk, make, nativeRequest, customRequest };
}

async function raised(call: Promise<unknown>): Promise<any> {
  try {
    await call;
  } catch (e) {
    return e;
  }
  return undefined;
}

type Row = [string, Env, { kind: string; native: number; fetch: number; custom: number; error?: string }];

const ROWS: Row[] = [
  ['auto, module v1', { module: 'v1', mode: 'auto' }, { kind: 'native', native: 1, fetch: 0, custom: 0 }],
  ['no option (auto), module v1', { module: 'v1' }, { kind: 'native', native: 1, fetch: 0, custom: 0 }],
  ['auto, module absent', { module: 'absent', mode: 'auto' }, { kind: 'js', native: 0, fetch: 1, custom: 0 }],
  ['auto, module v2', { module: 'v2', mode: 'auto' }, { kind: 'js', native: 0, fetch: 1, custom: 0 }],
  ['native, module v1', { module: 'v1', mode: 'native' }, { kind: 'native', native: 1, fetch: 0, custom: 0 }],
  ['native, module absent', { module: 'absent', mode: 'native' }, { kind: 'js', native: 0, fetch: 0, custom: 0, error: 'NATIVE_TRANSPORT_UNAVAILABLE' }],
  ['native, module v2', { module: 'v2', mode: 'native' }, { kind: 'js', native: 0, fetch: 0, custom: 0, error: 'NATIVE_TRANSPORT_UNAVAILABLE' }],
  ['js, module v1', { module: 'v1', mode: 'js' }, { kind: 'js', native: 0, fetch: 1, custom: 0 }],
  ['js, module absent', { module: 'absent', mode: 'js' }, { kind: 'js', native: 0, fetch: 1, custom: 0 }],
  ['custom transport, auto, module v1', { module: 'v1', mode: 'auto', custom: true }, { kind: 'custom', native: 0, fetch: 0, custom: 1 }],
  ['custom transport, native, module absent', { module: 'absent', mode: 'native', custom: true }, { kind: 'custom', native: 0, fetch: 0, custom: 1 }],
  ['custom transport, js, module v1', { module: 'v1', mode: 'js', custom: true }, { kind: 'custom', native: 0, fetch: 0, custom: 1 }],
];

describe('the transport a client uses (SPT-01 to SPT-05, SPT-09)', () => {
  it.each(ROWS)('%s', async (_name, env, expected) => {
    const { make, nativeRequest, customRequest } = load(env);
    const client = make();
    const err = await raised(client.devices.identify({ externalId: 'u1' }));

    expect(client.transportKind).toBe(expected.kind);
    expect(nativeRequest).toHaveBeenCalledTimes(expected.native);
    expect(mockFetch).toHaveBeenCalledTimes(expected.fetch);
    expect(customRequest).toHaveBeenCalledTimes(expected.custom);
    if (expected.error) {
      const { EspressoNotifyError } = require('../src/errors');
      expect(err).toBeInstanceOf(EspressoNotifyError);
      expect(err.code).toBe(expected.error);
      expect(err.message).not.toMatch(/https?:|\/\//);
    } else {
      expect(err).toBeUndefined();
    }
  });

  it('the native transport receives the path under the API url, with the method and the project id', async () => {
    const { make, nativeRequest } = load({ module: 'v1' });
    await make().devices.identify({ externalId: 'u1' });
    const [method, url, headers] = nativeRequest.mock.calls[0];
    expect([method, url]).toEqual(['POST', `${API}/v1/devices/identify`]);
    expect(headers).toEqual(expect.arrayContaining(['Authorization', 'Bearer pk_live_test']));
  });

  it("'native' with the module unusable refuses every call, not only the first, and sends nothing", async () => {
    const { make, nativeRequest } = load({ module: 'absent', mode: 'native' });
    const client = make();
    const codes = [];
    for (const call of [
      () => client.devices.identify({ externalId: 'u1' }),
      () => client.devices.updateMetadata({ a: 1 }),
      () => client.devices.getPreferences('u1', 'tok'),
    ]) codes.push((await raised(call())).code);
    expect(codes).toEqual(['NATIVE_TRANSPORT_UNAVAILABLE', 'NATIVE_TRANSPORT_UNAVAILABLE', 'NATIVE_TRANSPORT_UNAVAILABLE']);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(nativeRequest).not.toHaveBeenCalled();
  });
});

describe('the warning when auto falls back to fetch (SPT-02)', () => {
  const fallbackWarnings = () => warn.mock.calls.filter((c) => /native/i.test(String(c[0])));

  it('logs exactly one warning per run in development, whatever the number of clients, and the text has no URL', () => {
    const { make } = load({ module: 'absent', mode: 'auto', dev: true, nodeEnv: 'development' });
    make();
    make();
    make();
    expect(fallbackWarnings()).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0][0]);
    expect(text).toMatch(/^\[espresso-notify\]/);
    expect(text).toContain('module not linked');
    expect(text).not.toMatch(/https?:|\/\/|api\.|__ESPRESSO/);
  });

  it('names a module of another contract version as the reason', () => {
    const { make } = load({ module: 'v2', dev: true, nodeEnv: 'development' });
    make();
    expect(fallbackWarnings()).toHaveLength(1);
    expect(String(warn.mock.calls[0][0])).toContain('contract version not supported');
  });

  it.each([
    ['__DEV__ is false', { dev: false, nodeEnv: 'development' }],
    ['there is no __DEV__', { dev: undefined, nodeEnv: 'development' }],
    ['NODE_ENV is test', { dev: true, nodeEnv: 'test' }],
  ])('logs nothing when %s', (_name, env) => {
    const { make } = load({ module: 'absent', mode: 'auto', ...env });
    make();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['the module is linked', { module: 'v1' as const, mode: 'auto' }],
    ['the mode is js', { module: 'absent' as const, mode: 'js' }],
    ['the mode is native', { module: 'absent' as const, mode: 'native' }],
    ['a custom transport is given', { module: 'absent' as const, mode: 'auto', custom: true }],
  ])('logs nothing when %s', (_name, env) => {
    const { make } = load({ ...env, dev: true, nodeEnv: 'development' });
    make();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("the validation of 'privateTransport' (SPT-07)", () => {
  it.each([['fast'], [''], [true], [1], [null], ['AUTO']])('%p throws the validation error', (value) => {
    const { make } = load({ module: 'absent', mode: value });
    expect(() => make()).toThrow(new Error("❌ Validation Error: 'privateTransport' must be 'auto', 'native' or 'js'."));
  });

  it.each([['auto'], ['native'], ['js']])('%s is accepted', (value) => {
    const { make } = load({ module: 'v1', mode: value });
    expect(() => make()).not.toThrow();
  });
});
