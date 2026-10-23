/**
 * @jest-environment node
 *
 * sdk-setup-fixes (SSF-02.1, SSF-02.3, SSF-02.5): the wizard against the REAL `npx expo install`, not a fake `spawn`.
 *
 * The Expo CLI comes from the `expo` package in `sdk/node_modules` (a dev dependency, so `npm ci` brings it) and, when the
 * example app is installed, from the Expo SDK 57 of `examples/expo-push-test`. It runs offline (`EXPO_OFFLINE=1`) and
 * `npm` is a fake that only writes the package names into package.json, so nothing is downloaded. What the audit found
 * is what the real CLI does with each kind of config: it adds the plugin to `app.json` and `app.config.json` by itself,
 * and with `app.config.ts` it installs the packages and then exits 1 because it cannot edit code.
 *
 * The fake `npm` is a shell script, so the suite does not run on Windows hosts.
 */
import { spawn as realSpawn } from 'child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join, resolve } from 'path';

jest.setTimeout(120_000);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const wizard = require('../bin/setup.js');

const PLUGIN = '@espresso-notify/react-native';
const SDK = resolve(__dirname, '..');
const CLIS = [
  { label: 'the Expo CLI of sdk/node_modules', modules: join(SDK, 'node_modules') },
  { label: 'the Expo SDK 57 CLI of examples/expo-push-test', modules: resolve(SDK, '..', 'examples', 'expo-push-test', 'node_modules') },
].filter((cli) => existsSync(join(cli.modules, '.bin', 'expo')) && existsSync(join(cli.modules, 'expo', 'bundledNativeModules.json')));

