/**
 * identity-jwt T20 (JWT-23 to JWT-26, JWT-28, JWT-29): the identity token of the client calls, its provider and the one
 * renewal. The tests read the requests the client sends to a fake server, never the code that builds them.
 */
import { PushClient, EspressoNotifyHttpError } from '../src/index';

jest.mock('expo-notifications', () => ({}), { virtual: true });

const mockFetch = jest.fn();
globalThis.fetch = mockFetch;

class MemoryStore {
  readonly map = new Map<string, string>();
  async getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  async setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  text() {
    return [...this.map.values()].join('\n');
  }
}

function client(extra: Record<string, unknown> = {}) {
  return new PushClient({ projectId: 'pk_live_test', pushToken: 'tok-1', platform: 'ios', autoTrack: false, ...extra });
}

const ok = (body: unknown = {}) => Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve(JSON.stringify(body)) });
const refusal = (status: number, code: string) =>
  Promise.resolve({ ok: false, status, statusText: 'No', text: () => Promise.resolve(JSON.stringify({ error: code, code })) });
const expired = () => refusal(401, 'identity_token_expired');

// sdk-parity T25: a successful identify of a new user also sends one `identity` lifecycle event. These tests are about
// the calls that carry the token, so they read the other requests only.
function requests() {
  return mockFetch.mock.calls.filter(([url]) => !String(url).endsWith('/v1/devices/lifecycle'));
}

function sent(i = 0) {
  const [url, init] = requests()[i];
  return { url: String(url), method: init.method as string, raw: init.body as string, body: JSON.parse(init.body) };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(() => ok());
});

/** The five calls that carry the token: each one sends the token it is given and the path it goes to. */
const CALLS: [string, string, (c: PushClient, identityToken?: string) => Promise<unknown>][] = [
  ['identify', '/v1/devices/identify', (c, t) => c.devices.identify({ externalId: 'u1', name: 'Ana', identityToken: t })],
  [
    'register with a user',
    '/v1/devices/register',
    (c, t) => c.devices.register({ user: { name: 'Ana', externalId: 'u1', identityToken: t } }),
  ],
  ['forgetDevice', '/v1/devices', (c, t) => c.devices.forgetDevice({ externalId: 'u1', identityToken: t })],
  ['getPreferences', '/v1/preferences/query', (c, t) => c.devices.getPreferences('u1', undefined, { identityToken: t })],
  [
    'setPreferences',
    '/v1/preferences',
    (c, t) => c.devices.setPreferences([{ categoryIdentifier: 'promotions', optedOut: true }], 'u1', undefined, { identityToken: t }),
  ],
];

describe('identity_token on the wire (JWT-23)', () => {
  it.each(CALLS)('%s sends identity_token at the top of the body and never identity_hash', async (_name, path, call) => {
    await call(client(), 'eyJ.header.sig');

    const { url, body, raw } = sent();
    expect(url).toMatch(new RegExp(`${path.replace(/\//g, '\\/')}$`));
    expect(body.identity_token).toBe('eyJ.header.sig');
    expect(raw).not.toContain('identity_hash');
  });

  it('identify has exactly the body of the contract', async () => {
    await client().devices.identify({ externalId: 'u1', name: 'Ana', identityToken: 'tkn' });

    expect(sent().body).toEqual({ pushToken: 'tok-1', user: { external_id: 'u1', name: 'Ana' }, identity_token: 'tkn' });
  });

  it('register keeps the user object as it was and puts the token beside it', async () => {
    await client().devices.register({ user: { name: 'Ana', externalId: 'u1', identityToken: 'tkn' } });

    expect(sent().body.identity_token).toBe('tkn');
    expect(sent().body.user).toEqual({ name: 'Ana', external_id: 'u1' });
  });

  it.each(CALLS)('%s without a token, or with an empty one, has no identity_token key', async (_name, _path, call) => {
    await call(client(), undefined);
    await call(client(), '');

    for (const i of [0, 1]) expect(sent(i).raw).not.toContain('identity_token');
  });

  it('an anonymous register has no identity_token key', async () => {
    await client().devices.register({});
    expect(sent().raw).not.toContain('identity_token');
  });

  it('a refused token throws an error with the status and the code of the server', async () => {
    mockFetch.mockImplementation(() => refusal(403, 'identity_verification_failed'));
    const err: any = await client().devices.identify({ externalId: 'u1', identityToken: 'bad' }).catch((e) => e);
    expect(err).toBeInstanceOf(EspressoNotifyHttpError);
    expect(err.status).toBe(403);
    expect(err.code).toBe('identity_verification_failed');
  });

  it('the old option is gone: identityHash is not read and not sent', async () => {
    await client().devices.identify({ externalId: 'u1', identityHash: 'abc' } as any);
    expect(sent().raw).not.toMatch(/identity_(hash|token)/);
  });
});

