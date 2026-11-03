/**
 * @jest-environment node
 *
 * setup-wizard-bare-rn T8 (SWB-01, SWB-02, SWB-03, SWB-07): `runBare`, the flow of the setup wizard for React Native CLI
 * apps. Every test works in a temporary app folder built from the real template files of React Native 0.87.1 and 0.79.7,
 * and replaces `spawn`: no package manager ever runs here.
 */
import { execFileSync, spawnSync as realSpawnSync } from 'child_process';
import { EventEmitter } from 'events';
import fs, { chmodSync, cpSync, renameSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { FIXTURE_ROOT, fixture, onlyAddsLines } from './helpers/bare-fixtures';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runBare, shellPath, WINDOWS_UNSAFE } = require('../bin/lib/bare.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { firebaseMajorFor, MIN_REACT_NATIVE_MINOR } = require('../bin/lib/versions.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const setup = require('../bin/setup.js');

const helpers = {
  makePrompter: setup.makePrompter,
  Stop: setup.Stop,
  installEnvironment: setup.installEnvironment,
  hookSnippet: setup.hookSnippet,
  PLACEHOLDER_KEY: setup.PLACEHOLDER_KEY,
  BARE_GUIDE: setup.BARE_GUIDE,
};

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const ALL_PACKAGES = ['@espresso-notify/react-native', '@react-native-firebase/app', '@react-native-firebase/messaging', 'react-native-notify-kit'];

type AppOptions = {
  version?: string;
  /** react-native range in package.json; defaults to the template's */
  range?: string;
  /** write node_modules/react-native/package.json with this version (the default is `version`); null to leave it out */
  installed?: string | null;
  deps?: Record<string, string>;
  lock?: string | null;
  ios?: boolean;
  android?: boolean;
};

/** An app folder made of the template files of `version`, with the packages in `deps` already in package.json. */
function app(opts: AppOptions = {}): string {
  const version = opts.version ?? '0.87.1';
  const fixtureVersion = version.startsWith('0.79') ? '0.79.7' : '0.87.1';
  const dir = mkdtempSync(join(tmpdir(), 'espresso-bare-'));
  dirs.push(dir);
  const pkg = JSON.parse(fixture(fixtureVersion, 'package.json'));
  pkg.dependencies['react-native'] = opts.range ?? version;
  Object.assign(pkg.dependencies, opts.deps ?? {});
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  const installed = opts.installed === undefined ? version : opts.installed;
  if (installed) {
    mkdirSync(join(dir, 'node_modules', 'react-native'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'react-native', 'package.json'), JSON.stringify({ name: 'react-native', version: installed }));
  }
  const lock = opts.lock === undefined ? null : opts.lock;
  if (lock) writeFileSync(join(dir, lock), '');
  const copy = (rel: string) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    cpSync(join(FIXTURE_ROOT, fixtureVersion, rel), join(dir, rel));
  };
  if (opts.ios !== false) {
    copy('ios/Podfile');
    copy('ios/HelloWorld/AppDelegate.swift');
    mkdirSync(join(dir, 'ios', 'HelloWorld.xcodeproj'), { recursive: true });
  }
  if (opts.android !== false) {
    copy('android/build.gradle');
    copy('android/app/build.gradle');
    copy('android/app/src/main/AndroidManifest.xml');
  }
  return dir;
}

/** Every file under `dir` with its content, to prove what changed. */
function snapshot(dir: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result[`${rel}/`] = '';
      Object.assign(result, snapshot(dir, rel));
    } else result[rel] = readFileSync(join(dir, rel), 'utf8');
  }
  return result;
}

/** What a real install does to package.json: the four packages are listed afterwards. */
function installPackages(dir: string) {
  const file = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  for (const name of ALL_PACKAGES) pkg.dependencies[name] = '^26.0.0';
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}

const BACKUP = '.espresso-notify-backup';
const STAMP = '20261023T100000';
/** The files the wizard copied: everything under the backup folder, as a path from the app folder. */
const backups = (dir: string) => Object.keys(snapshot(dir)).filter((name) => name.startsWith(`${BACKUP}/`) && !name.endsWith('/'));
/** The `.bak` files left next to a native file: the wizard no longer makes any. */
const bakFiles = (dir: string) => Object.keys(snapshot(dir)).filter((name) => /\.bak$/.test(name));
/** The answer of a folder that is not a git work tree. */
const noGit = () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository' });

type RunOptions = {
  closeCode?: number;
  spawnError?: Error;
  stdin?: string;
  tty?: boolean;
  platform?: string;
  env?: Record<string, string | undefined>;
  onInstall?: () => void;
  fs?: any;
  /** the `spawnSync` that answers the git questions; the default is a folder that is not a git work tree */
  spawnSync?: (...args: any[]) => any;
};

async function run(flags: Partial<{ dryRun: boolean; yes: boolean; key: string; pods: boolean }>, cwd: string, opts: RunOptions = {}) {
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
  const spawnSync = jest.fn(opts.spawnSync ?? noGit);
  const stdin = new PassThrough();
  if (opts.stdin !== undefined) stdin.end(opts.stdin);
  const code: number = await runBare(
    { dryRun: false, yes: false, ...flags },
    {
      cwd,
      spawn,
      spawnSync,
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      stdin,
      isTTY: opts.tty ?? false,
      platform: opts.platform ?? 'linux',
      env: opts.env ?? {},
      now: () => new Date(2026, 9, 23, 10, 0, 0),
      ...(opts.fs ? { fs: opts.fs } : {}),
    },
    helpers,
  );
  return { code, out: out.join(''), err: err.join(''), all: out.join('') + err.join(''), spawn, spawnSync };
}

describe('the table of Firebase versions', () => {
  it('maps React Native 0.80 and newer to the major 26 and 0.79 to the major 25', () => {
    expect(firebaseMajorFor({ major: 0, minor: 87 })).toBe(26);
    expect(firebaseMajorFor({ major: 0, minor: 80 })).toBe(26);
    expect(firebaseMajorFor({ major: 0, minor: 79 })).toBe(25);
    expect(firebaseMajorFor({ major: 1, minor: 0 })).toBe(26);
  });

  it('has no major below the floor of the SDK', () => {
    expect(MIN_REACT_NATIVE_MINOR).toBe(79);
    expect(firebaseMajorFor({ major: 0, minor: 78 })).toBeNull();
  });
});

describe('what the flow refuses (exit 1, nothing written)', () => {
  it('React Native 0.78 is below the floor', async () => {
    const dir = app({ version: '0.78.2' });
    const before = snapshot(dir);
    const result = await run({ yes: true }, dir);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/0\.78/);
    expect(result.err).toMatch(/0\.79/);
    expect(result.spawn).not.toHaveBeenCalled();
    expect(snapshot(dir)).toEqual(before);
  });

  it('a version that cannot be read from the range (and is not installed) is refused with the way out', async () => {
    const dir = app({ range: 'latest', installed: null });
    const before = snapshot(dir);
    const result = await run({ yes: true }, dir);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/React Native version/);
    expect(result.spawn).not.toHaveBeenCalled();
    expect(snapshot(dir)).toEqual(before);
  });

  it('a folder without package.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'espresso-bare-'));
    dirs.push(dir);
    const result = await run({ yes: true }, dir);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/package\.json/);
  });

  it('a project without react-native', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'espresso-bare-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '19.0.0' } }));
    const result = await run({ yes: true }, dir);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/react-native/);
  });

  it('a no at the confirmation ends with 1 and writes nothing', async () => {
    const dir = app();
    const before = snapshot(dir);
    const result = await run({}, dir, { tty: true, stdin: 'n\n' });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/Cancelled/);
    expect(result.spawn).not.toHaveBeenCalled();
    expect(snapshot(dir)).toEqual(before);
  });
});

