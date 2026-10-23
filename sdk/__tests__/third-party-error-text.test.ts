/**
 * @jest-environment node
 *
 * sdk-private-transport T14a (owner decision D-6): the three warnings that used to append the text of an error thrown
 * by another package (the signer, the pinning library, the attestation provider) are fixed SDK messages with a code.
 * The text the other package raised, an `Error` message or a rejected string, is never written to the console.
 *
 * Each case makes the other package fail with a sentinel text and reads every argument of every console method.
 */
import { PushClient, MemoryKeyStore } from '../src/index';
import type { AttestationProvider, Signer } from '../src/index';

jest.mock('expo-notifications', () => ({}), { virtual: true });

const mockFetch = jest.fn();
globalThis.fetch = mockFetch;

const METHODS = ['log', 'info', 'debug', 'warn', 'error', 'trace'] as const;

describe('a failure of another package is logged as a fixed message with a code (D-6)', () => {
  let spies: jest.SpyInstance[];
  const written = () => spies.flatMap((s) => s.mock.calls.flat().map((a) => String(a)));
  const warnings = () => spies[METHODS.indexOf('warn')].mock.calls;

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve('{}') });
    spies = METHODS.map((m) => jest.spyOn(console, m).mockImplementation());
  });
  afterEach(() => spies.forEach((s) => s.mockRestore()));

  const signingClient = (sign: Signer['sign']) =>
    new PushClient({
      projectId: 'pk_live_test',
      pushToken: 'tok',
      platform: 'ios',
      autoTrack: false,
      enableSigning: true,
      _keyStore: new MemoryKeyStore(),
      _signer: {
        generate: jest.fn().mockResolvedValue('PUB=='),
        sign,
        getPublicKey: jest.fn().mockResolvedValue('PUB=='),
        isSupported: jest.fn().mockResolvedValue(true),
      },
    });

  it('signer: an Error is named by SIGNING_FAILED and its message and extra fields stay out', async () => {
    const nativeError = Object.assign(new Error('SENTINEL_SIGNER_TEXT'), { nativeStackTrace: 'SENTINEL_SIGNER_STACK' });
    await signingClient(jest.fn().mockRejectedValue(nativeError)).devices.identify({ externalId: 'u1' });

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toHaveLength(1);
    expect(warnings()[0][0]).toBe(
      '[espresso-notify] request signing failed (SIGNING_FAILED); sending unsigned (server will reject if require_signing is enabled).',
    );
    expect(written().join('\n')).not.toMatch(/SENTINEL/);
  });

  it('signer: a rejected string is not written either', async () => {
    await signingClient(jest.fn().mockRejectedValue('SENTINEL_SIGNER_STRING')).devices.identify({ externalId: 'u1' });

    expect(warnings()).toHaveLength(1);
    expect(String(warnings()[0][0])).toContain('SIGNING_FAILED');
    expect(written().join('\n')).not.toMatch(/SENTINEL/);
  });

  it('signer: the request still goes out unsigned', async () => {
    await signingClient(jest.fn().mockRejectedValue(new Error('SENTINEL_SIGNER_TEXT'))).devices.identify({ externalId: 'u1' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][1].headers['X-KM-Signature']).toBeUndefined();
  });

  describe('pinning library', () => {
    beforeEach(() => jest.resetModules());

    it.each([
      ['an Error', () => new Error('SENTINEL_PINNING_TEXT')],
      ['a rejected string', () => 'SENTINEL_PINNING_STRING'],
    ])('%s: the call resolves false, with PINNING_INIT_FAILED and none of the library text', async (_name, make) => {
      jest.doMock(
        'react-native-ssl-public-key-pinning',
        () => ({ initializeSslPinning: jest.fn().mockRejectedValue(make()), disableSslPinning: jest.fn() }),
        { virtual: true },
      );
      const { enableCertificatePinning } = require('../src/index');

      const result = await enableCertificatePinning({ 'example.com': { publicKeyHashes: ['h1'] } });

      expect(result).toBe(false);
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toHaveLength(1);
      expect(warnings()[0][0]).toBe(
        '[espresso-notify] Certificate pinning initialization failed (PINNING_INIT_FAILED); pinning stays off.',
      );
      expect(written().join('\n')).not.toMatch(/SENTINEL/);
    });
  });

  describe('attestation', () => {
    const attestClient = (provider: AttestationProvider, answer: (path: string) => unknown) => {
      const transport = { request: jest.fn(async (path: string) => answer(path)) };
      return new PushClient({
        projectId: 'pk_live_test',
        transport,
        enableSigning: true,
        enableAttestation: true,
        platform: 'ios',
        _keyStore: new MemoryKeyStore(),
        _signer: {
          generate: jest.fn().mockResolvedValue('PUB=='),
          sign: jest.fn().mockResolvedValue('SIG=='),
          getPublicKey: jest.fn().mockResolvedValue('PUB=='),
          isSupported: jest.fn().mockResolvedValue(true),
        },
        _attestationProvider: provider,
      });
    };
    const ok = (path: string) => (path.endsWith('/challenge') ? { challenge: 'C' } : { attested: true });

    it('the provider fails: ATTESTATION_FAILED, the result is the same and the provider text stays out', async () => {
      const provider: AttestationProvider = {
        isSupported: jest.fn().mockReturnValue(true),
        attest: jest.fn().mockRejectedValue(new Error('SENTINEL_ATTEST_TEXT')),
      };

      const result = await attestClient(provider, ok).devices.attest();

      expect(result).toEqual({ attested: false, reason: 'error' });
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toHaveLength(1);
      expect(warnings()[0][0]).toBe(
        '[espresso-notify] device attestation failed (ATTESTATION_FAILED); the device is reported as not attested.',
      );
      expect(written().join('\n')).not.toMatch(/SENTINEL/);
    });

    it('a rejected string and a failing request are also fixed messages', async () => {
      const provider: AttestationProvider = {
        isSupported: jest.fn().mockReturnValue(true),
        attest: jest.fn().mockRejectedValue('SENTINEL_ATTEST_STRING'),
      };
      await attestClient(provider, ok).devices.attest();

      const failing: AttestationProvider = {
        isSupported: jest.fn().mockReturnValue(true),
        attest: jest.fn().mockResolvedValue({ provider: 'apple-appattest', keyId: 'K', attestation: 'A' }),
      };
      await attestClient(failing, (path) => {
        if (path.endsWith('/verify')) throw new Error('SENTINEL_REQUEST_TEXT');
        return ok(path);
      }).devices.attest();

      expect(warnings()).toHaveLength(2);
      expect(warnings().every((w) => w.length === 1 && String(w[0]).includes('ATTESTATION_FAILED'))).toBe(true);
      expect(written().join('\n')).not.toMatch(/SENTINEL/);
    });
  });
});
