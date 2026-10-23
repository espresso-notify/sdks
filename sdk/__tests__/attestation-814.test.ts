/**
 * Unit tests for device-attestation orchestration (#814-F).
 *
 * Covers the SDK layer that runs: challenge → native attest → verify.
 *
 *  - enableAttestation=false (default): attest() is a no-op, makes NO network
 *    call, and the signing wiring is byte-identical (no behaviour change).
 *  - enableSigning + enableAttestation + injected mock provider/transport:
 *      attest() POSTs /v1/attest/challenge then /v1/attest/verify with the
 *      correct payload (device_id from the signing session, provider/key_id/
 *      attestation OR app_check_token, challenge echoed) — asserted for BOTH an
 *      apple-appattest mock and a play-integrity mock.
 *  - provider.isSupported()=false → {attested:false}, NO network call, no throw.
 *  - provider.attest() throws → swallowed, {attested:false}, no throw.
 *  - challenge endpoint failure → graceful {attested:false}.
 *
 * All native deps are mocked via the internal _attestationProvider / _keyStore /
 * _signer escape hatches. No real fetch or native module is touched.
 */

// Virtual mock so expo-notifications doesn't crash module load
jest.mock('expo-notifications', () => ({}), { virtual: true });

import {
  PushClient,
  MemoryKeyStore,
  NullAttestationProvider,
  ExpoAppAttestProvider,
  FirebaseAppCheckProvider,
} from '../src/index';
import type {
  KeyStore,
  Signer,
  AttestationProvider,
  AttestationResult,
} from '../src/index';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockSigner(pubKey = 'MOCK_SPKI=='): Signer {
  return {
    generate: jest.fn().mockResolvedValue(pubKey),
    sign: jest.fn().mockResolvedValue('MOCK_SIG=='),
    getPublicKey: jest.fn().mockResolvedValue(pubKey),
    isSupported: jest.fn().mockResolvedValue(true),
  };
}

/**
 * A custom Transport that records every (path, options) it receives and returns
 * canned responses keyed by path. Lets us assert the exact attest payload shapes
 * without a real fetch.
 */
function makeRecordingTransport(responses: Record<string, unknown>) {
  const calls: Array<{ path: string; options: RequestInit }> = [];
  const transport = {
    request: jest.fn(async (path: string, options: RequestInit = {}) => {
      calls.push({ path, options });
      // Match by path prefix (ignore query strings)
      const key = Object.keys(responses).find((k) => path.startsWith(k));
      return key ? responses[key] : {};
    }),
  };
  return { transport, calls };
}

/** Mock attestation provider producing an Apple App Attest result. */
function makeAppleProvider(
  result: Partial<AttestationResult> = {},
): AttestationProvider {
  return {
    isSupported: jest.fn().mockReturnValue(true),
    attest: jest.fn(
      async (_challenge: string): Promise<AttestationResult> => ({
        provider: 'apple-appattest',
        keyId: 'BASE64_KEYID==',
        attestation: 'BASE64_CBOR_ATTESTATION==',
        ...result,
      }),
    ),
  };
}

/** Mock attestation provider producing a Play Integrity (App Check) result. */
function makePlayProvider(
  result: Partial<AttestationResult> = {},
): AttestationProvider {
  return {
    isSupported: jest.fn().mockReturnValue(true),
    attest: jest.fn(
      async (_challenge: string): Promise<AttestationResult> => ({
        provider: 'play-integrity',
        appCheckToken: 'APP_CHECK_JWT_TOKEN',
        ...result,
      }),
    ),
  };
}

const STANDARD_RESPONSES = {
  '/v1/attest/challenge': { challenge: 'SERVER_CHALLENGE_NONCE', expires_in_seconds: 300 },
  '/v1/attest/verify': { attested: true, environment: 'production' },
};

// ─── enableAttestation=false: total no-op ──────────────────────────────────────