describe('one renewal on identity_token_expired (JWT-24, JWT-25)', () => {
  it.each(CALLS)('%s: one provider call and one repeated request with the new token', async (_name, path, call) => {
    const provider = jest.fn().mockResolvedValue('new-token');
    mockFetch.mockImplementationOnce(expired).mockImplementation(() => ok([]));

    await call(client({ identityTokenProvider: provider }), 'old-token');

    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith('u1');
    expect(requests()).toHaveLength(2);
    expect(sent(0).body.identity_token).toBe('old-token');
    expect(sent(1).body.identity_token).toBe('new-token');
    expect(sent(1).url).toBe(sent(0).url);
    expect(sent(1).url).toMatch(new RegExp(`${path.replace(/\//g, '\\/')}$`));
  });

  it('the repeated request is the same call: same method, same body but the token', async () => {
    mockFetch.mockImplementationOnce(expired).mockImplementation(() => ok());
    await client({ identityTokenProvider: async () => 'new-token' }).devices.identify({
      externalId: 'u1',
      name: 'Ana',
      metadata: { plan: 'pro' },
      identityToken: 'old-token',
    });

    expect(sent(1).method).toBe(sent(0).method);
    expect({ ...sent(1).body, identity_token: 'old-token' }).toEqual(sent(0).body);
  });

  it('resolves with the answer of the repeated request', async () => {
    mockFetch.mockImplementationOnce(expired).mockImplementation(() => ok({ success: true, from: 'second' }));
    const result = await client({ identityTokenProvider: async () => 'new-token' }).devices.identify({
      externalId: 'u1',
      identityToken: 'old-token',
    });
    expect(result).toEqual({ success: true, from: 'second' });
  });

  it('asks for the token of the user of the call, not of another one', async () => {
    const provider = jest.fn().mockResolvedValue('t2');
    mockFetch.mockImplementationOnce(expired).mockImplementation(() => ok());
    await client({ identityTokenProvider: provider }).devices.identify({ externalId: 'user-77', identityToken: 'old' });
    expect(provider).toHaveBeenCalledWith('user-77');
  });
});

