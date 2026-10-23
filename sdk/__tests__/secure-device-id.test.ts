/**
 * @jest-environment node
 *
 * sdk-secure-device-id T4 (SRID-01 to SRID-07): where the bytes of the device id and of the nonce of a signed request come
 * from. Hermes has no `crypto.getRandomValues`, so the order is that global, then the native module, then `expo-crypto`,
 * and only then `Math.random` with one warning.
 */
jest.mock('expo-notifications', () => ({}), { virtual: true })

const KEY = 'espresso.deviceId'
const NATIVE_HEX = '0123456789abcdef0123456789abcdef' // 16 bytes
const globalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')

function setCrypto(value: unknown) {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true })
}

type Boot = {
  native?: { randomBytes?: jest.Mock } | 'absent'
  expoCrypto?: { getRandomBytesAsync?: jest.Mock; getRandomBytes?: jest.Mock } | 'absent'
  stored?: string
}

/** A client with request signing on, a memory store and a transport that records the headers it was given. */
function boot({ native = 'absent', expoCrypto = 'absent', stored }: Boot) {
  jest.resetModules()
  const nativeModule =
    native === 'absent'
      ? null
      : {
          getConstants: () => ({ contractVersion: 1 }),
          request: jest.fn(),
          setPins: jest.fn(),
          clearPins: jest.fn(),
          ...native,
        }
  jest.doMock(
    'react-native',
    () => ({ Platform: { OS: 'android', Version: 36 }, TurboModuleRegistry: { get: () => nativeModule } }),
    { virtual: true },
  )
  jest.doMock(
    'expo-crypto',
    () => {
      if (expoCrypto === 'absent') throw new Error("Cannot find module 'expo-crypto'")
      return expoCrypto
    },
    { virtual: true },
  )
  const { PushClient } = require('../src/index')
  const map = new Map<string, string>()
  if (stored) map.set(KEY, stored)
  const store = {
    async getItem(k: string) { return map.get(k) ?? null },
    async setItem(k: string, v: string) { map.set(k, v) },
  }
  const signer = {
    generate: jest.fn().mockResolvedValue('SPKI=='),
    sign: jest.fn().mockResolvedValue('SIG=='),
    getPublicKey: jest.fn().mockResolvedValue('SPKI=='),
    isSupported: jest.fn().mockResolvedValue(true),
  }
  const seen: Array<Record<string, string>> = []
  const transport = { request: jest.fn(async (_path: string, options: RequestInit = {}) => { seen.push(options.headers as Record<string, string>); return {} }) }
  const client = new PushClient({
    projectId: 'pk_live_x', pushToken: 'tok', platform: 'android', autoTrack: false, enableSigning: true,
    _keyStore: store, _signer: signer, _queueStore: store, transport,
  })
  return { client, map, seen, nativeModule }
}

async function firstSignedHeaders(t: ReturnType<typeof boot>) {
  await t.client.devices.register({})
  return t.seen.find((h) => h['X-KM-Device-Id'])!
}

