/**
 * @jest-environment node
 *
 * sdk-private-transport T35 (SPT-58, SPT-61): what the npm package ships.
 *
 * Autolinking reads the native folders from the installed package, so `android/`, `ios/`, the podspec and the codegen
 * spec must be in the tarball; the harnesses, the tests and every build output must not. The test asks npm what it would
 * pack (`npm pack --dry-run --json`, no script run, nothing written) and checks the list, so the allow-list of
 * `package.json` is proved by the same tool that publishes.
 */
import { execFileSync } from 'child_process';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

const SDK = resolve(__dirname, '..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const manifest = require('../package.json');

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

let packed: string[];

beforeAll(() => {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: SDK,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  packed = (JSON.parse(raw)[0].files as { path: string }[]).map((f) => f.path).sort();
}, 120_000);

/** Every file of the source folder that is part of the module (build outputs of a local build are not). */
const sourceFiles = (folder: string, keep: RegExp) =>
  filesUnder(join(SDK, folder))
    .map((f) => relative(SDK, f))
    .filter((f) => keep.test(f));

describe('what the package ships', () => {
  it('ships the native module: Gradle file, Kotlin sources, iOS sources, podspec, codegen spec and dist', () => {
    expect(packed).toContain('android/build.gradle');
    expect(packed).toContain('android/src/main/AndroidManifest.xml');
    expect(packed).toContain('EspressoNotifyTransport.podspec');
    expect(packed).toContain('src/native/NativeEspressoNotifyTransport.ts');
    // Every source file of the module is in the tarball, not a hand-written subset of it.
    const kotlin = sourceFiles('android/src', /\.kt$/);
    expect(kotlin.length).toBeGreaterThanOrEqual(5);
    for (const file of kotlin) expect(packed).toContain(file);
    const ios = sourceFiles('ios/Sources', /\.(h|m|mm)$/);
    expect(ios.length).toBeGreaterThanOrEqual(6);
    for (const file of ios) expect(packed).toContain(file);
    // The built JavaScript, including the transport helpers and the compiled spec.
    for (const file of ['dist/index.js', 'dist/index.d.ts', 'dist/hooks.js', 'dist/transport.js', 'dist/native/NativeEspressoNotifyTransport.js']) {
      expect(packed).toContain(file);
    }
    expect(packed).toContain('app.plugin.js');
  });

  it('does not ship the harnesses, the tests, node_modules or any build output', () => {
    const forbidden: [string, RegExp][] = [
      ['native-tests', /^native-tests\//],
      ['__tests__', /(^|\/)__tests__\//],
      ['node_modules', /(^|\/)node_modules\//],
      ['jest', /^jest(\.config\.js)?(\/|$)/],
      ['test sources', /(Test|Tests)\.(kt|swift)$|\.test\.(ts|js)$/],
      ['build outputs', /(^|\/)(build|\.gradle|\.build|\.swiftpm|\.kotlin|DerivedData|Pods)\//],
      ['compiled native files', /\.(class|dex|o|a|dylib|xcuserstate)$/],
      ['fixtures and keys', /\.(der|pem|key|jks|keystore)$/],
    ];
    for (const [name, pattern] of forbidden) {
      expect({ name, found: packed.filter((f) => pattern.test(f)) }).toEqual({ name, found: [] });
    }
  });

  it('declares no runtime dependency: the module brings OkHttp and the React pods from the app', () => {
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.files).toEqual(expect.arrayContaining(['android', 'ios', 'EspressoNotifyTransport.podspec', 'src/native', 'dist']));
    expect(manifest.files).not.toContain('native-tests');
  });

  it('keeps the codegen config and the podspec pointing at files that ship', () => {
    expect(packed).toContain(`${manifest.codegenConfig.jsSrcsDir}/NativeEspressoNotifyTransport.ts`);
    const podspec = readFileSync(join(SDK, 'EspressoNotifyTransport.podspec'), 'utf8');
    const glob = (key: string) => {
      const match = new RegExp(`s\\.${key}\\s*=\\s*"([^"]+)"`).exec(podspec);
      expect(match).not.toBeNull();
      return match![1];
    };
    // `ios/Sources/**/*.{h,m,mm}` and `ios/Sources/Core/include/*.h`, as a pattern over the packed paths.
    const toPattern = (g: string) =>
      new RegExp(
        '^' +
          g
            .replace(/[.+^$()|[\]\\]/g, '\\$&')
            .replace(/\{([^}]+)\}/g, (_, alts: string) => `(${alts.split(',').join('|')})`)
            .replace(/\*\*\//g, '\u0000')
            .replace(/\*/g, '[^/]*')
            .replace(/\u0000/g, '(.*/)?') +
          '$',
      );
    const sources = packed.filter((f) => toPattern(glob('source_files')).test(f));
    const publicHeaders = packed.filter((f) => toPattern(glob('public_header_files')).test(f));
    expect(sources.length).toBeGreaterThanOrEqual(6);
    expect(publicHeaders.sort()).toEqual([
      'ios/Sources/EspressoNotifyTransportCore/include/ESPPinStore.h',
      'ios/Sources/EspressoNotifyTransportCore/include/ESPRandomBytes.h',
      'ios/Sources/EspressoNotifyTransportCore/include/ESPTransportClient.h',
    ]);
    // The class the codegen is told to register is implemented in a shipped file.
    const provider = Object.values(manifest.codegenConfig.ios.modulesProvider) as string[];
    const implementation = packed.find((f) => f.endsWith(`${provider[0]}.mm`));
    expect(implementation).toBeDefined();
  });
});
