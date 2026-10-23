/**
 * @jest-environment node
 *
 * sdk-private-transport T12 (SPT-49, SPT-53; the option names of SPT-57 are checked in log-allowlist.test.ts): the real client runs every public call with every boolean
 * option on and sentinel values in every argument, while the network answers in turn with each class of failure, and
 * the six console methods are spied. No sentinel may appear in any console argument, in the message, the `path` or
 * the `code` of any error the SDK raised, or in any request URL. Only the edges are fake: fetch, the native signer and
 * the App Attest module, and they fail with harmless text.
 */

const S = {
  token: 'SENTINEL_TOKEN_7f3a',
  external: 'SENTINEL_EXTERNAL_7f3a',
  identity: 'SENTINEL_IDENTITYHASH_7f3a',
  project: 'pk_live_SENTINEL_PROJECT_7f3a',
  signingKey: 'SENTINEL_SIGNINGKEY_7f3a',
  notification: 7316254,
  event: 'event.SENTINEL_EVENT_7f3a',
  meta: 'SENTINEL_META_7f3a',
  device: 'SENTINEL_DEVICE_7f3a',
  category: 'SENTINEL_CATEGORY_7f3a',
};
/** Every text that must never come out; the notification id as the digits it is written with. */
const NEEDLES = [S.token, S.external, S.identity, S.project, S.signingKey, String(S.notification), S.event, S.meta, S.device, S.category];

type Mode = 'ok' | 'http500' | 'http403' | 'html502' | 'network' | 'rejectsText' | 'signerDown';
const MODES: Mode[] = ['ok', 'http500', 'http403', 'html502', 'network', 'rejectsText', 'signerDown'];
const CONSOLE_METHODS = ['log', 'info', 'debug', 'warn', 'error', 'trace'] as const;

