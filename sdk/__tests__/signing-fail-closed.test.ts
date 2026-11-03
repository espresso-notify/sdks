/**
 * @jest-environment node
 *
 * sdk-parity T27 (PAR-20, PAR-21, PAR-22): when signing is on and a request cannot be signed, the SDK does not send it
 * unsigned. A direct call rejects with the typed signing error, an event in the offline queue stays queued, and the
 * routes the server exempts from signing (register, attestation) keep working.
 *
 * feature: security.request-signing
 */
import { PushClient, MemoryKeyStore, EspressoNotifySigningError, EspressoNotifyError } from '../src/index';
import type { Signer } from '../src/index';

jest.mock('expo-notifications', () => ({}), { virtual: true });

const mockFetch = jest.fn();
globalThis.fetch = mockFetch;

class MemoryStore {
  readonly map = new Map<string, string>();
  async getItem(key: string) { return this.map.get(key) ?? null; }
  async setItem(key: string, value: string) { this.map.set(key, value); }
  async removeItem(key: string) { this.map.delete(key); }
}

/** A signer whose `sign` the test controls. */
function signer(sign: Signer['sign']): Signer {
  return {
    generate: jest.fn().mockResolvedValue('PUB=='),
    sign,
    getPublicKey: jest.fn().mockResolvedValue('PUB=='),
    isSupported: jest.fn().mockResolvedValue(true),
  };
}

function client(s: Signer, extra: Record<string, unknown> = {}) {
  return new PushClient({
    projectId: 'pk_live_test',
    pushToken: 'tok',
    platform: 'ios',
    autoTrack: false,
    enableSigning: true,
    _keyStore: new MemoryKeyStore(),
    _signer: s,
    ...extra,
  });
}

const failing = () => signer(jest.fn().mockRejectedValue(new Error('SENTINEL_SIGNER_TEXT')));
const paths = () => mockFetch.mock.calls.map(([url]) => String(url).replace(/^.*?(\/v1\/)/, '$1'));

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve('{}') });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('a direct call on a signed route (PAR-20, PAR-22)', () => {
  it.each([
    ['identify', (c: PushClient) => c.devices.identify({ externalId: 'u1' })],
    ['unregister', (c: PushClient) => c.devices.unregister()],
    ['forgetDevice', (c: PushClient) => c.devices.forgetDevice()],
    ['getPreferences', (c: PushClient) => c.devices.getPreferences('u1')],
  ])('%s rejects with SIGNING_FAILED and sends nothing', async (_name, call) => {
    const err: any = await call(client(failing())).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EspressoNotifySigningError);
    expect(err).toBeInstanceOf(EspressoNotifyError);
    expect(err.code).toBe('SIGNING_FAILED');
    expect(err.message).not.toContain('SENTINEL');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends nothing either when the signer cannot make a key at all', async () => {
    const noKey: Signer = { ...signer(jest.fn()), generate: jest.fn().mockRejectedValue(new Error('no hardware')) };
    const err: any = await client(noKey).devices.identify({ externalId: 'u1' }).catch((e: unknown) => e);

    expect(err.code).toBe('SIGNING_FAILED');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('signs and sends as before when the signer works', async () => {
    const c = client(signer(jest.fn().mockResolvedValue('SIG==')));
    await c.devices.identify({ externalId: 'u1' });

    expect(paths()[0]).toBe('/v1/devices/identify');
    expect(mockFetch.mock.calls[0][1].headers['X-KM-Signature']).toBe('SIG==');
  });
});

describe('the routes exempt from signing keep working (PAR-22)', () => {
  it('register goes out unsigned', async () => {
    await client(failing()).devices.register({});

    expect(paths()).toEqual(['/v1/devices/register']);
    expect(mockFetch.mock.calls[0][1].headers['X-KM-Signature']).toBeUndefined();
  });
});

describe('an event in the offline queue (PAR-21)', () => {
  it('stays queued while the signer fails, and is sent signed once it works', async () => {
    const sign = jest.fn().mockRejectedValue(new Error('locked'));
    const c = client(signer(sign), { _queueStore: new MemoryStore() });

    await c.devices.trackEvent('order.completed');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(await c.queueStats()).toEqual({ pending: 1, dropped: 0 });

    await c.flush();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(await c.queueStats()).toEqual({ pending: 1, dropped: 0 });

    sign.mockResolvedValue('SIG==');
    await c.flush();
    expect(paths()).toEqual(['/v1/notifications/track']);
    expect(mockFetch.mock.calls[0][1].headers['X-KM-Signature']).toBe('SIG==');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({ event: 'order.completed', push_token: 'tok' });
    expect(await c.queueStats()).toEqual({ pending: 0, dropped: 0 });
  });
});
