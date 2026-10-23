/**
 * @jest-environment node
 *
 * setup-wizard-bare-rn T8 (SWB-01, SWB-02, SWB-03, SWB-07): `runBare`, the flow of the setup wizard for React Native CLI
 * apps. Every test works in a temporary app folder built from the real template files of React Native 0.87.1 and 0.79.7,
 * and replaces `spawn`: no package manager ever runs here.
 */
import { EventEmitter } from 'events';
import fs, { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { FIXTURE_ROOT, fixture, onlyAddsLines } from './helpers/bare-fixtures';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runBare } = require('../bin/lib/bare.js');
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

const backups = (dir: string) => Object.keys(snapshot(dir)).filter((name) => name.endsWith('.bak'));

type RunOptions = {
  closeCode?: number;
  spawnError?: Error;
  stdin?: string;
  tty?: boolean;
  platform?: string;
  env?: Record<string, string | undefined>;
  onInstall?: () => void;
  fs?: any;
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
  const stdin = new PassThrough();
  if (opts.stdin !== undefined) stdin.end(opts.stdin);
  const code: number = await runBare(
    { dryRun: false, yes: false, ...flags },
    {
      cwd,
      spawn,
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
  return { code, out: out.join(''), err: err.join(''), all: out.join('') + err.join(''), spawn };
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
      const target = copy.replace(/\.espresso-notify-\d{8}T\d{6}(-\d+)?\.bak$/, '');
      expect(readFileSync(join(dir, copy), 'utf8')).toBe(original[target]);
    }
    expect(first.out).toMatch(/\.bak/);

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
