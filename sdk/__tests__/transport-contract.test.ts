/**
 * @jest-environment node
 *
 * sdk-private-transport T17 (SPT-11, SPT-12, SPT-14, SPT-51): the contract table of a transport.
 *
 * One table of answers, each with the result the spec defines, runs against every transport the SDK has. A transport
 * is a driver: `answer(row)` makes the platform give that answer and `call(path)` sends a request. T17 ran the table
 * on `FetchTransport`; T18 adds the driver of `NativeTransport`, and the same rows give the same errors and the same
 * classification by the offline queue (`_classifySendError`), so the queue and the retry of the hooks behave the same
 * on both. Below the table: what only the native transport has (the nine codes, the headers, the two TypeErrors,
 * concurrency).
 */
import { PushClient, EspressoNotifyHttpError, EspressoNotifyError, _classifySendError } from '../src/index';
import { NATIVE_TIMEOUT_MS, NativeTransport, buildHttpError, parseJsonBody, parseRetryAfter, redactPath } from '../src/transport';
import type { NativeTransportModule } from '../src/transport';

jest.mock('expo-notifications', () => ({}), { virtual: true });

/** An answer of the server, as the platform reports it. */
interface Answer {
  status: number;
  statusText: string;
  body: string;
  retryAfter?: string;
}

interface Driver {
  name: string;
  /** Makes the next request end with this answer. */
  answer(a: Answer): void;
  /** Makes the next request end without an answer. */
  networkFailure(): void;
  call(path: string, options?: RequestInit): Promise<unknown>;
  /** The message of the error of a request that got no answer. */
  networkMessage: string;
}

const mockFetch = jest.fn();

const fetchDriver: Driver = {
  name: 'FetchTransport',
  answer: (a) =>
    mockFetch.mockResolvedValueOnce({
      ok: a.status >= 200 && a.status < 300,
      status: a.status,
      statusText: a.statusText,
      text: () => Promise.resolve(a.body),
      headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' && a.retryAfter !== undefined ? a.retryAfter : null) },
    }),
  networkFailure: () => mockFetch.mockRejectedValueOnce(new TypeError('Network request failed')),
  call: (path, options) => {
    const client = new PushClient({ projectId: 'pk_live_test', pushToken: 'tok', platform: 'ios', autoTrack: false });
    return (client as unknown as { _transport: { request(p: string, o?: RequestInit): Promise<unknown> } })._transport.request(path, options);
  },
  networkMessage: 'Network request failed',
};

/** A fake native module: `next` is what the following `request` call does. */
function fakeModule() {
  const state: { next: () => Promise<unknown> } = { next: () => Promise.reject(new Error('no answer prepared')) };
  const module: NativeTransportModule = {
    getConstants: () => ({ contractVersion: 1 }),
    request: jest.fn((..._args: unknown[]) => state.next()) as unknown as NativeTransportModule['request'],
    setPins: jest.fn(async () => true),
    clearPins: jest.fn(async () => undefined),
  };
  return { module, state };
}

const BASE = 'https://api.example.test';

function nativeDriver(): Driver {
  const { module, state } = fakeModule();
  return {
    name: 'NativeTransport',
    answer: (a) => {
      state.next = () => Promise.resolve({ status: a.status, statusText: a.statusText, retryAfter: a.retryAfter ?? '', body: a.body });
    },
    networkFailure: () => {
      state.next = () => Promise.reject(Object.assign(new Error('SENTINEL native text'), { code: 'timeout' }));
    },
    call: (path, options) => new NativeTransport(BASE, 'pk_live_test', module).request(path, options),
    networkMessage: '[espresso-notify] network request failed (timeout)',
  };
}

const drivers: Driver[] = [fetchDriver, nativeDriver()];

async function failure(call: Promise<unknown>): Promise<any> {
  try {
    await call;
  } catch (e) {
    return e;
  }
  throw new Error('the call did not reject');
}

