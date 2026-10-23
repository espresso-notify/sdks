/**
 * @jest-environment node
 *
 * expo-setup-simpler T6 (ES-09): `npx @espresso-notify/react-native setup`, the install wizard for Expo apps.
 * Every test works in a temporary project folder and replaces `spawn`: no `expo install` ever runs here.
 */
import { EventEmitter } from 'events';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path, { join } from 'path';
import { PassThrough } from 'stream';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const wizard = require('../bin/setup.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const manifest = require('../package.json');

const PLUGIN = '@espresso-notify/react-native';
const INSTALL_ARGS = [
  'expo', 'install', PLUGIN, 'expo-notifications', 'expo-constants', 'expo-device', 'expo-application', 'expo-localization',
  'expo-secure-store',
];

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

type Files = Record<string, string | object>;

/** A project folder with the given files (objects are written as JSON, 2 spaces, trailing newline). */
function project(files: Files): string {
  const dir = mkdtempSync(join(tmpdir(), 'espresso-wizard-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const file = join(dir, name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  }
  return dir;
}

const expoApp = (extra: Files = {}, deps: Record<string, string> = { expo: '~57.0.26' }): Files => ({
  'package.json': { name: 'app', dependencies: deps },
  'app.json': { expo: { name: 'App', slug: 'app', extra: { eas: { projectId: 'abc-123' } } } },
  ...extra,
});

/**
 * Runs the wizard in `cwd`. `closeCode` is what the fake `npx expo install` exits with; `onInstall` runs when it "installs"
 * (to change package.json the way a real install does); `fs` and `path` replace the file system and the path module.
 */
async function run(argv: string[], cwd: string, opts: { closeCode?: number; spawnError?: Error; stdin?: string; tty?: boolean; platform?: string; env?: Record<string, string | undefined>; onInstall?: () => void; fs?: any; path?: any } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const spawn = jest.fn((_cmd: string, _args: string[], _options: any) => {
    const child: any = new EventEmitter();
    setImmediate(() => {
      if (opts.spawnError) return child.emit('error', opts.spawnError);
      opts.onInstall?.();
      return child.emit('close', opts.closeCode ?? 0);
    });
    return child;
  });
  const stdin = new PassThrough();
  if (opts.stdin !== undefined) stdin.end(opts.stdin);
  const code: number = await wizard.run(argv, {
    cwd,
    spawn,
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: (s: string) => err.push(s) },
    stdin,
    isTTY: opts.tty ?? false,
    platform: opts.platform ?? 'linux',
    env: opts.env ?? {},
    ...(opts.fs ? { fs: opts.fs } : {}),
    ...(opts.path ? { path: opts.path } : {}),
  });
  return { code, out: out.join(''), err: err.join(''), all: out.join('') + err.join(''), spawn };
}

const read = (dir: string, name: string) => readFileSync(join(dir, name), 'utf8');

/** Every file under `dir` with its content, to prove that nothing changed. */
function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else result[full.slice(dir.length)] = readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return result;
}

describe('detection and refusals (exit 1)', () => {
  it('refuses a folder without package.json', async () => {
    const dir = project({});
    const r = await run(['setup'], dir);

    expect(r.code).toBe(1);
    expect(r.all).toMatch(/package\.json/);
    expect(r.spawn).not.toHaveBeenCalled();
  });

  // setup-wizard-bare-rn T9: the only assertion of this file that changed. A project with react-native and without expo
  // used to be refused with a pointer to the manual guide; the wizard now routes it to the React Native CLI flow.
  it('routes a project without expo and with react-native to the React Native CLI flow', async () => {
    const dir = project({ 'package.json': { name: 'bare', dependencies: { 'react-native': '0.79.0' } } });
    const r = await run(['setup'], dir);

    expect(r.all).toContain('React Native CLI');
    expect(r.all).not.toMatch(/not an Expo project/);
    expect(r.spawn).toHaveBeenCalledTimes(1);
    expect(r.spawn.mock.calls[0][0]).toBe('npm');
  });

  it('refuses Expo SDK 52 (version read from node_modules) and says the floor', async () => {
    const dir = project({
      ...expoApp({}, { expo: '~52.0.0' }),
      'node_modules/expo/package.json': { name: 'expo', version: '52.0.46' },
    });
    const r = await run(['setup'], dir);

    expect(r.code).toBe(1);
    expect(r.all).toMatch(/Expo SDK 52/);
    expect(r.all).toMatch(/53/);
    expect(r.spawn).not.toHaveBeenCalled();
  });

  it('reads the Expo SDK from the range in package.json when expo is not installed yet', async () => {
    expect((await run(['setup'], project(expoApp({}, { expo: '~52.0.0' })))).code).toBe(1);
    expect((await run(['setup', '--yes'], project(expoApp({}, { expo: '^53.0.0' })))).code).toBe(0);
    expect((await run(['setup', '--yes'], project(expoApp({}, { expo: '~57.0.26' })))).code).toBe(0);
  });

  it('goes on, with a warning, when the Expo SDK cannot be read (for example "latest")', async () => {
    const r = await run(['setup', '--yes'], project(expoApp({}, { expo: 'latest' })));

    expect(r.code).toBe(0);
    expect(r.all).toMatch(/could not tell|cannot tell|not sure/i);
    expect(r.spawn).toHaveBeenCalledTimes(1);
  });

  it('refuses an unknown flag with the usage', async () => {
    const r = await run(['setup', '--nope'], project(expoApp()));

    expect(r.code).toBe(1);
    expect(r.all).toMatch(/--dry-run/);
    expect(r.spawn).not.toHaveBeenCalled();
  });

  it('prints the usage with the exit codes for --help', async () => {
    const r = await run(['--help'], project(expoApp()));

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/--dry-run/);
    expect(r.out).toMatch(/--yes/);
    expect(r.out).toMatch(/--key/);
    expect(r.out).toMatch(/exit/i);
  });
});

