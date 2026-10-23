/**
 * rn-sdk-v1-calls T3 (RNV-13, RNV-14): the proof of identity on register and identify.
 */
import { PushClient } from '../src/index';

jest.mock('expo-notifications', () => ({}), { virtual: true });

const mockFetch = jest.fn();
globalThis.fetch = mockFetch;

const HASH = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

function client() {
  return new PushClient({ projectId: 'pk_live_test', pushToken: 'tok-1', platform: 'ios', autoTrack: false });
}

function sent(callIndex = 0) {
  const [url, init] = mockFetch.mock.calls[callIndex];
  return { url: url as string, raw: init.body as string, body: JSON.parse(init.body) };
}

describe('identity_hash (RNV-13, RNV-14)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve('{}') });
  });

  it('identify sends user.identityHash as identity_hash at the top of the body (AC 1)', async () => {
    await client().devices.identify({ externalId: 'u1', name: 'Ana', identityHash: HASH });

    const { url, body } = sent();
    expect(url).toMatch(/\/v1\/devices\/identify$/);
    expect(body).toEqual({
      pushToken: 'tok-1',
      user: { external_id: 'u1', name: 'Ana' },
      identity_hash: HASH,
    });
  });

  it('register sends user.identityHash as identity_hash at the top of the body (AC 1)', async () => {
    await client().devices.register({ user: { name: 'Ana', externalId: 'u1', identityHash: HASH } });

    const { url, body } = sent();
    expect(url).toMatch(/\/v1\/devices\/register$/);
    expect(body.identity_hash).toBe(HASH);
    expect(body.user).toEqual({ name: 'Ana', external_id: 'u1' });
  });

  it('identify without a hash, or with an empty one, has the same body as before (AC 2)', async () => {
    const devices = client().devices;
    await devices.identify({ externalId: 'u1', name: 'Ana', metadata: { role: 'admin' } });
    await devices.identify({ externalId: 'u1', name: 'Ana', metadata: { role: 'admin' }, identityHash: '' });

    const expected = JSON.stringify({
      pushToken: 'tok-1',
      user: { external_id: 'u1', name: 'Ana', metadata: { role: 'admin' } },
    });
    expect(sent(0).raw).toBe(expected);
    expect(sent(1).raw).toBe(expected);
    expect(sent(1).raw).not.toContain('identity_hash');
  });

  it('register without a hash, or with an empty one, has no identity_hash key (AC 2)', async () => {
    const devices = client().devices;
    await devices.register({ user: { name: 'Ana', externalId: 'u1' } });
    await devices.register({ user: { name: 'Ana', externalId: 'u1', identityHash: '' } });
    await devices.register({});

    for (const i of [0, 1, 2]) expect(sent(i).raw).not.toContain('identity_hash');
  });

  it('a refused proof throws an error with the code of the server', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: () => Promise.resolve('{"error":"identity_verification_failed","code":"identity_verification_failed"}'),
    });
    const err: any = await client().devices.identify({ externalId: 'u1', identityHash: 'bad' }).catch((e) => e);
    expect(err.status).toBe(403);
    expect(err.code).toBe('identity_verification_failed');
  });
});

export {};