describe.each(drivers)('the transport contract: $name', (driver) => {
  beforeEach(() => {
    mockFetch.mockReset();
    globalThis.fetch = mockFetch;
  });
  afterEach(() => jest.useRealTimers());

  it('200 with a JSON body resolves with the parsed body (SPT-11)', async () => {
    driver.answer({ status: 200, statusText: 'OK', body: '{"a":1,"list":[2]}' });
    await expect(driver.call('/v1/x', { method: 'POST', body: '{}' })).resolves.toEqual({ a: 1, list: [2] });
  });

  it('200 with an empty body resolves with {} (SPT-11)', async () => {
    driver.answer({ status: 200, statusText: 'OK', body: '' });
    await expect(driver.call('/v1/x')).resolves.toEqual({});
  });

  it('200 with a body that is not JSON rejects with the invalid-JSON text, a plain Error (SPT-14)', async () => {
    driver.answer({ status: 200, statusText: 'OK', body: '<html>not json</html>' });
    const err = await failure(driver.call('/v1/x'));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(EspressoNotifyHttpError);
    expect(err).not.toBeInstanceOf(EspressoNotifyError);
    expect(err.message).toBe('[espresso-notify] invalid JSON in the response');
  });

  it('400 with a code in the body carries status, code, message and path (SPT-12)', async () => {
    driver.answer({ status: 400, statusText: 'Bad Request', body: '{"code":"invalid_preferences","error":"a text"}' });
    const err = await failure(driver.call('/v1/x'));
    expect(err).toBeInstanceOf(EspressoNotifyHttpError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('invalid_preferences');
    expect(err.path).toBe('/v1/x');
    expect(err.message).toBe('[espresso-notify] HTTP 400: Bad Request — /v1/x');
    expect(err.retryAfter).toBeUndefined();
  });

  it('400 with only an error field takes it as the code (SPT-12)', async () => {
    driver.answer({ status: 400, statusText: 'Bad Request', body: '{"error":"user_not_found"}' });
    const err = await failure(driver.call('/v1/x'));
    expect(err.status).toBe(400);
    expect(err.code).toBe('user_not_found');
  });

  it('429 with Retry-After in seconds carries retryAfter 7 (SPT-12)', async () => {
    driver.answer({ status: 429, statusText: 'Too Many Requests', body: '{"error":"rate_limited"}', retryAfter: '7' });
    const err = await failure(driver.call('/v1/x'));
    expect(err).toBeInstanceOf(EspressoNotifyHttpError);
    expect(err.status).toBe(429);
    expect(err.code).toBe('rate_limited');
    expect(err.retryAfter).toBe(7);
  });

  it('429 with Retry-After as an HTTP date carries the seconds until it (SPT-12)', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-22T10:00:00Z') });
    driver.answer({ status: 429, statusText: 'Too Many Requests', body: '', retryAfter: 'Thu, 22 Oct 2026 10:01:30 GMT' });
    const err = await failure(driver.call('/v1/x'));
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(90);
  });

  it('500 with no body and no status text says "request failed" and has no code (SPT-12)', async () => {
    driver.answer({ status: 500, statusText: '', body: '' });
    const err = await failure(driver.call('/v1/x'));
    expect(err).toBeInstanceOf(EspressoNotifyHttpError);
    expect(err.status).toBe(500);
    expect(err.code).toBeUndefined();
    expect(err.retryAfter).toBeUndefined();
    expect(err.message).toBe('[espresso-notify] HTTP 500: request failed — /v1/x');
  });

  it('an answer that is not JSON on an error status leaves the code undefined (SPT-12)', async () => {
    driver.answer({ status: 502, statusText: 'Bad Gateway', body: '<html>oops</html>' });
    const err = await failure(driver.call('/v1/x'));
    expect(err.status).toBe(502);
    expect(err.code).toBeUndefined();
  });

  it('a request that gets no answer rejects with a plain Error, not an HTTP error', async () => {
    driver.networkFailure();
    const err = await failure(driver.call('/v1/x'));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(EspressoNotifyHttpError);
    expect(err).not.toBeInstanceOf(EspressoNotifyError);
    expect(err.message).toBe(driver.networkMessage);
  });

  it('the message and the path of an error end before a query string or a fragment (SPT-51)', async () => {
    driver.answer({ status: 404, statusText: 'Not Found', body: '{"error":"not_found"}' });
    const err = await failure(driver.call('/v1/thing?external_id=SENTINEL_ID&push_token=SENTINEL_TOKEN#frag'));
    expect(err.path).toBe('/v1/thing');
    expect(err.message).toBe('[espresso-notify] HTTP 404: Not Found — /v1/thing');
    expect(`${err.message} ${err.path}`).not.toMatch(/SENTINEL|external_id|frag/);
  });

  describe('the offline queue judges each answer the same way on every transport', () => {
    const cases: [string, Answer | 'network', object][] = [
      ['400 with a code is refused', { status: 400, statusText: 'Bad Request', body: '{"code":"invalid_preferences"}' }, { kind: 'refused', status: 400, code: 'invalid_preferences' }],
      ['404 is refused', { status: 404, statusText: 'Not Found', body: '{"error":"not_found"}' }, { kind: 'refused', status: 404, code: 'not_found' }],
      ['302 is refused', { status: 302, statusText: 'Found', body: '' }, { kind: 'refused', status: 302 }],
      ['500 is retried, not a network failure', { status: 500, statusText: '', body: '' }, { kind: 'retry', network: false }],
      ['408 is retried, not a network failure', { status: 408, statusText: 'Request Timeout', body: '' }, { kind: 'retry', network: false }],
      ['200 with a body that is not JSON is retried as a network failure', { status: 200, statusText: 'OK', body: 'nope' }, { kind: 'retry', network: true }],
      ['no answer is retried as a network failure', 'network', { kind: 'retry', network: true }],
    ];
    it.each(cases)('%s', async (_name, answer, outcome) => {
      if (answer === 'network') driver.networkFailure();
      else driver.answer(answer);
      const err = await failure(driver.call('/v1/x'));
      expect(_classifySendError(err)).toEqual(expect.objectContaining(outcome));
    });

    it('429 with Retry-After 7 is retried after 7 to 8.75 seconds (the header plus 0 to 25%)', async () => {
      driver.answer({ status: 429, statusText: 'Too Many Requests', body: '', retryAfter: '7' });
      const outcome: any = _classifySendError(await failure(driver.call('/v1/x')));
      expect(outcome).toEqual(expect.objectContaining({ kind: 'retry', network: false }));
      expect(outcome.retryAfterMs).toBeGreaterThanOrEqual(7000);
      expect(outcome.retryAfterMs).toBeLessThanOrEqual(8750);
    });
  });
});

