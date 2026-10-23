/**
 * @jest-environment jsdom
 *
 * FE-12 (security-sdk-fixes, SDKS-01 to SDKS-06): `usePushNotifications` takes
 * `enableSigning` and `enableAttestation` and the client it creates signs and
 * attests exactly as the non-hook API does.
 *
 * The REAL PushClient runs here (nothing of ../src/index is mocked). Only the
 * edges are fake: `fetch`, the native signer (`react-native-secure-sign`) and the
 * App Attest module (`react-native-ios-appattest`). The tests read what went
 * over the wire.
 */

import { createHash } from 'crypto'
import { renderHook, waitFor } from '@testing-library/react'
import { usePushNotifications } from '../src/hooks'
import { buildCanonical, sha256HexUtf8 } from '../src/index'

// ─── Native edges ────────────────────────────────────────────────────────────
const mockGenerate = jest.fn(async (_id: string) => 'SPKI_B64==')
// The fake signature echoes the base64 canonical it was asked to sign, so a test can
// prove WHAT was signed, not only that a header exists.
const mockSign = jest.fn(async (_id: string, dataB64: string) => `SIG:${dataB64}`)
const mockGenerateAppAttestKey = jest.fn(async () => 'KEY_ID==')
const mockAttestKey = jest.fn(async (_keyId: string, _challengeHashBase64: string) => 'CBOR_ATTESTATION==')

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }), { virtual: true })
jest.mock('expo-notifications', () => ({}), { virtual: true })
jest.mock(
  'react-native-secure-sign',
  () => ({
    // The shape react-native-secure-sign 0.0.2 exports (its published types): generate, sign, getPublicKey, removeKey,
    // checkHardwareSupport. There is no `generateKeyPair`.
    generate: (id: string) => mockGenerate(id),
    sign: (id: string, data: string) => mockSign(id, data),
    getPublicKey: async () => 'SPKI_B64==',
    removeKey: async () => undefined,
    checkHardwareSupport: async () => true,
  }),
  { virtual: true },
)
jest.mock(
  'react-native-ios-appattest',
  // The shape react-native-ios-appattest exports (its published types): attestationSupported, generateKeys,
  // attestKeys, attestRequestData. There is no `generateKey` and no `attestKey`.
  () => ({
    attestationSupported: async () => true,
    generateKeys: () => mockGenerateAppAttestKey(),
    attestKeys: (k: string, c: string) => mockAttestKey(k, c),
    attestRequestData: async () => 'ASSERTION==',
  }),
  { virtual: true },
)

// ─── Fake fetch ──────────────────────────────────────────────────────────────
interface Call {
  path: string
  method: string
  headers: Record<string, string>
  body: string
}
let calls: Call[]

function installFetch(overrides: Record<string, () => unknown | Promise<unknown>> = {}) {
  calls = []
  const responses: Record<string, () => unknown | Promise<unknown>> = {
    '/v1/attest/challenge': () => ({ challenge: 'SERVER_CHALLENGE', expires_in_seconds: 300 }),
    '/v1/attest/verify': () => ({ attested: true, environment: 'production' }),
    ...overrides,
  }
  globalThis.fetch = jest.fn(async (url: unknown, init: RequestInit = {}) => {
    const path = String(url).replace('__ESPRESSO_API_URL__', '')
    calls.push({
      path,
      method: String(init.method ?? 'GET'),
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === 'string' ? init.body : '',
    })
    const respond = responses[path]
    const out = respond ? await respond() : {}
    if (out instanceof Error) throw out
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(out) }
  }) as unknown as typeof fetch
}

const paths = () => calls.map((c) => c.path)
const SIGN_HEADERS = ['X-KM-Device-Id', 'X-KM-Timestamp', 'X-KM-Nonce', 'X-KM-Signature', 'X-KM-Sig-Alg']
const BASE = { projectId: 'pk_live_abcdefghijklmnop', pushToken: 'ExponentPushToken[abc]', platform: 'ios' as const }

