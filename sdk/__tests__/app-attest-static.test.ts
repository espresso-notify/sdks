/**
 * @jest-environment jsdom
 *
 * SDKFIX-01 AC 4 (sdk-launch-fixes): the App Attest native module is loaded by a
 * static specifier, because Metro resolves only string-literal requires. A
 * custom App Attest package is injected as an object through `nativeModule`.
 */

import { createHash } from 'crypto'

// Same loading pattern as bare-provider.test.ts: fresh registry per test with
// virtual mocks, so the SDK reads Platform.OS === 'ios' at module load.
function freshProvider(appAttest: unknown) {
  jest.resetModules()
  jest.doMock('expo-notifications', () => ({}), { virtual: true })
  jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: '27.0' } }), { virtual: true })
  jest.doMock('react-native-ios-appattest', () => {
    if (!appAttest) throw new Error('not installed')
    return appAttest
  }, { virtual: true })
  return require('../src/index').ExpoAppAttestProvider
}

it('degrades to unsupported on iOS when no App Attest module is available', async () => {
  const p = new (freshProvider(null))()
  expect(p.isSupported()).toBe(false)
  await expect(p.attest('chal-3')).rejects.toThrow('iOS App Attest native module is not available')
})

it('uses an injected nativeModule when the default package is absent', async () => {
  const injected = {
    generateKeys: jest.fn().mockResolvedValue('KEY_INJECTED'),
    attestKeys: jest.fn().mockResolvedValue('ATTEST_INJECTED'),
  }
  const p = new (freshProvider(null))({ nativeModule: injected })
  expect(p.isSupported()).toBe(true)
  await expect(p.attest('chal-2')).resolves.toEqual({
    provider: 'apple-appattest',
    keyId: 'KEY_INJECTED',
    attestation: 'ATTEST_INJECTED',
  })
})

it('loads react-native-ios-appattest by its static name on iOS', async () => {
  const native = {
    generateKeys: jest.fn().mockResolvedValue('KEY_STATIC'),
    attestKeys: jest.fn().mockResolvedValue('ATTEST_STATIC'),
  }
  const p = new (freshProvider(native))()
  expect(p.isSupported()).toBe(true)
  await expect(p.attest('chal-1')).resolves.toEqual({
    provider: 'apple-appattest',
    keyId: 'KEY_STATIC',
    attestation: 'ATTEST_STATIC',
  })
  // react-native-ios-appattest takes the base64 of the SHA-256 of the challenge, not the challenge (BUG-3).
  expect(native.attestKeys).toHaveBeenCalledWith('KEY_STATIC', createHash('sha256').update('chal-1', 'utf8').digest('base64'))
})

it('keeps every require in sdk/src on a string-literal specifier', () => {
  const { readdirSync, readFileSync } = require('fs')
  const { join } = require('path')
  const dir = join(__dirname, '..', 'src')
  const offenders = readdirSync(dir)
    .filter((f: string) => f.endsWith('.ts'))
    .flatMap((f: string) =>
      readFileSync(join(dir, f), 'utf-8')
        .split('\n')
        .map((line: string, i: number) => ({ f, i: i + 1, line }))
        .filter(({ line }: { line: string }) => /\brequire\((?!['"])/.test(line)),
    )
  expect(offenders).toEqual([])
})

// Torna o arquivo um módulo: sem isso o ts-jest o trata como script global e
// nomes de topo repetidos entre testes colidem (TS2451) em cache frio.
export {}

// BUG-3 of the Expo 53 compatibility run: the provider called generateKey() and attestKey(), names that
// react-native-ios-appattest (0.x and 1.x) does not export; it exports generateKeys() and attestKeys().
it('uses only the names react-native-ios-appattest exports, and hashes a challenge the way the backend does', async () => {
  const exported = {
    attestationSupported: jest.fn().mockResolvedValue(true),
    generateKeys: jest.fn().mockResolvedValue('KEY_REAL'),
    attestKeys: jest.fn().mockResolvedValue('ATTEST_REAL'),
    attestRequestData: jest.fn().mockResolvedValue('ASSERTION'),
  }
  // The server issues base64url without padding; its verifier hashes the UTF-8 bytes of the string it issued.
  const challenge = 'q-_x8Yb2Zk1V0d3pTn5RjH6mXoWcE4uA9sLgBtNiDfM'
  const p = new (freshProvider(exported))()
  await expect(p.attest(challenge)).resolves.toEqual({ provider: 'apple-appattest', keyId: 'KEY_REAL', attestation: 'ATTEST_REAL' })
  expect(exported.generateKeys).toHaveBeenCalledTimes(1)
  expect(exported.attestKeys).toHaveBeenCalledWith('KEY_REAL', createHash('sha256').update(challenge, 'utf8').digest('base64'))
})

it('hashes a challenge with non-ASCII text by its UTF-8 bytes', async () => {
  const exported = {
    generateKeys: jest.fn().mockResolvedValue('K'),
    attestKeys: jest.fn().mockResolvedValue('A'),
  }
  const p = new (freshProvider(exported))()
  await p.attest('désafio-ç-€')
  expect(exported.attestKeys).toHaveBeenCalledWith('K', createHash('sha256').update('désafio-ç-€', 'utf8').digest('base64'))
})