describe('the packages: the Firebase major follows React Native', () => {
  it('React Native 0.87 installs @react-native-firebase/app@26 and messaging@26', async () => {
    const dir = app({ version: '0.87.1' });
    const result = await run({ yes: true }, dir);
    expect(result.code).toBe(0);
    expect(result.spawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = result.spawn.mock.calls[0];
    expect(cmd).toBe('npm');
    expect(args).toEqual(['install', '--', '@espresso-notify/react-native', '@react-native-firebase/app@26', '@react-native-firebase/messaging@26', 'react-native-notify-kit']);
  });

  it('React Native 0.79 installs the major 25', async () => {
    const dir = app({ version: '0.79.7' });
    const result = await run({ yes: true }, dir);
    expect(result.code).toBe(0);
    const [, args] = result.spawn.mock.calls[0];
    expect(args).toContain('@react-native-firebase/app@25');
    expect(args).toContain('@react-native-firebase/messaging@25');
  });

  it('React Native 0.80 is the first one on the major 26', async () => {
    const dir = app({ version: '0.80.0' });
    const result = await run({ yes: true }, dir);
    expect(result.spawn.mock.calls[0][1]).toContain('@react-native-firebase/app@26');
  });

  it('without node_modules the range of package.json decides', async () => {
    const dir = app({ range: '^0.79.7', installed: null });
    const result = await run({ yes: true }, dir);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/0\.79\.7/);
    expect(result.spawn.mock.calls[0][1]).toContain('@react-native-firebase/app@25');
  });

  it.each([
    ['yarn.lock', 'yarn', ['add']],
    ['pnpm-lock.yaml', 'pnpm', ['add']],
    ['bun.lock', 'bun', ['add']],
    ['bun.lockb', 'bun', ['add']],
    ['package-lock.json', 'npm', ['install', '--']],
    [null, 'npm', ['install', '--']],
  ])('the lock %s picks %s', async (lock, manager, lead) => {
    const dir = app({ lock });
    const result = await run({ yes: true }, dir);
    const [cmd, args] = result.spawn.mock.calls[0];
    expect(cmd).toBe(manager);
    expect(args.slice(0, lead.length)).toEqual(lead);
    expect(args.slice(lead.length)).toHaveLength(4);
    // the detection line names the manager on its own, apart from the install command line
    expect(result.out).toMatch(new RegExp(`React Native CLI project, React Native \\S+ \\((?:installed|from package\\.json)\\), ${manager}\\.`));
  });

  it('a package already in package.json is left out of the command', async () => {
    const dir = app({ deps: { 'react-native-notify-kit': '^10.8.0', '@espresso-notify/react-native': '^1.0.0' } });
    const result = await run({ yes: true }, dir);
    expect(result.spawn.mock.calls[0][1]).toEqual(['install', '--', '@react-native-firebase/app@26', '@react-native-firebase/messaging@26']);
  });

  it('with every package installed no package manager runs and the run says there is nothing to install', async () => {
    const deps = Object.fromEntries(ALL_PACKAGES.map((name) => [name, '^26.0.0']));
    const dir = app({ deps });
    const result = await run({ yes: true }, dir);
    expect(result.code).toBe(0);
    expect(result.spawn).not.toHaveBeenCalled();
    expect(result.out).toMatch(/Already installed/);
  });

  it('a Firebase package on another major only warns: it is not touched and not reinstalled', async () => {
    const deps = { '@react-native-firebase/app': '^23.5.0', '@react-native-firebase/messaging': '^23.5.0' };
    const dir = app({ version: '0.87.1', deps });
    const before = readFileSync(join(dir, 'package.json'), 'utf8');
    const result = await run({ yes: true }, dir);
    expect(result.code).toBe(0);
    expect(result.all).toMatch(/@react-native-firebase\/app[\s\S]*23/);
    expect(result.all).toMatch(/26/);
    expect(result.spawn.mock.calls[0][1]).toEqual(['install', '--', '@espresso-notify/react-native', 'react-native-notify-kit']);
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before);
  });

  it('an installed Firebase package is read from node_modules before the range', async () => {
    const deps = { '@react-native-firebase/app': 'latest' };
    const dir = app({ version: '0.87.1', deps });
    mkdirSync(join(dir, 'node_modules', '@react-native-firebase', 'app'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '@react-native-firebase', 'app', 'package.json'), JSON.stringify({ version: '25.1.0' }));
    const result = await run({ yes: true }, dir);
    expect(result.all).toMatch(/25\.1\.0/);
  });

  it('the command line holds only constants and versions of the table, and shell is off', async () => {
    const dir = app({ range: '^0.79.7', installed: null });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '--evil && rm -rf', dependencies: { 'react-native': '^0.79.7' } }));
    const result = await run({ yes: true }, dir);
    const [cmd, args, options] = result.spawn.mock.calls[0];
    const allowed = new Set(['npm', 'install', '--', ...ALL_PACKAGES, '@react-native-firebase/app@25', '@react-native-firebase/messaging@25']);
    allowed.delete('@react-native-firebase/app');
    allowed.delete('@react-native-firebase/messaging');
    for (const part of [cmd, ...args]) expect(allowed.has(part)).toBe(true);
    expect(options.shell).toBe(false);
    expect(options.cwd).toBe(dir);
  });

  it('on Windows the command goes through cmd.exe with constant arguments and a safe environment', async () => {
    const dir = app({ lock: 'yarn.lock' });
    const result = await run({ yes: true }, dir, { platform: 'win32', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe', Path: 'C:\\x' } });
    const [cmd, args, options] = result.spawn.mock.calls[0];
    expect(cmd).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(args.slice(0, 5)).toEqual(['/d', '/s', '/c', 'yarn', 'add']);
    expect(options.shell).toBe(false);
    expect(options.env.NoDefaultCurrentDirectoryInExePath).toBe('1');
  });

  it('on Windows without a usable ComSpec the System32 interpreter is used', async () => {
    const dir = app();
    const result = await run({ yes: true }, dir, { platform: 'win32', env: { ComSpec: 'cmd.exe' } });
    expect(result.spawn.mock.calls[0][0]).toBe('C:\\Windows\\System32\\cmd.exe');
  });
});

describe('a failed install', () => {
  it.each([
    ['an exit code', { closeCode: 1 }],
    ['an error from spawn', { spawnError: new Error('ENOENT') }],
  ])('%s ends with 2, prints the command and touches no native file', async (_name, opts) => {
    const dir = app({ lock: 'pnpm-lock.yaml' });
    const before = snapshot(dir);
    const result = await run({ yes: true }, dir, opts);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/pnpm add @espresso-notify\/react-native @react-native-firebase\/app@26/);
    expect(snapshot(dir)).toEqual(before);
    expect(backups(dir)).toEqual([]);
  });
});

