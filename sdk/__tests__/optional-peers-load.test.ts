/**
 * @jest-environment node
 *
 * BUG-4 of the Expo 53 compatibility run (2026-10-16): an Expo app without `expo-secure-store` and without
 * `@react-native-async-storage/async-storage` closed itself in a release build the moment the client was created.
 *
 * Why. Metro gives every `require` of an uninstalled optional peer a module id, but defines no module under it. Loading
 * that id throws "Requiring unknown module". Metro's runtime runs a module factory inside a guard that lets a
 * `try/catch` of the module see the error; but a `require` that runs later, from a function the app calls after the
 * bundle is loaded, runs outside that guard, and the runtime hands the error to `ErrorUtils.reportFatalError` before
 * the SDK's `try/catch` sees it. In Hermes release the app aborts.
 *
 * The rule these tests hold: every optional peer is required at the top level of the SDK module (inside a `try`, so
 * Metro treats it as optional), never from inside a function.
 */

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import * as ts from 'typescript'

const OPTIONAL_PEERS = [
  'expo-secure-store',
  '@react-native-async-storage/async-storage',
  'react-native-secure-sign',
  'react-native-ios-appattest',
  '@react-native-firebase/app-check',
  '@react-native-firebase/messaging',
  'react-native-notify-kit',
  'react-native-ssl-public-key-pinning',
  'expo-notifications',
  'expo-constants',
  'expo-crypto',
  'expo-localization',
  'expo-application',
  'expo-device',
]

describe('no optional peer is required after the SDK module has loaded (BUG-4)', () => {
  let warn: jest.SpyInstance

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation()
  })
  afterEach(() => warn.mockRestore())

  /**
   * Every optional peer is absent. The factory of an absent package throws on each require (jest does not cache a throw),
   * so a require that happens after the load is counted. In Metro that second require is the fatal one.
   */
  function loadWithEverythingAbsent(platform: 'ios' | 'android') {
    jest.resetModules()
    const state = { loaded: false, late: [] as string[] }
    for (const name of OPTIONAL_PEERS) {
      jest.doMock(
        name,
        () => {
          if (state.loaded) state.late.push(name)
          const err: any = new Error(`Cannot find module '${name}'`)
          err.code = 'MODULE_NOT_FOUND'
          throw err
        },
        { virtual: true },
      )
    }
    jest.doMock('react-native', () => ({ Platform: { OS: platform, Version: '27.0' } }), { virtual: true })
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('../src/index')
    state.loaded = true
    return { sdk, state }
  }

  for (const platform of ['ios', 'android'] as const) {
    it(`creates the client, registers and tracks on ${platform} with no store, no signer and no attestation module`, async () => {
      const { sdk, state } = loadWithEverythingAbsent(platform)
      globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' }) as any

      const client = new sdk.PushClient({
        projectId: 'pk_live_abcdefghijklmnop',
        enableSigning: true,
        enableAttestation: true,
        platform,
        autoTrack: false,
      })
      await client.devices.register({ pushToken: 'ExponentPushToken[abc]', platform })
      await client.devices.trackOpen(1)
      await client.devices.attest()

      expect(client).toBeDefined()
      expect(state.late).toEqual([])
    })
  }

  it('resolves the key store and the queue store at load, so a later client does not require anything', () => {
    const { sdk, state } = loadWithEverythingAbsent('ios')
    // Several clients, one after the other: none of them goes back to the module system.
    for (let i = 0; i < 3; i++) {
      new sdk.PushClient({ projectId: 'pk_live_abcdefghijklmnop', autoTrack: false })
    }
    expect(state.late).toEqual([])
  })

  it('a present store is found by the lookup at load and keeps the offline queue', async () => {
    jest.resetModules()
    const items = new Map<string, string>()
    jest.doMock(
      'expo-secure-store',
      () => ({
        getItemAsync: async (k: string) => items.get(k) ?? null,
        setItemAsync: async (k: string, v: string) => void items.set(k, v),
        deleteItemAsync: async (k: string) => void items.delete(k),
      }),
      { virtual: true },
    )
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: '27.0' } }), { virtual: true })
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('../src/index')
    const transport = { request: jest.fn().mockRejectedValue(new TypeError('Network request failed')) }
    const client = new sdk.PushClient({
      projectId: 'pk_live_abcdefghijklmnop',
      pushToken: 'ExponentPushToken[abc]',
      platform: 'ios',
      transport,
      autoTrack: false,
    })
    await client.devices.trackOpen(1)
    expect((await client.queueStats()).pending).toBe(1)
    expect([...items.keys()].some((k) => k.startsWith('espresso.eventQueue'))).toBe(true)
  })
})