describe('the bytes of the device id and of the nonce', () => {
  let random: jest.SpyInstance
  let warn: jest.SpyInstance
  const nodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    // Event ids and the session id of the registration tracker keep a silent Math.random fallback (not secrets, out of scope
    // of this feature), so Math.random is called by the client either way. A sentinel (byte 253) makes any leak into the
    // device id or the nonce visible in the exact values asserted below.
    random = jest.spyOn(Math, 'random').mockReturnValue(0.99)
    warn = jest.spyOn(console, 'warn').mockImplementation()
    process.env.NODE_ENV = 'production' // the warning is silent under test; here it must be able to show
    setCrypto(undefined)
  })
  afterEach(() => {
    random.mockRestore()
    warn.mockRestore()
    process.env.NODE_ENV = nodeEnv
    if (globalCrypto) Object.defineProperty(globalThis, 'crypto', globalCrypto)
    else delete (globalThis as any).crypto
  })

  const warnings = () => warn.mock.calls.filter(([m]) => String(m).includes('crypto.getRandomValues'))

  it('SRID-01: uses crypto.getRandomValues first and calls nothing else', async () => {
    const getRandomValues = jest.fn((bytes: Uint8Array) => bytes.fill(0xab))
    setCrypto({ getRandomValues })
    const randomBytes = jest.fn()
    const getRandomBytesAsync = jest.fn()
    const t = boot({ native: { randomBytes }, expoCrypto: { getRandomBytesAsync } })
    const headers = await firstSignedHeaders(t)
    expect(t.map.get(KEY)).toBe('ab'.repeat(16))
    expect(headers['X-KM-Nonce']).toBe('ab'.repeat(8))
    expect(randomBytes).not.toHaveBeenCalled()
    expect(getRandomBytesAsync).not.toHaveBeenCalled()
    expect(random).not.toHaveBeenCalled()
    expect(warnings()).toEqual([])
  })

  it('SRID-02: takes the bytes from the native module when there is no crypto global, with no Math.random and no warning', async () => {
    const randomBytes = jest.fn(async (n: number) => NATIVE_HEX.slice(0, n * 2).padEnd(n * 2, 'f'))
    const t = boot({ native: { randomBytes } })
    const headers = await firstSignedHeaders(t)
    expect(t.map.get(KEY)).toBe(NATIVE_HEX)
    expect(t.map.get(KEY)).not.toContain('fd')
    expect(headers['X-KM-Nonce']).toBe(NATIVE_HEX.slice(0, 16))
    expect(randomBytes.mock.calls.map(([n]) => n).sort()).toEqual([16, 8])
    expect(warnings()).toEqual([])
  })

  it('SRID-03: takes the bytes from expo-crypto when there is neither a crypto global nor a native source', async () => {
    const getRandomBytesAsync = jest.fn(async (n: number) => new Uint8Array(n).fill(0x5a))
    const t = boot({ expoCrypto: { getRandomBytesAsync } })
    const headers = await firstSignedHeaders(t)
    expect(t.map.get(KEY)).toBe('5a'.repeat(16))
    expect(headers['X-KM-Nonce']).toBe('5a'.repeat(8))
    expect(warnings()).toEqual([])
  })

  it('SRID-03: a native module without randomBytes (an older build) still gives way to expo-crypto, and still carries the transport', async () => {
    const t = boot({ native: {}, expoCrypto: { getRandomBytes: jest.fn((n: number) => new Uint8Array(n).fill(0x11)) } })
    await firstSignedHeaders(t)
    expect(t.map.get(KEY)).toBe('11'.repeat(16))
  })

  it('SRID-04: falls back to Math.random with ONE warning per app run that carries no value', async () => {
    random.mockReturnValue(0.5) // byte 128
    const t = boot({})
    const headers = await firstSignedHeaders(t)
    await t.client.devices.register({}) // a second nonce in the same run
    expect(t.map.get(KEY)).toBe('80'.repeat(16))
    expect(headers['X-KM-Nonce']).toBe('80'.repeat(8))
    expect(warnings()).toHaveLength(1)
    const text = String(warnings()[0][0])
    expect(text).toContain('[espresso-notify] crypto.getRandomValues is not available')
    expect(text).not.toContain(t.map.get(KEY)!)
    expect(text).not.toContain('pk_live_x')
    expect(text).not.toContain('tok')
  })

  describe('SRID-05: a source that fails hands over to the next one and never throws', () => {
    const expo = () => ({ getRandomBytesAsync: jest.fn(async (n: number) => new Uint8Array(n).fill(0x22)) })
    const cases: Array<[string, () => Promise<unknown> | unknown]> = [
      ['rejects', () => Promise.reject(new Error('boom'))],
      ['throws', () => { throw new Error('boom') }],
      ['answers too short', async () => 'abcd'],
      ['answers too long', async () => NATIVE_HEX + 'ff'],
      ['answers other characters', async () => 'zz'.repeat(16)],
      ['answers capitals', async () => NATIVE_HEX.toUpperCase().replace(/[0-9]/g, 'A')],
      ['answers a non-string', async () => 12345],
    ]
    for (const [name, answer] of cases) {
      it(`the native module ${name}`, async () => {
        const t = boot({ native: { randomBytes: jest.fn(answer as any) }, expoCrypto: expo() })
        await firstSignedHeaders(t)
        expect(t.map.get(KEY)).toBe('22'.repeat(16))
              })
    }

    it('crypto.getRandomValues throws', async () => {
      setCrypto({ getRandomValues: () => { throw new Error('no entropy') } })
      const t = boot({ native: { randomBytes: jest.fn(async (n: number) => 'cd'.repeat(n)) } })
      await firstSignedHeaders(t)
      expect(t.map.get(KEY)).toBe('cd'.repeat(16))
    })

    it('expo-crypto answers the wrong length, so Math.random is the last resort', async () => {
      random.mockReturnValue(0)
      const t = boot({ expoCrypto: { getRandomBytesAsync: jest.fn(async () => new Uint8Array(3)) } })
      await firstSignedHeaders(t)
      expect(t.map.get(KEY)).toBe('00'.repeat(16))
      expect(warnings()).toHaveLength(1)
    })
  })

  it('SRID-06: keeps the format, and returns a stored id without drawing a byte for it', async () => {
    const randomBytes = jest.fn(async (n: number) => NATIVE_HEX.slice(0, n * 2).padEnd(n * 2, 'e'))
    const old = 'feedfacefeedfacefeedfacefeedface'
    const t = boot({ native: { randomBytes }, stored: old })
    const headers = await firstSignedHeaders(t)
    expect(headers['X-KM-Device-Id']).toBe(old)
    expect(t.map.get(KEY)).toBe(old)
    expect(randomBytes.mock.calls.map(([n]) => n)).toEqual([8]) // the nonce only
    expect(headers['X-KM-Nonce']).toMatch(/^[0-9a-f]{16}$/)

    const fresh = boot({ native: { randomBytes } })
    await firstSignedHeaders(fresh)
    expect(fresh.map.get(KEY)).toMatch(/^[0-9a-f]{32}$/)
  })
})
