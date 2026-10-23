/**
 * @jest-environment node
 *
 * sdk-private-transport T23 (SPT-01, SPT-25, SPT-26): a Reactotron-style harness proves that, with the native module
 * linked, the SDK leaves no trace in the JavaScript network layer.
 *
 * The harness is written for this test (no Reactotron package). Before the client is built it patches
 * `XMLHttpRequest.prototype.open`, `setRequestHeader` and `send`, and wraps `globalThis.fetch`, the two places such
 * tools hook into. The `fetch` underneath is an XHR-backed one, like the one React Native ships, so a request that goes
 * through `fetch` is seen in both layers. The whole lifecycle then runs: register, identify, metadata, categories,
 * preferences (write and read), attest, tracking (single, batch flush), a network outage with the replay of the offline
 * queue, forget device and unregister. The same run without the module is the negative control: it must capture every
 * one of those calls, or the harness proves nothing.
 */

const API = 'https://api.example.test';
const TOKEN = 'ExponentPushToken[capture-test]';

/** Every request the lifecycle makes, as `METHOD path`. */
const EXPECTED = [
  'POST /v1/devices/register',
  'POST /v1/devices/identify',
  'PUT /v1/devices/metadata',
  'GET /v1/notifications/categories',
  'POST /v1/preferences',
  'POST /v1/preferences/query',
  'POST /v1/attest/challenge',
  'POST /v1/attest/verify',
  'POST /v1/notifications/track',
  'POST /v1/notifications/track/batch',
  'DELETE /v1/devices',
  'POST /v1/devices/unregister',
];