describe('the source keeps every optional require at the top level, inside a try (BUG-4 guard)', () => {
  const SRC = join(__dirname, '..', 'src')
  // `react-native` is a required peer, always in the bundle; hooks.ts reads it lazily for AppState.
  const ALWAYS_PRESENT = new Set(['react-native', 'react'])

  /** The name recorded for a `require` that is not called by its name, whose argument the scan cannot read. */
  const ALIASED_REQUIRE = '<aliased require>'

  /** The name recorded for a dynamic `import()` whose specifier is not a string literal. */
  const DYNAMIC_IMPORT = '<dynamic import>'

  /** True for an identifier that only names a property, a member or a type member, never the `require` function. */
  function isOnlyAName(id: ts.Identifier): boolean {
    const p = id.parent
    if (ts.isPropertyAccessExpression(p) && p.name === id) return true
    if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name === id) return true
    if (ts.isBindingElement(p) && p.propertyName === id) return true
    return false
  }

  type Found = { file: string; line: number; name: string; inFunction: boolean; inTry: boolean }

  /** Every load of a module in `text`, as the scan sees it. */
  function scan(file: string, text: string): Found[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, true)
    const found: Found[] = []
    const visit = (node: ts.Node, inFunction: boolean, inTry: boolean) => {
      const at = (n: ts.Node) => source.getLineAndCharacterOfPosition(n.getStart()).line + 1
      const isLoad =
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      if (isLoad) {
        const call = node as ts.CallExpression
        const arg = call.arguments.length === 1 ? call.arguments[0] : undefined
        const kind = call.expression.kind === ts.SyntaxKind.ImportKeyword ? DYNAMIC_IMPORT : ALIASED_REQUIRE
        // A literal specifier is a load of that package; anything else cannot be read by name, and is a finding of its own.
        found.push({ file, line: at(node), name: arg && ts.isStringLiteralLike(arg) ? arg.text : kind, inFunction, inTry })
      } else if (ts.isIdentifier(node) && node.text === 'require' && !isOnlyAName(node)) {
        // `const r = require`, `use(require)`, `require.call(...)`: the function is reached without being called by name.
        found.push({ file, line: at(node), name: ALIASED_REQUIRE, inFunction, inTry })
      }
      if (isLoad) {
        // The callee was handled above; only the arguments are looked at further.
        for (const arg of (node as ts.CallExpression).arguments) visit(arg, inFunction, inTry)
        return
      }
      if (ts.isTryStatement(node)) {
        // Only the `try` block marks a require as optional for Metro; the `catch` and `finally` blocks do not.
        visit(node.tryBlock, inFunction, true)
        if (node.catchClause) visit(node.catchClause, inFunction, inTry)
        if (node.finallyBlock) visit(node.finallyBlock, inFunction, inTry)
        return
      }
      const isFn =
        ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node) || ts.isPropertyDeclaration(node)
      ts.forEachChild(node, (child) => visit(child, inFunction || isFn, inTry))
    }
    visit(source, false, false)
    return found
  }

  const requiresIn = (file: string): Found[] => scan(file, readFileSync(join(SRC, file), 'utf8'))

  const all = readdirSync(SRC)
    .filter((f) => f.endsWith('.ts'))
    .flatMap(requiresIn)
    .filter((r) => !ALWAYS_PRESENT.has(r.name))

  describe('the scan itself (BUG-4 guard, G2 of compat-expo53-rn079)', () => {
    it('sees a plain require, with where it is', () => {
      const found = scan('x.ts', `try { a = require('expo-secure-store') } catch {}\nfunction f() { return require('expo-device') }`)
      expect(found.map((f) => [f.name, f.inFunction, f.inTry])).toEqual([
        ['expo-secure-store', false, true],
        ['expo-device', true, false],
      ])
    })

    it('does not count a require in a catch or a finally block as inside the try (Metro marks only the try block optional)', () => {
      const found = scan('x.ts', `try { a = 1 } catch { b = require('expo-secure-store') } finally { c = require('expo-device') }`)
      expect(found.map((f) => [f.name, f.inTry])).toEqual([
        ['expo-secure-store', false],
        ['expo-device', false],
      ])
      // and one nested in a try inside that catch is inside its own try
      expect(scan('x.ts', `try {} catch { try { a = require('expo-device') } catch {} }`).map((f) => [f.name, f.inTry])).toEqual([['expo-device', true]])
    })

    it('sees a lazy import() of a package, which Metro loads outside the module guard like a late require', () => {
      const found = scan('x.ts', `async function f() { return import('expo-secure-store') }`)
      expect(found.map((f) => [f.name, f.inFunction])).toEqual([['expo-secure-store', true]])
    })

    it('sees a top-level import() too, so it can be held to the try rule', () => {
      const found = scan('x.ts', `const p = import('expo-device')`)
      expect(found.map((f) => [f.name, f.inTry])).toEqual([['expo-device', false]])
    })

    it('sees a require that is aliased, whose calls cannot be read by name', () => {
      const found = scan('x.ts', `const r = require\nfunction f() { return r('expo-secure-store') }`)
      expect(found.map((f) => f.name)).toEqual([ALIASED_REQUIRE])
    })

    it('sees a require passed along or called through another name', () => {
      expect(scan('x.ts', `use(require)`).map((f) => f.name)).toEqual([ALIASED_REQUIRE])
      expect(scan('x.ts', `require.call(null, 'expo-device')`).map((f) => f.name)).toEqual([ALIASED_REQUIRE])
      expect(scan('x.ts', `const { r } = { r: require }`).map((f) => f.name)).toEqual([ALIASED_REQUIRE])
    })

    it('sees a load whose specifier is not a literal', () => {
      expect(scan('x.ts', `require(name)`).map((f) => f.name)).toEqual([ALIASED_REQUIRE])
      expect(scan('x.ts', `import(name)`).map((f) => f.name)).toEqual([DYNAMIC_IMPORT])
    })

    it('does not mistake a property or a type named require for the function', () => {
      expect(scan('x.ts', `const o = { require: 1 }; o.require; type T = { require(): void }`)).toEqual([])
    })
  })

  it('no module is loaded through an alias, a dynamic specifier or a lazy import() that this scan cannot guard', () => {
    const offenders = all.filter((r) => r.name.startsWith('<')).map((r) => `${r.file}:${r.line} ${r.name}`)
    expect(offenders).toEqual([])
  })

  it('finds the requires it is meant to guard (the scan is not empty)', () => {
    const names = new Set(all.map((r) => r.name))
    for (const name of OPTIONAL_PEERS) expect(names).toContain(name)
  })

  it('no optional peer is required from inside a function or a class', () => {
    const offenders = all.filter((r) => r.inFunction).map((r) => `${r.file}:${r.line} require('${r.name}')`)
    expect(offenders).toEqual([])
  })

  it('every optional peer is required inside a try block, which is what makes Metro treat it as optional', () => {
    const offenders = all.filter((r) => !r.inTry).map((r) => `${r.file}:${r.line} require('${r.name}')`)
    expect(offenders).toEqual([])
  })
})

export {}