describe('no loop (JWT-26)', () => {
  it('without a provider the error reaches the app and nothing is repeated', async () => {
    mockFetch.mockImplementation(expired);

    const err: any = await client().devices.identify({ externalId: 'u1', identityToken: 'old' }).catch((e) => e);

    expect(err).toBeInstanceOf(EspressoNotifyHttpError);
    expect(err.status).toBe(401);
    expect(err.code).toBe('identity_token_expired');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('a provider that throws: the error of the call reaches the app, one provider call, no repeat', async () => {
    const provider = jest.fn().mockRejectedValue(new Error('my backend is down'));
    mockFetch.mockImplementation(expired);

    const err: any = await client({ identityTokenProvider: provider }).devices.identify({ externalId: 'u1', identityToken: 'old' }).catch((e) => e);

    expect(err.status).toBe(401);
    expect(err.code).toBe('identity_token_expired');
    expect(err.message).not.toContain('my backend is down');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('a provider that throws before it returns a promise is handled the same way', async () => {
    const provider = jest.fn(() => {
      throw new Error('sync failure');
    });
    mockFetch.mockImplementation(expired);

    const err: any = await client({ identityTokenProvider: provider as any }).devices.identify({ externalId: 'u1', identityToken: 'old' }).catch((e) => e);

    expect(err.code).toBe('identity_token_expired');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each([[''], [undefined], [null], [42]])('a provider that returns %p is no token: no repeat', async (value) => {
    const provider = jest.fn().mockResolvedValue(value);
    mockFetch.mockImplementation(expired);

    const err: any = await client({ identityTokenProvider: provider }).devices.identify({ externalId: 'u1', identityToken: 'old' }).catch((e) => e);

    expect(err.code).toBe('identity_token_expired');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('a second 401 after the renewal reaches the app: one provider call, two requests, no third', async () => {
    const provider = jest.fn().mockResolvedValue('new-token');
    mockFetch.mockImplementation(expired);

    const err: any = await client({ identityTokenProvider: provider }).devices.identify({ externalId: 'u1', identityToken: 'old' }).catch((e) => e);

    expect(err.status).toBe(401);
    expect(err.code).toBe('identity_token_expired');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('a second failure of another kind reaches the app as it is', async () => {
    mockFetch.mockImplementationOnce(expired).mockImplementation(() => refusal(403, 'identity_verification_failed'));

    const err: any = await client({ identityTokenProvider: async () => 'new-token' })
      .devices.identify({ externalId: 'u1', identityToken: 'old' })
      .catch((e) => e);

    expect(err.status).toBe(403);
    expect(err.code).toBe('identity_verification_failed');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, 'unauthorized'],
    [401, 'invalid_api_key'],
    [403, 'identity_verification_failed'],
    [400, 'identity_hash_unsupported'],
    [503, 'identity_verification_unavailable'],
  ])('%i %s never calls the provider', async (status, code) => {
    const provider = jest.fn().mockResolvedValue('new-token');
    mockFetch.mockImplementation(() => refusal(status, code));

    const err: any = await client({ identityTokenProvider: provider }).devices.identify({ externalId: 'u1', identityToken: 'old' }).catch((e) => e);

    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    expect(provider).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('a call with no user to name (forgetDevice before any identify) cannot ask the provider', async () => {
    const provider = jest.fn().mockResolvedValue('new-token');
    mockFetch.mockImplementation(expired);

    const err: any = await client({ identityTokenProvider: provider }).devices.forgetDevice({ identityToken: 'old' }).catch((e) => e);

    expect(err.code).toBe('identity_token_expired');
    expect(provider).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('single flight (JWT-25)', () => {
  it('two calls of one user that expire together call the provider once and both repeat with the new token', async () => {
    let release!: (token: string) => void;
    const provider = jest.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    mockFetch.mockImplementation((_url: string, init: any) =>
      JSON.parse(init.body).identity_token === 'new-token' ? ok([]) : expired(),
    );
    const c = client({ identityTokenProvider: provider });

    const first = c.devices.identify({ externalId: 'u1', identityToken: 'old' });
    const second = c.devices.getPreferences('u1', undefined, { identityToken: 'old' });
    await new Promise((resolve) => setTimeout(resolve, 10)); // both got their 401 and wait for the provider
    expect(provider).toHaveBeenCalledTimes(1);
    release('new-token');
    await Promise.all([first, second]);

    expect(provider).toHaveBeenCalledTimes(1);
    expect(requests()).toHaveLength(4);
    const tokens = requests().map(([, init]) => JSON.parse(init.body).identity_token);
    expect(tokens.filter((t) => t === 'old')).toHaveLength(2);
    expect(tokens.filter((t) => t === 'new-token')).toHaveLength(2);
  });

  it('a call whose 401 arrives after the renewal is over repeats with the renewed token and does not ask again', async () => {
    const provider = jest.fn().mockResolvedValue('new-token');
    let releaseLate!: () => void;
    const lateGate = new Promise<void>((resolve) => { releaseLate = resolve; });
    mockFetch.mockImplementation(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (body.identity_token === 'new-token') return ok([]);
      if (_url.endsWith('/v1/preferences/query')) await lateGate; // its 401 comes after the first call renewed
      return expired();
    });
    const c = client({ identityTokenProvider: provider });

    const late = c.devices.getPreferences('u1', undefined, { identityToken: 'old' });
    await c.devices.identify({ externalId: 'u1', identityToken: 'old' }); // renews
    expect(provider).toHaveBeenCalledTimes(1);
    releaseLate();
    await late;

    expect(provider).toHaveBeenCalledTimes(1);
    const lastBody = JSON.parse(mockFetch.mock.calls[mockFetch.mock.calls.length - 1][1].body);
    expect(lastBody.identity_token).toBe('new-token');
  });

  it('two users that expire together are two provider calls, one each', async () => {
    const provider = jest.fn(async (id: string) => `new-${id}`);
    mockFetch.mockImplementation((_url: string, init: any) =>
      String(JSON.parse(init.body).identity_token).startsWith('new-') ? ok() : expired(),
    );
    const c = client({ identityTokenProvider: provider });

    await Promise.all([
      c.devices.identify({ externalId: 'u1', identityToken: 'old1' }),
      c.devices.identify({ externalId: 'u2', identityToken: 'old2' }),
    ]);

    expect(provider).toHaveBeenCalledTimes(2);
    expect(provider).toHaveBeenCalledWith('u1');
    expect(provider).toHaveBeenCalledWith('u2');
  });
});

describe('the token the client keeps (JWT-27, JWT-29)', () => {
  it('a later call of the user without a token sends the one the app gave', async () => {
    const c = client();
    await c.devices.identify({ externalId: 'u1', identityToken: 'tkn' });
    await c.devices.getPreferences('u1');
    await c.devices.setPreferences([{ categoryIdentifier: 'promotions', optedOut: true }], 'u1');

    expect(sent(1).body.identity_token).toBe('tkn');
    expect(sent(2).body.identity_token).toBe('tkn');
  });

  it('a token the app passes wins over the one kept', async () => {
    const c = client();
    await c.devices.identify({ externalId: 'u1', identityToken: 'first' });
    await c.devices.getPreferences('u1', undefined, { identityToken: 'second' });
    await c.devices.getPreferences('u1');

    expect(sent(1).body.identity_token).toBe('second');
    expect(sent(2).body.identity_token).toBe('second');
  });

  it('after a renewal the new token is the one kept: the next call needs no provider call', async () => {
    const provider = jest.fn().mockResolvedValue('new-token');
    mockFetch.mockImplementationOnce(expired).mockImplementation(() => ok([]));
    const c = client({ identityTokenProvider: provider });

    await c.devices.identify({ externalId: 'u1', identityToken: 'old' });
    await c.devices.getPreferences('u1');

    expect(provider).toHaveBeenCalledTimes(1);
    expect(sent(2).body.identity_token).toBe('new-token');
  });

  it("another user's token is not sent for this user", async () => {
    const c = client();
    await c.devices.identify({ externalId: 'u1', identityToken: 'of-u1' });
    await c.devices.identify({ externalId: 'u2' });

    expect(sent(1).raw).not.toContain('identity_token');
  });

  it('the token reaches no store: not the offline queue, not the persisted record of the calls', async () => {
    const store = new MemoryStore();
    mockFetch.mockImplementationOnce(expired).mockImplementation(() => ok());
    const c = client({ _queueStore: store, identityTokenProvider: async () => 'SECRET-RENEWED-TOKEN' });

    await c.devices.identify({ externalId: 'u1', identityToken: 'SECRET-OLD-TOKEN' });
    await c.devices.recordLifecycle('identity', 'u1', 'u2', 'u2'); // an event the queue keeps in memory
    await c.flush();
    c.destroy();

    expect(store.text()).not.toContain('SECRET-OLD-TOKEN');
    expect(store.text()).not.toContain('SECRET-RENEWED-TOKEN');
    expect(store.text()).not.toContain('identity_token');
  });
});

describe('logout clears the token (JWT-28)', () => {
  it('unregister: the next identify of the same user sends no token', async () => {
    const c = client();
    await c.devices.identify({ externalId: 'u1', identityToken: 'tkn' });
    await c.devices.unregister();
    await c.devices.identify({ externalId: 'u1' });

    expect(sent(1).url).toMatch(/\/v1\/devices\/unregister$/);
    expect(sent(2).raw).not.toContain('identity_token');
  });

  it('unregister clears the token even when the call failed', async () => {
    const c = client();
    await c.devices.identify({ externalId: 'u1', identityToken: 'tkn' });
    mockFetch.mockImplementationOnce(() => refusal(500, 'server_error'));
    await c.devices.unregister().catch(() => {});
    await c.devices.identify({ externalId: 'u1' });

    expect(sent(2).raw).not.toContain('identity_token');
  });

  it('forgetDevice: once it succeeded, a call of the same user sends no token', async () => {
    const c = client();
    await c.devices.identify({ externalId: 'u1', identityToken: 'tkn' });
    await c.devices.forgetDevice();
    expect(sent(1).body.identity_token).toBe('tkn'); // it used the kept token
    await c.devices.identify({ externalId: 'u1' });

    expect(sent(2).raw).not.toContain('identity_token');
  });

  it('forgetDevice that failed keeps the token, so the call can be repeated', async () => {
    const c = client();
    await c.devices.identify({ externalId: 'u1', identityToken: 'tkn' });
    mockFetch.mockImplementationOnce(() => refusal(500, 'erasure_failed'));
    await c.devices.forgetDevice().catch(() => {});
    await c.devices.forgetDevice();

    expect(sent(2).body.identity_token).toBe('tkn');
  });

  it('a token that comes back from the provider after the logout is not kept', async () => {
    let release!: (token: string) => void;
    const provider = jest.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const c = client({ identityTokenProvider: provider });
    mockFetch.mockImplementation((url: string) => (String(url).endsWith('/v1/devices/identify') ? expired() : ok()));

    const pending = c.devices.identify({ externalId: 'u1', identityToken: 'old' }).catch((e) => e);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await c.devices.unregister(); // the user logs out while the app builds the token
    release('late-token');
    const err: any = await pending;

    expect(err.code).toBe('identity_token_expired'); // no repeat with a token of a user who left
    mockFetch.mockImplementation(() => ok());
    await c.devices.identify({ externalId: 'u1' });
    const last = JSON.parse(mockFetch.mock.calls[mockFetch.mock.calls.length - 1][1].body);
    expect(last).not.toHaveProperty('identity_token');
  });
});

export {};

// feature: identity.identify
// feature: identity.token
// feature: identity.token-renewal
// feature: identity.logout