describe('the shared helpers (SPT-12, SPT-14, SPT-51)', () => {
  it('redactPath cuts at the first ? or #', () => {
    expect(redactPath('/v1/a')).toBe('/v1/a');
    expect(redactPath('/v1/a?x=1#y')).toBe('/v1/a');
    expect(redactPath('/v1/a#y?x=1')).toBe('/v1/a');
    expect(redactPath('?only')).toBe('');
  });

  it('parseRetryAfter reads seconds and dates and nothing else', () => {
    expect(parseRetryAfter('12')).toBe(12);
    expect(parseRetryAfter(' 3 ')).toBe(3);
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('-5')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter('1234567890')).toBeUndefined();
  });

  it('buildHttpError and parseJsonBody build the texts of the spec', () => {
    const err = buildHttpError(409, 'Conflict', '/v1/z?q=1', '{"code":"dup"}', '4');
    expect(err).toBeInstanceOf(EspressoNotifyHttpError);
    expect([err.status, err.code, err.path, err.retryAfter]).toEqual([409, 'dup', '/v1/z', 4]);
    expect(err.message).toBe('[espresso-notify] HTTP 409: Conflict — /v1/z');
    expect(parseJsonBody('')).toEqual({});
    expect(parseJsonBody('[1]')).toEqual([1]);
    expect(() => parseJsonBody('{')).toThrow('[espresso-notify] invalid JSON in the response');
  });
});

// ─── What only the native transport has ───────────────────────────────────────

const CODES = ['timeout', 'no_connection', 'dns', 'tls', 'pin_mismatch', 'cancelled', 'response_too_large', 'invalid_request', 'unknown'];