let warn: jest.SpyInstance

beforeEach(() => {
  jest.clearAllMocks()
  installFetch()
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => warn.mockRestore())

// ─── SDKS-01 ─────────────────────────────────────────────────────────────────
describe('enableSigning on the hook (SDKS-01)', () => {
  it('registers with the signing fields and signs identify and events', async () => {
    const { result } = renderHook(() => usePushNotifications({ ...BASE, externalId: 'user-1', enableSigning: true }))
    await waitFor(() => expect(result.current.isReady).toBe(true))
    await waitFor(() => expect(paths()).toContain('/v1/devices/identify'))
    await result.current.client!.devices.trackOpen(42)

    const register = calls.find((c) => c.path === '/v1/devices/register')!
    const body = JSON.parse(register.body)
    expect(body.signing_public_key).toBe('SPKI_B64==')
    expect(body.signing_key_type).toBe('ecdsa_p256')
    expect(body.device_id).toMatch(/^[0-9a-f]{32}$/)

    for (const path of ['/v1/devices/identify', '/v1/notifications/track']) {
      const call = calls.find((c) => c.path === path)!
      for (const h of SIGN_HEADERS) expect(call.headers[h]).toBeTruthy()
      expect(call.headers['X-KM-Device-Id']).toBe(body.device_id)
      expect(call.headers['X-KM-Sig-Alg']).toBe('ES256')

      // What was signed is the canonical string of THAT request (current scheme).
      const canonical = buildCanonical(
        call.method,
        path,
        '',
        sha256HexUtf8(call.body),
        call.headers['X-KM-Timestamp'],
        call.headers['X-KM-Nonce'],
        body.device_id,
      )
      expect(call.headers['X-KM-Signature']).toBe(`SIG:${Buffer.from(canonical, 'binary').toString('base64')}`)
    }
  })

  it('signs the unregister when the user logs out', async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => usePushNotifications({ ...BASE, externalId: id, enableSigning: true }),
      { initialProps: { id: 'user-1' as string | null } },
    )
    await waitFor(() => expect(paths()).toContain('/v1/devices/identify'))
    rerender({ id: null })
    await waitFor(() => expect(paths()).toContain('/v1/devices/unregister'))
    const call = calls.find((c) => c.path === '/v1/devices/unregister')!
    for (const h of SIGN_HEADERS) expect(call.headers[h]).toBeTruthy()
    expect(result.current.error).toBeNull()
  })
})