describe('--dry-run', () => {
  it('prints the plan (packages, each file and the lines) and leaves the folder as it was', async () => {
    const dir = app();
    const before = snapshot(dir);
    const result = await run({ dryRun: true }, dir);
    expect(result.code).toBe(0);
    expect(result.spawn).not.toHaveBeenCalled();
    expect(snapshot(dir)).toEqual(before);
    expect(result.out).toMatch(/Would run: npm install -- .*@react-native-firebase\/app@26/);
    expect(result.out).toContain('ios/Podfile');
    expect(result.out).toContain('use_frameworks! :linkage => :dynamic');
    expect(result.out).toContain('android/build.gradle');
    expect(result.out).toContain('com.google.gms:google-services');
    expect(result.out).toContain('android/app/build.gradle');
    expect(result.out).toContain("apply plugin: 'com.google.gms.google-services'");
    expect(result.out).toContain('ios/HelloWorld/AppDelegate.swift');
    expect(result.out).toContain('FirebaseApp.configure()');
    expect(result.out).toMatch(/Dry run: nothing was changed/);
  });

  it('does not ask anything even on a terminal', async () => {
    const dir = app();
    const result = await run({ dryRun: true }, dir, { tty: true });
    expect(result.code).toBe(0);
    expect(result.out).not.toMatch(/\[Y\/n\]/);
  });
});

describe('the native files', () => {
  it('the first run adds only lines between markers, with a copy of each file, and the second run changes nothing', async () => {
    const dir = app({ version: '0.87.1' });
    const original = snapshot(dir);
    const first = await run({ yes: true }, dir, { onInstall: () => installPackages(dir) });
    expect(first.code).toBe(0);
    const rels = ['ios/Podfile', 'ios/HelloWorld/AppDelegate.swift', 'android/build.gradle', 'android/app/build.gradle'];
    for (const rel of rels) {
      const after = readFileSync(join(dir, rel), 'utf8');
      expect(after).not.toBe(original[rel]);
      expect(onlyAddsLines(original[rel], after)).toBe(true);
      expect(after).toContain('espresso-notify:begin');
    }
    expect(readFileSync(join(dir, 'android/app/src/main/AndroidManifest.xml'), 'utf8')).toBe(original['android/app/src/main/AndroidManifest.xml']);
    const copies = backups(dir);
    expect(copies).toHaveLength(4);
    for (const copy of copies) {
      const target = copy.replace(new RegExp(`^${BACKUP}/\\d{8}T\\d{6}(-\\d+)?/`), '');
      expect(readFileSync(join(dir, copy), 'utf8')).toBe(original[target]);
    }
    expect(first.out).toContain(`${BACKUP}/${STAMP}/ios/Podfile`);

    const afterFirst = snapshot(dir);
    const second = await run({ yes: true }, dir);
    expect(second.code).toBe(0);
    expect(second.spawn).not.toHaveBeenCalled();
    expect(snapshot(dir)).toEqual(afterFirst);
    expect(second.out).toMatch(/Nothing to change/);
  });

  it('the second run, with the packages installed, makes no copy and runs no package manager', async () => {
    const deps = Object.fromEntries(ALL_PACKAGES.map((name) => [name, '^26.0.0']));
    const dir = app({ deps });
    await run({ yes: true }, dir);
    const copies = backups(dir);
    const second = await run({ yes: true }, dir);
    expect(second.spawn).not.toHaveBeenCalled();
    expect(backups(dir)).toEqual(copies);
    expect(second.out).toMatch(/Nothing to change/);
  });

  it('React Native 0.79 gets the same edits', async () => {
    const dir = app({ version: '0.79.7' });
    const result = await run({ yes: true }, dir);
    expect(result.code).toBe(0);
    expect(readFileSync(join(dir, 'ios/Podfile'), 'utf8')).toContain('use_frameworks! :linkage => :dynamic');
    expect(backups(dir)).toHaveLength(4);
  });

  it('a Podfile with static linkage is left alone: the step is printed and the exit code is still 0', async () => {
    const dir = app();
    const podfile = join(dir, 'ios', 'Podfile');
    const text = readFileSync(podfile, 'utf8').replace(/linkage = ENV\['USE_FRAMEWORKS'\][\s\S]*?\nend\n/, 'use_frameworks! :linkage => :static\n');
    writeFileSync(podfile, text);
    const result = await run({ yes: true }, dir);
    expect(result.code).toBe(0);
    expect(readFileSync(podfile, 'utf8')).toBe(text);
    expect(result.all).toMatch(/static/);
    expect(result.all).toContain('use_frameworks! :linkage => :dynamic');
    expect(result.all).toMatch(/left for you|by hand/i);
    expect(readdirSync(join(dir, 'ios')).filter((n) => n.endsWith('.bak'))).toEqual([]);
    expect(backups(dir).some((name) => name.endsWith('/ios/Podfile'))).toBe(false);
    expect(readFileSync(join(dir, 'android/build.gradle'), 'utf8')).toContain('espresso-notify:begin');
  });

  it('a file left alone prints its reason once, with a single full stop at the end', async () => {
    const dir = app();
    const podfile = join(dir, 'ios', 'Podfile');
    writeFileSync(podfile, readFileSync(podfile, 'utf8').replace(/linkage = ENV\['USE_FRAMEWORKS'\][\s\S]*?\nend\n/, 'use_frameworks! :linkage => :static\n'));
    const result = await run({ yes: true }, dir);
    const line = result.out.split('\n').find((l) => l.includes('ios/Podfile: left alone'));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/\.\.\s*$/);
    expect(line).toMatch(/[^.]\.\s*$/);
  });

  it('a Kotlin DSL Gradle file is left alone and its step is printed', async () => {
    const dir = app();
    rmSync(join(dir, 'android', 'build.gradle'));
    writeFileSync(join(dir, 'android', 'build.gradle.kts'), 'buildscript { }\n');
    const result = await run({ yes: true }, dir);
    expect(result.code).toBe(0);
    expect(readFileSync(join(dir, 'android', 'build.gradle.kts'), 'utf8')).toBe('buildscript { }\n');
    expect(result.all).toMatch(/Kotlin/);
    expect(result.all).toContain('com.google.gms:google-services');
  });

  it('an app without an ios folder: the ios steps are printed, the android files are edited, exit 0', async () => {
    const dir = app({ ios: false });
    const result = await run({ yes: true }, dir);
    expect(result.code).toBe(0);
    expect(existsSync(join(dir, 'ios'))).toBe(false);
    expect(result.all).toMatch(/no ios\/ folder|ios\/ folder/);
    expect(readFileSync(join(dir, 'android/app/build.gradle'), 'utf8')).toContain('espresso-notify:begin');
  });

  it('an app without an android folder', async () => {
    const dir = app({ android: false });
    const result = await run({ yes: true }, dir);
    expect(result.code).toBe(0);
    expect(existsSync(join(dir, 'android'))).toBe(false);
    expect(readFileSync(join(dir, 'ios/Podfile'), 'utf8')).toContain('espresso-notify:begin');
  });

  it('an AppDelegate that is not found is a printed step', async () => {
    const dir = app();
    rmSync(join(dir, 'ios', 'HelloWorld', 'AppDelegate.swift'));
    const result = await run({ yes: true }, dir);
    expect(result.code).toBe(0);
    expect(result.all).toMatch(/AppDelegate/);
    expect(result.all).toContain('FirebaseApp.configure()');
  });

  it('a write that fails ends with 2 and leaves the file as it was', async () => {
    const dir = app();
    const original = readFileSync(join(dir, 'ios', 'Podfile'), 'utf8');
    const failing = { ...fs, renameSync: () => { throw new Error('EPERM'); } };
    const result = await run({ yes: true }, dir, { fs: failing });
    expect(result.code).toBe(2);
    expect(readFileSync(join(dir, 'ios', 'Podfile'), 'utf8')).toBe(original);
    expect(result.err).toMatch(/EPERM/);
  });

  it('a read-only file that cannot be copied is not written', async () => {
    const dir = app();
    const dirPath = join(dir, 'android');
    const before = readFileSync(join(dir, 'android', 'build.gradle'), 'utf8');
    chmodSync(dirPath, 0o555);
    try {
      const result = await run({ yes: true }, dir);
      if (process.getuid && process.getuid() !== 0) {
        expect(result.code).toBe(2);
        expect(readFileSync(join(dir, 'android', 'build.gradle'), 'utf8')).toBe(before);
      }
    } finally {
      chmodSync(dirPath, 0o755);
    }
  });

  it('prints the exact steps of what was not edited and lists the copies to delete after checking', async () => {
    const dir = app();
    const result = await run({ yes: true }, dir);
    expect(result.out).toMatch(/copies/i);
    expect(result.out).toMatch(/delete/i);
  });

  it('warns when the AppDelegate already calls FirebaseApp.configure() without the guard', async () => {
    const dir = app();
    const file = join(dir, 'ios', 'HelloWorld', 'AppDelegate.swift');
    const text = readFileSync(file, 'utf8').replace('let delegate = ReactNativeDelegate()', 'FirebaseApp.configure()\n    let delegate = ReactNativeDelegate()');
    writeFileSync(file, text);
    const result = await run({ yes: true }, dir);
    expect(result.code).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(result.all).toMatch(/GoogleService-Info\.plist/);
  });

  it('keeps the mode of the files it edits', async () => {
    const dir = app();
    const file = join(dir, 'ios', 'Podfile');
    chmodSync(file, 0o640);
    await run({ yes: true }, dir);
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });
});

