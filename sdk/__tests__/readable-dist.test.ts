/**
 * @jest-environment node
 *
 * D-54: the React Native SDK is open source (Apache 2.0) and its code is readable. This guard fails if obfuscation comes back:
 * the committed `dist` looks obfuscated, the package depends on the obfuscator, or `build` runs an obfuscation step.
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

const SDK = resolve(__dirname, '..');
const DIST = join(SDK, 'dist');
const pkg = JSON.parse(readFileSync(join(SDK, 'package.json'), 'utf-8'));

/** Why a piece of JavaScript looks obfuscated, as a list (empty when it reads like ordinary code). */
function obfuscationSigns(name: string, code: string): string[] {
  const signs: string[] = [];
  if (/\b_0x[0-9a-f]{3,}\b/.test(code)) signs.push(`${name}: hexadecimal identifiers (_0x...)`);
  if (/while\s*\(\s*!!\s*\[\s*\]\s*\)/.test(code)) signs.push(`${name}: control-flow flattening loop (while(!![]))`);
  if (/\bparseInt\([^)]*\)\s*\/\s*0x[0-9a-f]+\s*\*/.test(code)) signs.push(`${name}: string-array rotation checksum`);
  const lines = code.split('\n');
  const longest = Math.max(...lines.map((l) => l.length));
  if (lines.length < 20 && code.length > 5000) signs.push(`${name}: ${code.length} characters in ${lines.length} lines (minified)`);
  if (longest > 2000) signs.push(`${name}: a line of ${longest} characters`);
  return signs;
}

describe('the committed sdk/dist is readable', () => {
  const files = readdirSync(DIST).filter((f) => f.endsWith('.js')).sort();

  it('has the files of the build', () => {
    // SPEC_AMENDMENT (sdk-private-transport T17, SPT-64): the build also holds transport.js, the helpers that both transports
    // share. (T24 listed this edit; it moved to the task that adds the file so that the suite stays green.)
    // sdk-secure-device-id T4: and random.js, the sources of the random bytes of the device id and of the nonce.
    expect(files).toEqual(['errors.js', 'hooks.js', 'image-push.js', 'index.js', 'random.js', 'registration.js', 'retry.js', 'track-batch.js', 'transport.js']);
  });

  it.each(files)('%s shows no sign of obfuscation or minification', (file) => {
    expect(obfuscationSigns(file, readFileSync(join(DIST, file), 'utf-8'))).toEqual([]);
  });

  it('keeps the names, the API paths and the error texts of the source in clear text', () => {
    const index = readFileSync(join(DIST, 'index.js'), 'utf-8');
    for (const text of ['class PushClient', '/v1/devices/register', 'https://api.espressonotify.com']) {
      expect({ text, present: index.includes(text) }).toEqual({ text, present: true });
    }
    expect(readFileSync(join(DIST, 'hooks.js'), 'utf-8').includes('usePushNotifications')).toBe(true);
  });

  it('ships the type declarations next to the code', () => {
    for (const d of ['index.d.ts', 'hooks.d.ts', 'errors.d.ts', 'image-push.d.ts', 'registration.d.ts', 'retry.d.ts', 'track-batch.d.ts', 'transport.d.ts']) expect(existsSync(join(DIST, d))).toBe(true);
  });
});

describe('the package does not obfuscate', () => {
  it('has no obfuscator in any dependency list', () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies };
    expect(Object.keys(all).filter((n) => /obfuscat/i.test(n))).toEqual([]);
  });

  it('has no obfuscator in the lockfile', () => {
    expect(readFileSync(join(SDK, 'package-lock.json'), 'utf-8')).not.toMatch(/javascript-obfuscator/);
  });

  it('runs no obfuscation step in any script', () => {
    for (const [name, cmd] of Object.entries<string>(pkg.scripts)) {
      expect({ name, obfuscates: /obfuscat/i.test(cmd) }).toEqual({ name, obfuscates: false });
    }
    expect(pkg.scripts.build).toBe('npm run clean && tsc && node inject-url.mjs');
  });

  it('has no obfuscation script or switch left in the folder', () => {
    expect(existsSync(join(SDK, 'obfuscate.mjs'))).toBe(false);
    expect(existsSync(join(SDK, 'inject-url.mjs'))).toBe(true);
    expect(readFileSync(join(SDK, 'inject-url.mjs'), 'utf-8')).not.toMatch(/OBFUSCATE/i);
  });

  // SPEC_AMENDMENT (sdk-private-transport T16, SPT-58): the package also ships the native transport, so `files` gains
  // android, ios, the podspec and the codegen spec folder. The first four entries are unchanged and nothing else is added.
  it('packs the build, the setup wizard (bin), the Expo plugin, the security note, the license and its notice, and the native transport only', () => {
    expect(pkg.files).toEqual([
      'dist', 'bin', 'app.plugin.js', 'SECURITY.md', 'LICENSE', 'NOTICE',
      'android', 'ios', 'EspressoNotifyTransport.podspec', 'src/native',
    ]);
  });
});

describe('the guard itself', () => {
  it('names an obfuscated build', () => {
    const obfuscated = "var _0x1a2b=['abc'];(function(_0x3c4d,_0x5e6f){while(!![]){try{var _0x7a8b=parseInt(_0x9c0d(0x1))/0x1*(0x2);}catch(e){}}}(_0x1a2b,0x3a));";
    const signs = obfuscationSigns('index.js', obfuscated);
    expect(signs.some((s) => s.includes('hexadecimal identifiers'))).toBe(true);
    expect(signs.some((s) => s.includes('control-flow'))).toBe(true);
  });

  it('accepts what tsc writes', () => {
    expect(obfuscationSigns('index.js', '"use strict";\nclass PushClient {\n  constructor() {}\n}\nexports.PushClient = PushClient;\n')).toEqual([]);
  });

  it('names a minified bundle', () => {
    expect(obfuscationSigns('index.js', 'a'.repeat(6000)).length).toBeGreaterThan(0);
  });
});
