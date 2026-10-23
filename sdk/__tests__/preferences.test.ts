/**
 * rn-sdk-v1-calls T5 (RNV-05 to RNV-08, RNV-12): getPreferences and setPreferences.
 */
import { createHash } from 'crypto';
import { PushClient, MemoryKeyStore } from '../src/index';
import type { Signer } from '../src/index';

jest.mock('expo-notifications', () => ({}), { virtual: true });

const mockFetch = jest.fn();
globalThis.fetch = mockFetch;

function client(extra: Record<string, unknown> = {}) {
  return new PushClient({ projectId: 'pk_live_test', pushToken: 'tok-1', platform: 'ios', autoTrack: false, ...extra });
}

const answer = (body: unknown, status = 200) =>
  Promise.resolve({
    ok: status < 300,
    status,
    statusText: status < 300 ? 'OK' : 'Error',
    text: () => Promise.resolve(JSON.stringify(body)),
  });

function call(i = 0) {
  const [url, init] = mockFetch.mock.calls[i];
  return { url: url as string, method: (init.method ?? 'GET') as string, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('getPreferences (RNV-05, RNV-08, SPT-48)', () => {
  it('posts /v1/preferences/query with the external id and the token in the body, and maps the answer (AC 5)', async () => {
    mockFetch.mockImplementation(() =>
      answer([
        { id: 1, tenant_id: 't', project_id: 1, user_id: 7, category_identifier: 'promotions', opted_out: true },
        { id: 2, tenant_id: 't', project_id: 1, user_id: 7, category_identifier: 'news', opted_out: false },
      ]),
    );

    const prefs = await client().devices.getPreferences('u1');

    const { url, method, body } = call();
    expect(method).toBe('POST');
    expect(url).toMatch(/\/v1\/preferences\/query$/);
    expect(url).not.toContain('?');
    expect(body).toEqual({ external_id: 'u1', push_token: 'tok-1' });
    expect(prefs).toEqual([
      { categoryIdentifier: 'promotions', optedOut: true },
      { categoryIdentifier: 'news', optedOut: false },
    ]);
  });

  it('keeps the external id and the token out of the URL, whatever characters they hold (SPT-48, SPT-49)', async () => {
    mockFetch.mockImplementation(() => answer([]));
    await client().devices.getPreferences('ana+1@example.com', 'ExponentPushToken[abc def]');

    const { url, body } = call();
    expect(url).toMatch(/\/v1\/preferences\/query$/);
    expect(url).not.toMatch(/ana|ExponentPushToken|abc/);
    expect(body).toEqual({ external_id: 'ana+1@example.com', push_token: 'ExponentPushToken[abc def]' });
  });

  it('sends exactly two keys and no preferences list (SPT-48)', async () => {
    mockFetch.mockImplementation(() => answer([]));
    await client().devices.getPreferences('u1');
    expect(Object.keys(call().body).sort()).toEqual(['external_id', 'push_token']);
  });

  it('maps an answer with only the two keys of the route, and tolerates odd elements', async () => {
    mockFetch.mockImplementation(() =>
      answer([{ category_identifier: 'news', opted_out: true }, { category_identifier: 'tips' }, null, {}]),
    );
    await expect(client().devices.getPreferences('u1')).resolves.toEqual([
      { categoryIdentifier: 'news', optedOut: true },
      { categoryIdentifier: 'tips', optedOut: false },
      { categoryIdentifier: '', optedOut: false },
      { categoryIdentifier: '', optedOut: false },
    ]);
  });

  it('names the route and not the user in the error of a refusal (SPT-49)', async () => {
    mockFetch.mockImplementation(() => answer({ error: 'user_not_found', code: 'user_not_found' }, 404));
    const err: any = await client().devices.getPreferences('SENTINEL-ID', 'SENTINEL-TOKEN').catch((e) => e);
    expect(err.path).toBe('/v1/preferences/query');
    expect(err.message).not.toMatch(/SENTINEL/);
  });

  it('resolves with an empty list when the answer is not a list', async () => {
    mockFetch.mockImplementation(() => answer({}));
    await expect(client().devices.getPreferences('u1')).resolves.toEqual([]);
  });

  it('throws an error with the status and the code on a 404 user_not_found', async () => {
    mockFetch.mockImplementation(() => answer({ error: 'user_not_found', code: 'user_not_found' }, 404));
    const err: any = await client().devices.getPreferences('u1').catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.code).toBe('user_not_found');
    expect(err.message).toMatch(/^\[espresso-notify\] getPreferences failed/);
  });

  it('uses the external id of the last identify when none is passed (AC 8)', async () => {
    mockFetch.mockImplementation(() => answer({ success: true }));
    const c = client();
    await c.devices.identify({ externalId: 'u9' });
    mockFetch.mockImplementation(() => answer([]));
    await c.devices.getPreferences();

    expect(call(1).body.external_id).toBe('u9');
  });

  it('uses the external id of a register with a user', async () => {
    mockFetch.mockImplementation(() => answer({ success: true }));
    const c = client();
    await c.devices.register({ user: { name: 'Ana', externalId: 'u3' } });
    await c.devices.getPreferences();
    expect(call(1).body.external_id).toBe('u3');
  });

  it('throws before any request when there is no external id, or after unregister (AC 8)', async () => {
    mockFetch.mockImplementation(() => answer({ success: true }));
    const c = client();
    await expect(c.devices.getPreferences()).rejects.toThrow(/externalId/);

    await c.devices.identify({ externalId: 'u9' });
    await c.devices.unregister();
    mockFetch.mockClear();
    await expect(c.devices.getPreferences()).rejects.toThrow(/externalId/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not remember an external id from an identify that failed', async () => {
    mockFetch.mockImplementation(() => answer({ code: 'identity_verification_failed' }, 403));
    const c = client();
    await c.devices.identify({ externalId: 'u9' }).catch(() => {});
    mockFetch.mockClear();
    await expect(c.devices.getPreferences()).rejects.toThrow(/externalId/);
  });

  it('throws without a token', async () => {
    const c = new PushClient({ projectId: 'pk_live_test', autoTrack: false });
    await expect(c.devices.getPreferences('u1')).rejects.toThrow(/pushToken/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('setPreferences (RNV-06, RNV-07)', () => {
  it('posts the preferences with the snake case names and resolves with the count (AC 6)', async () => {
    mockFetch.mockImplementation(() => answer({ updated: 2 }));

    const result = await client().devices.setPreferences(
      [
        { categoryIdentifier: 'promotions', optedOut: true },
        { categoryIdentifier: 'news', optedOut: false },
      ],
      'u1',
    );

    const { url, method, body } = call();
    expect(url).toMatch(/\/v1\/preferences$/);
    expect(method).toBe('POST');
    expect(body).toEqual({
      external_id: 'u1',
      push_token: 'tok-1',
      preferences: [
        { category_identifier: 'promotions', opted_out: true },
        { category_identifier: 'news', opted_out: false },
      ],
    });
    expect(result).toEqual({ updated: 2 });
  });

  it('falls back to the remembered external id', async () => {
    mockFetch.mockImplementation(() => answer({ success: true }));
    const c = client();
    await c.devices.identify({ externalId: 'u5' });
    mockFetch.mockImplementation(() => answer({ updated: 1 }));
    await c.devices.setPreferences([{ categoryIdentifier: 'news', optedOut: true }]);
    expect(call(1).body.external_id).toBe('u5');
  });

  it.each([
    ['no item', []],
    ['an empty identifier', [{ categoryIdentifier: '', optedOut: true }]],
    ['a blank identifier', [{ categoryIdentifier: '   ', optedOut: true }]],
    ['an identifier of 65 bytes', [{ categoryIdentifier: 'a'.repeat(65), optedOut: true }]],
    ['an identifier of 33 two-byte characters (66 bytes)', [{ categoryIdentifier: 'é'.repeat(33), optedOut: true }]],
    ['51 items', Array.from({ length: 51 }, (_, i) => ({ categoryIdentifier: `c${i}`, optedOut: true }))],
    ['an optedOut that is not a boolean', [{ categoryIdentifier: 'news', optedOut: 'yes' as unknown as boolean }]],
  ])('throws before any request for %s (AC 7)', async (_label, preferences) => {
    await expect(client().devices.setPreferences(preferences as any, 'u1')).rejects.toThrow(/Validation Error/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends 50 items with a 64-byte identifier (the limits themselves)', async () => {
    mockFetch.mockImplementation(() => answer({ updated: 50 }));
    const preferences = Array.from({ length: 50 }, (_, i) => ({
      categoryIdentifier: i === 0 ? 'a'.repeat(64) : `c${i}`,
      optedOut: i % 2 === 0,
    }));
    await expect(client().devices.setPreferences(preferences, 'u1')).resolves.toEqual({ updated: 50 });
  });

  it('throws on a refusal with the status and the code', async () => {
    mockFetch.mockImplementation(() => answer({ code: 'invalid_preferences' }, 400));
    const err: any = await client().devices.setPreferences([{ categoryIdentifier: 'news', optedOut: true }], 'u1').catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.code).toBe('invalid_preferences');
  });
});

describe('signing a preferences call (RNV-12)', () => {
  it('signs the POST of the read with the path, an empty query and the hash of the body as canonical lines', async () => {
    mockFetch.mockImplementation(() => answer([]));
    const sign = jest.fn().mockResolvedValue('SIG==');
    const signer: Signer = {
      generate: jest.fn().mockResolvedValue('PUB=='),
      sign,
      getPublicKey: jest.fn().mockResolvedValue('PUB=='),
      isSupported: jest.fn().mockResolvedValue(true),
    };
    const c = client({ enableSigning: true, _keyStore: new MemoryKeyStore(), _signer: signer });

    await c.devices.getPreferences('u1');

    expect(sign).toHaveBeenCalledTimes(1);
    const canonical = Buffer.from(sign.mock.calls[0][1], 'base64').toString('binary').split('\n');
    expect(canonical[0]).toBe('POST');
    expect(canonical[1]).toBe('/v1/preferences/query');
    expect(canonical[2]).toBe('');
    expect(canonical[3]).toBe(createHash('sha256').update(JSON.stringify({ external_id: 'u1', push_token: 'tok-1' })).digest('hex'));
    expect(call().headers['X-KM-Signature']).toBe('SIG==');
  });
});

export {};