describe('the flow of the Expo project is not this one', () => {
  it('a project with expo is not handled here: it is refused with a pointer, nothing written', async () => {
    const dir = app();
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    pkg.dependencies.expo = '~57.0.26';
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
    const before = snapshot(dir);
    const result = await run({ yes: true }, dir);
    expect(result.code).toBe(1);
    expect(snapshot(dir)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// wizard-backup-folder (W-49): the copies of the originals go to one folder, and git is the backup when it can be.
// ---------------------------------------------------------------------------------------------------------------------

const RELS = ['ios/Podfile', 'ios/HelloWorld/AppDelegate.swift', 'android/build.gradle', 'android/app/build.gradle'];
const GITIGNORE_LINE = `${BACKUP}/`;

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) =>
  String(execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, env: gitEnv, stdio: 'pipe' }));
/** Makes `dir` a git work tree and commits what is there (`.gitignore` first, when given, so ignored files stay out). */
function commitAll(dir: string, gitignore?: string) {
  git(dir, 'init', '-q');
  if (gitignore !== undefined) writeFileSync(join(dir, '.gitignore'), gitignore);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
}
/** The real `spawnSync`, wrapped so a test sees the calls; it keeps the environment away from the user's git config. */
const realGit = (...args: any[]) => (realSpawnSync as any)(args[0], args[1], { ...args[2], env: { ...gitEnv, ...(args[2]?.env || {}) } });
const porcelain = (dir: string) => git(dir, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).sort();

describe('the copies of the originals (W-49)', () => {
  it('WB-04, WB-05, WB-06: outside git every edited file is copied into one folder, nothing sits next to a file, and the .gitignore line is printed', async () => {
    const dir = app();
    const original = snapshot(dir);
    const result = await run({ yes: true }, dir);
    expect(result.code).toBe(0);
    expect(backups(dir).sort()).toEqual(RELS.map((rel) => `${BACKUP}/${STAMP}/${rel}`).sort());
    for (const rel of RELS) expect(readFileSync(join(dir, BACKUP, STAMP, rel), 'utf8')).toBe(original[rel]);
    expect(bakFiles(dir)).toEqual([]);
    for (const rel of RELS) expect(readdirSync(join(dir, rel, '..')).filter((n) => /espresso-notify-\d/.test(n))).toEqual([]);
    expect(result.out).toContain(`Copies of the original files are in ${BACKUP}/${STAMP}/ (4)`);
    for (const rel of RELS) expect(result.out).toContain(`  - ${BACKUP}/${STAMP}/${rel}`);
    expect(result.out.match(new RegExp(`^  ${GITIGNORE_LINE.replace('.', '\\.')}$`, 'gm'))).toHaveLength(1);
    expect(result.out).toMatch(/\.gitignore/);
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
  });

  it('WB-05: a .gitignore that exists is left byte for byte as it was', async () => {
    const dir = app();
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
    await run({ yes: true }, dir);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules/\n');
  });

  it('WB-01: in a git work tree with every file committed and unchanged there is no copy, git add . takes only the edits, and the review and undo commands are printed per file', async () => {
    const dir = app();
    const original = snapshot(dir);
    commitAll(dir);
    const result = await run({ yes: true }, dir, { spawnSync: realGit });
    expect(result.code).toBe(0);
    expect(backups(dir)).toEqual([]);
    expect(existsSync(join(dir, BACKUP))).toBe(false);
    expect(bakFiles(dir)).toEqual([]);
    git(dir, 'add', '.');
    expect(porcelain(dir)).toEqual(RELS.map((rel) => `M  ${rel}`).sort());
    for (const rel of RELS) {
      expect(result.out).toContain(`git diff HEAD -- ${rel}`);
      expect(result.out).toContain(`git checkout HEAD -- ${rel}`);
    }
    expect(result.out).toMatch(/Git has the original of 4 files/);
    expect(result.out).not.toContain(GITIGNORE_LINE);
    expect(result.out).not.toMatch(/Copies of the original files/);
    // after `git add .` the printed commands still work: the review shows the edit and the undo brings the original bytes back
    for (const rel of RELS) {
      const review = result.out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('git diff HEAD -- ') && l.endsWith(rel))[0];
      expect(git(dir, ...review.split(' ').slice(1))).toContain('espresso-notify');
      const undo = result.out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('git checkout HEAD -- ') && l.endsWith(rel))[0];
      git(dir, ...undo.split(' ').slice(1));
      expect(readFileSync(join(dir, rel), 'utf8')).toBe(original[rel]);
    }
    expect(porcelain(dir)).toEqual([]);
  });

  it('WB-02: a tracked file that already has an uncommitted change is copied, with the change in the copy; the clean ones are not', async () => {
    const dir = app();
    commitAll(dir);
    const podfile = join(dir, 'ios/Podfile');
    const mine = readFileSync(podfile, 'utf8') + '# my own uncommitted line\n';
    writeFileSync(podfile, mine);
    const result = await run({ yes: true }, dir, { spawnSync: realGit });
    expect(result.code).toBe(0);
    expect(backups(dir)).toEqual([`${BACKUP}/${STAMP}/ios/Podfile`]);
    expect(readFileSync(join(dir, BACKUP, STAMP, 'ios/Podfile'), 'utf8')).toBe(mine);
    expect(result.out).toContain(`  ${GITIGNORE_LINE}`);
    expect(result.out).toMatch(/Git has the original of 3 files/);
    expect(result.out).toContain('git diff HEAD -- android/build.gradle');
    expect(result.out).not.toContain('git diff HEAD -- ios/Podfile');
  });

  it('WB-02: a change that is only staged also counts as a change', async () => {
    const dir = app();
    commitAll(dir);
    const gradle = join(dir, 'android/build.gradle');
    writeFileSync(gradle, readFileSync(gradle, 'utf8') + '// staged\n');
    git(dir, 'add', 'android/build.gradle');
    await run({ yes: true }, dir, { spawnSync: realGit });
    expect(backups(dir)).toEqual([`${BACKUP}/${STAMP}/android/build.gradle`]);
  });

  it('WB-03: untracked and ignored files are copied, tracked ones are not, and the .gitignore stays as it was', async () => {
    const dir = app();
    commitAll(dir, 'android/\n');
    expect(git(dir, 'ls-files', 'android')).toBe('');
    const result = await run({ yes: true }, dir, { spawnSync: realGit });
    expect(result.code).toBe(0);
    expect(backups(dir).sort()).toEqual([`${BACKUP}/${STAMP}/android/app/build.gradle`, `${BACKUP}/${STAMP}/android/build.gradle`]);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('android/\n');
    expect(result.out).toMatch(/Git has the original of 2 files/);
    expect(result.out).toContain('git diff HEAD -- ios/Podfile');
    expect(result.out).not.toContain('git diff HEAD -- android/build.gradle');
    expect(result.out).toContain(`  ${GITIGNORE_LINE}`);
  });

  it('WB-04: a repository without a commit is not a backup, so the files are copied', async () => {
    const dir = app();
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    const result = await run({ yes: true }, dir, { spawnSync: realGit });
    expect(backups(dir)).toHaveLength(4);
    expect(result.out).toContain(`  ${GITIGNORE_LINE}`);
    expect(result.out).not.toMatch(/Git has the original/);
  });

  it('WB-04: git missing from the machine (spawnSync reports ENOENT) copies the files', async () => {
    const dir = app();
    const result = await run({ yes: true }, dir, {
      spawnSync: () => ({ error: Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' }), status: null, stdout: null }),
    });
    expect(result.code).toBe(0);
    expect(backups(dir)).toHaveLength(4);
  });

  it('WB-07: --dry-run writes nothing, not even the folder, and says per file what it would copy or that git holds the original', async () => {
    const dir = app();
    commitAll(dir);
    writeFileSync(join(dir, 'ios/Podfile'), readFileSync(join(dir, 'ios/Podfile'), 'utf8') + '# mine\n');
    const before = snapshot(dir);
    const status = porcelain(dir);
    const result = await run({ dryRun: true }, dir, { spawnSync: realGit });
    expect(result.code).toBe(0);
    expect(snapshot(dir)).toEqual(before);
    expect(porcelain(dir)).toEqual(status);
    expect(existsSync(join(dir, BACKUP))).toBe(false);
    expect(result.out).toContain(`Would copy the original to ${BACKUP}/${STAMP}/ios/Podfile`);
    expect(result.out).toMatch(/Git has the original of android\/build\.gradle: no copy/);
    expect(result.out).toMatch(/Git has the original of android\/app\/build\.gradle: no copy/);
    expect(result.out).toMatch(/Git has the original of ios\/HelloWorld\/AppDelegate\.swift: no copy/);
    expect(result.out).toContain(`  ${GITIGNORE_LINE}`);
    expect(result.out).toMatch(/Dry run: nothing was changed/);
  });

  it('WB-07: --dry-run outside git names the copy of each file', async () => {
    const dir = app();
    const before = snapshot(dir);
    const result = await run({ dryRun: true }, dir);
    expect(snapshot(dir)).toEqual(before);
    for (const rel of RELS) expect(result.out).toContain(`Would copy the original to ${BACKUP}/${STAMP}/${rel}`);
  });

  it('WB-08: the second run touches no file, makes no copy and does not ask git anything', async () => {
    const dir = app({ deps: Object.fromEntries(ALL_PACKAGES.map((name) => [name, '^26.0.0'])) });
    commitAll(dir);
    const first = await run({ yes: true }, dir, { spawnSync: realGit });
    expect(first.spawnSync).toHaveBeenCalled();
    const afterFirst = snapshot(dir);
    const second = await run({ yes: true }, dir, { spawnSync: realGit });
    expect(second.code).toBe(0);
    expect(second.spawnSync).not.toHaveBeenCalled();
    expect(snapshot(dir)).toEqual(afterFirst);
    expect(second.out).toMatch(/Nothing to change/);
    expect(second.out).not.toMatch(/Copies of the original|Git has the original/);
  });

  it('WB-08: the second run outside git makes no second folder', async () => {
    const dir = app({ deps: Object.fromEntries(ALL_PACKAGES.map((name) => [name, '^26.0.0'])) });
    await run({ yes: true }, dir);
    const afterFirst = snapshot(dir);
    await run({ yes: true }, dir);
    expect(snapshot(dir)).toEqual(afterFirst);
    expect(readdirSync(join(dir, BACKUP))).toEqual([STAMP]);
  });

  it('WB-09: the copy is checked against the original before the file is written, and a copy that differs stops the write', async () => {
    const dir = app();
    const original = snapshot(dir);
    const broken = {
      ...fs,
      copyFileSync: (from: string, to: string, flags?: number) => {
        fs.copyFileSync(from, to, flags);
        fs.writeFileSync(to, 'not the original');
      },
    };
    const result = await run({ yes: true }, dir, { fs: broken });
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/could not verify the backup copy/);
    for (const rel of RELS) expect(readFileSync(join(dir, rel), 'utf8')).toBe(original[rel]);
  });

  it('WB-10: on Windows git runs by its name, without a shell, in the app folder, with constant arguments and the safe environment', async () => {
    const dir = app();
    const result = await run({ yes: true }, dir, { platform: 'win32', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe', Path: 'C:\\x' } });
    expect(result.spawnSync.mock.calls.length).toBeGreaterThan(0);
    for (const [file, args, options] of result.spawnSync.mock.calls) {
      expect(file).toBe('git');
      expect(args.every((arg: string) => /^(-[-\w]+|ls-files|diff|status|HEAD|\.)$/.test(arg))).toBe(true);
      expect(options.shell).toBe(false);
      expect(options.cwd).toBe(dir);
      expect(options.env.NoDefaultCurrentDirectoryInExePath).toBe('1');
    }
  });
});

describe('the path in a printed git command (W-49)', () => {
  const HOSTILE = ['$HOME', '`id`', '"q"', "it's", '!x', '50%', 'a;b', 'a&b', 'a|b', 'a(b)', '$(id)', '@scope', 'a,b', 'My App', '#c', '~d', '<e>'];

  it('a path of letters, digits and _ + = : . / - is printed as it is, on every platform', () => {
    expect(shellPath('ios/Podfile', 'darwin')).toBe('ios/Podfile');
    expect(shellPath('android/app/build.gradle', 'win32')).toBe('android/app/build.gradle');
  });

  it('a character a shell reads is not in the safe set: % @ , $ ! ; & ( ) space are quoted or refused', () => {
    for (const ch of ['%', '@', ',', '$', '!', ';', '&', '(', ')', ' ']) {
      expect(shellPath(`ios/a${ch}b`, 'linux')).toBe(`'ios/a${ch}b'`);
    }
  });

  it('POSIX: every hostile path goes in single quotes, and a real shell gives it back byte for byte', () => {
    for (const name of HOSTILE) {
      const rel = `ios/${name}/x`;
      const quoted = shellPath(rel, 'linux');
      expect(quoted).toMatch(/^'/);
      expect(String(execFileSync('sh', ['-c', `printf %s ${quoted}`], { stdio: 'pipe' }))).toBe(rel);
    }
    expect(shellPath("ios/it's", 'darwin')).toBe("'ios/it'\\''s'");
    const many = "ios/a'b''c";
    expect(String(execFileSync('sh', ['-c', `printf %s ${shellPath(many, 'linux')}`], { stdio: 'pipe' }))).toBe(many);
  });

  it('Windows: a name with a space goes in double quotes, safe in cmd.exe and in PowerShell', () => {
    expect(shellPath('ios/My App/Podfile', 'win32')).toBe('"ios/My App/Podfile"');
    expect(shellPath('ios/a,b/@x', 'win32')).toBe('"ios/a,b/@x"');
    expect(shellPath('ios/Hello World/AppDelegate.swift', 'win32')).toBe('"ios/Hello World/AppDelegate.swift"');
  });

  /** The 21 characters the Windows guard refuses, written out here on purpose: a character dropped from the guard must fail this list. */
  const WINDOWS_REFUSED = ['&', '|', '<', '>', '^', '(', ')', '$', '`', '"', "'", '%', '!', ';', '\u2018', '\u2019', '\u201a', '\u201b', '\u201c', '\u201d', '\u201e'];

  it.each(WINDOWS_REFUSED)('Windows: a name with %j gets no command, because cmd.exe or PowerShell would read it', (ch) => {
    expect(shellPath(`ios/a${ch}b`, 'win32')).toBeNull();
    expect(shellPath(`ios/a ${ch} b/Podfile`, 'win32')).toBeNull();
  });

  it('Windows: the guard refuses exactly the 21 characters above, and no other character of the first 64 K', () => {
    const refused: string[] = [];
    for (let code = 0x20; code <= 0xffff; code += 1) {
      const ch = String.fromCharCode(code);
      if (code >= 0x7f && code <= 0x9f) continue;
      if (code === 0x2028 || code === 0x2029) continue;
      if (WINDOWS_UNSAFE.test(ch)) refused.push(ch);
    }
    expect(refused.sort()).toEqual([...WINDOWS_REFUSED].sort());
    expect(WINDOWS_REFUSED).toHaveLength(21);
  });

  it.each(['*', '?', '[', '\\'])('a name with %j gets no command on any platform, because Git reads it as a pattern', (ch) => {
    for (const platform of ['linux', 'darwin', 'win32']) {
      expect(shellPath(`ios/a${ch}b/AppDelegate.swift`, platform)).toBeNull();
    }
  });

  it('a line break or another control character gives no command on any platform', () => {
    for (const platform of ['linux', 'darwin', 'win32']) {
      for (const bad of ['ios/a\nb', 'ios/a\rb', 'ios/a\u001b[31mb', 'ios/a\u0000b', 'ios/a\u007fb', 'ios/a\u2028b']) {
        expect(shellPath(bad, platform)).toBeNull();
      }
    }
  });

  it('the summary prints a plain note, not a command, for a file whose name no command can hold', async () => {
    const dir = app();
    renameSync(join(dir, 'ios/HelloWorld'), join(dir, 'ios/Hello%World'));
    commitAll(dir);
    const result = await run({ yes: true }, dir, { spawnSync: realGit, platform: 'win32' });
    expect(result.code).toBe(0);
    expect(result.out).toContain('ios/Hello%World/AppDelegate.swift: the name has a character that a shell or Git reads, so no command is printed');
    expect(result.out).not.toMatch(/git (diff|checkout) HEAD -- .*%/);
    expect(result.out).toContain('git checkout HEAD -- ios/Podfile');
    const posix = await run({ yes: true }, (() => { const d = app(); renameSync(join(d, 'ios/HelloWorld'), join(d, 'ios/Hello%World')); commitAll(d); return d; })(), { spawnSync: realGit });
    expect(posix.out).toContain("git checkout HEAD -- 'ios/Hello%World/AppDelegate.swift'");
  });

  it('on Windows a name with a space is printed in double quotes, which cmd.exe and PowerShell both read as one name', async () => {
    const dir = app();
    renameSync(join(dir, 'ios/HelloWorld'), join(dir, 'ios/Hello World'));
    commitAll(dir);
    const result = await run({ yes: true }, dir, { spawnSync: realGit, platform: 'win32' });
    expect(result.out).toContain('git diff HEAD -- "ios/Hello World/AppDelegate.swift"');
    expect(result.out).toContain('git checkout HEAD -- "ios/Hello World/AppDelegate.swift"');
  });
});

describe('a folder name that git or a terminal reads (WB-01)', () => {
  /** Renames the app folder (and its .xcodeproj) of `app()` to `name`. */
  function renameApp(dir: string, name: string) {
    renameSync(join(dir, 'ios/HelloWorld'), join(dir, 'ios', name));
    renameSync(join(dir, 'ios/HelloWorld.xcodeproj'), join(dir, 'ios', `${name}.xcodeproj`));
  }
  const ESC = '\u001b';
  const BEL = '\u0007';

  it('a glob character in the folder name: no runnable command is printed, and the work in the folder it would match is not touched', async () => {
    for (const platform of ['linux', 'win32']) {
      const dir = app();
      renameApp(dir, 'My*App');
      // a second app folder the pattern `ios/My*App/AppDelegate.swift` also matches
      mkdirSync(join(dir, 'ios/MyOtherApp'), { recursive: true });
      writeFileSync(join(dir, 'ios/MyOtherApp/AppDelegate.swift'), '// committed\n');
      commitAll(dir);
      const work = '// my uncommitted work, not to be lost\n';
      writeFileSync(join(dir, 'ios/MyOtherApp/AppDelegate.swift'), work);
      const result = await run({ yes: true }, dir, { spawnSync: realGit, platform });
      expect(result.code).toBe(0);
      expect(readFileSync(join(dir, 'ios/My*App/AppDelegate.swift'), 'utf8')).toContain('espresso-notify');
      expect(result.out).toContain('ios/My*App/AppDelegate.swift: the name has a character that a shell or Git reads, so no command is printed');
      // the glob name has no runnable line, in any quoting
      expect(result.out).not.toMatch(/git (diff|checkout) HEAD -- .*My\*App/);
      // every command that is printed is safe to run, and the work stays
      const commands = result.out.split('\n').map((l) => l.trim()).filter((l) => /^git (diff|checkout) HEAD -- /.test(l));
      expect(commands.length).toBeGreaterThan(0);
      for (const line of commands) {
        git(dir, ...line.replace(/["']/g, '').split(' ').slice(1));
        expect(readFileSync(join(dir, 'ios/MyOtherApp/AppDelegate.swift'), 'utf8')).toBe(work);
      }
    }
  });

  it('a control sequence in the folder name shows as ? in the summary note, and no escape byte is printed', async () => {
    const dir = app();
    renameApp(dir, `Hello${ESC}[2KApp`);
    commitAll(dir);
    const result = await run({ yes: true }, dir, { spawnSync: realGit });
    expect(result.code).toBe(0);
    expect(result.out).toContain('ios/Hello?[2KApp/AppDelegate.swift: the name has a character that a shell or Git reads');
    expect(result.all).not.toContain(ESC);
  });

  it.each([
    ['CSI erase line', `Hello${ESC}[2KWorld`],
    ['OSC 52 clipboard write', `Hello${ESC}]52;c;QUJD${BEL}World`],
  ])('%s in the folder name: no escape or bell byte reaches the terminal, in git, outside git, and in a dry run', async (_label, name) => {
    for (const mode of ['git', 'plain', 'dry']) {
      const dir = app();
      renameApp(dir, name);
      if (mode === 'git') commitAll(dir);
      const result = await run({ yes: true, dryRun: mode === 'dry' }, dir, { spawnSync: mode === 'git' ? realGit : noGit });
      expect(result.code).toBe(0);
      expect(result.all).not.toContain(ESC);
      expect(result.all).not.toContain(BEL);
      expect(result.all).toContain('Hello?');
      if (mode === 'plain') {
        // the file operations still used the real name
        expect(readFileSync(join(dir, 'ios', name, 'AppDelegate.swift'), 'utf8')).toContain('espresso-notify');
        expect(result.out).toContain('Copy of the original:');
      }
    }
  });

  const INSTALLED = Object.fromEntries(ALL_PACKAGES.map((name) => [name, '^26.0.0']));
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  /** Each scenario reaches one print site that shows the path of a file; `reaches` proves the site was run. */
  const SITES: Array<[string, string, (name: string) => Promise<{ all: string }>]> = [
    ['second run: the "already set up" line', 'already set up', async (name) => {
      const dir = app({ deps: INSTALLED });
      renameApp(dir, name);
      await run({ yes: true }, dir);
      return run({ yes: true }, dir);
    }],
    ['--dry-run inside a git work tree: the "Git has the original" line', 'Git has the original of', async (name) => {
      const dir = app();
      renameApp(dir, name);
      commitAll(dir);
      return run({ yes: true, dryRun: true }, dir, { spawnSync: realGit });
    }],
    ['an AppDelegate nobody can read: the "left alone" reason', 'left alone', async (name) => {
      const dir = app();
      renameApp(dir, name);
      const file = join(dir, 'ios', name, 'AppDelegate.swift');
      chmodSync(file, 0o000);
      try {
        return await run({ yes: true }, dir);
      } finally {
        chmodSync(file, 0o644);
      }
    }],
    ['a read-only app folder in git: the error line', 'could not be written', async (name) => {
      const dir = app();
      renameApp(dir, name);
      commitAll(dir);
      const folder = join(dir, 'ios', name);
      chmodSync(folder, 0o555);
      try {
        return await run({ yes: true }, dir, { spawnSync: realGit });
      } finally {
        chmodSync(folder, 0o755);
      }
    }],
    ['a rename that fails after the copy: the list of copies', 'could not be written', async (name) => {
      const dir = app();
      renameApp(dir, name);
      const failing = { ...fs, renameSync: () => { throw new Error('EPERM'); } };
      return run({ yes: true }, dir, { fs: failing });
    }],
  ];

  it.each(SITES)('%s: no escape or bell byte reaches the terminal', async (label, reaches, scenario) => {
    // a mode 000 file and a read-only folder only stop the owner when the tests do not run as root
    if (isRoot && /nobody can read|read-only/.test(label)) return;
    for (const name of [`Hello${ESC}[2KWorld`, `Hello${ESC}]52;c;QUJD${BEL}World`]) {
      const result = await scenario(name);
      expect(result.all).toContain(reaches);
      expect(result.all).not.toContain(ESC);
      expect(result.all).not.toContain(BEL);
      expect(result.all).toContain('Hello?');
    }
  });

  /** A version of the project that carries an OSC 52 clipboard write: the wizard shows it with `?` for the control bytes. */
  const HOSTILE_VERSION = `22.${ESC}]52;c;aGk=${BEL}`;
  const SHOWN_VERSION = '22.?]52;c;aGk=?';
  const VERSION_SITES: Array<[string, string, boolean, (version: string) => string]> = [
    ['the range of a Firebase package in package.json, in the step 2 warning', `@react-native-firebase/app is on ^${SHOWN_VERSION}`, false, (version) =>
      app({ deps: { '@react-native-firebase/app': `^${version}` } })],
    ['the range of a Firebase package in package.json, in the step 2 warning of a dry run', `@react-native-firebase/app is on ^${SHOWN_VERSION}`, true, (version) =>
      app({ deps: { '@react-native-firebase/app': `^${version}` } })],
    ['the installed version of a Firebase package, in the step 2 warning', `@react-native-firebase/messaging is on ${SHOWN_VERSION.replace('22.', '22.1.0')}`, false, (version) => {
      const dir = app({ deps: { '@react-native-firebase/messaging': '^22.1.0' } });
      mkdirSync(join(dir, 'node_modules/@react-native-firebase/messaging'), { recursive: true });
      writeFileSync(join(dir, 'node_modules/@react-native-firebase/messaging/package.json'), JSON.stringify({ version: version.replace('22.', '22.1.0') }));
      return dir;
    }],
    ['the installed react-native version, in the step 2 warning about another Firebase major', `and React Native 0.87.1${SHOWN_VERSION.slice(2)} works with major 26`, false, (version) =>
      app({ installed: `0.87.1${version.slice(2)}`, deps: { '@react-native-firebase/app': '^22.0.0' } })],
    ['a react-native range the wizard cannot read, in the refusal', `from "latest${SHOWN_VERSION.slice(2)}"`, false, (version) =>
      app({ range: `latest${version.slice(2)}`, installed: null })],
    ['an installed react-native with a suffix, in step 1', `React Native 0.87.1${SHOWN_VERSION.slice(2)} (installed)`, false, (version) =>
      app({ installed: `0.87.1${version.slice(2)}` })],
    ['an installed react-native below the floor, in the refusal', `React Native 0.78.2${SHOWN_VERSION.slice(2)}.`, false, (version) =>
      app({ range: '0.78.2', installed: `0.78.2${version.slice(2)}` })],
  ];

  it.each(VERSION_SITES)('a version read from the project (%s): no escape or bell byte reaches the terminal', async (_label, shown, dryRun, build) => {
    const dir = build(HOSTILE_VERSION);
    const result = await run({ yes: true, dryRun }, dir);
    expect(result.all).toContain(shown);
    expect(result.all).not.toContain(ESC);
    expect(result.all).not.toContain(BEL);
  });

  it('a control sequence in the folder name does not reach the terminal when the wizard leaves the file alone either', async () => {
    const dir = app();
    renameApp(dir, `Hello${ESC}]52;c;QUJD${BEL}World`);
    writeFileSync(join(dir, 'ios', `Hello${ESC}]52;c;QUJD${BEL}World`, 'AppDelegate.swift'), 'not a delegate the wizard knows\n');
    const result = await run({ yes: true }, dir);
    expect(result.all).not.toContain(ESC);
    expect(result.all).not.toContain(BEL);
    expect(result.out).toContain('left alone');
  });
});

describe('the warning about uncommitted changes (WB-12)', () => {
  const WARNING = /uncommitted changes/i;
  const PROMPT = 'Continue anyway? [y/N]';
  /** Everything except git's own folder, which `git status` may touch. */
  const tree = (dir: string) => Object.fromEntries(Object.entries(snapshot(dir)).filter(([name]) => !name.startsWith('.git/') && name !== '.git/'));
  const statusCalls = (result: { spawnSync: jest.Mock }) => result.spawnSync.mock.calls.filter(([, args]: any[]) => args.includes('status'));
  /** A committed app with one uncommitted change of the person. */
  function dirtyApp() {
    const dir = app();
    commitAll(dir);
    writeFileSync(join(dir, 'README.md'), 'my own uncommitted work\n');
    return dir;
  }
  const cleanApp = () => {
    const dir = app();
    commitAll(dir);
    return dir;
  };

  it('WB-12b: with --yes it prints the warning and the switch, before the install, and goes on', async () => {
    const dir = dirtyApp();
    const result = await run({ yes: true }, dir, { spawnSync: realGit });
    expect(result.code).toBe(0);
    expect(result.out).toMatch(WARNING);
    expect(result.out).toMatch(/commit/i);
    expect(result.out).toContain('ESPRESSO_NO_GIT_STATUS=1');
    expect(result.out).not.toContain(PROMPT);
    expect(result.out.indexOf('uncommitted changes')).toBeLessThan(result.out.indexOf('[2/6]'));
    expect(result.spawn).toHaveBeenCalled();
    expect(readFileSync(join(dir, 'ios/Podfile'), 'utf8')).toContain('espresso-notify');
  });

  it('WB-12b: without a terminal, and with CI set on a terminal, it only warns', async () => {
    const noTerminal = await run({}, dirtyApp(), { spawnSync: realGit });
    expect(noTerminal.code).toBe(0);
    expect(noTerminal.out).toMatch(WARNING);
    expect(noTerminal.out).not.toContain(PROMPT);
    const ci = await run({}, dirtyApp(), { spawnSync: realGit, tty: true, stdin: 'y\n', env: { CI: 'true' } });
    expect(ci.code).toBe(0);
    expect(ci.out).toMatch(WARNING);
    expect(ci.out).not.toContain(PROMPT);
  });

  it.each(['true', '1', 'yes', 'TRUE', 'jenkins'])('WB-12b: CI=%s counts as on: it only warns, even on a terminal', async (value) => {
    const result = await run({}, dirtyApp(), { spawnSync: realGit, tty: true, stdin: 'y\n', env: { CI: value } });
    expect(result.code).toBe(0);
    expect(result.out).toMatch(WARNING);
    expect(result.out).not.toContain(PROMPT);
  });

  it.each(['0', 'false', 'FALSE', '', ' '])('WB-12b: CI=%j does not count as on: on a terminal it still asks, and a no stops', async (value) => {
    const dir = dirtyApp();
    const result = await run({}, dir, { spawnSync: realGit, tty: true, stdin: 'y\nn\n', env: { CI: value } });
    expect(result.code).toBe(1);
    expect(result.out).toContain(PROMPT);
    expect(result.err).toMatch(/Nothing was changed/);
    expect(readFileSync(join(dir, 'ios/Podfile'), 'utf8')).not.toContain('espresso-notify');
  });

  it('WB-12a: on a terminal it asks, and a yes goes on', async () => {
    const dir = dirtyApp();
    const result = await run({}, dir, { spawnSync: realGit, tty: true, stdin: 'y\ny\n' });
    expect(result.code).toBe(0);
    expect(result.out).toMatch(WARNING);
    expect(result.out).toContain(PROMPT);
    expect(result.out.indexOf(PROMPT)).toBeLessThan(result.out.indexOf('[2/6]'));
    expect(readFileSync(join(dir, 'ios/Podfile'), 'utf8')).toContain('espresso-notify');
  });

  it.each([['n', 'a no'], ['', 'an empty answer (the default is no)'], ['maybe', 'any other answer']])('WB-12a: %j (%s) ends with 1 and changes nothing', async (answer) => {
    const dir = dirtyApp();
    const before = tree(dir);
    const result = await run({}, dir, { spawnSync: realGit, tty: true, stdin: `y\n${answer}\n` });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/Nothing was changed/);
    expect(result.spawn).not.toHaveBeenCalled();
    expect(tree(dir)).toEqual(before);
    expect(existsSync(join(dir, BACKUP))).toBe(false);
    expect(porcelain(dir)).toEqual(['?? README.md']);
  });

  it('WB-12c: --dry-run neither asks, warns nor asks git for the status', async () => {
    const dir = dirtyApp();
    const before = tree(dir);
    const result = await run({ dryRun: true }, dir, { spawnSync: realGit, tty: true });
    expect(result.code).toBe(0);
    expect(result.out).not.toMatch(WARNING);
    expect(result.out).not.toContain(PROMPT);
    expect(statusCalls(result)).toHaveLength(0);
    expect(tree(dir)).toEqual(before);
  });

  it.each(['ESPRESSO_NO_GIT_STATUS', 'EXPO_NO_GIT_STATUS'])('WB-12d: %s=1 skips the check and does not ask git', async (name) => {
    const dir = dirtyApp();
    const result = await run({}, dir, { spawnSync: realGit, tty: true, stdin: 'y\n', env: { [name]: '1' } });
    expect(result.code).toBe(0);
    expect(result.out).not.toMatch(WARNING);
    expect(result.out).not.toContain(PROMPT);
    expect(statusCalls(result)).toHaveLength(0);
  });

  it('WB-12d: a switch set to 0 does not skip the check', async () => {
    const result = await run({ yes: true }, dirtyApp(), { spawnSync: realGit, env: { ESPRESSO_NO_GIT_STATUS: '0', EXPO_NO_GIT_STATUS: '0' } });
    expect(result.out).toMatch(WARNING);
  });

  it('WB-12e: a clean work tree gives no warning and no question', async () => {
    const result = await run({}, cleanApp(), { spawnSync: realGit, tty: true, stdin: 'y\n' });
    expect(result.code).toBe(0);
    expect(result.out).not.toMatch(WARNING);
    expect(result.out).not.toContain(PROMPT);
    expect(statusCalls(result)).toHaveLength(1);
  });

  it('WB-12e: a folder that is not a work tree gives no warning and no question', async () => {
    const result = await run({}, app(), { tty: true, stdin: 'y\n' });
    expect(result.code).toBe(0);
    expect(result.out).not.toMatch(WARNING);
    expect(result.out).not.toContain(PROMPT);
  });

  it.each([
    ['git is not installed', { error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }), status: null, stdout: '' }],
    ['the command times out', { error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, stdout: '' }],
    ['the command fails', { status: 1, stdout: ' M x\0' }],
    ['the output is not text', { status: 0, stdout: null }],
  ])('WB-12e: when %s there is no warning and no question', async (_name, answer) => {
    const result = await run({}, app(), { tty: true, stdin: 'y\n', spawnSync: () => answer });
    expect(result.code).toBe(0);
    expect(result.out).not.toMatch(WARNING);
    expect(result.out).not.toContain(PROMPT);
  });

  it('WB-12: git is asked with constant arguments, without a shell, in the app folder, and on Windows with the safe environment', async () => {
    const dir = app();
    const unix = await run({ yes: true }, dir);
    const [file, args, options] = statusCalls(unix)[0];
    expect(file).toBe('git');
    expect(args).toEqual(['--no-optional-locks', 'status', '--porcelain', '-z', '--', '.']);
    expect(options.shell).toBe(false);
    expect(options.cwd).toBe(dir);
    const win = await run({ yes: true }, app(), { platform: 'win32', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe', Path: 'C:\\x' } });
    expect(statusCalls(win)[0][2].env.NoDefaultCurrentDirectoryInExePath).toBe('1');
  });

  it('WB-12f: a run with nothing to change does not ask git for the status, even when the tree is dirty', async () => {
    const dir = app({ deps: Object.fromEntries(ALL_PACKAGES.map((name) => [name, '^26.0.0'])) });
    commitAll(dir);
    await run({ yes: true }, dir, { spawnSync: realGit });
    const second = await run({}, dir, { spawnSync: realGit, tty: true, stdin: 'y\n' });
    expect(second.code).toBe(0);
    expect(second.spawnSync).not.toHaveBeenCalled();
    expect(second.out).not.toMatch(WARNING);
    expect(second.out).toMatch(/Nothing to change/);
  });

  it('WB-12: the packages are already installed but a native file still needs the edit: the check runs', async () => {
    const dir = app({ deps: Object.fromEntries(ALL_PACKAGES.map((name) => [name, '^26.0.0'])) });
    commitAll(dir);
    writeFileSync(join(dir, 'README.md'), 'mine\n');
    const result = await run({ yes: true }, dir, { spawnSync: realGit });
    expect(result.out).toMatch(WARNING);
    expect(result.spawn).not.toHaveBeenCalled();
  });

  it('WB-12 with WB-02: the copies are made as before when the person goes on', async () => {
    const dir = dirtyApp();
    const result = await run({ yes: true }, dir, { spawnSync: realGit });
    expect(backups(dir)).toEqual([]);
    expect(result.out).toMatch(/Git has the original of 4 files/);
  });
});