describe('enableAttestation=false (default) — total no-op', () => {
  it('attest() returns {attested:false} and makes NO network call', async () => {
    const { transport, calls } = makeRecordingTransport(STANDARD_RESPONSES);
    const client = new PushClient({
      projectId: 'pk_live_test',
      transport,
      // signing enabled, attestation NOT enabled
      enableSigning: true,
      _keyStore: new MemoryKeyStore(),
      _signer: makeMockSigner(),
    });

    const result = await client.devices.attest();

    expect(result.attested).toBe(false);
    // No attest endpoint may be hit
    const attestCalls = calls.filter((c) => c.path.includes('/v1/attest/'));
    expect(attestCalls).toHaveLength(0);
  });

  it('does not throw even with NO signing and NO attestation configured', async () => {
    const { transport, calls } = makeRecordingTransport(STANDARD_RESPONSES);
    const client = new PushClient({ projectId: 'pk_live_test', transport });

    const result = await client.devices.attest();
    expect(result.attested).toBe(false);
    expect(calls.filter((c) => c.path.includes('/v1/attest/'))).toHaveLength(0);
  });

  it('signing wiring is unchanged: register still emits signing fields', async () => {
    // Guards the byte-identical signing behaviour guarantee — attestation off
    // must not perturb the #813 register payload.
    const store = new MemoryKeyStore();
    const signer = makeMockSigner('SPKI_PUB==');
    const { transport, calls } = makeRecordingTransport({});

    const client = new PushClient({
      projectId: 'pk_live_test',
      transport,
      enableSigning: true,
      _keyStore: store,
      _signer: signer,
    });

    await client.devices.register({ pushToken: 'tok', platform: 'ios' });

    const reg = calls.find((c) => c.path.includes('/v1/devices/register'));
    expect(reg).toBeDefined();
    const body = JSON.parse((reg!.options.body as string) ?? '{}');
    expect(body.signing_public_key).toBe('SPKI_PUB==');
    expect(body.signing_key_type).toBe('ecdsa_p256');
    expect(typeof body.device_id).toBe('string');
  });
});

// ─── Happy path: challenge → attest → verify ───────────────────────────────────

describe('attest() — apple-appattest payload', () => {
  it('POSTs /v1/attest/challenge then /v1/attest/verify with the correct payload', async () => {
    const store = new MemoryKeyStore();
    const provider = makeAppleProvider();
    const { transport, calls } = makeRecordingTransport(STANDARD_RESPONSES);

    const client = new PushClient({
      projectId: 'pk_live_test',
      transport,
      enableSigning: true,
      enableAttestation: true,
      platform: 'ios',
      _keyStore: store,
      _signer: makeMockSigner(),
      _attestationProvider: provider,
    });

    const result = await client.devices.attest();

    // The persisted per-install device_id the backend binds attestation to.
    const deviceId = await store.getItem('espresso.deviceId');
    expect(deviceId).toBeTruthy();

    // Ordering: challenge first, then verify.
    const challengeCall = calls.find((c) => c.path === '/v1/attest/challenge');
    const verifyCall = calls.find((c) => c.path === '/v1/attest/verify');
    expect(challengeCall).toBeDefined();
    expect(verifyCall).toBeDefined();
    expect(calls.indexOf(challengeCall!)).toBeLessThan(calls.indexOf(verifyCall!));

    // challenge body carries the device_id
    const challengeBody = JSON.parse((challengeCall!.options.body as string) ?? '{}');
    expect(challengeBody.device_id).toBe(deviceId);

    // provider.attest received the server challenge
    expect(provider.attest).toHaveBeenCalledWith('SERVER_CHALLENGE_NONCE');

    // verify body — Apple shape
    const verifyBody = JSON.parse((verifyCall!.options.body as string) ?? '{}');
    expect(verifyBody.device_id).toBe(deviceId);
    expect(verifyBody.provider).toBe('apple-appattest');
    expect(verifyBody.key_id).toBe('BASE64_KEYID==');
    expect(verifyBody.attestation).toBe('BASE64_CBOR_ATTESTATION==');
    expect(verifyBody.app_check_token).toBeUndefined();
    expect(verifyBody.challenge).toBe('SERVER_CHALLENGE_NONCE');

    // Verify response surfaced
    expect(result.attested).toBe(true);
    expect(result.environment).toBe('production');
  });
});

describe('attest() — play-integrity payload', () => {
  it('POSTs verify with app_check_token (no key_id/attestation)', async () => {
    const store = new MemoryKeyStore();
    const provider = makePlayProvider();
    const { transport, calls } = makeRecordingTransport({
      '/v1/attest/challenge': { challenge: 'ANDROID_CHALLENGE', expires_in_seconds: 300 },
      '/v1/attest/verify': { attested: true, environment: 'production' },
    });

    const client = new PushClient({
      projectId: 'pk_live_test',
      transport,
      enableSigning: true,
      enableAttestation: true,
      platform: 'android',
      _keyStore: store,
      _signer: makeMockSigner(),
      _attestationProvider: provider,
    });

    const result = await client.devices.attest();
    const deviceId = await store.getItem('espresso.deviceId');

    expect(provider.attest).toHaveBeenCalledWith('ANDROID_CHALLENGE');

    const verifyCall = calls.find((c) => c.path === '/v1/attest/verify');
    expect(verifyCall).toBeDefined();
    const verifyBody = JSON.parse((verifyCall!.options.body as string) ?? '{}');
    expect(verifyBody.device_id).toBe(deviceId);
    expect(verifyBody.provider).toBe('play-integrity');
    expect(verifyBody.app_check_token).toBe('APP_CHECK_JWT_TOKEN');
    expect(verifyBody.key_id).toBeUndefined();
    expect(verifyBody.attestation).toBeUndefined();
    expect(verifyBody.challenge).toBe('ANDROID_CHALLENGE');

    expect(result.attested).toBe(true);
  });
});

