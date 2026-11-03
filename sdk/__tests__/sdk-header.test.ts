/**
 * @jest-environment node
 *
 * feature: registration.sdk-marker
 * feature: platform.sdk-version
 *
 * sdk-parity T64 (PAR-79): every request of the React Native SDK, on the JS transport and on the native transport,
 * carries `X-Espresso-SDK: react-native/<version>`, and the version is the one in `package.json`.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const API = 'https://api.example.test';
const OK = { status: 200, statusText: 'OK', retryAfter: '', body: '{}' };
const VERSION = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version as string;

let mockFetch: jest.Mock;

beforeEach(() => {
  jest.resetModules();
  mockFetch = jest.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve('{}') });
  globalThis.fetch = mockFetch;
  for (const name of ['expo-notifications', 'expo-localization', 'expo-application', 'expo-device']) {
    jest.doMock(name, () => ({}), { virtual: true });
  }
});

afterEach(() => jest.dontMock('react-native'));

function client(mode: 'js' | 'native', nativeRequest: jest.Mock) {
  if (mode === 'native') {
    jest.doMock(
      'react-native',
      () => ({
        TurboModuleRegistry: {
          get: (name: string) =>
            name === 'EspressoNotifyTransport'
              ? { getConstants: () => ({ contractVersion: 1 }), request: nativeRequest, setPins: jest.fn(), clearPins: jest.fn() }
              : null,
        },
      }),
      { virtual: true },
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdk = require('../src/index') as typeof import('../src/index');
  return new sdk.PushClient({
    projectId: 'pk_live_test', pushToken: 'tok', platform: 'ios', autoTrack: false, _apiUrl: API, privateTransport: mode,
  });
}

describe('X-Espresso-SDK (PAR-79)', () => {
  it('the version in the source is the version in package.json', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(require('../src/transport').SDK_VERSION).toBe(VERSION);
  });

  it('the JS transport sends react-native/<version> on a register, an identify and an event', async () => {
    const c = client('js', jest.fn());
    await c.devices.register({});
    await c.devices.identify({ externalId: 'u1' });
    await c.devices.trackOpen(1);
    await c.flush();
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [, init] of mockFetch.mock.calls) {
      expect(init.headers['X-Espresso-SDK']).toBe(`react-native/${VERSION}`);
    }
  });

  it('the native transport passes react-native/<version> in the header list of every request', async () => {
    const nativeRequest = jest.fn().mockResolvedValue(OK);
    const c = client('native', nativeRequest);
    await c.devices.register({});
    await c.devices.identify({ externalId: 'u1' });
    await c.devices.trackOpen(1);
    await c.flush();
    expect(nativeRequest.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of nativeRequest.mock.calls) {
      const headers = call[2] as string[];
      const at = headers.findIndex((h, i) => i % 2 === 0 && h.toLowerCase() === 'x-espresso-sdk');
      expect(headers[at + 1]).toBe(`react-native/${VERSION}`);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
