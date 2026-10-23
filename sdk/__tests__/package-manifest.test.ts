/**
 * @jest-environment node
 *
 * sdk-launch-fixes: the package manifest as Node and npm read it.
 * SDKFIX-02: `exports` exposes the Expo config plugin and package.json.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SDK = resolve(__dirname, '..');
const NAME = '@espresso-notify/react-native';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const manifest = require('../package.json');

describe('exports (SDKFIX-02)', () => {
  let app: string;

  beforeAll(() => {
    // An app with the SDK installed under its real name, resolved by Node
    // through the package's `exports` map.
    app = mkdtempSync(join(tmpdir(), 'espresso-exports-'));
    mkdirSync(join(app, 'node_modules', '@espresso-notify'), { recursive: true });
    symlinkSync(SDK, join(app, 'node_modules', '@espresso-notify', 'react-native'), 'dir');
  });

  afterAll(() => rmSync(app, { recursive: true, force: true }));

  const resolveFromApp = (spec: string) => realpathSync(require.resolve(spec, { paths: [app] }));

  it('declares ./app.plugin.js and ./package.json (AC 1)', () => {
    expect(manifest.exports['./app.plugin.js']).toBe('./app.plugin.js');
    expect(manifest.exports['./package.json']).toBe('./package.json');
  });

  it('resolves the config plugin from an app (AC 2)', () => {
    expect(resolveFromApp(`${NAME}/app.plugin.js`)).toBe(join(SDK, 'app.plugin.js'));
  });

  it('resolves package.json from an app (AC 1)', () => {
    expect(resolveFromApp(`${NAME}/package.json`)).toBe(join(SDK, 'package.json'));
  });

  it('still resolves the root entry and /hooks', () => {
    expect(resolveFromApp(NAME)).toBe(join(SDK, 'dist', 'index.js'));
    expect(resolveFromApp(`${NAME}/hooks`)).toBe(join(SDK, 'dist', 'hooks.js'));
  });
});

describe('peer dependencies (SDKFIX-06)', () => {
  it('requires React Native 0.79+ and React 19+ (AC 1)', () => {
    expect(manifest.peerDependencies['react-native']).toBe('>=0.79.0');
    expect(manifest.peerDependencies.react).toBe('>=19.0.0');
  });

  it('marks every peer except react-native optional (AC 2)', () => {
    const peers = Object.keys(manifest.peerDependencies);
    expect(peers).toEqual(
      expect.arrayContaining([
        'expo-constants',
        '@react-native-firebase/app-check',
        'react-native-ios-appattest',
        'expo-notifications',
        '@react-native-firebase/messaging',
        'react-native-notify-kit',
        'react-native-secure-sign',
        'react-native-ssl-public-key-pinning',
        'expo-secure-store',
      ]),
    );
    const required = peers.filter((p) => manifest.peerDependenciesMeta?.[p]?.optional !== true);
    expect(required).toEqual(['react-native']);
  });

  it('declares every native module the SDK requires as a peer (AC 2)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readdirSync, readFileSync } = require('fs');
    const dir = join(SDK, 'src');
    const specs = new Set<string>();
    for (const f of readdirSync(dir).filter((n: string) => n.endsWith('.ts'))) {
      for (const m of readFileSync(join(dir, f), 'utf-8').matchAll(/require\(['"]([^'"./][^'"]*)['"]\)/g)) {
        specs.add(m[1]);
      }
    }
    const undeclared = [...specs].filter((s) => !(s in manifest.peerDependencies));
    expect(undeclared).toEqual([]);
  });
});

describe('the native transport in the manifest (sdk-private-transport T16, SPT-58, SPT-61)', () => {
  it('declares the codegen config the module needs', () => {
    expect(manifest.codegenConfig).toEqual({
      name: 'EspressoNotifyTransportSpec',
      type: 'modules',
      jsSrcsDir: 'src/native',
      android: { javaPackageName: 'com.espressonotify.transport' },
      ios: { modulesProvider: { EspressoNotifyTransport: 'EspressoNotifyTransport' } },
    });
  });

  it('ships the native folders, the podspec and the codegen spec, and still the files it shipped', () => {
    expect(manifest.files).toEqual(
      expect.arrayContaining(['android', 'ios', 'EspressoNotifyTransport.podspec', 'src/native']),
    );
    expect(manifest.files).toEqual(expect.arrayContaining(['dist', 'bin', 'app.plugin.js', 'SECURITY.md']));
    expect(manifest.files).toHaveLength(8);
  });

  it('does not ship the native tests', () => {
    expect(manifest.files.filter((f: string) => /native-tests|__tests__|\.test\./.test(f))).toEqual([]);
  });

  it('adds no runtime dependency, and no peer beyond the optional ones it lists', () => {
    expect(manifest.dependencies).toBeUndefined();
    expect(Object.keys(manifest.peerDependencies).sort()).toEqual([
      '@react-native-async-storage/async-storage',
      '@react-native-firebase/app-check',
      '@react-native-firebase/messaging',
      'expo',
      'expo-application',
      'expo-constants',
      'expo-crypto',
      'expo-device',
      'expo-localization',
      'expo-notifications',
      'expo-secure-store',
      'react',
      'react-native',
      'react-native-ios-appattest',
      'react-native-notify-kit',
      'react-native-secure-sign',
      'react-native-ssl-public-key-pinning',
    ]);
  });
});