// ─── Graceful degradation ──────────────────────────────────────────────────────

describe('attest() — graceful degradation', () => {
  it('provider.isSupported()=false → {attested:false}, NO network call, no throw', async () => {
    const provider: AttestationProvider = {
      isSupported: jest.fn().mockReturnValue(false),
      attest: jest.fn(),
    };
    const { transport, calls } = makeRecordingTransport(STANDARD_RESPONSES);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new PushClient({
      projectId: 'pk_live_test',
      transport,
      enableSigning: true,
      enableAttestation: true,
      platform: 'ios',
      _keyStore: new MemoryKeyStore(),
      _signer: makeMockSigner(),
      _attestationProvider: provider,
    });

    const result = await client.devices.attest();

    expect(result.attested).toBe(false);
    expect(provider.attest).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.path.includes('/v1/attest/'))).toHaveLength(0);
    warn.mockRestore();
  });

  it('provider.attest() throws → swallowed, {attested:false}, no throw', async () => {
    const provider: AttestationProvider = {
      isSupported: jest.fn().mockReturnValue(true),
      attest: jest.fn().mockRejectedValue(new Error('native attest blew up')),
    };
    const { transport, calls } = makeRecordingTransport(STANDARD_RESPONSES);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new PushClient({
      projectId: 'pk_live_test',
      transport,
      enableSigning: true,
      enableAttestation: true,
      platform: 'ios',
      _keyStore: new MemoryKeyStore(),
      _signer: makeMockSigner(),
      _attestationProvider: provider,
    });

    let result: { attested: boolean } | undefined;
    await expect(
      (async () => {
        result = await client.devices.attest();
      })(),
    ).resolves.toBeUndefined();

    expect(result!.attested).toBe(false);
    // Challenge was fetched, attest threw, verify must NOT be called.
    expect(calls.some((c) => c.path === '/v1/attest/challenge')).toBe(true);
    expect(calls.some((c) => c.path === '/v1/attest/verify')).toBe(false);
    warn.mockRestore();
  });

  it('challenge endpoint failure → graceful {attested:false}', async () => {
    const provider = makeAppleProvider();
    const calls: string[] = [];
    const transport = {
      request: jest.fn(async (path: string) => {
        calls.push(path);
        if (path.startsWith('/v1/attest/challenge')) {
          throw new Error('challenge endpoint 500');
        }
        return {};
      }),
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new PushClient({
      projectId: 'pk_live_test',
      transport,
      enableSigning: true,
      enableAttestation: true,
      platform: 'ios',
      _keyStore: new MemoryKeyStore(),
      _signer: makeMockSigner(),
      _attestationProvider: provider,
    });

    const result = await client.devices.attest();

    expect(result.attested).toBe(false);
    // attest()/verify must not run once challenge failed
    expect(provider.attest).not.toHaveBeenCalled();
    expect(calls.some((p) => p.startsWith('/v1/attest/verify'))).toBe(false);
    warn.mockRestore();
  });

  it('verify endpoint failure → graceful {attested:false}', async () => {
    const provider = makeAppleProvider();
    const transport = {
      request: jest.fn(async (path: string) => {
        if (path.startsWith('/v1/attest/challenge')) {
          return { challenge: 'C', expires_in_seconds: 300 };
        }
        throw new Error('verify endpoint 500');
      }),
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new PushClient({
      projectId: 'pk_live_test',
      transport,
      enableSigning: true,
      enableAttestation: true,
      platform: 'ios',
      _keyStore: new MemoryKeyStore(),
      _signer: makeMockSigner(),
      _attestationProvider: provider,
    });

    const result = await client.devices.attest();
    expect(result.attested).toBe(false);
    warn.mockRestore();
  });
});

// ─── Provider resolution / units ───────────────────────────────────────────────

describe('AttestationProvider concrete units', () => {
  it('NullAttestationProvider.isSupported() is false and attest() throws', async () => {
    const p = new NullAttestationProvider();
    expect(p.isSupported()).toBe(false);
    await expect(p.attest('c')).rejects.toThrow();
  });

  it('ExpoAppAttestProvider.isSupported() is false when native module is absent', () => {
    // No 'react-native-ios-appattest' installed in the test env → false.
    const p = new ExpoAppAttestProvider();
    expect(p.isSupported()).toBe(false);
  });

  // The custom-module case (`nativeModule`, which replaced `moduleName`) and the
  // static default specifier are covered in app-attest-static.test.ts (SDKFIX-01).

  it('FirebaseAppCheckProvider.isSupported() is false when module is absent', () => {
    // @react-native-firebase/app-check not installed in the test env → false.
    const p = new FirebaseAppCheckProvider();
    expect(p.isSupported()).toBe(false);
  });
});