describe('NativeTransport: a rejection of the module (SPT-13, SPT-56)', () => {
  it.each(CODES)('the code %s gives a plain Error with that code and nothing else of the module', async (code) => {
    const { module, state } = fakeModule();
    state.next = () => Promise.reject(Object.assign(new Error('SENTINEL_NATIVE_MESSAGE host.example.test'), { code, nativeStack: 'SENTINEL_STACK' }));
    const err = await failure(new NativeTransport(BASE, 'pk_live_test', module).request('/v1/x'));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(EspressoNotifyHttpError);
    expect(err).not.toBeInstanceOf(EspressoNotifyError);
    expect(err.message).toBe(`[espresso-notify] network request failed (${code})`);
    expect(Object.keys(err)).toEqual([]);
    expect(_classifySendError(err)).toEqual({ kind: 'retry', network: true });
  });

  it.each([
    ['a code that is not on the list', Object.assign(new Error('SENTINEL_NATIVE_MESSAGE'), { code: 'E_SURPRISE' })],
    ['a rejection without a code', new Error('SENTINEL_NATIVE_MESSAGE')],
    ['a rejected string', 'SENTINEL_NATIVE_MESSAGE'],
    ['a rejected undefined', undefined],
    ['a code that is not a string', { code: 7, message: 'SENTINEL_NATIVE_MESSAGE' }],
    ['an inherited code', Object.create({ code: 'timeout' })],
  ])('%s is reported as unknown, without the text of the module', async (_name, rejection) => {
    const { module, state } = fakeModule();
    state.next = () => Promise.reject(rejection);
    const err = await failure(new NativeTransport(BASE, 'pk_live_test', module).request('/v1/x'));
    expect(err.message).toBe('[espresso-notify] network request failed (unknown)');
    expect(err.message).not.toMatch(/SENTINEL/);
  });

  it('a module that throws before returning a promise is also a network failure', async () => {
    const { module } = fakeModule();
    (module.request as jest.Mock).mockImplementation(() => {
      throw Object.assign(new Error('SENTINEL_NATIVE_MESSAGE'), { code: 'tls' });
    });
    const err = await failure(new NativeTransport(BASE, 'pk_live_test', module).request('/v1/x'));
    expect(err.message).toBe('[espresso-notify] network request failed (tls)');
  });

  it('an answer that is not an object is a network failure with the unknown code', async () => {
    const { module, state } = fakeModule();
    state.next = () => Promise.resolve('SENTINEL_NOT_AN_OBJECT');
    const err = await failure(new NativeTransport(BASE, 'pk_live_test', module).request('/v1/x'));
    expect(err.message).toBe('[espresso-notify] network request failed (unknown)');
  });
});

describe('NativeTransport: what it hands to the module (SPT-15, SPT-16)', () => {
  const sent = (module: NativeTransportModule) => (module.request as jest.Mock).mock.calls[0];

  it('passes the method in upper case, the absolute url, the body and the 30 second timeout', async () => {
    const { module, state } = fakeModule();
    state.next = () => Promise.resolve({ status: 200, statusText: 'OK', retryAfter: '', body: '{}' });
    await new NativeTransport(BASE, 'pk_live_test', module).request('/v1/devices/register', { method: 'post', body: '{"a":1}' });
    const [method, url, , body, timeoutMs] = sent(module);
    expect([method, url, body, timeoutMs]).toEqual(['POST', `${BASE}/v1/devices/register`, '{"a":1}', 30000]);
    expect(NATIVE_TIMEOUT_MS).toBe(30000);
  });

  it('sends GET with no body when the caller gives neither', async () => {
    const { module, state } = fakeModule();
    state.next = () => Promise.resolve({ status: 200, statusText: 'OK', retryAfter: '', body: '' });
    await new NativeTransport(BASE, 'pk_live_test', module).request('/v1/categories');
    const [method, , , body] = sent(module);
    expect([method, body]).toEqual(['GET', null]);
  });

  const pairs = (flat: string[]) => {
    expect(flat.length % 2).toBe(0);
    const out: Record<string, string> = {};
    for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
    return out;
  };

  it('hands the module the headers FetchTransport hands to fetch, the signer X-KM headers and the winning caller value included', async () => {
    const callerHeaders = {
      'X-KM-Signature': 'SIG==',
      'X-KM-Timestamp': '1790000000',
      'X-KM-Nonce': 'abc',
      'Content-Type': 'application/x-test',
      'X-Custom': 'one',
    };
    mockFetch.mockReset();
    globalThis.fetch = mockFetch;
    fetchDriver.answer({ status: 200, statusText: 'OK', body: '{}' });
    await fetchDriver.call('/v1/x', { method: 'POST', body: '{}', headers: callerHeaders });
    const fetchHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>;

    const { module, state } = fakeModule();
    state.next = () => Promise.resolve({ status: 200, statusText: 'OK', retryAfter: '', body: '{}' });
    await new NativeTransport(BASE, 'pk_live_test', module).request('/v1/x', { method: 'POST', body: '{}', headers: callerHeaders });
    const nativeHeaders = pairs(sent(module)[2]);

    expect(nativeHeaders).toEqual(fetchHeaders);
    expect(nativeHeaders.Authorization).toBe('Bearer pk_live_test');
    expect(nativeHeaders['Content-Type']).toBe('application/x-test');
    expect(nativeHeaders['X-KM-Signature']).toBe('SIG==');
  });

  it('sends Authorization and Content-Type when the caller gives no headers', async () => {
    const { module, state } = fakeModule();
    state.next = () => Promise.resolve({ status: 200, statusText: 'OK', retryAfter: '', body: '{}' });
    await new NativeTransport(BASE, 'pk_live_test', module).request('/v1/x');
    expect(pairs(sent(module)[2])).toEqual({ Authorization: 'Bearer pk_live_test', 'Content-Type': 'application/json' });
  });

  it('a name that repeats with another case is sent once, with the value of the caller', async () => {
    const { module, state } = fakeModule();
    state.next = () => Promise.resolve({ status: 200, statusText: 'OK', retryAfter: '', body: '{}' });
    await new NativeTransport(BASE, 'pk_live_test', module).request('/v1/x', { headers: { authorization: 'Bearer other' } });
    const flat: string[] = sent(module)[2];
    expect(flat.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase()).filter((n) => n === 'authorization')).toHaveLength(1);
    expect(flat[flat.indexOf('authorization') + 1]).toBe('Bearer other');
  });

  it('reads a Headers instance and an array as no extra headers', async () => {
    const { module, state } = fakeModule();
    state.next = () => Promise.resolve({ status: 200, statusText: 'OK', retryAfter: '', body: '{}' });
    const transport = new NativeTransport(BASE, 'pk_live_test', module);
    await transport.request('/v1/x', { headers: new Headers({ 'X-Extra': '1' }) });
    await transport.request('/v1/x', { headers: [['X-Extra', '1']] });
    for (const call of (module.request as jest.Mock).mock.calls) {
      expect(pairs(call[2])).toEqual({ Authorization: 'Bearer pk_live_test', 'Content-Type': 'application/json' });
    }
  });
});

