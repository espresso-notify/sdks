/**
 * rn-sdk-v1-calls T1 (RNV-11): an HTTP failure carries the status and the code of the answer.
 */
import { PushClient, EspressoNotifyHttpError } from '../src/index';

jest.mock('expo-notifications', () => ({}), { virtual: true });

const mockFetch = jest.fn();
globalThis.fetch = mockFetch;

function failure(status: number, statusText: string, body?: unknown) {
  return {
    ok: false,
    status,
    statusText,
    text: () => Promise.resolve(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** The error a call rejects with; the test fails when it resolves. */
async function fails(call: Promise<unknown>): Promise<any> {
  try {
    await call;
  } catch (e) {
    return e;
  }
  throw new Error('the call did not reject');
}

function client() {
  return new PushClient({ projectId: 'pk_live_test', pushToken: 'tok', platform: 'ios' });
}

describe('EspressoNotifyHttpError (RNV-11)', () => {
  beforeEach(() => mockFetch.mockReset());

  it('carries the status and the code of a JSON answer, and keeps the message form', async () => {
    mockFetch.mockResolvedValueOnce(failure(403, 'Forbidden', { error: 'identity_verification_failed', code: 'identity_verification_failed' }));
    const err = await fails(client().devices.identify({ externalId: 'u1' }));

    expect(err).toBeInstanceOf(EspressoNotifyHttpError);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(403);
    expect(err.code).toBe('identity_verification_failed');
    expect(err.message).toBe(
      '[espresso-notify] identify failed: [espresso-notify] HTTP 403: Forbidden — /v1/devices/identify',
    );
  });

  it('falls back to the error field when the answer has no code', async () => {
    mockFetch.mockResolvedValueOnce(failure(404, 'Not Found', { error: 'Token not found' }));
    const err = await fails(client().devices.unregister());
    expect(err.status).toBe(404);
    expect(err.code).toBe('Token not found');
  });

  it('leaves code undefined when the body is not JSON or is empty', async () => {
    mockFetch.mockResolvedValueOnce(failure(502, 'Bad Gateway', '<html>oops</html>'));
    const first = await fails(client().devices.updateMetadata({ a: 1 }));
    expect(first).toBeInstanceOf(EspressoNotifyHttpError);
    expect(first.status).toBe(502);
    expect(first.code).toBeUndefined();

    mockFetch.mockResolvedValueOnce(failure(500, 'Server Error'));
    const second = await fails(client().devices.register({}));
    expect(second.status).toBe(500);
    expect(second.code).toBeUndefined();
  });

  it('survives an answer object without a text() method', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' });
    const err = await fails(client().devices.identify({ externalId: 'u1' }));
    expect(err).toBeInstanceOf(EspressoNotifyHttpError);
    expect(err.status).toBe(401);
  });

  it('throws a plain Error when the failure is not an HTTP answer', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    const err = await fails(client().devices.identify({ externalId: 'u1' }));
    expect(err).not.toBeInstanceOf(EspressoNotifyHttpError);
    expect(err.message).toBe('[espresso-notify] identify failed: network down');
  });
});

describe('the path of an HTTP error has no query string (SPT-51)', () => {
  beforeEach(() => mockFetch.mockReset());

  it('keeps the query and the fragment out of the message and of the path', async () => {
    mockFetch.mockResolvedValueOnce(failure(404, 'Not Found', { code: 'user_not_found' }));
    const err = await fails((client().devices as any)._request('/v1/x?external_id=SENTINEL&push_token=SENTINEL2#frag'));

    expect(err).toBeInstanceOf(EspressoNotifyHttpError);
    expect(err.path).toBe('/v1/x');
    expect(err.message).toBe('[espresso-notify] HTTP 404: Not Found — /v1/x');
    expect(`${err.message} ${err.path}`).not.toMatch(/SENTINEL|frag|\?/);
  });

  it('leaves a path with no query unchanged', async () => {
    mockFetch.mockResolvedValueOnce(failure(500, 'Server Error'));
    const err = await fails((client().devices as any)._request('/v1/devices/register'));
    expect(err.path).toBe('/v1/devices/register');
    expect(err.message).toBe('[espresso-notify] HTTP 500: Server Error — /v1/devices/register');
  });

  it('keeps the status, the code and the retry-after of a call whose path had a query', async () => {
    mockFetch.mockResolvedValueOnce({
      ...failure(429, 'Too Many Requests', { code: 'rate_limited' }),
      headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '7' : null) },
    });
    const err = await fails((client().devices as any)._request('/v1/x?external_id=SENTINEL'));
    expect(err.status).toBe(429);
    expect(err.code).toBe('rate_limited');
    expect(err.retryAfter).toBe(7);
    expect(err.path).toBe('/v1/x');
  });

  it('redacts the path again in the error a Devices method hands to the app', async () => {
    const inner = new EspressoNotifyHttpError(
      '[espresso-notify] HTTP 400: Bad Request — /v1/x?external_id=SENTINEL',
      400,
      'bad',
      '/v1/x?external_id=SENTINEL',
      3,
    );
    const custom = new PushClient({
      projectId: 'pk_live_test',
      pushToken: 'tok',
      platform: 'ios',
      autoTrack: false,
      transport: { request: () => Promise.reject(inner) },
    });
    const err = await fails(custom.devices.getPreferences('u1'));

    expect(err).toBeInstanceOf(EspressoNotifyHttpError);
    expect(err.path).toBe('/v1/x');
    expect(err.message).toBe('[espresso-notify] getPreferences failed: [espresso-notify] HTTP 400: Bad Request — /v1/x');
    expect(err.status).toBe(400);
    expect(err.code).toBe('bad');
    expect(err.retryAfter).toBe(3);
  });
});

export {};
