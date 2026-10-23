/**
 * @jest-environment node
 *
 * sdk-private-transport T25 (SPT-06, SPT-22): the seam holds. Signing, the offline queue, the batcher and the
 * `requirePinning` guard sit above `Transport`; this suite runs their scenarios (those of `signing-813`, `offline-queue`,
 * `track-batch-client` and `pinning-visible`) on a client built on the real `NativeTransport` over a fake module, so a
 * request that goes through the module ends in the same results as one that goes through `fetch`.
 *
 * Only the edge is fake: the native module, the signer and the key and queue stores. Time is fake.
 */

const API = 'https://api.example.test';
const T0 = 1_700_000_000_000;
const SECOND = 1000;
const BATCH = '/v1/notifications/track/batch';
const TOKEN = 'ExponentPushToken[seam-test]';
const PINS = { 'api.example.test': { includeSubdomains: true, publicKeyHashes: ['hashA==', 'hashB=='] } };

const OK = { status: 200, statusText: 'OK', retryAfter: '', body: '{}' };
const answer = (status: number, statusText: string, body: string, retryAfter = '') => ({ status, statusText, retryAfter, body });

class MemoryStore {
  readonly map = new Map<string, string>();
  async getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  async setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

interface Native {
  request: jest.Mock;
  setPins: jest.Mock;
  clearPins: jest.Mock;
}

const makeNative = (): Native => ({
  request: jest.fn().mockResolvedValue(OK),
  setPins: jest.fn().mockResolvedValue(true),
  clearPins: jest.fn().mockResolvedValue(undefined),
});

/** The flat `name, value, name, value` list the module takes, as an object. */
function headersOf(flat: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

/** What one call of the fake module received. */
function received(native: Native) {
  return native.request.mock.calls.map(([method, url, headers, body]) => ({
    method: method as string,
    path: (url as string).replace(API, ''),
    headers: headersOf(headers as string[]),
    body: body === null ? null : JSON.parse(body as string),
    rawBody: body as string | null,
  }));
}

interface Booted {
  sdk: typeof import('../src/index');
  native: Native;
  mockFetch: jest.Mock;
  make: (extra?: Record<string, unknown>) => any;
}

/** A fresh SDK with the native module linked and a `fetch` that must stay unused. */
function boot(): Booted {
  jest.resetModules();
  const native = makeNative();
  const mockFetch = jest.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', text: async () => '{}' });
  globalThis.fetch = mockFetch;
  jest.doMock(
    'react-native',
    () => ({
      Platform: { OS: 'ios', Version: 17 },
      AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
      TurboModuleRegistry: {
        get: (name: string) => (name === 'EspressoNotifyTransport' ? { getConstants: () => ({ contractVersion: 1 }), ...native } : null),
      },
    }),
    { virtual: true },
  );
  jest.doMock('expo-notifications', () => ({}), { virtual: true });
  jest.doMock('react-native-ssl-public-key-pinning', () => {
    throw Object.assign(new Error("Cannot find module 'react-native-ssl-public-key-pinning'"), { code: 'MODULE_NOT_FOUND' });
  }, { virtual: true });
  const sdk = require('../src/index') as typeof import('../src/index');
  const make = (extra: Record<string, unknown> = {}) =>
    new sdk.PushClient({
      projectId: 'pk_live_seam',
      pushToken: TOKEN,
      platform: 'ios',
      autoTrack: false,
      _apiUrl: API,
      _queueStore: new MemoryStore(),
      ...extra,
    } as never);
  return { sdk, native, mockFetch, make };
}

function makeSigner() {
  return {
    generate: jest.fn().mockResolvedValue('SPKI=='),
    sign: jest.fn().mockResolvedValue('SIGNATURE_BASE64=='),
    getPublicKey: jest.fn().mockResolvedValue('SPKI=='),
    isSupported: jest.fn().mockResolvedValue(true),
  };
}

beforeEach(() => {
  jest.useFakeTimers({ now: T0 });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(Math, 'random').mockReturnValue(0); // no jitter on the delays of the queue and the batcher
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  jest.dontMock('react-native');
});

const KM = ['X-KM-Device-Id', 'X-KM-Timestamp', 'X-KM-Nonce', 'X-KM-Signature', 'X-KM-Sig-Alg'];

describe('signing on the native transport (signing-813, SPT-06)', () => {
  it('every request through the module carries the five X-KM-* headers, on a POST and on a PUT', async () => {
    const { sdk, native, mockFetch, make } = boot();
    const client = make({ enableSigning: true, _keyStore: new sdk.MemoryKeyStore(), _signer: makeSigner() });

    await client.devices.register({ pushToken: TOKEN, platform: 'ios' });
    await client.devices.updateMetadata({ plan: 'free' }, TOKEN);

    const calls = received(native);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v1/devices/register', 'PUT /v1/devices/metadata']);
    for (const call of calls) {
      expect(KM.filter((name) => !call.headers[name])).toEqual([]);
      expect(call.headers['X-KM-Signature']).toBe('SIGNATURE_BASE64==');
      expect(call.headers['X-KM-Sig-Alg']).toBe('ES256');
      expect(call.headers['X-KM-Timestamp']).toMatch(/^\d+$/);
      expect(call.headers.Authorization).toBe('Bearer pk_live_seam');
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('the signature is made over the canonical string of the request, the same one the fetch path signs', async () => {
    const viaModule = boot();
    const signerA = makeSigner();
    const a = viaModule.make({ enableSigning: true, _keyStore: new viaModule.sdk.MemoryKeyStore(), _signer: signerA });
    await a.devices.updateMetadata({ plan: 'free' }, TOKEN);
    const call = received(viaModule.native)[0];

    // The canonical string the signer got, decoded, is the one the server rebuilds from the headers and the body.
    const signed = Buffer.from(signerA.sign.mock.calls[0][1] as string, 'base64').toString('utf8');
    const { buildCanonical, sha256HexUtf8 } = viaModule.sdk;
    expect(signed).toBe(
      buildCanonical('PUT', '/v1/devices/metadata', '', sha256HexUtf8(call.rawBody as string), call.headers['X-KM-Timestamp'], call.headers['X-KM-Nonce'], call.headers['X-KM-Device-Id']),
    );

    // The same call with privateTransport js signs the same method, path, query, body hash and time.
    const viaFetch = boot();
    const signerB = makeSigner();
    const b = viaFetch.make({ privateTransport: 'js', enableSigning: true, _keyStore: new viaFetch.sdk.MemoryKeyStore(), _signer: signerB });
    await b.devices.updateMetadata({ plan: 'free' }, TOKEN);
    const other = Buffer.from(signerB.sign.mock.calls[0][1] as string, 'base64').toString('utf8');
    expect(viaFetch.mockFetch).toHaveBeenCalledTimes(1);

    const fields = (canonical: string) => canonical.split('\n');
    expect(fields(signed)).toHaveLength(7);
    // method, path, query, body hash, timestamp are equal; the nonce (5) and the device id (6) are random per install.
    expect(fields(signed).slice(0, 5)).toEqual(fields(other).slice(0, 5));
  });
});

describe('the offline queue on the native transport (offline-queue, SPT-06)', () => {
  it('a network rejection of the module keeps the event', async () => {
    const { native, make } = boot();
    native.request.mockRejectedValueOnce(Object.assign(new Error('no_connection'), { code: 'no_connection' }));
    const client = make();

    await expect(client.devices.trackOpen(42)).resolves.toBeUndefined();

    expect(await client.queueStats()).toEqual({ pending: 1, dropped: 0 });
  });

  it('a 429 with Retry-After: 5 pauses the queue for five seconds, then the event goes', async () => {
    const { native, make } = boot();
    native.request.mockResolvedValueOnce(answer(429, 'Too Many Requests', '{"code":"rate_limited"}', '5'));
    const client = make();
    await client.devices.trackOpen(1);
    expect(await client.queueStats()).toEqual({ pending: 1, dropped: 0 });
    native.request.mockClear();

    await jest.advanceTimersByTimeAsync(4 * SECOND);
    await client.devices.trackOpen(2); // a new event during the pause is kept, not sent
    expect(native.request).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2 * SECOND);

    expect(received(native).map((c) => c.body.notification_id)).toEqual([1, 2]);
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 });
  });

  it('a 400 drops the event and counts it, with no second attempt', async () => {
    const { native, make } = boot();
    native.request.mockResolvedValueOnce(answer(400, 'Bad Request', '{"code":"invalid_request"}'));
    const client = make();

    await client.devices.trackOpen(42);
    await jest.advanceTimersByTimeAsync(10 * 60 * SECOND);

    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 1 });
    expect(native.request).toHaveBeenCalledTimes(1);
  });
});