class MemoryStore {
  readonly map = new Map<string, string>();
  async getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  async setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

/** The body the server would answer, by path. */
function bodyFor(path: string): string {
  if (path === '/v1/attest/challenge') return JSON.stringify({ challenge: 'CHALLENGE', expires_in_seconds: 300 });
  if (path === '/v1/attest/verify') return JSON.stringify({ attested: true, environment: 'production' });
  if (path === '/v1/preferences/query' || path === '/v1/notifications/categories') return '[]';
  if (path === '/v1/notifications/track/batch') return JSON.stringify({ recorded: 1, rejected: 0, results: [] });
  return '{}';
}

interface Capture {
  xhrOpen: string[];
  xhrSetRequestHeader: number;
  xhrSend: number;
  wrappedFetch: string[];
  baseFetch: number;
  module: string[];
  /** While true the network is down: the module rejects with `no_connection` and the XHR fails. */
  offline: boolean;
}

interface Harness {
  cap: Capture;
  make: (extra?: Record<string, unknown>) => any;
  run: (client: any) => Promise<void>;
  restore: () => void;
}

/** A fresh copy of the SDK, the Reactotron-style patches in place, the native module linked or not. */
function boot(withModule: boolean): Harness {
  jest.resetModules();
  jest.useFakeTimers({ now: 1_700_000_000_000 });
  jest.spyOn(console, 'warn').mockImplementation(() => {});

  const cap: Capture = { xhrOpen: [], xhrSetRequestHeader: 0, xhrSend: 0, wrappedFetch: [], baseFetch: 0, module: [], offline: false };

  // The fake XMLHttpRequest of the platform and, over it, the patch of the inspector (set before the client is built).
  class FakeXHR {
    private target = '';
    onResolve: ((answer: { status: number; text: string }) => void) | null = null;
    open(_method: string, url: string) {
      this.target = url;
    }
    setRequestHeader(_name: string, _value: string) {}
    send(_body?: string) {
      const path = this.target.replace(API, '');
      if (cap.offline) throw new TypeError('Network request failed');
      this.onResolve?.({ status: 200, text: bodyFor(path) });
    }
  }
  const proto = FakeXHR.prototype;
  const realOpen = proto.open;
  const realSetHeader = proto.setRequestHeader;
  const realSend = proto.send;
  proto.open = function (this: FakeXHR, method: string, url: string) {
    cap.xhrOpen.push(`${method.toUpperCase()} ${url.replace(API, '')}`);
    return realOpen.call(this, method, url);
  };
  proto.setRequestHeader = function (this: FakeXHR, name: string, value: string) {
    cap.xhrSetRequestHeader += 1;
    return realSetHeader.call(this, name, value);
  };
  proto.send = function (this: FakeXHR, body?: string) {
    cap.xhrSend += 1;
    return realSend.call(this, body);
  };
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXHR;

  // The `fetch` of the platform, built over XHR, and the wrap of the inspector over it.
  const baseFetch = (url: unknown, init: any = {}) =>
    new Promise((resolve, reject) => {
      cap.baseFetch += 1;
      const xhr = new (globalThis as any).XMLHttpRequest() as FakeXHR;
      xhr.onResolve = ({ status, text }) => resolve({ ok: status < 300, status, statusText: 'OK', text: async () => text });
      try {
        xhr.open(init.method ?? 'GET', String(url));
        for (const name of Object.keys(init.headers ?? {})) xhr.setRequestHeader(name, String(init.headers[name]));
        xhr.send(init.body);
      } catch (error) {
        reject(error);
      }
    });
  globalThis.fetch = ((url: unknown, init: any) => {
    cap.wrappedFetch.push(`${String(init?.method ?? 'GET').toUpperCase()} ${String(url).replace(API, '')}`);
    return baseFetch(url, init);
  }) as unknown as typeof fetch;

  const nativeRequest = jest.fn(async (method: string, url: string) => {
    cap.module.push(`${method} ${url.replace(API, '')}`);
    if (cap.offline) throw Object.assign(new Error('no_connection'), { code: 'no_connection' });
    return { status: 200, statusText: 'OK', retryAfter: '', body: bodyFor(url.replace(API, '')) };
  });
  jest.doMock(
    'react-native',
    () => ({
      Platform: { OS: 'ios', Version: 17 },
      AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
      ...(withModule
        ? {
            TurboModuleRegistry: {
              get: (name: string) =>
                name === 'EspressoNotifyTransport'
                  ? { getConstants: () => ({ contractVersion: 1 }), request: nativeRequest, setPins: jest.fn(), clearPins: jest.fn() }
                  : null,
            },
          }
        : {}),
    }),
    { virtual: true },
  );
  jest.doMock('expo-notifications', () => ({}), { virtual: true });
  jest.doMock(
    'react-native-secure-sign',
    () => ({
      generate: async () => 'SIGNING_KEY==',
      sign: async () => 'SIGNATURE==',
      getPublicKey: async () => 'SIGNING_KEY==',
      removeKey: async () => undefined,
      checkHardwareSupport: async () => true,
    }),
    { virtual: true },
  );
  jest.doMock(
    'react-native-ios-appattest',
    () => ({
      attestationSupported: async () => true,
      generateKeys: async () => 'KEY_ID==',
      attestKeys: async () => 'CBOR_ATTESTATION==',
      attestRequestData: async () => 'ASSERTION==',
    }),
    { virtual: true },
  );

  const sdk = require('../src/index');
  const make = (extra: Record<string, unknown> = {}) =>
    new sdk.PushClient({
      projectId: 'pk_live_capture',
      pushToken: TOKEN,
      platform: 'ios',
      autoTrack: false,
      handleDeepLinks: true,
      enableSigning: true,
      enableAttestation: true,
      _apiUrl: API,
      _queueStore: new MemoryStore(),
      _keyStore: new MemoryStore(),
      displayAdapter: {
        onResponse: () => () => {},
        onReceived: () => () => {},
        onDismissed: () => () => {},
        supportsCategories: () => true,
        setCategories: async () => {},
      },
      ...extra,
    });

  /** The whole lifecycle of the issue, in one client. */
  const run = async (client: any) => {
    const d = client.devices;
    await d.register({ pushToken: TOKEN, platform: 'ios', deviceId: 'device-1', user: { name: 'Ana', externalId: 'u1' } });
    await d.identify({ externalId: 'u1', name: 'Ana' }, TOKEN);
    await d.updateMetadata({ plan: 'free' }, TOKEN);
    await d.registerCategories();
    await d.setPreferences([{ categoryIdentifier: 'news', optedOut: true }], 'u1', TOKEN);
    await d.getPreferences('u1', TOKEN);
    await d.attest();
    await d.trackEvent('level_up', TOKEN);
    await d.trackReceived(11, TOKEN);
    await d.trackReceived(12, TOKEN);
    await client.flush(); // the two received events leave as one batch
    // The network goes down: the click is kept by the offline queue, and goes out when the network is back.
    cap.offline = true;
    await d.trackClick(13, TOKEN);
    cap.offline = false;
    await jest.advanceTimersByTimeAsync(300_000);
    await d.forgetDevice({ pushToken: TOKEN, deviceId: 'device-1' });
    await d.unregister(TOKEN);
    await jest.advanceTimersByTimeAsync(60_000);
  };

  return {
    cap,
    make,
    run,
    restore: () => {
      jest.restoreAllMocks();
      jest.useRealTimers();
      delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
    },
  };
}

let h: Harness | undefined;
afterEach(() => {
  h?.restore();
  h = undefined;
});

/** The distinct `METHOD path` of a list, in the order they first appear. */
const distinct = (list: string[]) => [...new Set(list)];

describe('with the native module linked, nothing reaches the JavaScript network layer (SPT-01, SPT-25)', () => {
  it.each([
    ['the default (auto)', {}],
    ["'native'", { privateTransport: 'native' }],
  ])('%s: 0 XHR calls, 0 wrapped fetch calls and 0 fetch calls through the whole lifecycle', async (_name, extra) => {
    h = boot(true);
    const client = h.make(extra);
    expect(client.transportKind).toBe('native');
    await h.run(client);
    client.destroy();

    expect(h.cap.module.length).toBeGreaterThan(EXPECTED.length - 1); // the lifecycle did go out, so the zeros mean something
    expect(h.cap.xhrOpen).toEqual([]);
    expect(h.cap.xhrSetRequestHeader).toBe(0);
    expect(h.cap.xhrSend).toBe(0);
    expect(h.cap.wrappedFetch).toEqual([]);
    expect(h.cap.baseFetch).toBe(0);
  });

  it('the fake module received every request of the lifecycle with the right path and method, and no other', async () => {
    h = boot(true);
    const client = h.make();
    await h.run(client);
    client.destroy();

    expect(distinct(h.cap.module).sort()).toEqual([...EXPECTED].sort());
    // The outage: the click reached the module while the network was down and again when the queue replayed it.
    expect(h.cap.module.filter((r) => r === 'POST /v1/notifications/track').length).toBeGreaterThanOrEqual(3); // trackEvent, the click, its replay
    // No query string and no fragment ever travels in a path (the preferences read is a body, not a URL).
    expect(h.cap.module.filter((r) => /[?#]/.test(r))).toEqual([]);
  });
});

describe('without the module, the same run is captured (the negative control, SPT-26)', () => {
  it('captures every request of the lifecycle in the XHR layer and in the wrapped fetch', async () => {
    h = boot(false);
    const client = h.make();
    expect(client.transportKind).toBe('js');
    await h.run(client);
    client.destroy();

    expect(distinct(h.cap.wrappedFetch).sort()).toEqual([...EXPECTED].sort());
    expect(distinct(h.cap.xhrOpen).sort()).toEqual([...EXPECTED].sort());
    expect(h.cap.xhrSend).toBe(h.cap.xhrOpen.length);
    expect(h.cap.xhrSetRequestHeader).toBeGreaterThan(0);
    expect(h.cap.baseFetch).toBe(h.cap.wrappedFetch.length);
    expect(h.cap.module).toEqual([]);
  });

  it("with the module linked and privateTransport: 'js', the harness captures the run too", async () => {
    h = boot(true);
    const client = h.make({ privateTransport: 'js' });
    expect(client.transportKind).toBe('js');
    await h.run(client);
    client.destroy();

    expect(distinct(h.cap.wrappedFetch).sort()).toEqual([...EXPECTED].sort());
    expect(distinct(h.cap.xhrOpen).sort()).toEqual([...EXPECTED].sort());
    expect(h.cap.module).toEqual([]);
  });

  it('the capture and the module see the same set of requests, so the zeros above are not a different lifecycle', async () => {
    const withModule = boot(true);
    const a = withModule.make();
    await withModule.run(a);
    a.destroy();
    const viaModule = distinct(withModule.cap.module).sort();
    withModule.restore();

    h = boot(false);
    const b = h.make();
    await h.run(b);
    b.destroy();

    expect(distinct(h.cap.wrappedFetch).sort()).toEqual(viaModule);
  });
});

export {};
