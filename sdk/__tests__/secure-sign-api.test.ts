/**
 * @jest-environment node
 *
 * BUG-2 of the Expo 53 compatibility run (2026-10-16): the signer called `generateKeyPair`, which
 * `react-native-secure-sign` does not export, and the tests passed because their mock used the SDK's name.
 *
 * The mock here is built from the published types of react-native-secure-sign 0.0.2 (`lib/typescript/src/index.d.ts`):
 *
 *   generate(keyId, options?: { requireUserAuthentication: boolean }): Promise<string>   // the public key
 *   sign(keyId, information: string): Promise<string>
 *   getPublicKey(keyId): Promise<string>
 *   removeKey(keyId): Promise<void>
 *   checkHardwareSupport(): Promise<boolean>
 *
 * and it has nothing else: a call to a name the package does not export throws, as it does on a device.
 */

const REAL_EXPORTS = ['generate', 'sign', 'getPublicKey', 'removeKey', 'checkHardwareSupport'] as const

function realShapedModule() {
  const calls: Array<{ fn: string; args: unknown[] }> = []
  const record =
    <T>(fn: string, result: T) =>
    async (...args: unknown[]) => {
      calls.push({ fn, args })
      return result
    }
  const mod: Record<string, (...args: any[]) => Promise<unknown>> = {
    generate: record('generate', 'SPKI_PUBLIC_KEY'),
    sign: record('sign', 'P1363_SIGNATURE'),
    getPublicKey: record('getPublicKey', 'SPKI_PUBLIC_KEY'),
    removeKey: record('removeKey', undefined),
    checkHardwareSupport: record('checkHardwareSupport', true),
  }
  return { mod, calls }
}

function boot(mod: unknown) {
  jest.resetModules()
  jest.doMock('react-native-secure-sign', () => mod, { virtual: true })
  jest.doMock('expo-secure-store', () => { throw new Error('absent') }, { virtual: true })
  jest.doMock('@react-native-async-storage/async-storage', () => { throw new Error('absent') }, { virtual: true })
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../src/index')
}

describe('request signing with the real react-native-secure-sign API (BUG-2)', () => {
  const mockFetch = jest.fn()
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve('{}') })
    globalThis.fetch = mockFetch as any
    jest.spyOn(console, 'warn').mockImplementation()
  })
  afterEach(() => jest.restoreAllMocks())

  it('the mock is the published shape: five functions and no generateKeyPair', () => {
    const { mod } = realShapedModule()
    expect(Object.keys(mod).sort()).toEqual([...REAL_EXPORTS].sort())
    expect((mod as any).generateKeyPair).toBeUndefined()
  })

  it('generates the key with generate(), without asking the user for biometrics, and registers its public key', async () => {
    const { mod, calls } = realShapedModule()
    const sdk = boot(mod)
    const client = new sdk.PushClient({ projectId: 'pk_live_abcdefghijklmnop', enableSigning: true, autoTrack: false })
    await client.devices.register({ pushToken: 'ExponentPushToken[abc]', platform: 'ios' })

    const generate = calls.filter((c) => c.fn === 'generate')
    expect(generate).toHaveLength(1)
    expect(generate[0].args[1]).toEqual({ requireUserAuthentication: false })
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.signing_public_key).toBe('SPKI_PUBLIC_KEY')
    expect(body.signing_key_type).toBe('ecdsa_p256')
  })

  it('signs the request with sign() and puts the signature in the header', async () => {
    const { mod, calls } = realShapedModule()
    const sdk = boot(mod)
    const client = new sdk.PushClient({ projectId: 'pk_live_abcdefghijklmnop', enableSigning: true, autoTrack: false })
    await client.devices.register({ pushToken: 'ExponentPushToken[abc]', platform: 'ios' })

    const sign = calls.filter((c) => c.fn === 'sign')
    expect(sign.length).toBeGreaterThan(0)
    expect(typeof sign[0].args[1]).toBe('string') // the base64 of the canonical string
    const headers = mockFetch.mock.calls[0][1].headers
    expect(headers['X-KM-Signature']).toBe('P1363_SIGNATURE')
    expect(headers['X-KM-Sig-Alg']).toBe('ES256')
  })
})

export {}
