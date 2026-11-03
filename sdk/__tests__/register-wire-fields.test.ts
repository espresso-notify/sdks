/**
 * @jest-environment node
 *
 * feature: registration.sdk-marker
 * feature: registration.device-id
 * feature: metadata.language
 *
 * sdk-parity T62 (PAR-78, PAR-80): the register body of the React Native SDK always names the SDK (`sdk`), carries a
 * `device_id` (the install id kept as `espresso.deviceId`, unless the app passes its own) and the device language, both
 * as top-level `language` and as `metadata.locale`, with request signing on and off.
 */

// A module, not a script: two test files that declare the same names in the global scope collide (TS2451).
export {};

const ABSENT = () => {
  throw new Error('not found');
};

const mockFetch = jest.fn();

/** One storage behind every wrapper, as production has (`backing` names it). */
function storage() {
  const map = new Map<string, string>();
  return {
    map,
    store: {
      backing: map,
      async getItem(k: string) { return map.get(k) ?? null; },
      async setItem(k: string, v: string) { map.set(k, v); },
    },
  };
}

const signer = () => ({
  generate: jest.fn().mockResolvedValue('SPKI=='),
  sign: jest.fn().mockResolvedValue('SIG=='),
  getPublicKey: jest.fn().mockResolvedValue('SPKI=='),
  isSupported: jest.fn().mockResolvedValue(true),
});

function boot(opts: { localization?: unknown; signing?: boolean }) {
  jest.resetModules();
  jest.doMock('expo-notifications', () => ({}), { virtual: true });
  jest.doMock('expo-device', ABSENT, { virtual: true });
  jest.doMock('expo-application', ABSENT, { virtual: true });
  jest.doMock('expo-localization', opts.localization === undefined ? ABSENT : () => opts.localization, { virtual: true });
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve(JSON.stringify({ success: true })) });
  (globalThis as any).fetch = mockFetch;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PushClient } = require('../src/index');
  const kv = storage();
  const client = new PushClient({
    projectId: 'pk_live_test-key',
    autoTrack: false,
    _queueStore: kv.store,
    ...(opts.signing ? { enableSigning: true, _keyStore: kv.store, _signer: signer() } : {}),
  });
  return { client, kv };
}

const registerCall = () => mockFetch.mock.calls.find(([u]: [string]) => u.includes('/v1/devices/register'))!;
const registerBody = () => JSON.parse(registerCall()[1].body);
const PT = { getLocales: () => [{ languageTag: 'pt-BR' }, { languageTag: 'en-US' }], getCalendars: () => [{ timeZone: 'America/Sao_Paulo' }] };

describe('register wire fields (PAR-78, PAR-80)', () => {
  it('without an app deviceId and without signing: sdk marker, the stored install id and the language twice', async () => {
    const { client, kv } = boot({ localization: PT });
    await client.devices.register({ pushToken: 'tok', platform: 'ios' });
    const body = registerBody();
    const stored = kv.map.get('espresso.deviceId');
    expect(stored).toMatch(/^[0-9a-f]{32}$/);
    expect(body.sdk).toBe('react-native');
    expect(body.device_id).toBe(stored);
    expect(body.language).toBe('pt-BR');
    expect(body.metadata.locale).toBe('pt-BR');
  });

  it('a second register sends the same install id (it is created once)', async () => {
    const { client } = boot({ localization: PT });
    await client.devices.register({ pushToken: 'tok', platform: 'ios' });
    await client.devices.register({ pushToken: 'tok', platform: 'ios' });
    const ids = mockFetch.mock.calls.filter(([u]: [string]) => u.includes('/v1/devices/register')).map(([, o]: any) => JSON.parse(o.body).device_id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('with an app deviceId and without signing: the app value is sent, the marker and the language still are', async () => {
    const { client } = boot({ localization: PT });
    await client.devices.register({ pushToken: 'tok', platform: 'android', deviceId: 'app-chosen-id' });
    const body = registerBody();
    expect(body.device_id).toBe('app-chosen-id');
    expect(body.sdk).toBe('react-native');
    expect(body.language).toBe('pt-BR');
    expect(body.metadata.locale).toBe('pt-BR');
  });

  it('with signing on: the install id is the signing id and the marker and the language are sent', async () => {
    const { client, kv } = boot({ localization: PT, signing: true });
    await client.devices.register({ pushToken: 'tok', platform: 'ios' });
    const [, init] = registerCall();
    const body = JSON.parse(init.body);
    const stored = kv.map.get('espresso.deviceId');
    expect(body.device_id).toBe(stored);
    expect(init.headers['X-KM-Device-Id']).toBe(stored);
    expect(body.sdk).toBe('react-native');
    expect(body.language).toBe('pt-BR');
    expect(body.metadata.locale).toBe('pt-BR');
  });

  it('with signing on and an app deviceId: the signing id wins, as before', async () => {
    const { client, kv } = boot({ localization: PT, signing: true });
    await client.devices.register({ pushToken: 'tok', platform: 'ios', deviceId: 'app-chosen-id' });
    expect(registerBody().device_id).toBe(kv.map.get('espresso.deviceId'));
  });

  it('a device without a readable language sends neither language nor metadata.locale', async () => {
    const { client } = boot({});
    await client.devices.register({ pushToken: 'tok', platform: 'ios' });
    const body = registerBody();
    expect(body).not.toHaveProperty('language');
    expect(body.metadata?.locale).toBeUndefined();
  });

  it('a metadata.locale the app sets is the language too', async () => {
    const { client } = boot({ localization: PT });
    await client.devices.register({ pushToken: 'tok', platform: 'ios', metadata: { locale: 'es-MX' } });
    const body = registerBody();
    expect(body.language).toBe('es-MX');
    expect(body.metadata.locale).toBe('es-MX');
  });
});