describe('NativeTransport: a request that is wrong before it leaves (SPT-20, SPT-21)', () => {
  it.each(['ftp://files.example.test', 'file:///etc/hosts', 'javascript:alert(1)', 'api.example.test', ''])(
    'the base %j throws the TypeError for the scheme and never calls the module',
    async (base) => {
      const { module } = fakeModule();
      const err = await failure(new NativeTransport(base, 'pk_live_test', module).request('/v1/x'));
      expect(err).toBeInstanceOf(TypeError);
      expect(err.message).toBe('[espresso-notify] unsupported URL scheme');
      expect(module.request).not.toHaveBeenCalled();
    },
  );

  it.each([['http://localhost:3000'], ['HTTPS://API.EXAMPLE.TEST']])('the base %s is accepted', async (base) => {
    const { module, state } = fakeModule();
    state.next = () => Promise.resolve({ status: 200, statusText: 'OK', retryAfter: '', body: '{}' });
    await expect(new NativeTransport(base, 'pk_live_test', module).request('/v1/x')).resolves.toEqual({});
  });

  it.each([[42], [{ a: 1 }], [new Uint8Array([1, 2])], [new URLSearchParams('a=1')], [null]])(
    'the body %p throws the TypeError for the body and never calls the module',
    async (body) => {
      const { module } = fakeModule();
      const err = await failure(new NativeTransport(BASE, 'pk_live_test', module).request('/v1/x', { method: 'POST', body: body as never }));
      expect(err).toBeInstanceOf(TypeError);
      expect(err.message).toBe('[espresso-notify] request body must be a string');
      expect(module.request).not.toHaveBeenCalled();
    },
  );
});

describe('NativeTransport: concurrent requests (SPT-22)', () => {
  it('20 calls with distinct bodies each settle once with their own answer', async () => {
    const { module } = fakeModule();
    const settled: string[] = [];
    (module.request as jest.Mock).mockImplementation(
      (_m: string, _u: string, _h: string[], body: string) =>
        new Promise((resolve) => {
          const n = Number(JSON.parse(body).n);
          // The later calls answer first, so an implementation that shares state between calls mixes the answers.
          setTimeout(() => {
            settled.push(body);
            resolve({ status: 200, statusText: 'OK', retryAfter: '', body: JSON.stringify({ echo: n }) });
          }, (20 - n) * 2);
        }),
    );
    const transport = new NativeTransport(BASE, 'pk_live_test', module);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, n) => transport.request('/v1/x', { method: 'POST', body: JSON.stringify({ n }) })),
    );
    expect(results).toEqual(Array.from({ length: 20 }, (_, n) => ({ echo: n })));
    expect(settled).toHaveLength(20);
    expect(new Set(settled).size).toBe(20);
    expect(module.request).toHaveBeenCalledTimes(20);
  });
});