const scratch = mkdtempSync(join(tmpdir(), 'espresso-expo-cli-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// The fake npm: `npm install --save a b@1 ...` puts every name into "dependencies" of package.json, like a real install.
const fakeBin = join(scratch, 'bin');
mkdirSync(fakeBin);
writeFileSync(
  join(fakeBin, 'npm.js'),
  `const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.dependencies = pkg.dependencies || {};
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('-') || ['install', 'i', 'add'].includes(arg)) continue;
  const name = arg.replace(/(?!^)@.*$/, '');
  pkg.dependencies[name] = pkg.dependencies[name] || '*';
}
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\\n');
`,
);
writeFileSync(join(fakeBin, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "${join(fakeBin, 'npm.js')}" "$@"\n`);
chmodSync(join(fakeBin, 'npm'), 0o755);

/** A project folder whose node_modules is the one with the CLI, and an empty lockfile so Expo picks npm. */
function project(modules: string, files: Record<string, string | object>): string {
  const dir = mkdtempSync(join(scratch, 'app-'));
  const major = String(JSON.parse(readFileSync(join(modules, 'expo', 'package.json'), 'utf8')).version).split('.')[0];
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { expo: `~${major}.0.0` } }, null, 2));
  writeFileSync(join(dir, 'package-lock.json'), '{}\n');
  symlinkSync(modules, join(dir, 'node_modules'), 'dir');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  return dir;
}

async function runWizard(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const env = { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH}`, EXPO_OFFLINE: '1', CI: '1', EXPO_NO_TELEMETRY: '1' };
  const code: number = await wizard.run(['setup', '--yes'], {
    cwd,
    // the real process, with its own noise kept out of the test log
    spawn: (cmd: string, args: string[], options: object) => realSpawn(cmd, args, { ...options, stdio: 'ignore', env }),
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: (s: string) => err.push(s) },
    stdin: process.stdin,
    isTTY: false,
    platform: process.platform,
    env,
  });
  return { code, out: out.join(''), err: err.join('') };
}

/**
 * Whether `after` is `before` with one piece of text added at one place and every other byte as it was (compared as bytes,
 * so a byte order mark, CRLF and tabs count).
 */
function isOneInsertion(before: Buffer, after: Buffer): boolean {
  let prefix = 0;
  while (prefix < before.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  return prefix + suffix === before.length && after.length > before.length;
}

/** A config the person wrote with a comment (Expo reads it as JSON5 and writes plain JSON back). */
const COMMENTED = '{\n  // my app\n  "expo": {\n    "name": "A", // the name\n    "slug": "a"\n  }\n}\n';
/** A BOM, CRLF, tabs, `1.0`, an integer above 2^53, a \u escape and a key written twice: all lost when Expo writes the file. */
const HARD =
  '﻿{\r\n\t"expo": {\r\n\t\t"name": "Caf\\u00e9",\r\n\t\t"version": 1.0,\r\n\t\t"big": 12345678901234567890,\r\n\t\t"slug": "x",\r\n\t\t"slug": "y"\r\n\t}\r\n}\r\n';

const packagesOf = (dir: string) => Object.keys(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies);
const EVERY_PACKAGE = [PLUGIN, 'expo-notifications', 'expo-constants', 'expo-device', 'expo-application', 'expo-localization', 'expo-secure-store'];

const suite = process.platform === 'win32' ? describe.skip : describe;

suite('the wizard on top of the real `npx expo install` (offline, fake npm)', () => {
  it('finds at least one Expo CLI to run', () => {
    expect(CLIS.length).toBeGreaterThan(0);
  });

  describe.each(CLIS)('with $label', ({ modules }) => {
    it('app.json: installs, the plugin is listed once, exit 0', async () => {
      const dir = project(modules, { 'app.json': { expo: { name: 'A', slug: 'a', extra: { eas: { projectId: 'p' } } } } });
      const r = await runWizard(dir);

      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      expect(packagesOf(dir)).toEqual(expect.arrayContaining(EVERY_PACKAGE));
      const plugins = JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8')).expo.plugins;
      expect(plugins.filter((entry: unknown) => wizard.isEspressoPlugin(entry))).toHaveLength(1);
      expect(r.out).toMatch(/^Done\.$/m);
    });

    it('app.config.json: installs, the plugin is listed once, exit 0', async () => {
      const dir = project(modules, { 'app.config.json': { expo: { name: 'A', slug: 'a', extra: { eas: { projectId: 'p' } } } } });
      const r = await runWizard(dir);

      expect(r.code).toBe(0);
      expect(packagesOf(dir)).toEqual(expect.arrayContaining(EVERY_PACKAGE));
      const plugins = JSON.parse(readFileSync(join(dir, 'app.config.json'), 'utf8')).expo.plugins;
      expect(plugins.filter((entry: unknown) => wizard.isEspressoPlugin(entry))).toHaveLength(1);
      expect(existsSync(join(dir, 'app.json'))).toBe(false);
    });

    it('app.config.ts: expo exits 1 after installing; the wizard goes on and ends with the manual step, exit 2', async () => {
      const config = 'export default ({ config }) => ({ ...config, name: "A", slug: "a", plugins: [] });\n';
      const dir = project(modules, { 'app.config.ts': config });
      const r = await runWizard(dir);

      expect(packagesOf(dir)).toEqual(expect.arrayContaining(EVERY_PACKAGE));
      expect(r.err).toMatch(/exited with code 1, but every package is in package.json/);
      expect(r.err).not.toMatch(/did not finish/);
      expect(r.code).toBe(2);
      expect(r.out).toContain(`"${PLUGIN}"`);
      expect(r.out).toContain('1 manual step left');
      expect(r.out).not.toContain('Nothing to change');
      expect(readFileSync(join(dir, 'app.config.ts'), 'utf8')).toBe(config);
    });

    it('app.config.ts that spreads config next to an app.json that lists the plugin: exit 0, no manual step, and a request to check the file, never a success line (SSF-02.16)', async () => {
      const config = 'export default ({ config }) => ({ ...config, name: "A", slug: "a" });\n';
      const dir = project(modules, { 'app.config.ts': config, 'app.json': { expo: { name: 'A', slug: 'a', plugins: [PLUGIN] } } });
      const r = await runWizard(dir);

      expect(packagesOf(dir)).toEqual(expect.arrayContaining(EVERY_PACKAGE));
      expect(r.code).toBe(0);
      expect(r.out).not.toContain('manual step');
      expect(r.out).toContain('Check that app.config.ts keeps');
      expect(r.out).not.toMatch(/already set up|Nothing to change|^Done\.$/m);
      expect(readFileSync(join(dir, 'app.config.ts'), 'utf8')).toBe(config);
    });

    it('app.config.ts that already lists the plugin: the second run ends with exit 0', async () => {
      const dir = project(modules, { 'app.config.ts': `export default ({ config }) => ({ ...config, plugins: ["${PLUGIN}"] });\n` });
      await runWizard(dir);
      const second = await runWizard(dir);

      expect(second.code).toBe(0);
      expect(second.out).not.toContain('manual step');
      expect(second.out).not.toMatch(/already set up|Nothing to change|^Done\.$/m);
    });

    describe('Expo rewrites the JSON config while it installs (SSF-02.17)', () => {
      /** The plugins a plain, Expo-formatted config ends with: what this Expo CLI adds, plus the one of the wizard. */
      async function pluginsOnAPlainConfig(name: string): Promise<string[]> {
        const dir = project(modules, { [name]: { expo: { name: 'A', slug: 'a' } } });
        await runWizard(dir);
        return JSON.parse(readFileSync(join(dir, name), 'utf8')).expo.plugins;
      }

      it.each(['app.json', 'app.config.json'])('%s with comments stays byte for byte, the manual step lists every plugin, exit 2, never Done', async (name) => {
        const expected = await pluginsOnAPlainConfig(name);
        const dir = project(modules, { [name]: COMMENTED });
        const r = await runWizard(dir);

        expect(expected.length).toBeGreaterThan(1); // this Expo does add plugins of its own, so the file really was rewritten
        expect(readFileSync(join(dir, name), 'utf8')).toBe(COMMENTED);
        expect(r.code).toBe(2);
        expect(r.out).toMatch(new RegExp(`Expo rewrote ${name.replace('.', '\\.')}`));
        expect(r.out).toContain('1 manual step left');
        const step = r.out.split('\n').find((line) => /^\s+- add /.test(line))!;
        for (const plugin of expected) expect(step).toContain(`"${plugin}"`);
        expect(r.out).not.toMatch(/^Done\.$/m);
        expect(packagesOf(dir)).toEqual(expect.arrayContaining(EVERY_PACKAGE));
      });

      it.each(['app.json', 'app.config.json'])('%s as a link to another file, with the mode 0600: Expo replaces the link and writes 0644, the wizard puts the link and the mode back and the plugins go into the file it points to (GAP-F)', async (name) => {
        const expected = await pluginsOnAPlainConfig(name);
        const plain = JSON.stringify({ expo: { name: 'A', slug: 'a' } }, null, 2) + '\n';
        const dir = project(modules, {});
        mkdirSync(join(dir, 'shared'));
        writeFileSync(join(dir, 'shared', name), plain);
        chmodSync(join(dir, 'shared', name), 0o600);
        symlinkSync(`shared/${name}`, join(dir, name));
        const r = await runWizard(dir);

        expect(r.code).toBe(0);
        expect(lstatSync(join(dir, name)).isSymbolicLink()).toBe(true);
        expect(readlinkSync(join(dir, name))).toBe(`shared/${name}`);
        expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
        const shared = readFileSync(join(dir, 'shared', name), 'utf8');
        expect(isOneInsertion(Buffer.from(plain, 'utf8'), Buffer.from(shared, 'utf8'))).toBe(true);
        expect(JSON.parse(shared).expo.plugins).toEqual(expected);
        expect(r.out).toMatch(/put your file back as you wrote it/);
        expect(r.out).toMatch(/^Done\.$/m);
      });

      it.each(['app.json', 'app.config.json'])('%s with a BOM, CRLF, tabs, 1.0, a big integer, an escape and a repeated key: one insertion, every other byte kept, exit 0', async (name) => {
        const expected = await pluginsOnAPlainConfig(name);
        const dir = project(modules, { [name]: HARD });
        const r = await runWizard(dir);

        const after = readFileSync(join(dir, name));
        expect(isOneInsertion(Buffer.from(HARD, 'utf8'), after)).toBe(true);
        expect(r.code).toBe(0);
        expect(r.out).toMatch(/^Done\.$/m);
        expect(r.out).toMatch(/Expo rewrote/);
        expect(JSON.parse(after.toString('utf8').replace(/^﻿/, '')).expo.plugins).toEqual(expected);
        for (const kept of ['﻿{\r\n\t"expo"', '1.0', '12345678901234567890', '\\u00e9', '"slug": "x"', '"slug": "y"']) expect(after.toString('utf8')).toContain(kept);
      });
    });
  });
});
