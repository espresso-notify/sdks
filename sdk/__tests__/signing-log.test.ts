/**
 * @jest-environment node
 *
 * rn-sdk-v1-calls T13 (RNV-25): a failed signature is logged as a message, not as the raw error.
 *
 * SPEC_AMENDMENT (sdk-private-transport T14a, owner decision D-6): the message is a fixed SDK text with the code
 * SIGNING_FAILED. It no longer appends the message of the error that the signer raised, so the two assertions that
 * pinned that echo (formerly lines 49 and 93) now assert that the text is absent.
 */
import { PushClient, MemoryKeyStore } from '../src/index';
import type { Signer } from '../src/index';

jest.mock('expo-notifications', () => ({}), { virtual: true });

const mockFetch = jest.fn();
globalThis.fetch = mockFetch;

describe('logging a failed signature (RNV-25)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve('{}') });
    warn = jest.spyOn(console, 'warn').mockImplementation();
  });
  afterEach(() => warn.mockRestore());

  it('warns once, with the espresso-notify prefix and a fixed message with the code', async () => {
    const nativeError = Object.assign(new Error('keystore locked'), { nativeStackTrace: 'secret internals' });
    const signer: Signer = {
      generate: jest.fn().mockResolvedValue('PUB=='),
      sign: jest.fn().mockRejectedValue(nativeError),
      getPublicKey: jest.fn().mockResolvedValue('PUB=='),
      isSupported: jest.fn().mockResolvedValue(true),
    };
    const client = new PushClient({
      projectId: 'pk_live_test',
      pushToken: 'tok',
      platform: 'ios',
      autoTrack: false,
      enableSigning: true,
      _keyStore: new MemoryKeyStore(),
      _signer: signer,
    });

    await client.devices.identify({ externalId: 'u1' });

    const signingWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('signing failed'));
    expect(signingWarnings).toHaveLength(1);
    const args = signingWarnings[0];
    expect(args).toHaveLength(1);
    expect(typeof args[0]).toBe('string');
    expect(args[0]).toMatch(/^\[espresso-notify\] request signing failed/);
    // SPEC_AMENDMENT (D-6): was toContain('keystore locked'); the signer's text is never logged.
    expect(args[0]).toContain('SIGNING_FAILED');
    expect(args[0]).not.toContain('keystore locked');
    expect(args[0]).not.toContain('secret internals');
    expect(String(args[0])).not.toContain('[push-sdk]');
  });

  it('still sends the request, unsigned', async () => {
    const signer: Signer = {
      generate: jest.fn().mockResolvedValue('PUB=='),
      sign: jest.fn().mockRejectedValue(new Error('boom')),
      getPublicKey: jest.fn().mockResolvedValue('PUB=='),
      isSupported: jest.fn().mockResolvedValue(true),
    };
    const client = new PushClient({
      projectId: 'pk_live_test',
      pushToken: 'tok',
      platform: 'ios',
      autoTrack: false,
      enableSigning: true,
      _keyStore: new MemoryKeyStore(),
      _signer: signer,
    });

    await client.devices.identify({ externalId: 'u1' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][1].headers['X-KM-Signature']).toBeUndefined();
  });

  it('names a non-Error rejection by the code, not by its text', async () => {
    const signer: Signer = {
      generate: jest.fn().mockResolvedValue('PUB=='),
      sign: jest.fn().mockRejectedValue('plain string failure'),
      getPublicKey: jest.fn().mockResolvedValue('PUB=='),
      isSupported: jest.fn().mockResolvedValue(true),
    };
    const client = new PushClient({
      projectId: 'pk_live_test',
      pushToken: 'tok',
      autoTrack: false,
      enableSigning: true,
      _keyStore: new MemoryKeyStore(),
      _signer: signer,
    });
    await client.devices.identify({ externalId: 'u1' });
    // SPEC_AMENDMENT (D-6): was toContain('plain string failure').
    const text = String(warn.mock.calls.find((c) => String(c[0]).includes('signing failed'))?.[0]);
    expect(text).toContain('SIGNING_FAILED');
    expect(text).not.toContain('plain string failure');
  });
});

export {};