class MemoryStore {
  readonly map = new Map<string, string>();
  async getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  async setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

interface Harness {
  sdk: any;
  mode: Mode;
  logs: { method: string; text: string }[];
  urls: string[];
  errors: { label: string; error: any }[];
  make: (extra?: Record<string, unknown>) => any;
  restore: () => void;
}

function boot(): Harness {
  jest.resetModules();
  jest.useFakeTimers({ now: 1_700_000_000_000 });
  const h = { mode: 'ok' as Mode, logs: [] as Harness['logs'], urls: [] as string[], errors: [] as Harness['errors'] } as Harness;

  const spies = CONSOLE_METHODS.map((method) =>
    jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      h.logs.push({ method, text: args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ') });
    }),
  );

  const signerDown = () => h.mode === 'signerDown';
  jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: 17 }, AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) } }), { virtual: true });
  jest.doMock('expo-notifications', () => ({}), { virtual: true });
  jest.doMock(
    'react-native-secure-sign',
    () => ({
      generate: async () => {
        if (signerDown()) throw new Error('the signer is down');
        return S.signingKey;
      },
      sign: async () => {
        if (signerDown()) throw new Error('the signer is down');
        return 'SIGNATURE==';
      },
      getPublicKey: async () => S.signingKey,
      removeKey: async () => undefined,
      checkHardwareSupport: async () => true,
    }),
    { virtual: true },
  );
  jest.doMock(
    'react-native-ios-appattest',
    () => ({
      attestationSupported: async () => true,
      generateKeys: async () => {
        if (signerDown()) throw new Error('the attest module is down');
        return 'KEY_ID==';
      },
      attestKeys: async () => 'CBOR_ATTESTATION==',
      attestRequestData: async () => 'ASSERTION==',
    }),
    { virtual: true },
  );

  const answer = (status: number, body: string) => ({ ok: status < 300, status, statusText: status < 300 ? 'OK' : 'Failure', text: async () => body });
  globalThis.fetch = jest.fn(async (url: unknown) => {
    const full = String(url);
    h.urls.push(full);
    const path = full.replace('__ESPRESSO_API_URL__', '');
    switch (h.mode) {
      case 'http500':
        return answer(500, JSON.stringify({ code: 'server_error' }));
      case 'http403':
        return answer(403, JSON.stringify({ error: 'identity_verification_failed', code: 'identity_verification_failed' }));
      case 'html502':
        return answer(502, '<html>Bad gateway</html>');
      case 'network':
        throw new TypeError('Network request failed');
      case 'rejectsText':
        throw 'the connection was reset'; // eslint-disable-line no-throw-literal
      default:
        break;
    }
    if (path.startsWith('/v1/attest/challenge')) return answer(200, JSON.stringify({ challenge: 'CHALLENGE', expires_in_seconds: 300 }));
    if (path.startsWith('/v1/attest/verify')) return answer(200, JSON.stringify({ attested: true, environment: 'production' }));
    if (path.startsWith('/v1/preferences/query') || path.startsWith('/v1/notifications/categories')) return answer(200, '[]');
    return answer(200, '{}');
  }) as unknown as typeof fetch;

  h.sdk = require('../src/index');
  h.make = (extra = {}) =>
    new h.sdk.PushClient({
      projectId: S.project,
      pushToken: S.token,
      platform: 'ios',
      autoTrack: true,
      handleDeepLinks: true,
      enableSigning: true,
      enableAttestation: true,
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
  h.restore = () => {
    spies.forEach((spy) => spy.mockRestore());
    jest.useRealTimers();
  };
  return h;
}

/** Runs one public call, keeping the error it raised (the call may also resolve). */
async function attempt(h: Harness, label: string, call: () => Promise<unknown>) {
  try {
    await call();
  } catch (error) {
    h.errors.push({ label, error });
  }
}

/** Every place the SDK could have written a sentinel: console arguments, error fields, request URLs. */
function surfaces(h: Harness): { where: string; text: string }[] {
  return [
    ...h.logs.map((l, i) => ({ where: `console.${l.method} #${i}`, text: l.text })),
    ...h.errors.flatMap(({ label, error }) => [
      { where: `${label} error message`, text: String(error?.message ?? error) },
      { where: `${label} error path`, text: String(error?.path ?? '') },
      { where: `${label} error code`, text: String(error?.code ?? '') },
      { where: `${label} error name`, text: String(error?.name ?? '') },
    ]),
    ...h.urls.map((u, i) => ({ where: `request URL #${i}`, text: u })),
  ];
}

function expectNoSentinel(h: Harness) {
  const found: string[] = [];
  for (const { where, text } of surfaces(h)) {
    for (const needle of NEEDLES) if (text.includes(needle)) found.push(`${needle} in ${where}: ${text.slice(0, 160)}`);
  }
  expect(found).toEqual([]);
}

/** The public calls of the client, each with sentinel values in every argument. */
const CALLS: [string, (c: any) => Promise<unknown>][] = [
  ['register', (c) => c.devices.register({ pushToken: S.token, platform: 'ios', deviceId: S.device, user: { name: S.meta, externalId: S.external, identityHash: S.identity }, metadata: { k: S.meta } })],
  ['identify', (c) => c.devices.identify({ externalId: S.external, name: S.meta, identityHash: S.identity, metadata: { k: S.meta } }, S.token)],
  ['unregister', (c) => c.devices.unregister(S.token)],
  ['updateMetadata', (c) => c.devices.updateMetadata({ k: S.meta }, S.token)],
  [
    'trackEvent',
    async (c) => {
      await c.devices.trackEvent(S.event, S.token);
      await c.devices.trackEvent(`bad name ${S.event}`, S.token); // refused with a warning
    },
  ],
  [
    'trackConversion',
    async (c) => {
      await c.devices.trackConversion(S.notification, S.token);
      await c.devices.trackConversion(`bad ${S.event}` as never, S.token); // refused with a warning
    },
  ],
  [
    'flush',
    async (c) => {
      await c.devices.trackOpen(S.notification, S.token);
      await c.devices.trackClick(S.notification, S.token);
      await c.devices.trackReceived(S.notification, S.token);
      await c.devices.trackDismissed(S.notification, S.token);
      await c.devices.trackAppOpened(S.token);
      await c.flush();
    },
  ],
  ['getCategories', (c) => c.devices.registerCategories()],
  ['getPreferences', (c) => c.devices.getPreferences(S.external, S.token)],
  ['setPreferences', (c) => c.devices.setPreferences([{ categoryIdentifier: S.category, optedOut: true }], S.external, S.token)],
  ['forgetDevice', (c) => c.devices.forgetDevice({ pushToken: S.token, deviceId: S.device, identityHash: S.identity })],
  [
    'attest',
    async (c) => {
      await c.devices.register({ pushToken: S.token, platform: 'ios' });
      await c.devices.attest();
    },
  ],
];

describe('nothing sensitive reaches a log, an error or a path (SPT-49, SPT-53)', () => {
  it.each(CALLS)('%s, whether the network works or fails in any way', async (name, call) => {
    const h = boot();
    try {
      const client = h.make();
      for (const mode of MODES) {
        h.mode = mode;
        await attempt(h, `${name}/${mode}`, () => call(client));
        await attempt(h, `${name}/${mode}`, () => jest.advanceTimersByTimeAsync(60_000));
      }
      client.destroy();
      expect(h.urls.length).toBeGreaterThan(0); // the calls did go out
      expectNoSentinel(h);
    } finally {
      h.restore();
    }
  });

  it('the whole lifecycle in one run: only warnings, each queue and link warning once, no sentinel', async () => {
    const h = boot();
    try {
      const client = h.make();
      for (const mode of MODES) {
        h.mode = mode;
        for (const [name, call] of CALLS) {
          await attempt(h, `${name}/${mode}`, () => call(client));
        }
        await attempt(h, `time/${mode}`, () => jest.advanceTimersByTimeAsync(60_000));
      }
      client.destroy();

      expectNoSentinel(h);
      // Only `warn` is used, and every text is one the SDK wrote with its own name in front.
      expect(h.logs.filter((l) => l.method !== 'warn')).toEqual([]);
      expect(h.logs.length).toBeGreaterThan(0);
      expect(h.logs.filter((l) => !l.text.startsWith('[espresso-notify]'))).toEqual([]);
      // What the code says to show once, shows once.
      const once = h.logs.map((l) => l.text).filter((t) => /^\[espresso-notify\] (offline queue|handleDeepLinks|Some device metadata)/.test(t));
      expect(once.filter((t, i) => once.indexOf(t) !== i)).toEqual([]);
    } finally {
      h.restore();
    }
  });

  it('every call refused by the pinning guard (requirePinning on) names no value either', async () => {
    const h = boot();
    try {
      const client = h.make({ requirePinning: true });
      h.mode = 'ok';
      for (const [name, call] of CALLS) {
        await attempt(h, `${name}/pinning`, () => call(client));
      }
      await attempt(h, 'time/pinning', () => jest.advanceTimersByTimeAsync(60_000));
      client.destroy();

      expect(h.errors.some((e) => e.error?.code === 'PINNING_NOT_ACTIVE')).toBe(true);
      expectNoSentinel(h);
    } finally {
      h.restore();
    }
  });
});

export {};