// ─── SDKS-02 / SDKS-04 ───────────────────────────────────────────────────────
describe('both options off (SDKS-02, SDKS-04)', () => {
  it('sends no signing header, no signing field and no attest request', async () => {
    const { result } = renderHook(() => usePushNotifications({ ...BASE, externalId: 'user-1' }))
    await waitFor(() => expect(result.current.isReady).toBe(true))
    await waitFor(() => expect(paths()).toContain('/v1/devices/identify'))
    await result.current.client!.devices.trackOpen(42)

    expect(paths()).toEqual(['/v1/devices/register', '/v1/devices/identify', '/v1/notifications/track'])
    for (const c of calls) for (const h of SIGN_HEADERS) expect(c.headers[h]).toBeUndefined()
    const body = JSON.parse(calls[0].body)
    expect(body).not.toHaveProperty('signing_public_key')
    expect(body).not.toHaveProperty('signing_key_type')
    expect(body).not.toHaveProperty('device_id')
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('signing alone makes no attest request', async () => {
    const { result } = renderHook(() => usePushNotifications({ ...BASE, enableSigning: true }))
    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(paths()).toEqual(['/v1/devices/register'])
    expect(mockAttestKey).not.toHaveBeenCalled()
  })

  it('explicit false behaves as omitted', async () => {
    const { result } = renderHook(() =>
      usePushNotifications({ ...BASE, enableSigning: false, enableAttestation: false }),
    )
    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(paths()).toEqual(['/v1/devices/register'])
    expect(mockGenerate).not.toHaveBeenCalled()
  })
})

// ─── SDKS-03 ─────────────────────────────────────────────────────────────────
describe('enableAttestation on the hook (SDKS-03)', () => {
  it('attests once, after register and before isReady', async () => {
    // The challenge answers after a timer, so an attestation that is not awaited
    // would still be running when isReady turns true.
    installFetch({
      '/v1/attest/challenge': () =>
        new Promise((resolve) => setTimeout(() => resolve({ challenge: 'SERVER_CHALLENGE', expires_in_seconds: 300 }), 30)),
    })
    let attestCallsWhenReady = -1
    const { result } = renderHook(() => {
      const r = usePushNotifications({ ...BASE, enableSigning: true, enableAttestation: true })
      if (r.isReady && attestCallsWhenReady === -1) {
        attestCallsWhenReady = calls.filter((c) => c.path.startsWith('/v1/attest/')).length
      }
      return r
    })
    await waitFor(() => expect(result.current.isReady).toBe(true))

    expect(paths()).toEqual(['/v1/devices/register', '/v1/attest/challenge', '/v1/attest/verify'])
    expect(attestCallsWhenReady).toBe(2) // both attest requests were done before isReady became true
    const verify = JSON.parse(calls[2].body)
    expect(verify).toMatchObject({
      provider: 'apple-appattest',
      key_id: 'KEY_ID==',
      attestation: 'CBOR_ATTESTATION==',
      challenge: 'SERVER_CHALLENGE',
    })
    expect(verify.device_id).toBe(JSON.parse(calls[0].body).device_id)
    // The native call takes the base64 of the SHA-256 of the challenge (clientDataHash); the backend hashes the same bytes.
    expect(mockAttestKey).toHaveBeenCalledWith('KEY_ID==', createHash('sha256').update('SERVER_CHALLENGE', 'utf8').digest('base64'))
    expect(result.current.error).toBeNull()
  })

  it('the identify of a hard-mode project waits for the attestation', async () => {
    const { result } = renderHook(() =>
      usePushNotifications({ ...BASE, externalId: 'user-1', enableSigning: true, enableAttestation: true }),
    )
    await waitFor(() => expect(result.current.isReady).toBe(true))
    await waitFor(() => expect(paths()).toContain('/v1/devices/identify'))
    expect(paths().indexOf('/v1/devices/identify')).toBeGreaterThan(paths().indexOf('/v1/attest/verify'))
  })

  it('a failed attestation sets no error and does not stop isReady', async () => {
    mockAttestKey.mockRejectedValueOnce(new Error('App Attest unavailable'))
    const { result } = renderHook(() => usePushNotifications({ ...BASE, enableSigning: true, enableAttestation: true }))
    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(result.current.error).toBeNull()
    expect(paths()).not.toContain('/v1/attest/verify')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('device attestation failed'))
  })

  it('a failing challenge endpoint sets no error either', async () => {
    installFetch({ '/v1/attest/challenge': () => new Error('network down') })
    const { result } = renderHook(() => usePushNotifications({ ...BASE, enableSigning: true, enableAttestation: true }))
    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(result.current.error).toBeNull()
  })
})

// ─── SDKS-05 ─────────────────────────────────────────────────────────────────
describe('configurations that would silently do less (SDKS-05)', () => {
  it('warns once when attestation is on without signing, and makes no attest request', async () => {
    const { result, rerender } = renderHook(() => usePushNotifications({ ...BASE, enableAttestation: true }))
    await waitFor(() => expect(result.current.isReady).toBe(true))
    rerender()
    expect(paths()).toEqual(['/v1/devices/register'])
    const warnings = warn.mock.calls.filter((c) => String(c[0]).includes('enableAttestation'))
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0][0])).toContain('enableSigning')
  })
})
