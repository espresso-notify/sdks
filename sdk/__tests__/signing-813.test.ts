/**
 * Unit tests for hardware-bound request signing (#813-D).
 *
 * Covers:
 *  - sha256Hex / sha256HexUtf8: known standard vectors (CRITICAL)
 *  - buildCanonical: exact field order and join
 *  - sortQuery: deterministic query sorting
 *  - Provisioning: deviceId + key generation/persistence with mocked deps
 *  - Transport signing: POST gets X-KM-* headers; GET does not
 *  - enableSigning=false (default): NO X-KM-* headers — byte-identical to pre-813
 *
 * All native deps (expo-secure-store, react-native-secure-sign) are mocked via
 * the internal _keyStore / _signer escape hatches.
 */

// Virtual mocks so expo-notifications doesn't crash module load
jest.mock('expo-notifications', () => ({}), { virtual: true });

import {
  sha256Hex,
  sha256HexUtf8,
  buildCanonical,
  sortQuery,
  MemoryKeyStore,
} from '../src/index';
import type { KeyStore, Signer } from '../src/index';

// ─── SHA-256 vectors ──────────────────────────────────────────────────────────

describe('sha256Hex — standard vectors', () => {
  /**
   * These three vectors are from FIPS 180-4 and are the canonical test cases.
   * A single bit error in the SHA-256 implementation will cause all of them to
   * fail — they serve as the primary correctness gate before any networking code
   * runs.
   */
  it('empty string → e3b0c44... (FIPS 180-4 vector)', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('"abc" → ba7816bf... (FIPS 180-4 / NIST vector)', () => {
    // Verified against Node.js crypto, Python hashlib, and the NIST SHA-256 test vectors.
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('"hello" → 2cf24db...', () => {
    // SHA-256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(sha256Hex('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('returns a 64-character lowercase hex string for any input', () => {
    const result = sha256Hex('arbitrary payload 🔑');
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });
});

describe('sha256HexUtf8 — UTF-8 encoding matches standard vectors', () => {
  // sha256HexUtf8 encodes as UTF-8; ASCII inputs are identical to sha256Hex
  it('empty string matches sha256Hex("")', () => {
    expect(sha256HexUtf8('')).toBe(sha256Hex(''));
  });

  it('"abc" matches sha256Hex("abc") (pure ASCII)', () => {
    expect(sha256HexUtf8('abc')).toBe(sha256Hex('abc'));
  });

  it('produces a stable 64-char hex for a multi-byte UTF-8 string', () => {
    const result = sha256HexUtf8('{"foo":"bar"}');
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });
});

// ─── sortQuery ────────────────────────────────────────────────────────────────

describe('sortQuery', () => {
  it('returns "" for an empty string', () => {
    expect(sortQuery('')).toBe('');
  });

  it('returns "" for a lone "?" prefix', () => {
    expect(sortQuery('?')).toBe('');
  });

  it('strips leading "?" and returns single param', () => {
    expect(sortQuery('?foo=1')).toBe('foo=1');
  });

  it('sorts params lexicographically by key', () => {
    expect(sortQuery('z=3&a=1&m=2')).toBe('a=1&m=2&z=3');
  });

  it('strips leading "?" then sorts', () => {
    expect(sortQuery('?z=3&a=1')).toBe('a=1&z=3');
  });

  it('is stable for already-sorted params', () => {
    expect(sortQuery('a=1&b=2&c=3')).toBe('a=1&b=2&c=3');
  });

  // ── byte-exact parity with server reqsign.SortRawQuery (Go url.Values.Encode) ──

  it('handles params without values (Go encodes empty value as key=)', () => {
    // Go's url.Values.Encode emits "key=" for an empty value.
    expect(sortQuery('z&a&m')).toBe('a=&m=&z=');
  });

  it('sorts two params by key: b=2&a=1 → a=1&b=2', () => {
    expect(sortQuery('b=2&a=1')).toBe('a=1&b=2');
  });

  it('encodes a space as "+" (Go QueryEscape): a=hello world → a=hello+world', () => {
    expect(sortQuery('a=hello world')).toBe('a=hello+world');
  });

  it('sorts a key with multiple values ascending: x=2&x=1 → x=1&x=2', () => {
    expect(sortQuery('x=2&x=1')).toBe('x=1&x=2');
  });

  it('strips leading "?" and sorts: ?z=1&a=2 → a=2&z=1', () => {
    expect(sortQuery('?z=1&a=2')).toBe('a=2&z=1');
  });

  it('normalises percent-encoding to match Go (space as %20 or + both → +)', () => {
    expect(sortQuery('a=hello%20world')).toBe('a=hello+world');
    expect(sortQuery('a=hello+world')).toBe('a=hello+world');
  });

  it('percent-encodes the chars Go escapes but encodeURIComponent keeps', () => {
    // Go QueryEscape escapes ! * ' ( ) which encodeURIComponent leaves bare.
    expect(sortQuery("a=!*'()")).toBe('a=%21%2A%27%28%29');
  });
});

// ─── buildCanonical ───────────────────────────────────────────────────────────

describe('buildCanonical', () => {
  it('joins 7 fields with \\n in exact order', () => {
    const result = buildCanonical(
      'POST',
      '/v1/devices/register',
      '',
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      '1718500000',
      'abc123nonce',
      'device-id-0011',
    );

    const lines = result.split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe('POST');
    expect(lines[1]).toBe('/v1/devices/register');
    expect(lines[2]).toBe('');                          // sortedQuery
    expect(lines[3]).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(lines[4]).toBe('1718500000');
    expect(lines[5]).toBe('abc123nonce');
    expect(lines[6]).toBe('device-id-0011');
  });

  it('is byte-identical across calls with the same inputs', () => {
    const a = buildCanonical('PUT', '/v1/devices/metadata', 'a=1&b=2', 'deadbeef', '100', 'nonce', 'dev');
    const b = buildCanonical('PUT', '/v1/devices/metadata', 'a=1&b=2', 'deadbeef', '100', 'nonce', 'dev');
    expect(a).toBe(b);
  });

  it('incorporates query string correctly', () => {
    const result = buildCanonical('GET', '/v1/foo', 'a=1&z=9', 'hash', 'ts', 'nn', 'did');
    const lines = result.split('\n');
    expect(lines[2]).toBe('a=1&z=9');
  });
});

// ─── MemoryKeyStore ────────────────────────────────────────────────────────────

describe('MemoryKeyStore', () => {
  it('returns null for missing key', async () => {
    const store = new MemoryKeyStore();
    expect(await store.getItem('missing')).toBeNull();
  });

  it('persists values across calls', async () => {
    const store = new MemoryKeyStore();
    await store.setItem('k', 'v');
    expect(await store.getItem('k')).toBe('v');
  });
});

// ─── Provisioning (SigningSession via PushClient) ─────────────────────────────

describe('Provisioning — deviceId + key generation', () => {
  function makeMockSigner(pubKey = 'MOCK_SPKI_BASE64=='): Signer {
    return {
      generate: jest.fn().mockResolvedValue(pubKey),
      sign: jest.fn().mockResolvedValue('MOCK_SIG=='),
      getPublicKey: jest.fn().mockResolvedValue(pubKey),
      isSupported: jest.fn().mockResolvedValue(true),
    };
  }

  it('generates and persists a deviceId on first init', async () => {
    const store = new MemoryKeyStore();
    const signer = makeMockSigner();

    // Initialise PushClient with signing enabled + injected deps
    // (jest.resetModules not required — we use the inline _keyStore/_signer escapes)
    const { PushClient } = require('../src/index');
    const client = new PushClient({
      projectId: 'pk_live_test',
      enableSigning: true,
      _keyStore: store,
      _signer: signer,
    });

    // Trigger provisioning by calling register (which calls ensureInitialized)
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('{}'),
    });
    globalThis.fetch = mockFetch;

    await client.devices.register({ pushToken: 'tok', platform: 'ios' });

    const deviceId = await store.getItem('espresso.deviceId');
    expect(deviceId).toBeTruthy();
    expect(typeof deviceId).toBe('string');
    expect(deviceId!.length).toBeGreaterThanOrEqual(16);
  });

  it('generates and persists the signing public key', async () => {
    const store = new MemoryKeyStore();
    const signer = makeMockSigner('FAKE_SPKI_PUBLIC_KEY==');

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('{}'),
    });
    globalThis.fetch = mockFetch;

    const { PushClient } = require('../src/index');
    const client = new PushClient({
      projectId: 'pk_live_test',
      enableSigning: true,
      _keyStore: store,
      _signer: signer,
    });

    await client.devices.register({ pushToken: 'tok', platform: 'ios' });

    const storedKey = await store.getItem('espresso.signingPublicKey');
    expect(storedKey).toBe('FAKE_SPKI_PUBLIC_KEY==');
    expect(signer.generate).toHaveBeenCalledWith('espresso-signing-key');
  });

  it('reuses existing deviceId + key on subsequent calls (CREATE-ONLY)', async () => {
    const store = new MemoryKeyStore();
    // Pre-seed an existing identity
    await store.setItem('espresso.deviceId', 'pre-existing-device-id');
    await store.setItem('espresso.signingPublicKey', 'PRE_EXISTING_KEY==');

    const signer = makeMockSigner('NEW_KEY==');

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('{}'),
    });
    globalThis.fetch = mockFetch;

    const { PushClient } = require('../src/index');
    const client = new PushClient({
      projectId: 'pk_live_test',
      enableSigning: true,
      _keyStore: store,
      _signer: signer,
    });

    await client.devices.register({ pushToken: 'tok', platform: 'ios' });

    // Key generation must NOT have been called — existing key reused
    expect(signer.generate).not.toHaveBeenCalled();

    const deviceId = await store.getItem('espresso.deviceId');
    expect(deviceId).toBe('pre-existing-device-id');
    const storedKey = await store.getItem('espresso.signingPublicKey');
    expect(storedKey).toBe('PRE_EXISTING_KEY==');
  });

  it('register payload includes signing_public_key, signing_key_type, device_id', async () => {
    const store = new MemoryKeyStore();
    const signer = makeMockSigner('SPKI_PUB_KEY==');

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('{}'),
    });
    globalThis.fetch = mockFetch;

    const { PushClient } = require('../src/index');
    const client = new PushClient({
      projectId: 'pk_live_test',
      enableSigning: true,
      _keyStore: store,
      _signer: signer,
    });

    await client.devices.register({ pushToken: 'tok', platform: 'android' });

    // Find the register call (FetchTransport will have been called)
    const registerCall = mockFetch.mock.calls.find(([url]: [string]) =>
      url.includes('/v1/devices/register'),
    );
    expect(registerCall).toBeDefined();
    const body = JSON.parse(registerCall![1].body);

    expect(body.signing_public_key).toBe('SPKI_PUB_KEY==');
    expect(body.signing_key_type).toBe('ecdsa_p256');
    expect(typeof body.device_id).toBe('string');
    expect(body.device_id.length).toBeGreaterThan(0);
  });
});

