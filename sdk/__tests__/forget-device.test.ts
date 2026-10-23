/**
 * rn-sdk-v1-calls T6 (RNV-09, RNV-10, RNV-13, RNV-14): forgetDevice erases the device.
 */
import { PushClient, EspressoNotifyHttpError } from '../src/index';

jest.mock('expo-notifications', () => ({}), { virtual: true });

const mockFetch = jest.fn();
globalThis.fetch = mockFetch;

function client(pushToken: string | null = 'tok-1') {
  return new PushClient({ projectId: 'pk_live_test', pushToken: pushToken ?? undefined, platform: 'ios', autoTrack: false });
}

const noContent = () => Promise.resolve({ ok: true, status: 204, statusText: 'No Content', text: () => Promise.resolve('') });
const refusal = (status: number, code: string) =>
  Promise.resolve({ ok: false, status, statusText: 'No', text: () => Promise.resolve(JSON.stringify({ error: code, code })) });

function call(i = 0) {
  const [url, init] = mockFetch.mock.calls[i];
  return { url: url as string, method: init.method as string, body: JSON.parse(init.body), raw: init.body as string };
}

beforeEach(() => mockFetch.mockReset());

describe('forgetDevice (RNV-09, RNV-10)', () => {
  it('sends DELETE /v1/devices with the token of the client (AC 1)', async () => {
    mockFetch.mockImplementation(noContent);

    await expect(client().devices.forgetDevice()).resolves.toBeUndefined();

    const { url, method, raw } = call();
    expect(url).toMatch(/\/v1\/devices$/);
    expect(method).toBe('DELETE');
    expect(JSON.parse(raw)).toEqual({ push_token: 'tok-1' });
    expect(raw).not.toContain('identity_hash');
    expect(raw).not.toContain('device_id');
  });

  it('adds device_id and identity_hash when the options carry them (RNV-13)', async () => {
    mockFetch.mockImplementation(noContent);

    await client().devices.forgetDevice({ deviceId: 'dev-9', identityHash: 'abc123' });

    expect(call().body).toEqual({ push_token: 'tok-1', device_id: 'dev-9', identity_hash: 'abc123' });
  });

  it('erases by device id alone when the client has no token', async () => {
    mockFetch.mockImplementation(noContent);
    await client(null).devices.forgetDevice({ deviceId: 'dev-9' });
    expect(call().body).toEqual({ device_id: 'dev-9' });
  });

  it('takes the token of the options over the one of the client', async () => {
    mockFetch.mockImplementation(noContent);
    await client().devices.forgetDevice({ pushToken: 'other' });
    expect(call().body).toEqual({ push_token: 'other' });
  });

  it('leaves out an empty identity hash (RNV-14)', async () => {
    mockFetch.mockImplementation(noContent);
    await client().devices.forgetDevice({ identityHash: '' });
    expect(call().raw).not.toContain('identity_hash');
  });

  it('throws before any request without a token and without a device id (AC 2)', async () => {
    await expect(client(null).devices.forgetDevice()).rejects.toThrow(/Validation Error/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    [403, 'identity_verification_failed'],
    [404, 'not_found'],
    [409, 'device_changed'],
    [503, 'identity_verification_unavailable'],
    [500, 'erasure_failed'],
  ])('throws on %i %s with the status and the code (AC 2)', async (status, code) => {
    mockFetch.mockImplementation(() => refusal(status, code));
    const err: any = await client().devices.forgetDevice().catch((e) => e);
    expect(err).toBeInstanceOf(EspressoNotifyHttpError);
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    expect(err.message).toMatch(/^\[espresso-notify\] forgetDevice failed/);
  });

  it('throws on a network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('offline'));
    await expect(client().devices.forgetDevice()).rejects.toThrow('[espresso-notify] forgetDevice failed: offline');
  });
});

describe('forgetDevice and the remembered external id (RNV-09)', () => {
  it('forgets the external id once the erase succeeded', async () => {
    mockFetch.mockImplementation(() => Promise.resolve({ ok: true, text: () => Promise.resolve('{}') }));
    const c = client();
    await c.devices.identify({ externalId: 'u1' });
    mockFetch.mockImplementation(noContent);
    await c.devices.forgetDevice();
    mockFetch.mockClear();

    await expect(c.devices.getPreferences()).rejects.toThrow(/externalId/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('keeps the external id when the erase failed', async () => {
    mockFetch.mockImplementation(() => Promise.resolve({ ok: true, text: () => Promise.resolve('{}') }));
    const c = client();
    await c.devices.identify({ externalId: 'u1' });
    mockFetch.mockImplementation(() => refusal(403, 'identity_verification_failed'));
    await c.devices.forgetDevice().catch(() => {});
    mockFetch.mockImplementation(() => Promise.resolve({ ok: true, text: () => Promise.resolve('[]') }));

    await c.devices.getPreferences();
    const last = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    expect(JSON.parse(last[1].body).external_id).toBe('u1');
  });
});

export {};