describe('the install step', () => {
  it('runs `npx expo install` with the exact argument list, no shell', async () => {
    const dir = project(expoApp());
    const r = await run(['setup', '--yes'], dir);

    expect(r.spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = r.spawn.mock.calls[0];
    expect(cmd).toBe('npx');
    expect(args).toEqual(INSTALL_ARGS);
    expect(options.cwd).toBe(dir);
    expect(options.shell).toBeFalsy();
  });

  it('on Windows runs it through cmd.exe, because Node refuses to spawn a .cmd without a shell (EINVAL)', async () => {
    const dir = project(expoApp());
    const r = await run(['setup', '--yes'], dir, { platform: 'win32', env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' } });

    expect(r.spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = r.spawn.mock.calls[0];
    expect(cmd).toBe('C:\\Windows\\system32\\cmd.exe');
    // constant arguments only: nothing from the project reaches the command line
    expect(args).toEqual(['/d', '/s', '/c', 'npx', ...INSTALL_ARGS]);
    expect(options.cwd).toBe(dir);
    expect(options.shell).toBeFalsy();
    expect(JSON.stringify(r.spawn.mock.calls)).not.toContain('npx.cmd');
    expect(r.code).toBe(0);
  });

  // The interpreter is found by the path Windows gives (the ComSpec variable), not by the search path: a cmd.exe that
  // sits in the project folder or in a folder ahead of System32 on PATH would run instead of the system one.
  it('on Windows names the command interpreter by the ComSpec variable, never by a bare file name', async () => {
    const r = await run(['setup', '--yes'], project(expoApp()), { platform: 'win32', env: { ComSpec: 'D:\\Windows\\System32\\cmd.exe' } });

    expect(r.spawn.mock.calls[0][0]).toBe('D:\\Windows\\System32\\cmd.exe');
  });

  it('on Windows falls back to the System32 cmd.exe when ComSpec is not set', async () => {
    const r = await run(['setup', '--yes'], project(expoApp()), { platform: 'win32', env: {} });

    expect(r.spawn.mock.calls[0][0]).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  it.each(['cmd.exe', '..\\evil\\cmd.exe', '.\\cmd.exe', '', '   '])('on Windows ignores a ComSpec that is not an absolute path (%j)', async (comspec) => {
    const r = await run(['setup', '--yes'], project(expoApp()), { platform: 'win32', env: { ComSpec: comspec } });

    expect(r.spawn.mock.calls[0][0]).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  it.each(['linux', 'darwin'])('%s ignores ComSpec', async (platform) => {
    const r = await run(['setup', '--yes'], project(expoApp()), { platform, env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' } });

    expect(r.spawn.mock.calls[0][0]).toBe('npx');
  });

  it.each(['linux', 'darwin'])('on %s still runs npx itself, with no cmd.exe in between', async (platform) => {
    const r = await run(['setup', '--yes'], project(expoApp()), { platform });

    const [cmd, args] = r.spawn.mock.calls[0];
    expect(cmd).toBe('npx');
    expect(args).toEqual(INSTALL_ARGS);
  });

  it('skips it, and says so, when the seven packages are already in package.json', async () => {
    const deps = {
      expo: '~57.0.26', [PLUGIN]: '^0.1.0', 'expo-notifications': '~57.0.21', 'expo-constants': '~57.0.0',
      'expo-device': '~57.0.2', 'expo-application': '~57.0.3', 'expo-localization': '~57.0.2',
      'expo-secure-store': '~15.0.0',
    };
    const r = await run(['setup', '--yes'], project(expoApp({}, deps)));

    expect(r.spawn).not.toHaveBeenCalled();
    expect(r.out).toMatch(/already installed/i);
  });

  it('still runs it when only expo-secure-store is missing (an app set up before the wizard added it)', async () => {
    const deps = {
      expo: '~57.0.26', [PLUGIN]: '^0.1.0', 'expo-notifications': '~57.0.21', 'expo-constants': '~57.0.0',
      'expo-device': '~57.0.2', 'expo-application': '~57.0.3', 'expo-localization': '~57.0.2',
    };
    const r = await run(['setup', '--yes'], project(expoApp({}, deps)));

    expect(r.spawn).toHaveBeenCalledTimes(1);
    expect(r.spawn.mock.calls[0][1]).toEqual(INSTALL_ARGS);
  });

  it('exits 2 and prints the command to run by hand when the install fails', async () => {
    const dir = project(expoApp());
    const before = read(dir, 'app.json');
    const r = await run(['setup', '--yes'], dir, { closeCode: 1 });

    expect(r.code).toBe(2);
    expect(r.all).toContain('npx expo install ' + INSTALL_ARGS.slice(2).join(' '));
    expect(read(dir, 'app.json')).toBe(before);
  });

  it('exits 2 when npx cannot be started', async () => {
    const r = await run(['setup', '--yes'], project(expoApp()), { spawnError: new Error('spawn npx ENOENT') });

    expect(r.code).toBe(2);
    expect(r.all).toMatch(/npx expo install/);
  });
});

describe('app.json (exit 0)', () => {
  it('adds the plugin to expo.plugins and keeps everything else', async () => {
    const dir = project(expoApp());
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(0);
    const json = JSON.parse(read(dir, 'app.json'));
    expect(json.expo.plugins).toEqual([PLUGIN]);
    expect(json.expo.name).toBe('App');
    expect(json.expo.extra.eas.projectId).toBe('abc-123');
  });

  it('keeps the plugins that are there and the formatting (4 spaces, no trailing newline)', async () => {
    const original = JSON.stringify({ expo: { name: 'A', plugins: ['expo-router', ['expo-build-properties', { ios: {} }]] } }, null, 4);
    const dir = project(expoApp({ 'app.json': original }));
    await run(['setup', '--yes'], dir);

    const after = read(dir, 'app.json');
    expect(JSON.parse(after).expo.plugins).toEqual(['expo-router', ['expo-build-properties', { ios: {} }], PLUGIN]);
    expect(after.startsWith('{\n    "expo"')).toBe(true);
    expect(after.endsWith('\n')).toBe(false);
  });

  it('works on a flat app.json (no "expo" wrapper)', async () => {
    const dir = project(expoApp({ 'app.json': { name: 'Flat', slug: 'flat' } }));
    await run(['setup', '--yes'], dir);

    expect(JSON.parse(read(dir, 'app.json')).plugins).toEqual([PLUGIN]);
  });

  it.each([
    ['as a string', [PLUGIN]],
    ['as a [name, options] pair', [[PLUGIN, { apsEnvironment: 'production' }]]],
  ])('does not add the plugin again when it is already listed %s', async (_label, plugins) => {
    const dir = project(expoApp({ 'app.json': { expo: { name: 'A', plugins } } }));
    const before = read(dir, 'app.json');
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(0);
    expect(read(dir, 'app.json')).toBe(before);
  });

  it('leaves an app.json that is not valid JSON alone and exits 2', async () => {
    const dir = project(expoApp({ 'app.json': '{ "expo": { // comment\n' }));
    const before = read(dir, 'app.json');
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(2);
    expect(read(dir, 'app.json')).toBe(before);
    expect(r.all).toContain(PLUGIN);
  });
});

describe('app.config.js / app.config.ts are never edited, and the plugin line is a manual step (SSF-02.3, SSF-02.4)', () => {
  it.each(['app.config.js', 'app.config.ts', 'app.config.mjs', 'app.config.cjs'])('%s: prints the exact line, changes nothing, says "1 manual step left" and exits 2', async (name) => {
    const config = 'module.exports = ({ config }) => ({ ...config, plugins: [] });\n';
    const dir = project(expoApp({ [name]: config }));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(2);
    expect(read(dir, name)).toBe(config);
    expect(r.out).toContain(`"${PLUGIN}"`);
    expect(r.out).toContain(name);
    expect(r.out).toContain('1 manual step left');
    expect(r.out).not.toContain('Nothing to change');
    expect(r.out).not.toMatch(/^Done\.$/m);
    expect(read(dir, 'app.json')).not.toContain(PLUGIN);
  });

  it('does not ask for the step when the file already mentions the plugin, and a second run exits 0', async () => {
    const config = `export default ({ config }) => ({ ...config, plugins: ["${PLUGIN}"] })\n`;
    const deps = {
      expo: '~57.0.26', [PLUGIN]: '^0.1.0', 'expo-notifications': '~57.0.21', 'expo-constants': '~57.0.0',
      'expo-device': '~57.0.2', 'expo-application': '~57.0.3', 'expo-localization': '~57.0.2', 'expo-secure-store': '~15.0.0',
    };
    const dir = project(expoApp({ 'app.config.ts': config }, deps));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(0);
    expect(r.out).not.toContain('manual step');
    expect(r.out).toContain('mentions');
    expect(read(dir, 'app.config.ts')).toBe(config);
  });

  it('with --dry-run exits 0 and still prints the line', async () => {
    const dir = project(expoApp({ 'app.config.ts': 'export default {}\n' }));
    const r = await run(['setup', '--dry-run'], dir);

    expect(r.code).toBe(0);
    expect(r.out).toContain(`"${PLUGIN}"`);
    expect(r.out).toContain('Dry run');
  });

  it('finds App.Config.TS written with other capitals', async () => {
    const dir = project(expoApp({ 'App.Config.TS': 'export default {}\n' }));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(2);
    expect(r.out).toContain('App.Config.TS');
    expect(read(dir, 'app.json')).not.toContain(PLUGIN);
  });
});

describe('the EAS project id', () => {
  it('tells the user to run `eas init`, and does not run it, when extra.eas.projectId is missing', async () => {
    const dir = project(expoApp({ 'app.json': { expo: { name: 'A' } } }));
    const r = await run(['setup', '--yes'], dir);

    expect(r.out).toContain('eas init');
    expect(r.spawn.mock.calls.every(([cmd, args]) => cmd === 'npx' && args[0] === 'expo')).toBe(true);
    expect(JSON.stringify(r.spawn.mock.calls)).not.toContain('eas');
  });

  it('says nothing about `eas init` when the id is there', async () => {
    const r = await run(['setup', '--yes'], project(expoApp()));

    expect(r.out).not.toContain('eas init');
  });
});

describe('the public key', () => {
  it('refuses a secret key (sk_) with a security message, before anything runs, and never prints it', async () => {
    const dir = project(expoApp());
    const before = snapshot(dir);
    const r = await run(['setup', '--yes', '--key', 'sk_live_supersecret123'], dir);

    expect(r.code).toBe(1);
    expect(r.all).toMatch(/secret/i);
    expect(r.all).toContain('pk_');
    expect(r.all).not.toContain('supersecret123');
    expect(r.spawn).not.toHaveBeenCalled();
    expect(snapshot(dir)).toEqual(before);
  });

  it('refuses a value that is not a public key', async () => {
    const r = await run(['setup', '--yes', '--key', 'hello'], project(expoApp()));

    expect(r.code).toBe(1);
    expect(r.spawn).not.toHaveBeenCalled();
  });

  it('prints the usePushNotifications snippet filled with a pk_ key, and writes the key nowhere', async () => {
    const dir = project(expoApp());
    const r = await run(['setup', '--yes', '--key=pk_live_abc123XYZ'], dir);

    expect(r.code).toBe(0);
    expect(r.out).toContain('usePushNotifications');
    expect(r.out).toContain("projectId: 'pk_live_abc123XYZ'");
    for (const content of Object.values(snapshot(dir))) expect(content).not.toContain('pk_live_abc123XYZ');
    expect(JSON.stringify(r.spawn.mock.calls)).not.toContain('pk_live_abc123XYZ');
  });

  it('prints the snippet with a placeholder when no key is given', async () => {
    const r = await run(['setup', '--yes'], project(expoApp()));

    expect(r.out).toContain('usePushNotifications');
    expect(r.out).toMatch(/projectId: 'pk_live_/);
  });

  it('asks for the key when interactive, and uses the answer', async () => {
    const r = await run(['setup'], project(expoApp()), { tty: true, stdin: 'y\npk_test_typed42\n' });

    expect(r.code).toBe(0);
    expect(r.out).toContain("projectId: 'pk_test_typed42'");
  });

  it('refuses a secret key typed at the prompt', async () => {
    const r = await run(['setup'], project(expoApp()), { tty: true, stdin: 'y\nsk_live_typedsecret\n' });

    expect(r.code).toBe(1);
    expect(r.all).not.toContain('typedsecret');
  });

  it('does not ask anything with --yes', async () => {
    const r = await run(['setup', '--yes'], project(expoApp()), { tty: true });

    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/\?\s*$/m);
  });

  it('stops without changing anything when the user declines the confirmation', async () => {
    const dir = project(expoApp());
    const before = snapshot(dir);
    const r = await run(['setup'], dir, { tty: true, stdin: 'n\n' });

    expect(r.code).toBe(1);
    expect(r.spawn).not.toHaveBeenCalled();
    expect(snapshot(dir)).toEqual(before);
  });
});

describe('--dry-run', () => {
  it('prints what it would do and touches nothing: no process, no file', async () => {
    const dir = project(expoApp());
    const before = snapshot(dir);
    const r = await run(['setup', '--dry-run'], dir);

    expect(r.code).toBe(0);
    expect(r.spawn).not.toHaveBeenCalled();
    expect(snapshot(dir)).toEqual(before);
    expect(r.out).toMatch(/would/i);
    expect(r.out).toContain('npx expo install');
    expect(r.out).toContain(PLUGIN);
  });

  it('still refuses what a real run refuses', async () => {
    const r = await run(['setup', '--dry-run', '--key', 'sk_live_x'], project(expoApp()));

    expect(r.code).toBe(1);
  });
});

describe('a second run (idempotency)', () => {
  it('changes nothing and says so', async () => {
    const deps = {
      expo: '~57.0.26', [PLUGIN]: '^0.1.0', 'expo-notifications': '~57.0.21', 'expo-constants': '~57.0.0',
      'expo-device': '~57.0.2', 'expo-application': '~57.0.3', 'expo-localization': '~57.0.2',
      'expo-secure-store': '~15.0.0',
    };
    const dir = project(expoApp({ 'app.json': { expo: { name: 'A', plugins: [PLUGIN], extra: { eas: { projectId: 'x' } } } } }, deps));
    const before = snapshot(dir);
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(0);
    expect(snapshot(dir)).toEqual(before);
    expect(r.spawn).not.toHaveBeenCalled();
    expect(r.out).toMatch(/nothing to change|already set up/i);
  });

  it('after a first run, the second run edits nothing (app.json is stable)', async () => {
    const dir = project(expoApp());
    await run(['setup', '--yes'], dir);
    const afterFirst = read(dir, 'app.json');
    const second = await run(['setup', '--yes'], dir);

    expect(read(dir, 'app.json')).toBe(afterFirst);
    expect(second.out).toMatch(/already/i);
  });
});

describe('what the wizard leaves to you', () => {
  it('ends with the manual checklist', async () => {
    const r = await run(['setup', '--yes'], project(expoApp()));

    expect(r.out).toContain('google-services.json');
    expect(r.out).toContain('eas credentials');
    expect(r.out).toMatch(/APNs/);
    expect(r.out).toMatch(/development build/i);
    expect(r.out).toMatch(/Expo Go/);
  });

  it('prints the six steps in order', async () => {
    const r = await run(['setup', '--yes'], project(expoApp()));

    const positions = [1, 2, 3, 4, 5, 6].map((n) => r.out.indexOf(`[${n}/6]`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe('the package (ES-09 AC 1)', () => {
  it('declares one bin and ships it', () => {
    expect(Object.values(manifest.bin)).toEqual(['bin/setup.js']);
    expect(manifest.files).toEqual(expect.arrayContaining(['bin']));
    expect(existsSync(join(__dirname, '..', 'bin', 'setup.js'))).toBe(true);
  });

  it('starts with a node shebang and is executable', () => {
    const file = join(__dirname, '..', 'bin', 'setup.js');
    expect(readFileSync(file, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(statSync(file).mode & 0o111).not.toBe(0);
  });

  it('adds no runtime dependency and requires only Node built-ins', () => {
    expect(manifest.dependencies).toBeUndefined();
    const source = readFileSync(join(__dirname, '..', 'bin', 'setup.js'), 'utf8');
    const required = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    expect(required.length).toBeGreaterThan(0);
    for (const name of required) expect(name).toMatch(/^node:/);
  });
});

// ─── sdk-setup-fixes ─────────────────────────────────────────────────────────────────────────────────────────────────

const ALL_DEPS = {
  expo: '~57.0.26', [PLUGIN]: '^0.1.0', 'expo-notifications': '~57.0.21', 'expo-constants': '~57.0.0',
  'expo-device': '~57.0.2', 'expo-application': '~57.0.3', 'expo-localization': '~57.0.2', 'expo-secure-store': '~15.0.0',
};

/** What a real `npm install` leaves behind: every package of the wizard in package.json. */
const installEverything = (dir: string) => () =>
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: ALL_DEPS }, null, 2) + '\n');

describe('expo install that exits 1 after a good install (SSF-02.1, SSF-02.2)', () => {
  it('goes on, with a warning that names the exit code, when every package is in package.json', async () => {
    const dir = project(expoApp());
    const r = await run(['setup', '--yes'], dir, { closeCode: 1, onInstall: installEverything(dir) });

    expect(r.code).toBe(0);
    expect(r.err).toMatch(/exited with code 1/);
    expect(r.err).toMatch(/every package is in package.json/);
    expect(JSON.parse(read(dir, 'app.json')).expo.plugins).toEqual([PLUGIN]);
    expect(r.out).toMatch(/^Done\.$/m);
  });

  it('with an app.config.ts it goes on to the manual step instead of stopping at the install', async () => {
    const dir = project(expoApp({ 'app.config.ts': 'export default {}\n' }));
    const r = await run(['setup', '--yes'], dir, { closeCode: 1, onInstall: installEverything(dir) });

    expect(r.code).toBe(2);
    expect(r.err).not.toMatch(/did not finish/);
    expect(r.out).toContain('[3/6]');
    expect(r.out).toContain('1 manual step left');
  });

  it('still stops with 2 when a package is missing after the failed install', async () => {
    const dir = project(expoApp());
    const r = await run(['setup', '--yes'], dir, {
      closeCode: 1,
      onInstall: () => writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { expo: '~57.0.26', [PLUGIN]: '^0.1.0' } })),
    });

    expect(r.code).toBe(2);
    expect(r.err).toMatch(/did not finish/);
    expect(r.all).toContain('npx expo install ' + INSTALL_ARGS.slice(2).join(' '));
    expect(r.out).not.toContain('[3/6]');
  });

  it('stops with 2 when package.json cannot be read again', async () => {
    const dir = project(expoApp());
    const r = await run(['setup', '--yes'], dir, { closeCode: 1, onInstall: () => writeFileSync(join(dir, 'package.json'), '{ not json') });

    expect(r.code).toBe(2);
    expect(r.err).toMatch(/did not finish/);
  });

  it('counts a package in devDependencies as installed', async () => {
    const dir = project(expoApp());
    const r = await run(['setup', '--yes'], dir, {
      closeCode: 1,
      onInstall: () => {
        const { expo, ...rest } = ALL_DEPS;
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { expo }, devDependencies: rest }));
      },
    });

    expect(r.code).toBe(0);
  });
});

describe('the Expo SDK from a range that does not name one (SSF-02.11)', () => {
  it.each(['>=52 <58', '>=52', '*', 'latest', '^52.0.0 || ^53.0.0', 'next', 'workspace:*'])('goes on with a warning for %j', async (range) => {
    const r = await run(['setup', '--yes'], project(expoApp({}, { expo: range })));

    expect(r.code).toBe(0);
    expect(r.all).toMatch(/could not tell/i);
    expect(r.spawn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['~57.0.26', 57], ['^53.0.0', 53], ['53', 53], ['57.x', 57], ['v54.0.1', 54], ['=55.0.0', 55], ['~57.0.0-beta.1', 57],
    ['>=52 <58', null], ['>=53', null], ['latest', null], ['*', null], ['', null], ['1.2.3.4', null],
  ])('majorFromRange(%j) is %j', (range, major) => {
    expect(wizard.majorFromRange(range)).toBe(major);
  });

  it('refuses a range that is exactly SDK 52', async () => {
    expect((await run(['setup', '--yes'], project(expoApp({}, { expo: '52.0.1' })))).code).toBe(1);
  });
});

describe('app.config.json (SSF-02.5)', () => {
  it('is read and written like app.json', async () => {
    const dir = project({
      'package.json': { name: 'app', dependencies: { expo: '~57.0.26' } },
      'app.config.json': { expo: { name: 'C', slug: 'c', extra: { eas: { projectId: 'p' } } } },
    });
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(0);
    expect(JSON.parse(read(dir, 'app.config.json')).expo.plugins).toEqual([PLUGIN]);
    expect(r.out).toContain('app.config.json');
    expect(r.out).not.toContain('eas init');
    expect(existsSync(join(dir, 'app.json'))).toBe(false);
  });

  it('wins over app.json, which Expo does too, and leaves app.json alone', async () => {
    const dir = project(expoApp({ 'app.config.json': { expo: { name: 'C', slug: 'c' } } }));
    const appJson = read(dir, 'app.json');
    await run(['setup', '--yes'], dir);

    expect(JSON.parse(read(dir, 'app.config.json')).expo.plugins).toEqual([PLUGIN]);
    expect(read(dir, 'app.json')).toBe(appJson);
  });

  it('is left alone when it already lists the plugin', async () => {
    const dir = project({
      'package.json': { name: 'app', dependencies: ALL_DEPS },
      'app.config.json': { expo: { plugins: [PLUGIN], extra: { eas: { projectId: 'p' } } } },
    });
    const before = snapshot(dir);
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(0);
    expect(snapshot(dir)).toEqual(before);
  });
});

describe('the plugin written another way is the same plugin (SSF-02.6, SSF-02.7)', () => {
  const entries = [
    PLUGIN,
    `${PLUGIN}/app.plugin.js`,
    `${PLUGIN}/app.plugin`,
    `./node_modules/${PLUGIN}/app.plugin.js`,
    `node_modules/${PLUGIN}/app.plugin.js`,
    `.\\node_modules\\@espresso-notify\\react-native\\app.plugin.js`,
    `@espresso-notify\\react-native\\app.plugin.js`,
    'C:\\Users\\João Silva\\meu app\\node_modules\\@espresso-notify\\react-native\\app.plugin.js',
    '/home/ana/meu app/node_modules/@espresso-notify/react-native/app.plugin.js',
  ];

  // a spelling with a backslash is the plugin for the wizard, but Expo resolves it only on Windows (SSF-02.7, GAP-H)
  const slashEntries = entries.filter((entry) => !entry.includes('\\'));
  const backslashEntries = entries.filter((entry) => entry.includes('\\'));

  it.each(slashEntries)('does not add the plugin again when app.json lists %j', async (entry) => {
    const dir = project(expoApp({ 'app.json': { expo: { name: 'A', plugins: [entry] } } }));
    const before = read(dir, 'app.json');
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(0);
    expect(read(dir, 'app.json')).toBe(before);
    expect(r.out).not.toContain('EAS Build runs');
  });

  it.each(slashEntries)('on Windows too, %j is the plugin and raises no warning', async (entry) => {
    const dir = project(expoApp({ 'app.json': { expo: { name: 'A', plugins: [entry] } } }));
    const before = read(dir, 'app.json');
    const r = await run(['setup', '--yes'], dir, { platform: 'win32' });

    expect(r.code).toBe(0);
    expect(read(dir, 'app.json')).toBe(before);
    expect(r.all).not.toContain('EAS Build runs');
  });

  describe.each(['linux', 'darwin'])('on %s a plugin written with a backslash is a manual step (GAP-H)', (platform) => {
    it.each(backslashEntries.flatMap((entry) => [[entry], [[entry, { apsEnvironment: 'production' }]]]))('%j: file left alone, says to write it with "/", 1 manual step left, exit 2, never Done', async (entry) => {
      const dir = project(expoApp({ 'app.json': { expo: { name: 'A', plugins: [entry] } } }));
      const before = read(dir, 'app.json');
      const r = await run(['setup', '--yes'], dir, { platform });

      expect(r.code).toBe(2);
      expect(read(dir, 'app.json')).toBe(before);
      expect(r.err).toMatch(/Expo cannot resolve that on macOS and Linux/);
      expect(r.err).toMatch(/EAS Build runs there/);
      expect(r.out).toContain('1 manual step left');
      expect(r.out).toContain(`write the plugin as "${PLUGIN}"`);
      expect(r.out).not.toMatch(/^Done\.$/m);
      expect(r.out).not.toMatch(/Nothing to change|already lists|already set up/);
    });

    it('--dry-run ends with 2 as the real run does, and writes nothing', async () => {
      const dir = project(expoApp({ 'app.json': { expo: { name: 'A', plugins: ['@espresso-notify\\react-native'] } } }));
      const before = snapshot(dir);
      const r = await run(['setup', '--dry-run'], dir, { platform });

      expect(r.code).toBe(2);
      expect(snapshot(dir)).toEqual(before);
    });

    it('next to an app.config.ts the app.json that lists it with a backslash is the manual step, and the code file is not judged', async () => {
      const dir = project(expoApp({
        'app.json': { expo: { name: 'A', plugins: ['@espresso-notify\\react-native\\app.plugin.js'] } },
        'app.config.ts': 'export default ({ config }) => ({ ...config, name: "A" });\n',
      }, ALL_DEPS));
      const before = snapshot(dir);
      const r = await run(['setup', '--yes'], dir, { platform });

      expect(r.code).toBe(2);
      expect(snapshot(dir)).toEqual(before);
      expect(r.out).toContain('1 manual step left');
      expect(r.out).toContain(`write the plugin as "${PLUGIN}"`);
      expect(r.out).toContain('app.json');
      expect(r.out).not.toMatch(/Check that app\.config\.ts/);
    });

    it('a list that has the plugin written well and written with a backslash is still a manual step: the bad entry breaks the build', async () => {
      const dir = project(expoApp({ 'app.json': { expo: { name: 'A', plugins: [PLUGIN, '@espresso-notify\\react-native'] } } }));
      const before = read(dir, 'app.json');
      const r = await run(['setup', '--yes'], dir, { platform });

      expect(r.code).toBe(2);
      expect(read(dir, 'app.json')).toBe(before);
    });
  });

  describe('on Windows a plugin written with a backslash is present, with a warning that EAS Build needs "/" (GAP-H)', () => {
    it.each(backslashEntries)('%j: file untouched, exit 0, the warning names EAS Build, no success line', async (entry) => {
      const dir = project(expoApp({ 'app.json': { expo: { name: 'A', plugins: [entry] } } }));
      const before = read(dir, 'app.json');
      const r = await run(['setup', '--yes'], dir, { platform: 'win32' });

      expect(r.code).toBe(0);
      expect(read(dir, 'app.json')).toBe(before);
      expect(r.out).toMatch(/EAS Build runs on Linux or macOS/);
      expect(r.out).toContain(`Write it as "${PLUGIN}"`);
      expect(r.out).toMatch(/Finished what the wizard can do\. Check app\.json/);
      expect(r.out).not.toMatch(/^Done\.$/m);
      expect(r.out).not.toMatch(/Nothing to change|already lists|already set up/);
      expect(r.out).not.toContain('manual step');
    });

    it('next to an app.config.ts the warning is printed too, and the code file is judged as usual', async () => {
      const dir = project(expoApp({
        'app.json': { expo: { name: 'A', plugins: ['@espresso-notify\\react-native'] } },
        'app.config.ts': 'export default ({ config }) => ({ ...config, name: "A" });\n',
      }, ALL_DEPS));
      const before = snapshot(dir);
      const r = await run(['setup', '--yes'], dir, { platform: 'win32' });

      expect(r.code).toBe(0);
      expect(snapshot(dir)).toEqual(before);
      expect(r.out).toMatch(/EAS Build runs on Linux or macOS/);
      expect(r.out).toContain('Check that app.config.ts keeps');
      expect(r.out).not.toMatch(/^Done\.$/m);
    });
  });

  it('does not add it again when the entry is a [path, options] pair', async () => {
    const dir = project(expoApp({ 'app.json': { expo: { name: 'A', plugins: [[`${PLUGIN}/app.plugin.js`, { apsEnvironment: 'production' }]] } } }));
    const before = read(dir, 'app.json');
    await run(['setup', '--yes'], dir);

    expect(read(dir, 'app.json')).toBe(before);
  });

  const notThePlugin = ['@espresso-notify/react-native-extra', '@espresso-notify/web', 'react-native', './plugins/@espresso-notify/react-native.js', '', 7, null];

  it.each([['path.posix', path.posix], ['path.win32', path.win32]])('isEspressoPlugin gives the same answer under %s', (_name, pathModule) => {
    for (const entry of entries) expect(wizard.isEspressoPlugin(entry, pathModule)).toBe(true);
    for (const entry of entries) expect(wizard.isEspressoPlugin([entry, {}], pathModule)).toBe(true);
    for (const entry of notThePlugin) expect(wizard.isEspressoPlugin(entry, pathModule)).toBe(false);
  });

  it('adds the plugin when only a similar name is listed', async () => {
    const dir = project(expoApp({ 'app.json': { expo: { name: 'A', plugins: ['@espresso-notify/react-native-extra'] } } }));
    await run(['setup', '--yes'], dir);

    expect(JSON.parse(read(dir, 'app.json')).expo.plugins).toEqual(['@espresso-notify/react-native-extra', PLUGIN]);
  });
});

describe('app.json with comments or a trailing comma, and app.json that is not JSON (SSF-02.8, SSF-02.9)', () => {
  it.each([
    ['a line comment', '{\n  "expo": {\n    // the name\n    "name": "A"\n  }\n}\n'],
    ['a block comment', '{ /* app */ "expo": { "name": "A" } }\n'],
    ['a trailing comma', '{\n  "expo": {\n    "name": "A",\n  },\n}\n'],
  ])('%s: leaves the file alone, says Expo accepts it and the wizard does not, prints the line, exits 2', async (_label, text) => {
    const dir = project(expoApp({ 'app.json': text }));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(2);
    expect(read(dir, 'app.json')).toBe(text);
    expect(r.err).toMatch(/comments or a trailing comma/);
    expect(r.err).toMatch(/Expo accepts that/);
    expect(r.err).not.toMatch(/not valid JSON/);
    expect(r.all).toContain(`"${PLUGIN}"`);
    expect(r.out).toContain('1 manual step left');
  });

  it('keeps a comment marker inside a string out of the way', async () => {
    const dir = project(expoApp({ 'app.json': { expo: { name: 'http://example.test // not a comment', slug: 'a' } } }));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(0);
    expect(JSON.parse(read(dir, 'app.json')).expo.name).toBe('http://example.test // not a comment');
  });

  it('says "not valid JSON" for a file that is broken even without its comments', async () => {
    const dir = project(expoApp({ 'app.json': '{ "expo": { "name": }' }));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(2);
    expect(r.err).toMatch(/not valid JSON/);
    expect(read(dir, 'app.json')).toBe('{ "expo": { "name": }');
  });

  it('does not tell the person to run eas init about a file it could not read', async () => {
    const dir = project(expoApp({ 'app.json': '{ // c\n "expo": {} }' }));
    const r = await run(['setup', '--yes'], dir);

    expect(r.out).toMatch(/was not read/);
  });

  it('isJson5Like is true for comments and trailing commas only', () => {
    expect(wizard.isJson5Like('{"a": 1, // x\n}')).toBe(true);
    expect(wizard.isJson5Like('{"a": [1, 2,],}')).toBe(true);
    expect(wizard.isJson5Like('{"a": }')).toBe(false);
    expect(wizard.isJson5Like('{"a": "x // y",}')).toBe(true);
  });
});

describe('ios/ and android/ that exist (SSF-02.10)', () => {
  it('warns that the plugin applies only after `npx expo prebuild`, and not to use --clean', async () => {
    const dir = project(expoApp({ 'ios/Podfile': '# pods\n', 'android/build.gradle': '// gradle\n' }));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(0);
    expect(r.out).toContain('ios/ and android/');
    expect(r.out).toContain('npx expo prebuild');
    expect(r.out).toMatch(/Do not add --clean/);
  });

  it('names just the folder that is there', async () => {
    const r = await run(['setup', '--yes'], project(expoApp({ 'android/build.gradle': '' })));

    expect(r.out).toContain('android/ folder already exists');
    expect(r.out).not.toContain('ios/');
  });

  it('says nothing about prebuild in a project without native folders', async () => {
    const r = await run(['setup', '--yes'], project(expoApp()));

    expect(r.out).not.toContain('prebuild');
  });

  it('warns also with an app.config.ts (the folders hold the old native config either way)', async () => {
    const r = await run(['setup', '--yes'], project(expoApp({ 'app.config.ts': 'export default {}\n', 'ios/Podfile': '' })));

    expect(r.out).toContain('npx expo prebuild');
  });

  it('a file called ios is not a folder', async () => {
    const r = await run(['setup', '--yes'], project(expoApp({ ios: 'just a file' })));

    expect(r.out).not.toContain('prebuild');
  });
});

describe('the same on every system: line endings, byte order mark, case, paths (SSF-03)', () => {
  it('writes app.json back with CRLF when it had CRLF (SSF-03.2)', async () => {
    const lf = JSON.stringify({ expo: { name: 'A', slug: 'a', plugins: ['expo-router'] } }, null, 2) + '\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    const dir = project(expoApp({ 'app.json': crlf }));
    await run(['setup', '--yes'], dir);

    const after = read(dir, 'app.json');
    expect(after).toBe(JSON.stringify({ expo: { name: 'A', slug: 'a', plugins: ['expo-router', PLUGIN] } }, null, 2).replace(/\n/g, '\r\n') + '\r\n');
    expect(after.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('writes LF when it had LF, and CRLF without a final newline when that is how it was', async () => {
    const lfDir = project(expoApp({ 'app.json': '{\n  "expo": {\n    "name": "A"\n  }\n}\n' }));
    await run(['setup', '--yes'], lfDir);
    expect(read(lfDir, 'app.json')).not.toContain('\r');

    const crlfDir = project(expoApp({ 'app.json': '{\r\n\t"expo": {\r\n\t\t"name": "A"\r\n\t}\r\n}' }));
    await run(['setup', '--yes'], crlfDir);
    const after = read(crlfDir, 'app.json');
    expect(after.startsWith('{\r\n\t"expo"')).toBe(true);
    expect(after.endsWith('\r\n')).toBe(false);
    expect(after.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('keeps the byte order mark and reads a package.json that has one (SSF-03.3)', async () => {
    const dir = project(expoApp({
      'package.json': '\uFEFF' + JSON.stringify({ name: 'app', dependencies: { expo: '~57.0.26' } }, null, 2) + '\r\n',
      'app.json': '\uFEFF' + JSON.stringify({ expo: { name: 'A' } }, null, 2) + '\r\n',
    }));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(0);
    const after = read(dir, 'app.json');
    expect(after.startsWith('\uFEFF{')).toBe(true);
    expect(JSON.parse(after.slice(1)).expo.plugins).toEqual([PLUGIN]);
  });

  it('finds App.json (SSF-03.4)', async () => {
    const dir = project({ 'package.json': { name: 'app', dependencies: { expo: '~57.0.26' } }, 'App.json': { expo: { name: 'A' } } });
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(0);
    expect(JSON.parse(read(dir, 'App.json')).expo.plugins).toEqual([PLUGIN]);
    expect(r.out).toContain('App.json');
  });

  it('works in a folder with spaces and accents, and keeps the folder out of the command line (SSF-03.5)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'espresso-wizard-'));
    dirs.push(parent);
    const dir = join(parent, 'João Silva', 'meu app');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { expo: '~57.0.26' } }));
    writeFileSync(join(dir, 'app.json'), JSON.stringify({ expo: { name: 'A' } }));
    for (const platform of ['linux', 'win32']) {
      const r = await run(['setup', '--yes'], dir, { platform, env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } });
      const [cmd, args, options] = r.spawn.mock.calls[0];

      expect(r.code).toBe(0);
      expect(options.cwd).toBe(dir);
      expect(options.shell).toBeFalsy();
      expect(JSON.stringify([cmd, args])).not.toContain('João');
      expect(JSON.stringify([cmd, args])).not.toContain('meu app');
    }
    expect(JSON.parse(read(dir, 'app.json')).expo.plugins).toEqual([PLUGIN]);
  });

  describe.each([['path.posix', path.posix, '/home/joão/meu app'], ['path.win32', path.win32, 'C:\\Users\\João Silva\\meu app']])(
    'the pure helpers and the whole run under %s (SSF-03.1, SSF-03.6)',
    (_name, pathModule, cwd) => {
      /** A file system in memory whose keys are normalized with `pathModule`; on win32 it refuses a `/` in a path. */
      function memoryFs(files: Record<string, string>, folders: string[]) {
        const key = (p: string) => {
          if (pathModule === path.win32 && p.includes('/')) throw new Error(`EINVAL: a path with "/" on Windows: ${p}`);
          return pathModule.normalize(p);
        };
        const store = new Map(Object.entries(files).map(([name, text]) => [pathModule.join(cwd, name), text]));
        const dirsSet = new Set(folders.map((name) => pathModule.join(cwd, name)));
        return {
          store,
          readFileSync(p: string) {
            const text = store.get(key(p));
            if (text === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
            return text;
          },
          writeFileSync(p: string, data: string) {
            store.set(key(p), data);
          },
          readdirSync(dir: string) {
            const here = key(dir);
            const names = (paths: Iterable<string>) => [...paths].filter((p) => pathModule.dirname(p) === here).map((p) => pathModule.basename(p));
            return [
              ...names(store.keys()).map((name) => ({ name, isDirectory: () => false })),
              ...names(dirsSet).map((name) => ({ name, isDirectory: () => true })),
            ];
          },
        };
      }

      it('reads package.json and app.json, writes app.json and spots ios/ with the paths of the system', async () => {
        const memory = memoryFs(
          { 'package.json': JSON.stringify({ name: 'a', dependencies: { expo: '~57.0.26' } }), 'App.json': '{\r\n  "expo": {\r\n    "name": "A"\r\n  }\r\n}\r\n' },
          ['ios', 'node_modules'],
        );
        const r = await run(['setup', '--yes'], cwd, { fs: memory, path: pathModule, platform: pathModule === path.win32 ? 'win32' : 'linux', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } });

        expect(r.code).toBe(0);
        const written = memory.store.get(pathModule.join(cwd, 'App.json'))!;
        expect(JSON.parse(written).expo.plugins).toEqual([PLUGIN]);
        expect(written.endsWith('\r\n')).toBe(true);
        expect(r.out).toContain('npx expo prebuild');
        expect(r.spawn.mock.calls[0][2].cwd).toBe(cwd);
      });

      it('reads the installed Expo SDK from node_modules/expo/package.json', async () => {
        const memory = memoryFs(
          { 'package.json': JSON.stringify({ name: 'a', dependencies: { expo: '~52.0.0' } }), 'app.json': '{"expo":{}}' },
          [],
        );
        memory.store.set(pathModule.join(cwd, 'node_modules', 'expo', 'package.json'), JSON.stringify({ version: '53.0.1' }));
        const r = await run(['setup', '--yes'], cwd, { fs: memory, path: pathModule });

        expect(r.code).toBe(0);
        expect(r.out).toContain('Expo SDK 53');
      });

      it('findFile and findFolder ignore case and tell a folder from a file', () => {
        const entries = [
          { name: 'App.JSON', directory: false }, { name: 'IOS', directory: true }, { name: 'android', directory: false },
          { name: 'App.config.TS', directory: false },
        ];
        expect(wizard.findFile(entries, ['app.config.json', 'app.json'])).toBe('App.JSON');
        expect(wizard.findFile(entries, ['app.config.js', 'app.config.ts'])).toBe('App.config.TS');
        expect(wizard.findFolder(entries, 'ios')).toBe('IOS');
        expect(wizard.findFolder(entries, 'android')).toBeUndefined();
      });
    },
  );

  it('detectEol and formatJson round-trip both endings', () => {
    expect(wizard.detectEol('a\r\nb\r\n')).toBe('\r\n');
    expect(wizard.detectEol('a\nb\n')).toBe('\n');
    expect(wizard.detectEol('a\r\nb\nc\n')).toBe('\n');
    expect(wizard.detectEol('{}')).toBe('\n');
    const style = wizard.jsonStyle('\uFEFF{\r\n    "a": 1\r\n}\r\n');
    expect(style).toEqual({ indent: '    ', newline: true, eol: '\r\n', bom: '\uFEFF' });
    expect(wizard.formatJson({ a: [1] }, style)).toBe('\uFEFF{\r\n    "a": [\r\n        1\r\n    ]\r\n}\r\n');
  });

  it('installInvocation on win32 keeps the arguments constant whatever the environment holds', () => {
    const [cmd, args] = wizard.installInvocation('win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe', npm_config_prefix: 'C:\\Users\\João Silva\\&calc' });
    expect(cmd).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(args).toEqual(['/d', '/s', '/c', 'npx', ...INSTALL_ARGS]);
  });
});

describe('app.json is edited by inserting text, never written again from the parsed object (SSF-02.12)', () => {
  const NAME = `"${PLUGIN}"`;

  /** Runs the wizard on an app.json with exactly `text` and returns what is on disk afterwards. */
  async function edit(text: string, argv: string[] = ['setup', '--yes']) {
    const dir = project(expoApp({ 'app.json': text }));
    const r = await run(argv, dir);
    return { ...r, after: read(dir, 'app.json') };
  }

  it('keeps 1.0, an integer above 2^53, \\u escapes, \\/ and a repeated key as the person wrote them', async () => {
    const before =
      '{\n  "expo": {\n    "name": "caf\\u00e9 \\/ x",\n    "version": 1.0,\n    "extra": {\n      "big": 12345678901234567890,\n      "dup": 1,\n      "dup": 2,\n      "exp": 1E3\n    }\n  }\n}\n';
    const r = await edit(before);

    expect(r.code).toBe(0);
    const inserted = `,\n    "plugins": [\n      ${NAME}\n    ]`;
    expect(r.after).toBe(before.replace('\n  }\n}\n', `${inserted}\n  }\n}\n`));
    for (const kept of ['1.0', '\\u00e9', '\\/', '12345678901234567890', '"dup": 1', '"dup": 2', '1E3']) expect(r.after).toContain(kept);
  });

  it('appends to a list written over several lines with CRLF and tabs, and touches nothing else', async () => {
    const before = '{\r\n\t"expo": {\r\n\t\t"name": "A",\r\n\t\t"plugins": [\r\n\t\t\t"expo-router"\r\n\t\t],\r\n\t\t"slug": "a"\r\n\t}\r\n}\r\n';
    const r = await edit(before);

    expect(r.after).toBe(before.replace('"expo-router"', `"expo-router",\r\n\t\t\t${NAME}`));
  });

  it.each([
    ['a compact list', '{"expo":{"plugins":["a","b"]}}', `{"expo":{"plugins":["a","b",${NAME}]}}`],
    ['a list with spaces inside the brackets', '{ "expo": { "plugins": [ "a", "b" ] } }', `{ "expo": { "plugins": [ "a", "b", ${NAME} ] } }`],
    ['a list with one entry', '{"expo":{"plugins":["a"]}}', `{"expo":{"plugins":["a", ${NAME}]}}`],
    ['an empty list', '{"expo":{"plugins":[]}}', `{"expo":{"plugins":[${NAME}]}}`],
    ['an empty list on several lines', '{\n  "expo": {\n    "plugins": [\n    ]\n  }\n}', `{\n  "expo": {\n    "plugins": [\n      ${NAME}\n    ]\n  }\n}`],
    ['an entry that is a [name, options] pair', '{"expo":{"plugins":[["a",{"x":1}]]}}', `{"expo":{"plugins":[["a",{"x":1}], ${NAME}]}}`],
    ['a string with brackets, quotes and the word plugins inside', '{"expo":{"name":"a \\"plugins\\": [ ] ]","plugins":["a"]}}', `{"expo":{"name":"a \\"plugins\\": [ ] ]","plugins":["a", ${NAME}]}}`],
  ])('%s', async (_label, before, expected) => {
    const r = await edit(before);

    expect(r.code).toBe(0);
    expect(r.after).toBe(expected);
  });

  it.each([
    ['2 spaces', '{\n  "expo": {\n    "name": "A"\n  }\n}\n', `{\n  "expo": {\n    "name": "A",\n    "plugins": [\n      ${NAME}\n    ]\n  }\n}\n`],
    ['4 spaces and no final newline', '{\n    "expo": {\n        "name": "A"\n    }\n}', `{\n    "expo": {\n        "name": "A",\n        "plugins": [\n            ${NAME}\n        ]\n    }\n}`],
    ['tabs and CRLF', '{\r\n\t"expo": {\r\n\t\t"name": "A"\r\n\t}\r\n}\r\n', `{\r\n\t"expo": {\r\n\t\t"name": "A",\r\n\t\t"plugins": [\r\n\t\t\t${NAME}\r\n\t\t]\r\n\t}\r\n}\r\n`],
    ['a compact file', '{"expo":{"name":"A"}}', `{"expo":{"name":"A","plugins":[${NAME}]}}`],
    ['a space before the colon', '{ "expo" : { "name" : "A" } }', `{ "expo" : { "name" : "A", "plugins" : [${NAME}] } }`],
    ['no "expo" wrapper', '{\n  "name": "Flat"\n}\n', `{\n  "name": "Flat",\n  "plugins": [\n    ${NAME}\n  ]\n}\n`],
    ['an empty "expo" object (no style to copy: the usual ": ")', '{"expo":{}}', `{"expo":{"plugins": [${NAME}]}}`],
    ['an empty "expo" object over several lines', '{\n  "expo": {\n  }\n}\n', `{\n  "expo": {\n    "plugins": [\n      ${NAME}\n    ]\n  }\n}\n`],
    ['a byte order mark', '﻿{\r\n  "expo": {\r\n    "name": "A"\r\n  }\r\n}\r\n', `﻿{\r\n  "expo": {\r\n    "name": "A",\r\n    "plugins": [\r\n      ${NAME}\r\n    ]\r\n  }\r\n}\r\n`],
  ])('adds the "plugins" key, in the style of the file: %s', async (_label, before, expected) => {
    const r = await edit(before);

    expect(r.code).toBe(0);
    expect(r.after).toBe(expected);
  });

  it('puts the key in the object that Expo reads: "expo" when it is an object, else the file itself', async () => {
    const wrapped = await edit('{"name":"outside","expo":{"name":"inside"}}');
    expect(JSON.parse(wrapped.after).expo.plugins).toEqual([PLUGIN]);
    expect(JSON.parse(wrapped.after).plugins).toBeUndefined();

    const nullExpo = await edit('{"expo":null,"name":"flat"}');
    expect(JSON.parse(nullExpo.after).plugins).toEqual([PLUGIN]);
    expect(nullExpo.after).toBe(`{"expo":null,"name":"flat","plugins":[${NAME}]}`);
  });

  it('is stable: a second run finds the plugin and writes nothing', async () => {
    const dir = project(expoApp({ 'app.json': '{ "expo" : { "version": 1.0 } }' }));
    await run(['setup', '--yes'], dir);
    const afterFirst = read(dir, 'app.json');
    const second = await run(['setup', '--yes'], dir);

    expect(second.code).toBe(0);
    expect(read(dir, 'app.json')).toBe(afterFirst);
    expect(afterFirst.split(PLUGIN)).toHaveLength(2);
  });

  // The parsed file after the edit must be the parsed file before, plus the plugin and nothing else, whatever the layout.
  it.each([0, 1, 2, 3, 4, '\t'])('changes only the plugins list of every layout (indent %j)', async (indent) => {
    const bases: object[] = [
      { expo: { name: 'A', slug: 'a', version: '1.0.0', ios: { bundleIdentifier: 'x.y' }, extra: { eas: { projectId: 'p' } } } },
      { expo: { name: 'A', plugins: ['expo-router', ['expo-build-properties', { ios: { useFrameworks: 'static' } }]], scheme: 'a' } },
      { expo: { plugins: [] } },
      { name: 'Flat', slug: 'flat', plugins: ['x'], extra: {} },
      { expo: { name: 'A', list: [1, [2, { a: [] }], {}], empty: {}, plugins: ['a'], tail: [] } },
    ];
    for (const base of bases) {
      const before = JSON.stringify(base, null, indent) + (indent ? '\n' : '');
      const r = await edit(before);
      const expected: any = JSON.parse(before);
      const target = expected.expo && typeof expected.expo === 'object' ? expected.expo : expected;
      target.plugins = [...(target.plugins || []), PLUGIN];

      expect(r.code).toBe(0);
      expect(JSON.parse(r.after)).toEqual(expected);
    }
  });
});

describe('an app.json the wizard cannot edit without changing what is in it is left alone, with the manual step (SSF-02.13)', () => {
  it.each([
    ['a JSON array at the root', '[]\n', /array/],
    ['a JSON array with content', '[{"expo":{}}]\n', /array/],
    ['null', 'null\n', /object/],
    ['a number', '7\n', /object/],
    ['"plugins" that is a string', '{"expo":{"plugins":"other"}}', /"plugins".*not a list/],
    ['"plugins" that is null', '{"expo":{"plugins":null}}', /"plugins".*not a list/],
    ['"plugins" that is an object', '{"expo":{"plugins":{"a":1}}}', /"plugins".*not a list/],
    ['"expo" that is a list', '{"expo":[1]}', /"expo".*not an object/],
    ['"expo" that is a string', '{"expo":"text"}', /"expo".*not an object/],
    ['"expo" written twice', '{"expo":{"name":"a"},"expo":{"name":"b"}}', /"expo".*twice|repeats/],
    ['"plugins" written twice', '{"expo":{"plugins":["a"],"plugins":["b"]}}', /"plugins".*twice|repeats/],
  ])('%s: file intact, says why, prints the line, "1 manual step left", exit 2, never "Done"', async (_label, text, reason) => {
    const dir = project(expoApp({ 'app.json': text }));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(2);
    expect(read(dir, 'app.json')).toBe(text);
    expect(r.err).toMatch(reason);
    expect(r.all).toContain(`"${PLUGIN}"`);
    expect(r.out).toContain('1 manual step left');
    expect(r.out).not.toMatch(/^Done\.$/m);
    expect(r.out).not.toContain('Nothing to change');
  });

  it('does the same with app.config.json', async () => {
    const dir = project({ 'package.json': { name: 'app', dependencies: { expo: '~57.0.26' } }, 'app.config.json': '[]' });
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(2);
    expect(read(dir, 'app.config.json')).toBe('[]');
    expect(r.err).toContain('app.config.json');
  });
});

describe('--dry-run ends with the code the real run ends with, for a JSON config (SSF-02.14)', () => {
  it.each([
    ['comments', '{ // c\n "expo": {} }'],
    ['a trailing comma', '{"expo":{"name":"A",},}'],
    ['not JSON', '{ "expo": '],
    ['a root array', '[]'],
    ['"plugins" that is not a list', '{"expo":{"plugins":"x"}}'],
  ])('%s: both exit 2 and the dry run changes nothing', async (_label, text) => {
    const dryDir = project(expoApp({ 'app.json': text }));
    const before = snapshot(dryDir);
    const dry = await run(['setup', '--dry-run'], dryDir);
    const real = await run(['setup', '--yes'], project(expoApp({ 'app.json': text })));

    expect(real.code).toBe(2);
    expect(dry.code).toBe(2);
    expect(snapshot(dryDir)).toEqual(before);
    expect(dry.all).toContain(`"${PLUGIN}"`);
    expect(dry.out).toContain('Dry run');
  });

  it('an app.json it can edit: both exit 0 and the dry run says what it would add', async () => {
    const dir = project(expoApp());
    const before = snapshot(dir);
    const dry = await run(['setup', '--dry-run'], dir);

    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/Would add/);
    expect(snapshot(dir)).toEqual(before);
  });
});

describe('a code config that only names the package is not "already set up" (SSF-02.15)', () => {
  const closing = /already set up|Nothing to change|^Done\.$/m;

  it.each([
    ['in a comment', '// TODO: add "@espresso-notify/react-native" here\nexport default { name: "A", slug: "a", plugins: [] }\n'],
    ['in a string that is not the plugins list', 'export default { name: "@espresso-notify/react-native demo", plugins: [] }\n'],
    ['in the plugins list', `export default { name: "A", plugins: ["${PLUGIN}"] }\n`],
  ])('app.config.ts that names it %s: asks to check the file, says no success, exits 0', async (_label, config) => {
    const dir = project(expoApp({ 'app.config.ts': config }, ALL_DEPS));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(0);
    expect(read(dir, 'app.config.ts')).toBe(config);
    expect(r.out).not.toMatch(closing);
    expect(r.out).toMatch(/Check that app\.config\.ts lists/);
    expect(r.out).not.toContain('manual step');
  });

  it('says the same after an install that changed package.json', async () => {
    const dir = project(expoApp({ 'app.config.js': `module.exports = { plugins: ["${PLUGIN}"] }\n` }));
    const r = await run(['setup', '--yes'], dir, { onInstall: installEverything(dir) });

    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(closing);
    expect(r.out).toMatch(/Check that app\.config\.js lists/);
  });

  it('keeps "Nothing to change" for a project that really needs nothing (app.json lists the plugin)', async () => {
    const dir = project(expoApp({ 'app.json': { expo: { name: 'A', plugins: [PLUGIN], extra: { eas: { projectId: 'x' } } } } }, ALL_DEPS));
    const r = await run(['setup', '--yes'], dir);

    expect(r.out).toContain('Nothing to change');
    expect(r.out).not.toMatch(/Check that/);
  });
});

describe('app.json that lists the plugin next to an app.config.ts (SSF-02.16)', () => {
  const listed = { expo: { name: 'A', slug: 'a', plugins: [PLUGIN], extra: { eas: { projectId: 'x' } } } };
  const spreads = 'export default ({ config }) => ({ ...config, name: "A" });\n';

  it.each(['app.config.ts', 'app.config.js', 'app.config.mjs', 'app.config.cjs'])('%s spreads config: no manual step, exit 0, nothing written, and the closing asks to check the file instead of saying it is set up (GAP-G)', async (name) => {
    const dir = project(expoApp({ 'app.json': listed, [name]: spreads }, ALL_DEPS));
    const before = snapshot(dir);
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(0);
    expect(r.out).not.toContain('manual step');
    expect(r.out).toContain('app.json lists the plugin');
    expect(r.out).toMatch(/spreads/);
    expect(r.out).toContain(`Check that ${name} keeps "${PLUGIN}"`);
    expect(r.out).not.toMatch(/already set up|Nothing to change|^Done\.$|: nothing to add/m);
    expect(snapshot(dir)).toEqual(before);
  });

  it('recognises the plugin in app.json written another way, and a spread without spaces', async () => {
    const dir = project(expoApp({
      'app.json': { expo: { plugins: [['./node_modules/@espresso-notify/react-native/app.plugin.js', {}]] } },
      'app.config.ts': 'export default ({config}) => ({...config})\n',
    }, ALL_DEPS));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(0);
    expect(r.out).not.toContain('manual step');
    expect(r.out).toContain('Check that app.config.ts keeps');
  });

  it('app.config.json beats app.json: its list is the one that counts', async () => {
    const dir = project(expoApp({ 'app.config.json': listed, 'app.json': { expo: { name: 'no plugin' } }, 'app.config.ts': spreads }, ALL_DEPS));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(0);
    expect(r.out).toContain('app.config.json lists the plugin');
    expect(r.out).toContain('Check that app.config.ts keeps');
  });

  it('does not spread config: the manual step explains that Expo uses what app.config.ts returns', async () => {
    const config = 'export default { name: "A", slug: "a" };\n';
    const dir = project(expoApp({ 'app.json': listed, 'app.config.ts': config }, ALL_DEPS));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(2);
    expect(r.out).toContain('1 manual step left');
    expect(r.out).toContain('app.json lists the plugin');
    expect(r.out).toMatch(/Expo uses what app\.config\.ts returns/);
    expect(r.out).toContain('"...config"');
    expect(r.out).toContain(`"${PLUGIN}"`);
    expect(read(dir, 'app.config.ts')).toBe(config);
  });

  it('a spread written only in a comment does not count', async () => {
    const dir = project(expoApp({ 'app.json': listed, 'app.config.ts': '// ...config\nexport default { name: "A" };\n' }, ALL_DEPS));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(2);
    expect(r.out).toMatch(/Expo uses what app\.config\.ts returns/);
  });

  it('app.json without the plugin keeps the plain manual step (SSF-02.3)', async () => {
    const dir = project(expoApp({ 'app.config.ts': spreads }, ALL_DEPS));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(2);
    expect(r.out).toContain('1 manual step left');
    expect(r.out).not.toMatch(/Expo uses what/);
  });

  it('an app.json that cannot be read is no proof: the plain manual step', async () => {
    const dir = project(expoApp({ 'app.json': '{ // c\n "expo": { "plugins": ["@espresso-notify/react-native"] } }', 'app.config.ts': spreads }, ALL_DEPS));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(2);
  });
});

describe('on Windows the command interpreter does not look for npx in the project folder (SSF-03.7)', () => {
  it('passes NoDefaultCurrentDirectoryInExePath=1, with the rest of the environment, to the process it starts', async () => {
    const env = { ComSpec: 'C:\\Windows\\System32\\cmd.exe', Path: 'C:\\Windows', npm_config_cache: 'C:\\Users\\João Silva\\cache' };
    const r = await run(['setup', '--yes'], project(expoApp()), { platform: 'win32', env });
    const options = r.spawn.mock.calls[0][2];

    expect(options.env).toEqual({ ...env, NoDefaultCurrentDirectoryInExePath: '1' });
    expect(options.shell).toBeFalsy();
  });

  it('does not change the environment of the caller', async () => {
    const env: Record<string, string> = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
    await run(['setup', '--yes'], project(expoApp()), { platform: 'win32', env });

    expect(env).toEqual({ ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
  });

  it('replaces a NoDefaultCurrentDirectoryInExePath that the environment set to something else', async () => {
    const r = await run(['setup', '--yes'], project(expoApp()), { platform: 'win32', env: { NoDefaultCurrentDirectoryInExePath: '0' } });

    expect(r.spawn.mock.calls[0][2].env.NoDefaultCurrentDirectoryInExePath).toBe('1');
  });

  it.each(['linux', 'darwin'])('%s: the process inherits the environment as it is (no env option)', async (platform) => {
    const r = await run(['setup', '--yes'], project(expoApp()), { platform, env: { PATH: '/usr/bin' } });

    expect(r.spawn.mock.calls[0][2]).not.toHaveProperty('env');
  });
});

describe('installEnvironment (SSF-03.7)', () => {
  it('on win32 drops a spelling of the name with other capitals, because Windows ignores case', () => {
    const { env } = wizard.installEnvironment('win32', { nodefaultcurrentdirectoryinexepath: '0', Path: 'C:\\Windows' });

    expect(env).toEqual({ Path: 'C:\\Windows', NoDefaultCurrentDirectoryInExePath: '1' });
  });

  it.each(['linux', 'darwin', 'freebsd'])('on %s it adds nothing', (platform) => {
    expect(wizard.installEnvironment(platform, { PATH: '/usr/bin' })).toEqual({});
  });
});

// ─── sdk-setup-fixes, iteration 3: the real `expo install` rewrites the config before the wizard does (SSF-02.17) ───────

/**
 * What `npx expo install` does to a config (`@expo/cli` `install/applyPlugins.js` -> `utils/modifyConfigPlugins.js`): after the
 * packages are in it adds the config plugins of the packages that have one to `app.json` / `app.config.json` and writes the
 * file again from the parsed object (comments, BOM, line endings, tabs, `1.0` and a key written twice are lost). This
 * replaces that write: `after` is the object Expo writes, 2 spaces and LF.
 */
const expoRewrites = (dir: string, name: string, after: object, closeCode?: number) => () => {
  installEverything(dir)();
  writeFileSync(join(dir, name), JSON.stringify(after, null, 2) + '\n');
};

/** Whether `after` is `before` with one piece of text added at one place and nothing else changed (byte for byte). */
function isOneInsertion(before: string, after: string): boolean {
  const a = Buffer.from(before, 'utf8');
  const b = Buffer.from(after, 'utf8');
  let prefix = 0;
  while (prefix < a.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  return prefix + suffix === a.length && b.length > a.length;
}

describe('Expo rewrites app.json during `expo install`: the wizard puts the file back and adds the plugins as text (SSF-02.17)', () => {
  const NOTIFICATIONS = 'expo-notifications';
  const HARD =
    '﻿{\r\n\t"expo": {\r\n\t\t"name": "Caf\\u00e9",\r\n\t\t"version": 1.0,\r\n\t\t"big": 12345678901234567890,\r\n\t\t"slug": "x",\r\n\t\t"slug": "y"\r\n\t}\r\n}\r\n';
  const hardAfter = { expo: { name: 'Café', version: 1, big: 12345678901234567000, slug: 'y', plugins: [NOTIFICATIONS, PLUGIN] } };

  it('a file with a BOM, CRLF, tabs, 1.0, a big integer, an escape and a repeated key: one insertion, every other byte as written, exit 0', async () => {
    const dir = project(expoApp({ 'app.json': HARD }));
    const r = await run(['setup', '--yes'], dir, { onInstall: expoRewrites(dir, 'app.json', hardAfter) });

    expect(r.code).toBe(0);
    const after = read(dir, 'app.json');
    expect(isOneInsertion(HARD, after)).toBe(true);
    for (const kept of ['﻿{\r\n\t"expo"', '1.0', '12345678901234567890', '\\u00e9', '"slug": "x"', '"slug": "y"']) expect(after).toContain(kept);
    expect(JSON.parse(after.replace(/^﻿/, '')).expo.plugins).toEqual([NOTIFICATIONS, PLUGIN]);
    expect(r.out).toMatch(/Expo rewrote app\.json/);
    expect(r.out).toMatch(/put your file back/);
    expect(r.out).toContain(`Added "${NOTIFICATIONS}", "${PLUGIN}" to expo.plugins in app.json`);
    expect(r.out).toMatch(/^Done\.$/m);
  });

  it('appends to a list that was already there: the plugins Expo added come after the entries of the person', async () => {
    const before = '{\n  "expo": {\n    "name": "A",\n    "plugins": [\n      "expo-router"\n    ]\n  }\n}\n';
    const dir = project(expoApp({ 'app.json': before }));
    const r = await run(['setup', '--yes'], dir, {
      onInstall: expoRewrites(dir, 'app.json', { expo: { name: 'A', plugins: ['expo-router', NOTIFICATIONS, PLUGIN] } }),
    });

    expect(r.code).toBe(0);
    expect(read(dir, 'app.json')).toBe(before.replace('"expo-router"', `"expo-router",\n      "${NOTIFICATIONS}",\n      "${PLUGIN}"`));
  });

  it('a file with comments: put back byte for byte, the manual step lists every plugin line, exit 2, never Done', async () => {
    const before = '{\n  // my app\n  "expo": {\n    "name": "A", // the name\n    "slug": "a"\n  }\n}\n';
    const dir = project(expoApp({ 'app.json': before }));
    const r = await run(['setup', '--yes'], dir, {
      onInstall: expoRewrites(dir, 'app.json', { expo: { name: 'A', slug: 'a', plugins: [NOTIFICATIONS, 'expo-localization', PLUGIN] } }),
    });

    expect(r.code).toBe(2);
    expect(read(dir, 'app.json')).toBe(before);
    expect(r.out).toMatch(/Expo rewrote app\.json/);
    expect(r.out).toContain('1 manual step left');
    const step = r.out.split('\n').find((line) => line.includes('manual step') === false && /^\s+- add /.test(line))!;
    for (const name of [NOTIFICATIONS, 'expo-localization', PLUGIN]) expect(step).toContain(`"${name}"`);
    expect(r.err).toMatch(/comments or a trailing comma/);
    expect(r.out).not.toMatch(/^Done\.$/m);
    expect(r.out).not.toContain('Nothing to change');
  });

  it('a file the wizard cannot extend (a repeated "expo"): put back, the manual step lists every plugin line, exit 2', async () => {
    const before = '{"expo":{"name":"a"},"expo":{"name":"b"}}';
    const dir = project(expoApp({ 'app.json': before }));
    const r = await run(['setup', '--yes'], dir, { onInstall: expoRewrites(dir, 'app.json', { expo: { name: 'b', plugins: [NOTIFICATIONS, PLUGIN] } }) });

    expect(r.code).toBe(2);
    expect(read(dir, 'app.json')).toBe(before);
    expect(r.out).toContain('1 manual step left');
    expect(r.out).toContain(`"${NOTIFICATIONS}"`);
    expect(r.out).toContain(`"${PLUGIN}"`);
  });

  it('JSON5 that the wizard cannot parse (unquoted keys): put back, lists only what Expo added, not the entries of the person', async () => {
    const before = "{ expo: { name: 'A', plugins: ['expo-router'] } }\n";
    const dir = project(expoApp({ 'app.json': before }));
    const r = await run(['setup', '--yes'], dir, {
      onInstall: expoRewrites(dir, 'app.json', { expo: { name: 'A', plugins: ['expo-router', NOTIFICATIONS, PLUGIN] } }),
    });

    expect(r.code).toBe(2);
    expect(read(dir, 'app.json')).toBe(before);
    expect(r.out).toContain(`"${NOTIFICATIONS}"`);
    expect(r.out).toContain(`"${PLUGIN}"`);
    expect(r.out).not.toContain('"expo-router"');
  });

  it('the plugin was already listed by the person: only the plugins Expo added are inserted, the wizard never doubles it', async () => {
    const before = `{\n  "expo": {\n    "name": "A",\n    "plugins": ["${PLUGIN}"]\n  }\n}\n`;
    const dir = project(expoApp({ 'app.json': before }, ALL_DEPS));
    // the packages are in package.json already, so the wizard does not run the install: nothing to put back
    const untouched = await run(['setup', '--yes'], dir);
    expect(untouched.out).toContain('Nothing to change');

    const dir2 = project(expoApp({ 'app.json': before }));
    const r = await run(['setup', '--yes'], dir2, {
      onInstall: expoRewrites(dir2, 'app.json', { expo: { name: 'A', plugins: [PLUGIN, NOTIFICATIONS] } }),
    });

    expect(r.code).toBe(0);
    expect(isOneInsertion(before, read(dir2, 'app.json'))).toBe(true);
    expect(JSON.parse(read(dir2, 'app.json')).expo.plugins).toEqual([PLUGIN, NOTIFICATIONS]);
  });

  it('Expo changed the bytes but added no plugin (it only reformatted): the file is put back and the wizard adds only its own plugin', async () => {
    const before = '{\r\n\t"expo": {\r\n\t\t"name": "A"\r\n\t}\r\n}\r\n';
    const dir = project(expoApp({ 'app.json': before }));
    const r = await run(['setup', '--yes'], dir, { onInstall: expoRewrites(dir, 'app.json', { expo: { name: 'A' } }) });

    expect(r.code).toBe(0);
    expect(read(dir, 'app.json')).toBe(before.replace('"A"', `"A",\r\n\t\t"plugins": [\r\n\t\t\t"${PLUGIN}"\r\n\t\t]`));
  });

  it('a failed `expo install` (exit 1, packages in) that rewrote the file: it is put back as well', async () => {
    const before = '{\n  // c\n  "expo": { "name": "A" }\n}\n';
    const dir = project(expoApp({ 'app.json': before }));
    const r = await run(['setup', '--yes'], dir, { closeCode: 1, onInstall: expoRewrites(dir, 'app.json', { expo: { name: 'A', plugins: [PLUGIN] } }) });

    expect(r.code).toBe(2);
    expect(read(dir, 'app.json')).toBe(before);
  });

  it('a failed `expo install` with a package missing still puts the file back before it stops', async () => {
    const before = '{\n  // c\n  "expo": { "name": "A" }\n}\n';
    const dir = project(expoApp({ 'app.json': before }));
    const r = await run(['setup', '--yes'], dir, {
      closeCode: 1,
      onInstall: () => writeFileSync(join(dir, 'app.json'), JSON.stringify({ expo: { name: 'A', plugins: [PLUGIN] } })),
    });

    expect(r.code).toBe(2);
    expect(r.err).toMatch(/did not finish/);
    expect(read(dir, 'app.json')).toBe(before);
  });

  it('app.config.json is the file Expo rewrites when both exist, and app.json is put back too if it changed', async () => {
    const config = '{\r\n\t"expo": {\r\n\t\t"name": "A",\r\n\t\t"v": 1.0\r\n\t}\r\n}\r\n';
    const plain = '{ "expo": { "name": "B", "v": 2.0 } }\n';
    const dir = project(expoApp({ 'app.config.json': config, 'app.json': plain }));
    const r = await run(['setup', '--yes'], dir, {
      onInstall: () => {
        expoRewrites(dir, 'app.config.json', { expo: { name: 'A', v: 1, plugins: [NOTIFICATIONS] } })();
        writeFileSync(join(dir, 'app.json'), '{}');
      },
    });

    expect(r.code).toBe(0);
    expect(isOneInsertion(config, read(dir, 'app.config.json'))).toBe(true);
    expect(JSON.parse(read(dir, 'app.config.json')).expo.plugins).toEqual([NOTIFICATIONS, PLUGIN]);
    expect(read(dir, 'app.json')).toBe(plain);
  });

  it('with an app.config.ts the JSON file is put back too, and the plugin stays a manual step', async () => {
    const before = '{\n  // c\n  "expo": { "name": "A" }\n}\n';
    const dir = project(expoApp({ 'app.json': before, 'app.config.ts': 'export default {}\n' }));
    const r = await run(['setup', '--yes'], dir, { onInstall: expoRewrites(dir, 'app.json', { expo: { name: 'A', plugins: [NOTIFICATIONS] } }) });

    expect(r.code).toBe(2);
    expect(read(dir, 'app.json')).toBe(before);
    expect(r.out).toContain('1 manual step left');
  });

  it('when Expo leaves the bytes alone, the wizard says nothing about a rewrite', async () => {
    const dir = project(expoApp());
    const r = await run(['setup', '--yes'], dir, { onInstall: installEverything(dir) });

    expect(r.code).toBe(0);
    expect(r.all).not.toMatch(/Expo rewrote/);
    expect(JSON.parse(read(dir, 'app.json')).expo.plugins).toEqual([PLUGIN]);
  });
});

// ─── sdk-setup-fixes, iteration 3: a `...config` that is not a plain spread is not a proof (SSF-02.16, GAP-B) ──────────

describe('a spread of config that may still drop the plugins of app.json asks to check the file (SSF-02.16)', () => {
  const listed = { expo: { name: 'A', slug: 'a', plugins: [PLUGIN], extra: { eas: { projectId: 'x' } } } };
  const success = /already set up|Nothing to change|^Done\.$|: nothing to add|passes it on \(it spreads/m;

  it.each([
    ['plugins set after the spread', 'export default ({ config }) => ({ ...config, plugins: ["expo-router"] });\n'],
    ['plugins set as a string key', 'export default ({ config }) => ({ ...config, "plugins": [] });\n'],
    ['plugins built from config.plugins', 'export default ({ config }) => ({ ...config, plugins: [...(config.plugins ?? []), "x"] });\n'],
    ['a spread of config.expo', 'export default ({ config }) => ({ ...config.expo, name: "A" });\n'],
    ['a spread of config.plugins', 'export default ({ config }) => ({ name: "A", ...config.plugins });\n'],
    ['a config that is not the parameter', 'const config = { name: "A" };\nexport default { ...config };\n'],
    ['a call spread, not an object spread', 'export default ({ config }) => build(...config);\n'],
  ])('%s: the closing asks to check the file, never says it is set up, exit 0', async (_label, code) => {
    const dir = project(expoApp({ 'app.json': listed, 'app.config.ts': code }, ALL_DEPS));
    const before = snapshot(dir);
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Check that app\.config\.ts keeps "@espresso-notify\/react-native"/);
    expect(r.out).toContain('"plugins"');
    expect(r.out).not.toMatch(success);
    expect(r.out).not.toContain('manual step');
    expect(snapshot(dir)).toEqual(before);
  });

  it.each([
    ['a string', 'export default { name: "...config" };\n'],
    ['a single-quoted string', "export default { name: '...config' };\n"],
    ['a template', 'export default { name: `...config` };\n'],
    ['a comment', '/* ...config */\nexport default { name: "A" };\n'],
  ])('a "...config" written only in %s is no spread: the manual step explains the precedence, exit 2', async (_label, code) => {
    const dir = project(expoApp({ 'app.json': listed, 'app.config.ts': code }, ALL_DEPS));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(2);
    expect(r.out).toContain('1 manual step left');
    expect(r.out).toMatch(/Expo uses what app\.config\.ts returns/);
    expect(r.out).not.toMatch(success);
  });

  it.each([
    ['an arrow function with a destructured parameter', 'export default ({ config }) => ({ ...config, name: "A" });\n'],
    ['a typed arrow function', 'export default ({ config }: ConfigContext): ExpoConfig => ({ ...config, name: "A" });\n'],
    ['a plain parameter', 'export default (config) => ({ ...config, name: "A" });\n'],
    ['a function declaration', 'module.exports = function ({ config }) { return { ...config, name: "A" }; };\n'],
    ['a spread after other keys', 'export default ({ config }) => ({ name: "A", ...config });\n'],
    ['a plugins word only in a comment', '// plugins come from app.json\nexport default ({ config }) => ({ ...config });\n'],
    // GAP-G: spreads that look right and can still lose the plugins of app.json, which nothing in the text tells
    ['two spreads', 'const base = { name: "A" };\nexport default ({ config }) => ({ ...config, ...base });\n'],
    ['a spread into a variable that is never returned', 'export default ({ config }) => { const merged = { ...config, name: "A" }; return { name: "B" }; };\n'],
    ['a spread in one branch only', 'export default ({ config }) => (process.env.CI ? { ...config, name: "A" } : { name: "B" });\n'],
    ['a config that is a constant while the parameter has another name', 'const config = { name: "A" };\nexport default ({ config: app }) => ({ ...config, name: app.name });\n'],
  ])('%s with a spread of config: the plugin is never claimed, the closing asks to check the file, exit 0 (GAP-G)', async (_label, code) => {
    const dir = project(expoApp({ 'app.json': listed, 'app.config.ts': code }, ALL_DEPS));
    const before = snapshot(dir);
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(0);
    expect(r.out).toContain('app.json lists the plugin');
    expect(r.out).toMatch(/Finished what the wizard can do\. Check that app\.config\.ts keeps "@espresso-notify\/react-native"/);
    expect(r.out).not.toMatch(success);
    expect(r.out).not.toMatch(/already set up|Nothing to change|^Done\.$/m);
    expect(r.out).not.toContain('manual step');
    expect(snapshot(dir)).toEqual(before);
  });
});

// ─── sdk-setup-fixes, iteration 3: any "expo" that is not an object is a manual step (SSF-02.13, GAP-C) ─────────────────

describe('an "expo" that is false, 0, an empty string or any other value that is not an object (SSF-02.13)', () => {
  it.each([
    ['false', '{"expo":false,"name":"flat"}'],
    ['0', '{"expo":0}'],
    ['an empty string', '{"expo":""}'],
    ['true', '{"expo":true}'],
    ['a number', '{"expo":7}'],
    ['false and a root that already lists the plugin', `{"expo":false,"plugins":["${PLUGIN}"]}`],
    ['a list and a root that already lists the plugin', `{"expo":[],"plugins":["${PLUGIN}"]}`],
  ])('%s: file intact, says why, prints the line, "1 manual step left", exit 2, never "Done" or "already lists"', async (_label, text) => {
    const dir = project(expoApp({ 'app.json': text }));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(2);
    expect(read(dir, 'app.json')).toBe(text);
    expect(r.err).toMatch(/"expo".*not an object/);
    expect(r.all).toContain(`"${PLUGIN}"`);
    expect(r.out).toContain('1 manual step left');
    expect(r.out).not.toMatch(/^Done\.$/m);
    expect(r.out).not.toContain('Nothing to change');
    expect(r.out).not.toContain('already lists');
  });

  it('--dry-run ends with 2 for them as well', async () => {
    const dir = project(expoApp({ 'app.json': '{"expo":false}' }));
    const r = await run(['setup', '--dry-run'], dir);

    expect(r.code).toBe(2);
    expect(read(dir, 'app.json')).toBe('{"expo":false}');
  });

  it('next to an app.config.ts that spreads config, a root list does not count as proof when "expo" is false', async () => {
    const dir = project(expoApp({
      'app.json': `{"expo":false,"plugins":["${PLUGIN}"]}`,
      'app.config.ts': 'export default ({ config }) => ({ ...config, name: "A" });\n',
    }, ALL_DEPS));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(2);
    expect(r.out).toContain('1 manual step left');
    expect(r.out).not.toMatch(/passes it on|nothing to add/);
  });

  it('"expo": null is still read at the root, where Expo reads it', async () => {
    const dir = project(expoApp({ 'app.json': '{"expo":null,"name":"flat"}' }));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(0);
    expect(read(dir, 'app.json')).toBe(`{"expo":null,"name":"flat","plugins":["${PLUGIN}"]}`);
  });
});

// ─── sdk-setup-fixes, iteration 3: a config that is not UTF-8 is never written (SSF-02.18, GAP-D) ───────────────────────

describe('an app.json that is not valid UTF-8 is left alone, byte for byte (SSF-02.18)', () => {
  const WINDOWS_1252 = Buffer.concat([Buffer.from('{"expo":{"name":"Caf'), Buffer.from([0xe9]), Buffer.from('","slug":"a"}}\r\n')]);
  const UTF_16 = Buffer.from('﻿{"expo":{"name":"A"}}', 'utf16le');

  const withBytes = (bytes: Buffer, extra: Files = {}) => {
    const dir = project(expoApp(extra));
    writeFileSync(join(dir, 'app.json'), bytes);
    return dir;
  };

  it.each([
    ['a legacy Windows code page (e-acute as the byte E9)', WINDOWS_1252],
    ['UTF-16 with a byte order mark (what PowerShell 5 writes)', UTF_16],
    ['a lone continuation byte', Buffer.concat([Buffer.from('{"expo":{"name":"a'), Buffer.from([0x80]), Buffer.from('b"}}')])],
  ])('%s: bytes unchanged, says it is not UTF-8, prints the line, "1 manual step left", exit 2, never "Done"', async (_label, bytes) => {
    const dir = withBytes(bytes);
    const r = await run(['setup', '--yes'], dir);

    expect(readFileSync(join(dir, 'app.json')).equals(bytes)).toBe(true);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/not (saved as )?(valid )?UTF-8/);
    expect(r.all).toContain(`"${PLUGIN}"`);
    expect(r.out).toContain('1 manual step left');
    expect(r.out).not.toMatch(/^Done\.$/m);
    expect(r.out).not.toContain('Nothing to change');
    expect(r.out).toMatch(/was not read/);
  });

  it('--dry-run ends with 2 and writes nothing', async () => {
    const dir = withBytes(WINDOWS_1252);
    const r = await run(['setup', '--dry-run'], dir);

    expect(r.code).toBe(2);
    expect(readFileSync(join(dir, 'app.json')).equals(WINDOWS_1252)).toBe(true);
  });

  it('valid UTF-8 with accents, a byte order mark and an emoji is edited: one insertion, the same bytes around it', async () => {
    const before = '﻿{\r\n  "expo": {\r\n    "name": "Café 日本 🚀"\r\n  }\r\n}\r\n';
    const dir = project(expoApp({ 'app.json': before }));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(0);
    expect(isOneInsertion(before, read(dir, 'app.json'))).toBe(true);
    expect(read(dir, 'app.json')).toContain('Café 日本 🚀');
  });

  it('a file that already holds U+FFFD written as UTF-8 is valid UTF-8 and is edited', async () => {
    const before = '{"expo":{"name":"a�b"}}';
    const dir = project(expoApp({ 'app.json': before }));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(0);
    expect(read(dir, 'app.json')).toBe(`{"expo":{"name":"a�b","plugins":["${PLUGIN}"]}}`);
  });

  it('after an `expo install` that rewrote it (and damaged the bytes): the original bytes are back and the manual step lists what Expo added', async () => {
    const dir = withBytes(WINDOWS_1252);
    const r = await run(['setup', '--yes'], dir, {
      onInstall: () => {
        installEverything(dir)();
        writeFileSync(join(dir, 'app.json'), JSON.stringify({ expo: { name: 'Caf�', slug: 'a', plugins: ['expo-localization', PLUGIN] } }));
      },
    });

    expect(readFileSync(join(dir, 'app.json')).equals(WINDOWS_1252)).toBe(true);
    expect(r.code).toBe(2);
    expect(r.out).toContain('"expo-localization"');
    expect(r.out).toContain(`"${PLUGIN}"`);
    expect(r.out).toContain('1 manual step left');
  });
});

// ─── sdk-setup-fixes, iteration 3: the two mutants that survived (M1, M30) ──────────────────────────────────────────────

describe('the check after the insertion refuses a result that is not the original plus the plugin (SSF-02.12, M1)', () => {
  /** The real reader of positions, with the end of the last member of "expo" moved to `place(body)`. */
  const misplaced = (place: (body: string, root: any) => number) => (body: string) => {
    const root = wizard.scanJson(body);
    const members = root.members.find((member: any) => member.key === 'expo').value.members;
    members[members.length - 1].value.end = place(body, root);
    return root;
  };

  it('a position inside a string: the result is not JSON, so there is a problem and no text', () => {
    const text = '{"expo":{"name":"A"}}';
    const result = wizard.addPluginsToJsonText(text, [PLUGIN], misplaced((body) => body.indexOf('"A"') + 1));

    expect(result.text).toBeUndefined();
    expect(result.problem).toMatch(/layout the wizard cannot extend/);
  });

  it('a position that gives valid JSON with the plugin in the wrong object: there is a problem and no text', () => {
    const text = '{"expo":{"name":"A"},"b":1}';
    const result = wizard.addPluginsToJsonText(text, [PLUGIN], misplaced((body) => body.lastIndexOf('1') + 1));

    expect(JSON.parse(text.slice(0, text.lastIndexOf('1') + 1) + `,"plugins":["${PLUGIN}"]}`).plugins).toEqual([PLUGIN]); // it would have been valid JSON
    expect(result.text).toBeUndefined();
    expect(result.problem).toMatch(/layout the wizard cannot extend/);
  });

  it('with the real reader the same texts are edited', () => {
    expect(wizard.addPluginsToJsonText('{"expo":{"name":"A"}}').text).toBe(`{"expo":{"name":"A","plugins":["${PLUGIN}"]}}`);
    expect(wizard.addPluginsToJsonText('{"expo":{"name":"A"},"b":1}').text).toBe(`{"expo":{"name":"A","plugins":["${PLUGIN}"]},"b":1}`);
  });
});

describe('the explanation line of the precedence step is printed (SSF-02.16, M30)', () => {
  const listed = { expo: { name: 'A', slug: 'a', plugins: [PLUGIN], extra: { eas: { projectId: 'x' } } } };

  it.each([['app.json', 'app.config.ts'], ['app.config.json', 'app.config.js']])('%s lists the plugin and %s does not pass it on: the line says so before the manual step', async (json, code) => {
    const dir = project(expoApp({ [json]: listed, [code]: 'export default { name: "A", slug: "a" };\n' }, ALL_DEPS));
    const r = await run(['setup', '--yes'], dir);

    expect(r.code).toBe(2);
    expect(r.out).toContain(`${json} lists the plugin, but Expo uses what ${code} returns, and ${code} does not seem to pass ${json} on (it has no "...config").`);
    expect(r.out.indexOf('does not seem to pass')).toBeLessThan(r.out.indexOf('1 manual step left'));
  });
});

// ─── sdk-setup-fixes, iteration 4: a link and the permissions of app.json survive `expo install` (SSF-02.17, GAP-F) ───────

const unixOnly = process.platform === 'win32' ? describe.skip : describe;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realFs = require('fs');
const eperm = (what: string) => Object.assign(new Error(`EPERM: operation not permitted, ${what}`), { code: 'EPERM' });

unixOnly('Expo replaces a link or changes the permissions of app.json while it installs: the wizard puts both back (SSF-02.17, GAP-F)', () => {
  const ORIGINAL = '{\n  "expo": {\n    "name": "A",\n    "slug": "a"\n  }\n}\n';
  const NOTIFICATIONS = 'expo-notifications';
  /** What Expo writes into app.json when it installs: our package is in package.json, so it adds both plugins. */
  const expoWrites = { expo: { name: 'A', slug: 'a', plugins: [NOTIFICATIONS, PLUGIN] } };
  const mode = (dir: string, name: string) => statSync(join(dir, name)).mode & 0o777;

  /** Expo writes the file again through a temporary file and a rename: the path ends as a new regular file, mode 0644, and a link is gone. */
  const expoReplaces = (dir: string, name = 'app.json') => () => {
    installEverything(dir)();
    rmSync(join(dir, name), { force: true });
    writeFileSync(join(dir, name), JSON.stringify(expoWrites, null, 2) + '\n');
    chmodSync(join(dir, name), 0o644);
  };

  /** A project whose app.json is a link to shared/app.json (the text of the link is `linkText`). */
  function linked(linkText = 'shared/app.json') {
    const dir = project({ 'package.json': { name: 'app', dependencies: { expo: '~57.0.26' } }, 'shared/app.json': ORIGINAL });
    symlinkSync(linkText, join(dir, 'app.json'));
    return dir;
  }

  it('a link that Expo replaced by a regular file comes back as the same link, and the plugins go into the file it points to', async () => {
    const dir = linked();
    chmodSync(join(dir, 'shared', 'app.json'), 0o600);
    const r = await run(['setup', '--yes'], dir, { onInstall: expoReplaces(dir) });

    expect(r.code).toBe(0);
    expect(lstatSync(join(dir, 'app.json')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, 'app.json'))).toBe('shared/app.json');
    const shared = read(dir, 'shared/app.json');
    expect(isOneInsertion(ORIGINAL, shared)).toBe(true);
    expect(JSON.parse(shared).expo.plugins).toEqual([NOTIFICATIONS, PLUGIN]);
    expect(mode(dir, 'shared/app.json')).toBe(0o600);
    expect(r.out).toMatch(/Expo rewrote app\.json/);
    expect(r.out).toMatch(/put your file back as you wrote it/);
    expect(r.out).toMatch(/^Done\.$/m);
    expect(r.out).not.toContain('manual step');
  });

  it('a link with another spelling (./ and ..) comes back with the text it had', async () => {
    const dir = linked('./shared/../shared/app.json');
    const r = await run(['setup', '--yes'], dir, { onInstall: expoReplaces(dir) });

    expect(r.code).toBe(0);
    expect(readlinkSync(join(dir, 'app.json'))).toBe('./shared/../shared/app.json');
    expect(isOneInsertion(ORIGINAL, read(dir, 'shared/app.json'))).toBe(true);
  });

  it('Expo writes through the link (the link stays): the file it points to gets the bytes back and then the plugins', async () => {
    const dir = linked();
    const r = await run(['setup', '--yes'], dir, {
      onInstall: () => {
        installEverything(dir)();
        writeFileSync(join(dir, 'app.json'), JSON.stringify(expoWrites, null, 2) + '\n');
      },
    });

    expect(r.code).toBe(0);
    expect(lstatSync(join(dir, 'app.json')).isSymbolicLink()).toBe(true);
    expect(isOneInsertion(ORIGINAL, read(dir, 'shared/app.json'))).toBe(true);
  });

  it('a link to a read-only file (0444) comes back as the link, the unchanged target is not written, and the plugin line is a manual step, not a crash (GAP-K)', async () => {
    const dir = linked();
    chmodSync(join(dir, 'shared', 'app.json'), 0o444);
    const r = await run(['setup', '--yes'], dir, { onInstall: expoReplaces(dir) });

    // the target is the file Expo did not touch: putting the link back must not write a file that already has the bytes
    expect(r.all).not.toContain('The wizard stopped');
    expect(lstatSync(join(dir, 'app.json')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, 'app.json'))).toBe('shared/app.json');
    expect(mode(dir, 'shared/app.json')).toBe(0o444);
    expect(readdirSync(dir).filter((name) => name.includes('espresso'))).toEqual([]);
    if (!isRoot) {
      expect(r.code).toBe(2);
      expect(read(dir, 'shared/app.json')).toBe(ORIGINAL);
      expect(r.err).toMatch(/app\.json could not be written \(EACCES\)/);
      expect(r.out).toContain('1 manual step left');
      expect(r.out).toContain(`"${NOTIFICATIONS}", "${PLUGIN}"`);
      expect(r.out).not.toMatch(/^Done\.$/m);
    }
  });

  it('the permissions come back: 0600 after Expo wrote the file with 0644', async () => {
    const dir = project(expoApp({ 'app.json': ORIGINAL }));
    chmodSync(join(dir, 'app.json'), 0o600);
    const r = await run(['setup', '--yes'], dir, { onInstall: expoReplaces(dir) });

    expect(r.code).toBe(0);
    expect(mode(dir, 'app.json')).toBe(0o600);
    expect(isOneInsertion(ORIGINAL, read(dir, 'app.json'))).toBe(true);
    expect(r.out).toMatch(/put your file back as you wrote it/);
  });

  it('a read-only app.json (0444) comes back read-only, and the plugin line is a manual step, not a crash', async () => {
    const dir = project(expoApp({ 'app.json': ORIGINAL }));
    chmodSync(join(dir, 'app.json'), 0o444);
    const r = await run(['setup', '--yes'], dir, { onInstall: expoReplaces(dir) });

    expect(mode(dir, 'app.json')).toBe(0o444);
    expect(r.all).not.toContain('The wizard stopped');
    if (!isRoot) {
      // a user who is not root cannot write a read-only file: the bytes are the ones the person wrote
      expect(r.code).toBe(2);
      expect(read(dir, 'app.json')).toBe(ORIGINAL);
      expect(r.err).toMatch(/app\.json could not be written \(EACCES\)/);
      expect(r.out).toContain('1 manual step left');
      expect(r.out).toContain(`"${NOTIFICATIONS}", "${PLUGIN}"`);
      expect(r.out).not.toMatch(/^Done\.$/m);
    }
  });

  it('a read-only app.json with the packages already installed is the same manual step (no install ran)', async () => {
    const dir = project(expoApp({ 'app.json': ORIGINAL }, ALL_DEPS));
    chmodSync(join(dir, 'app.json'), 0o444);
    const r = await run(['setup', '--yes'], dir);

    expect(r.all).not.toContain('The wizard stopped');
    expect(mode(dir, 'app.json')).toBe(0o444);
    if (!isRoot) {
      expect(r.code).toBe(2);
      expect(read(dir, 'app.json')).toBe(ORIGINAL);
      expect(r.out).toContain('1 manual step left');
    }
  });

  it('--dry-run on a read-only app.json ends with 2 like the real run: no "Would add", the same manual step, nothing written (GAP-I)', async () => {
    const dir = project(expoApp({ 'app.json': ORIGINAL }, ALL_DEPS));
    chmodSync(join(dir, 'app.json'), 0o444);
    const dry = await run(['setup', '--dry-run'], dir);

    expect(dry.all).not.toContain('The wizard stopped');
    expect(mode(dir, 'app.json')).toBe(0o444);
    expect(read(dir, 'app.json')).toBe(ORIGINAL);
    if (!isRoot) {
      const real = await run(['setup', '--yes'], project(expoApp({ 'app.json': ORIGINAL }, ALL_DEPS)));
      expect(real.code).toBe(0); // the control: the same project, writable, is fine
      expect(dry.code).toBe(2);
      expect(dry.err).toMatch(/app\.json could not be written \(EACCES\)/);
      expect(dry.err).toContain(`"${PLUGIN}"`);
      expect(dry.out).not.toMatch(/Would add/);
      expect(dry.out).toContain('Dry run: nothing was changed.');
    }
  });

  it('--dry-run asks the file system whether app.json can be written, and a refusal is the same manual step as in a real run (also as root)', async () => {
    const dir = project(expoApp({ 'app.json': ORIGINAL }, ALL_DEPS));
    const refuse = { ...realFs, accessSync: () => { throw Object.assign(new Error('EACCES: permission denied, access'), { code: 'EACCES' }); } };
    const dry = await run(['setup', '--dry-run'], dir, { fs: refuse });

    expect(dry.code).toBe(2);
    expect(dry.err).toMatch(/app\.json could not be written \(EACCES\)/);
    expect(dry.out).not.toMatch(/Would add/);
    expect(read(dir, 'app.json')).toBe(ORIGINAL);
  });

  it('when the link cannot be made again (EPERM) the file holds your bytes plus the plugins, the link target is untouched, and the message says what changed', async () => {
    // A BOM, CRLF, tabs and `1.0`: the text the fake Expo writes (2 spaces, LF, no BOM, no "version") is different, so only
    // putting the bytes back keeps them (GAP-J: without the put-back the file would hold what Expo wrote).
    const LINKED = '\uFEFF{\r\n\t"expo": {\r\n\t\t"name": "A",\r\n\t\t"version": 1.0\r\n\t}\r\n}\r\n';
    const dir = project({ 'package.json': { name: 'app', dependencies: { expo: '~57.0.26' } }, 'shared/app.json': LINKED });
    symlinkSync('shared/app.json', join(dir, 'app.json'));
    const r = await run(['setup', '--yes'], dir, {
      onInstall: expoReplaces(dir),
      fs: { ...realFs, symlinkSync: () => { throw eperm('symlink'); } },
    });

    expect(lstatSync(join(dir, 'app.json')).isSymbolicLink()).toBe(false);
    const after = read(dir, 'app.json');
    expect(isOneInsertion(LINKED, after)).toBe(true);
    expect(after.startsWith('\uFEFF{\r\n\t"expo"')).toBe(true);
    expect(after).toContain('"version": 1.0');
    expect(JSON.parse(after.replace(/^\uFEFF/, '')).expo.plugins).toEqual([NOTIFICATIONS, PLUGIN]);
    expect(read(dir, 'shared/app.json')).toBe(LINKED);
    expect(existsSync(join(dir, 'app.json.espresso-tmp'))).toBe(false);
    expect(r.out).not.toMatch(/as you wrote it/);
    expect(r.out).toContain('app.json was a link to shared/app.json and is a regular file now');
    expect(r.out).toContain('EPERM');
    expect(r.code).toBe(2);
    expect(r.out).toContain('1 manual step left');
    const steps = r.out.slice(r.out.indexOf('1 manual step left'));
    expect(steps).toContain('app.json is a regular file now, not the link to shared/app.json it was');
    expect(r.out).not.toMatch(/^Done\.$/m);
    expect(readdirSync(dir).filter((name) => name.includes('espresso'))).toEqual([]);
  });

  it('when the permissions cannot be set again the message says which they are, and the closing asks to check them (exit 0)', async () => {
    const dir = project(expoApp({ 'app.json': ORIGINAL }));
    chmodSync(join(dir, 'app.json'), 0o600);
    const r = await run(['setup', '--yes'], dir, {
      onInstall: expoReplaces(dir),
      fs: { ...realFs, chmodSync: () => { throw eperm('chmod'); } },
    });

    expect(r.code).toBe(0);
    expect(mode(dir, 'app.json')).toBe(0o644);
    expect(isOneInsertion(ORIGINAL, read(dir, 'app.json'))).toBe(true);
    expect(r.out).not.toMatch(/as you wrote it/);
    expect(r.out).toContain('the permissions of app.json are 644 instead of 600');
    expect(r.out).toContain('EPERM');
    expect(r.out).toMatch(/Finished what the wizard can do\. Check the permissions of app\.json/);
    expect(r.out).not.toMatch(/^Done\.$/m);
  });

  it('a config that is not a link and has the mode it had is put back as before, with the same words', async () => {
    const dir = project(expoApp({ 'app.json': ORIGINAL }));
    const r = await run(['setup', '--yes'], dir, { onInstall: expoReplaces(dir) });

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Expo rewrote app\.json on its own/);
    expect(r.out).toMatch(/put your file back as you wrote it/);
  });
});

// ─── sdk-setup-fixes, iteration 4: the S8 mutant (a config deleted during the install is put back) ───────────────────────

describe('a config that disappears while `expo install` runs comes back (SSF-02.17, S8)', () => {
  const ORIGINAL = '﻿{\r\n\t"expo": {\r\n\t\t"name": "A",\r\n\t\t"version": 1.0\r\n\t}\r\n}\r\n';

  it.each(['app.json', 'app.config.json'])('%s deleted by the process: back with the bytes it had plus one insertion of the plugin, exit 0, and the message says it was gone', async (name) => {
    const dir = project(expoApp({ [name]: ORIGINAL }));
    const r = await run(['setup', '--yes'], dir, {
      onInstall: () => {
        installEverything(dir)();
        rmSync(join(dir, name));
      },
    });

    expect(r.code).toBe(0);
    expect(existsSync(join(dir, name))).toBe(true);
    const after = read(dir, name);
    expect(isOneInsertion(ORIGINAL, after)).toBe(true);
    expect(after.startsWith('﻿{\r\n\t"expo"')).toBe(true);
    expect(after).toContain('"version": 1.0');
    expect(JSON.parse(after.replace(/^﻿/, '')).expo.plugins).toEqual([PLUGIN]);
    expect(r.out).toContain(`${name} was gone after \`expo install\`. The wizard put it back as you wrote it`);
    expect(r.out).not.toMatch(/Expo rewrote/);
    expect(r.out).toMatch(/^Done\.$/m);
  });
});

unixOnly('a symbolic link that disappears while `expo install` runs comes back as the link (S8)', () => {
  const ORIGINAL = '{\n  "expo": {\n    "name": "A"\n  }\n}\n';

  it('the link is made again and the plugin goes into the file it points to', async () => {
    const dir = project({ 'package.json': { name: 'app', dependencies: { expo: '~57.0.26' } }, 'shared/app.json': ORIGINAL });
    symlinkSync('shared/app.json', join(dir, 'app.json'));
    const r = await run(['setup', '--yes'], dir, {
      onInstall: () => {
        installEverything(dir)();
        rmSync(join(dir, 'app.json'));
      },
    });

    expect(r.code).toBe(0);
    expect(lstatSync(join(dir, 'app.json')).isSymbolicLink()).toBe(true);
    expect(isOneInsertion(ORIGINAL, read(dir, 'shared/app.json'))).toBe(true);
  });
});