// ─── Transport signing ────────────────────────────────────────────────────────

describe('Transport signing — POST/GET header injection', () => {
  function makeMockSigner(): Signer {
    return {
      generate: jest.fn().mockResolvedValue('SPKI=='),
      sign: jest.fn().mockResolvedValue('SIGNATURE_BASE64=='),
      getPublicKey: jest.fn().mockResolvedValue('SPKI=='),
      isSupported: jest.fn().mockResolvedValue(true),
    };
  }

  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('{}'),
    });
    globalThis.fetch = mockFetch;
  });

  it('POST attaches all 5 X-KM-* headers when signing is enabled', async () => {
    const store = new MemoryKeyStore();
    const signer = makeMockSigner();

    const { PushClient } = require('../src/index');
    const client = new PushClient({
      projectId: 'pk_live_test',
      enableSigning: true,
      _keyStore: store,
      _signer: signer,
    });

    await client.devices.register({ pushToken: 'tok', platform: 'ios' });

    const registerCall = mockFetch.mock.calls.find(([url]: [string]) =>
      url.includes('/v1/devices/register'),
    );
    expect(registerCall).toBeDefined();
    const headers = registerCall![1].headers as Record<string, string>;

    expect(headers['X-KM-Device-Id']).toBeTruthy();
    expect(headers['X-KM-Timestamp']).toMatch(/^\d+$/);
    expect(headers['X-KM-Nonce']).toBeTruthy();
    expect(headers['X-KM-Signature']).toBe('SIGNATURE_BASE64==');
    expect(headers['X-KM-Sig-Alg']).toBe('ES256');
  });

  it('signer.sign is called with a base64-encoded canonical string', async () => {
    const store = new MemoryKeyStore();
    const signer = makeMockSigner();

    const { PushClient } = require('../src/index');
    const client = new PushClient({
      projectId: 'pk_live_test',
      enableSigning: true,
      _keyStore: store,
      _signer: signer,
    });

    await client.devices.register({ pushToken: 'tok', platform: 'ios' });

    // sign() must have been called at least once (for the register POST)
    expect(signer.sign).toHaveBeenCalled();
    const [keyId, dataB64] = (signer.sign as jest.Mock).mock.calls[0];
    expect(keyId).toBe('espresso-signing-key');
    // dataB64 should be valid base64
    expect(() => Buffer.from(dataB64, 'base64')).not.toThrow();
    // The decoded canonical should contain the 7 fields separated by \n
    const canonical = Buffer.from(dataB64, 'base64').toString('utf8');
    const lines = canonical.split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe('POST');
    expect(lines[1]).toBe('/v1/devices/register');
  });

  it('signed canonical uses the SHA-256 hash of the request body', async () => {
    const store = new MemoryKeyStore();
    const signer = makeMockSigner();

    const { PushClient } = require('../src/index');
    const client = new PushClient({
      projectId: 'pk_live_test',
      enableSigning: true,
      _keyStore: store,
      _signer: signer,
    });

    await client.devices.register({ pushToken: 'tok', platform: 'ios' });

    expect(signer.sign).toHaveBeenCalled();
    const [, dataB64] = (signer.sign as jest.Mock).mock.calls[0];
    const canonical = Buffer.from(dataB64, 'base64').toString('utf8');
    const lines = canonical.split('\n');
    // line[3] is the body SHA-256 hex
    const bodyHashInCanonical = lines[3];
    expect(bodyHashInCanonical).toHaveLength(64);
    expect(bodyHashInCanonical).toMatch(/^[0-9a-f]+$/);
    // Must not be the empty-string hash (body is non-empty JSON)
    expect(bodyHashInCanonical).not.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('GET requests DO get X-KM-* headers when signing is enabled (#813-D)', async () => {
    const store = new MemoryKeyStore();
    const signer = makeMockSigner();

    // Inject a custom transport that records the options passed to it.
    // This lets us inspect headers without needing a real fetch or categories API.
    const capturedCalls: Array<{ path: string; options: RequestInit }> = [];
    const customTransport = {
      request: jest.fn(async (path: string, options: RequestInit = {}) => {
        capturedCalls.push({ path, options });
        return {};
      }),
    };

    const { PushClient } = require('../src/index');

    // Build signing transport wrapping the custom transport
    // (transport override + signing deps so SigningTransport wraps customTransport).
    const client = new PushClient({
      projectId: 'pk_live_test',
      enableSigning: true,
      transport: customTransport,
      _keyStore: store,
      _signer: signer,
    });

    // A GET-like call (no 'method' field = GET in the Transport contract).
    // The server enforces signing on all public-token paths except the bootstrap
    // register POST, so a signed GET is REQUIRED. The signing transport must add
    // X-KM-* headers here.
    await (client as any)._transport.request('/v1/test-get', {});

    expect(capturedCalls).toHaveLength(1);
    const { options } = capturedCalls[0];
    const headers = (options.headers ?? {}) as Record<string, string>;

    expect(headers['X-KM-Device-Id']).toBeTruthy();
    expect(headers['X-KM-Timestamp']).toMatch(/^\d+$/);
    expect(headers['X-KM-Nonce']).toBeTruthy();
    expect(headers['X-KM-Signature']).toBe('SIGNATURE_BASE64==');
    expect(headers['X-KM-Sig-Alg']).toBe('ES256');
  });

  it('GET canonical (field 3) uses the SORTED query string when one is present', async () => {
    const store = new MemoryKeyStore();
    const signer = makeMockSigner();

    const capturedCalls: Array<{ path: string; options: RequestInit }> = [];
    const customTransport = {
      request: jest.fn(async (path: string, options: RequestInit = {}) => {
        capturedCalls.push({ path, options });
        return {};
      }),
    };

    const { PushClient } = require('../src/index');
    const client = new PushClient({
      projectId: 'pk_live_test',
      enableSigning: true,
      transport: customTransport,
      _keyStore: store,
      _signer: signer,
    });

    // Unsorted query on a GET — canonical field 3 must be the SORTED form.
    await (client as any)._transport.request('/v1/items?z=1&a=2', {});

    expect(signer.sign).toHaveBeenCalled();
    const [, dataB64] = (signer.sign as jest.Mock).mock.calls[0];
    const canonical = Buffer.from(dataB64, 'base64').toString('utf8');
    const lines = canonical.split('\n');
    expect(lines[0]).toBe('GET');
    expect(lines[1]).toBe('/v1/items'); // path WITHOUT query
    expect(lines[2]).toBe('a=2&z=1');   // sorted query in field 3
  });

  it('GET with enableSigning=false carries NO X-KM-* headers (transport not wrapped)', async () => {
    // No signing deps and signing disabled → SigningTransport is never wired,
    // so the call is a true no-op pass-through with zero X-KM headers.
    const capturedCalls: Array<{ path: string; options: RequestInit }> = [];
    const customTransport = {
      request: jest.fn(async (path: string, options: RequestInit = {}) => {
        capturedCalls.push({ path, options });
        return {};
      }),
    };

    const { PushClient } = require('../src/index');
    const client = new PushClient({
      projectId: 'pk_live_test',
      enableSigning: false,
      transport: customTransport,
    });

    await (client as any)._transport.request('/v1/test-get', {});

    expect(capturedCalls).toHaveLength(1);
    const headers = (capturedCalls[0].options.headers ?? {}) as Record<string, string>;
    expect(headers['X-KM-Device-Id']).toBeUndefined();
    expect(headers['X-KM-Timestamp']).toBeUndefined();
    expect(headers['X-KM-Nonce']).toBeUndefined();
    expect(headers['X-KM-Signature']).toBeUndefined();
    expect(headers['X-KM-Sig-Alg']).toBeUndefined();
  });

  it('enableSigning=false (default) — NO X-KM-* headers on POST', async () => {
    const { PushClient } = require('../src/index');
    const client = new PushClient({
      projectId: 'pk_live_test',
      // enableSigning intentionally omitted (defaults to false)
    });

    await client.devices.register({ pushToken: 'tok', platform: 'ios' });

    const registerCall = mockFetch.mock.calls.find(([url]: [string]) =>
      url.includes('/v1/devices/register'),
    );
    expect(registerCall).toBeDefined();
    const headers = (registerCall![1]?.headers ?? {}) as Record<string, string>;

    expect(headers['X-KM-Device-Id']).toBeUndefined();
    expect(headers['X-KM-Timestamp']).toBeUndefined();
    expect(headers['X-KM-Nonce']).toBeUndefined();
    expect(headers['X-KM-Signature']).toBeUndefined();
    expect(headers['X-KM-Sig-Alg']).toBeUndefined();
  });

  it('enableSigning=false (explicit) — NO X-KM-* headers on POST', async () => {
    const { PushClient } = require('../src/index');
    const client = new PushClient({
      projectId: 'pk_live_test',
      enableSigning: false,
    });

    await client.devices.register({ pushToken: 'tok', platform: 'android' });

    const registerCall = mockFetch.mock.calls.find(([url]: [string]) =>
      url.includes('/v1/devices/register'),
    );
    const headers = (registerCall![1]?.headers ?? {}) as Record<string, string>;
    expect(headers['X-KM-Device-Id']).toBeUndefined();
    expect(headers['X-KM-Signature']).toBeUndefined();
  });

  it('enableSigning=false — register payload does NOT include signing_public_key', async () => {
    const { PushClient } = require('../src/index');
    const client = new PushClient({
      projectId: 'pk_live_test',
      enableSigning: false,
    });

    await client.devices.register({ pushToken: 'tok', platform: 'ios' });

    const registerCall = mockFetch.mock.calls.find(([url]: [string]) =>
      url.includes('/v1/devices/register'),
    );
    const body = JSON.parse(registerCall![1].body);
    expect(body.signing_public_key).toBeUndefined();
    expect(body.signing_key_type).toBeUndefined();
  });
});
