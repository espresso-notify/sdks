/**
 * rn-sdk-v1-calls T2 (RNV-01 to RNV-04): custom events and conversions.
 */
import { PushClient } from '../src/index';

jest.mock('expo-notifications', () => ({}), { virtual: true });

const mockFetch = jest.fn();
globalThis.fetch = mockFetch;

// rn-tap-and-offline-queue: a custom event carries the id the server deduplicates a retry on.
const EVENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

const ok = () => Promise.resolve({ ok: true, text: () => Promise.resolve('') });

function client(pushToken: string | null = 'tok-1') {
  return new PushClient({ projectId: 'pk_live_test', pushToken: pushToken ?? undefined, platform: 'ios', autoTrack: false });
}

function lastBody() {
  const [url, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
  return { url: url as string, method: init.method as string, body: JSON.parse(init.body) };
}

describe('trackEvent (RNV-01 to RNV-03)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(ok);
    warn = jest.spyOn(console, 'warn').mockImplementation();
  });
  afterEach(() => warn.mockRestore());

  it('posts the event name and the token to the track route, with no notification id (AC 1)', async () => {
    await client().devices.trackEvent('order.completed');

    const { url, method, body } = lastBody();
    expect(url).toMatch(/\/v1\/notifications\/track$/);
    expect(method).toBe('POST');
    expect(body).toEqual({ event: 'order.completed', push_token: 'tok-1', event_id: expect.stringMatching(EVENT_ID) });
  });

  it('takes the token of the call over the one of the client', async () => {
    await client().devices.trackEvent('signed_up', 'other-token');
    expect(lastBody().body).toEqual({ event: 'signed_up', push_token: 'other-token', event_id: expect.stringMatching(EVENT_ID) });
  });

  it('accepts every character the server accepts, at 64 characters', async () => {
    const name = 'A' + 'b0_.:-'.repeat(10) + 'xyz'; // 1 + 60 + 3 = 64
    expect(name).toHaveLength(64);
    await client().devices.trackEvent(name);
    expect(lastBody().body.event).toBe(name);
  });

  it.each([
    ['empty', ''],
    ['65 characters', 'a'.repeat(65)],
    ['starts with a dot', '.hidden'],
    ['has a space', 'order completed'],
    ['has a slash', 'order/completed'],
  ])('sends nothing and warns for a name that is %s (AC 2)', async (_label, name) => {
    await client().devices.trackEvent(name);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^\[espresso-notify\] trackEvent/);
  });

  it.each(['opened', 'clicked', 'received', 'dismissed', 'converted', 'app_opened'])(
    'refuses the reserved name %s (AC 2)',
    async (name) => {
      await client().devices.trackEvent(name);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(warn.mock.calls[0][0]).toMatch(/^\[espresso-notify\] trackEvent/);
    },
  );

  it('resolves without a request when there is no token (AC 3)', async () => {
    await expect(client(null).devices.trackEvent('signed_up')).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('resolves when the request fails with a status or with the network (AC 3)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found', text: () => Promise.resolve('{"code":"unknown_device"}') });
    await expect(client().devices.trackEvent('signed_up')).resolves.toBeUndefined();

    mockFetch.mockRejectedValueOnce(new Error('offline'));
    await expect(client().devices.trackEvent('signed_up')).resolves.toBeUndefined();
  });
});

describe('trackConversion (RNV-03, RNV-04)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(ok);
  });

  it('posts the converted event with the notification id as a number (AC 4)', async () => {
    await client().devices.trackConversion(42);
    expect(lastBody().body).toEqual({ notification_id: 42, event: 'converted', push_token: 'tok-1' });
  });

  it('turns a string id into a number', async () => {
    await client().devices.trackConversion('42', 'other-token');
    expect(lastBody().body).toEqual({ notification_id: 42, event: 'converted', push_token: 'other-token' });
  });

  it.each([
    ['text', 'abc'],
    ['digits with text after them', '42abc'],
    ['a decimal', '4.2'],
    ['hexadecimal', '0x1A'],
    ['an exponent', '1e3'],
    ['digits with a space before them', ' 12'],
    ['digits with a space after them', '12 '],
    ['digits with a space on both sides', ' 42 '],
    ['digits with a sign', '+12'],
    ['an empty-looking text of spaces', '   '],
    ['digits with a line break', '12\n'],
    ['a decimal number', 1.5],
    ['a negative number', -3],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an object', {}],
  ])('warns and sends nothing for an id that is %s, instead of sending null (AC 4)', async (_label, id) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    try {
      await expect(client().devices.trackConversion(id as never)).resolves.toBeUndefined();

      expect(mockFetch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/^\[espresso-notify\] trackConversion: .* is not a notification id and was not sent/);
    } finally {
      warn.mockRestore();
    }
  });

  // N2 of the rn-sdk-v1-calls re-verification: a string is accepted only when it is made of digits. `Number` reads
  // "0x1A" as 26 and "1e3" as 1000, which would count a conversion for another notification; a space at either end is
  // refused too (the string is exactly what the app passed), so the rule is one regular expression and nothing else.
  it('turns a string of digits, with leading zeros included, into a number', async () => {
    await client().devices.trackConversion('007');
    expect(lastBody().body.notification_id).toBe(7);
  });

  it('sends nothing without a notification id or a token, and never throws (AC 3)', async () => {
    await expect(client().devices.trackConversion(0)).resolves.toBeUndefined();
    await expect(client(null).devices.trackConversion(42)).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();

    mockFetch.mockRejectedValueOnce(new Error('offline'));
    await expect(client().devices.trackConversion(42)).resolves.toBeUndefined();
  });
});

describe('the warnings do not repeat the value passed (SPT-54)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(ok);
    warn = jest.spyOn(console, 'warn').mockImplementation();
  });
  afterEach(() => warn.mockRestore());

  it('trackEvent names the argument and leaves the rejected name out', async () => {
    await client().devices.trackEvent('bad name SENTINEL');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0][0]);
    expect(text).toMatch(/^\[espresso-notify\] trackEvent: /);
    expect(text).toMatch(/event name/);
    expect(text).not.toContain('SENTINEL');
  });

  it('trackConversion names the argument and leaves the rejected value out', async () => {
    await client().devices.trackConversion('SENTINEL' as never);
    await client().devices.trackConversion({ SENTINEL: 1 } as never);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    for (const call of warn.mock.calls) {
      const text = String(call[0]);
      expect(text).toMatch(/^\[espresso-notify\] trackConversion: .* is not a notification id and was not sent/);
      expect(text).not.toContain('SENTINEL');
    }
  });

  it('gives the same text whatever the rejected value is', async () => {
    await client().devices.trackEvent('one bad');
    await client().devices.trackEvent('another bad');
    await client().devices.trackConversion('abc' as never);
    await client().devices.trackConversion(-4);

    expect(warn.mock.calls[0][0]).toBe(warn.mock.calls[1][0]);
    expect(warn.mock.calls[2][0]).toBe(warn.mock.calls[3][0]);
  });
});

export {};