describe('the batcher on the native transport (track-batch-client, SPT-06)', () => {
  it('45 received events leave as 3 requests to the batch route, up to the batch size, with the token once per request', async () => {
    const { native, mockFetch, make } = boot();
    native.request.mockImplementation(async (_m: string, url: string, _h: string[], body: string | null) =>
      url.endsWith(BATCH) ? answer(200, 'OK', JSON.stringify({ recorded: JSON.parse(body as string).events.length, rejected: 0, results: [] })) : OK,
    );
    const client = make();

    for (let i = 1; i <= 45; i++) await client.devices.trackReceived(i);
    await jest.advanceTimersByTimeAsync(0);

    const sent = received(native);
    expect(sent.map((c) => [c.method, c.path, c.body.events.length])).toEqual([
      ['POST', BATCH, 20],
      ['POST', BATCH, 20],
      ['POST', BATCH, 5],
    ]);
    expect(sent.every((c) => c.body.push_token === TOKEN)).toBe(true);
    expect(sent[0].body.events[0]).toEqual({ notification_id: 1, event: 'received' });
    expect(await client.queueStats()).toEqual({ pending: 0, dropped: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('the requirePinning guard on the native transport (pinning-visible, SPT-06)', () => {
  it('refuses before the module is called while the pins are off, and lets calls through once the module holds the pins', async () => {
    const { sdk, native, mockFetch, make } = boot();
    const client = make({ requirePinning: true });

    const refused: any = await client.devices.identify({ externalId: 'u1' }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(sdk.EspressoNotifyError);
    expect(refused.code).toBe('PINNING_NOT_ACTIVE');
    await expect(client.devices.trackEvent('signed_up')).resolves.toBeUndefined(); // the calls that never throw are dropped
    expect(native.request).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();

    await expect(sdk.enableCertificatePinning(PINS)).resolves.toBe(true);
    expect(native.setPins).toHaveBeenCalledTimes(1);
    await client.devices.identify({ externalId: 'u1' });
    expect(received(native).map((c) => c.path)).toEqual(['/v1/devices/identify']);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses again after the pins are cleared, and the module gets no further request', async () => {
    const { sdk, native, make } = boot();
    const client = make({ requirePinning: true });
    await sdk.enableCertificatePinning(PINS);
    await client.devices.identify({ externalId: 'u1' });
    expect(native.request).toHaveBeenCalledTimes(1);

    await sdk.disableCertificatePinning();

    expect(native.clearPins).toHaveBeenCalledTimes(1);
    const refused: any = await client.devices.identify({ externalId: 'u1' }).catch((e: unknown) => e);
    expect(refused.code).toBe('PINNING_NOT_ACTIVE');
    expect(native.request).toHaveBeenCalledTimes(1);
  });
});

describe('concurrent calls on the native transport (SPT-22)', () => {
  it('30 calls with distinct bodies each get their own answer, whatever the order the module settles them', async () => {
    const { native, make } = boot();
    const settle: Array<() => void> = [];
    native.request.mockImplementation(
      (_m: string, _u: string, _h: string[], body: string | null) =>
        new Promise((resolve) => {
          const who = JSON.parse(body as string).external_id as string;
          settle.push(() => resolve(answer(200, 'OK', JSON.stringify([{ category_identifier: `for-${who}`, opted_out: true }]))));
        }),
    );
    const client = make();

    const calls = Array.from({ length: 30 }, (_, i) => client.devices.getPreferences(`user-${i}`, TOKEN));
    await jest.advanceTimersByTimeAsync(0);
    expect(settle).toHaveLength(30);
    settle.reverse().forEach((done) => done()); // the last one asked answers first

    const results = await Promise.all(calls);
    expect(results.map((r: any[]) => r[0].categoryIdentifier)).toEqual(Array.from({ length: 30 }, (_, i) => `for-user-${i}`));
  });
});

export {};
