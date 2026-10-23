/**
 * @jest-environment node
 *
 * setup-wizard-bare-rn T10 (SWB-08, SWB-09): the steps the wizard prints for what it does not do (the Firebase files, Xcode,
 * the APNs key, the service account, `index.js`, the hook, iOS 27) and the optional `pod install`. Every test works in a
 * temporary app folder and replaces `spawn`: no `pod` ever runs here.
 */
import { EventEmitter } from 'events';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { FIXTURE_ROOT, fixture } from './helpers/bare-fixtures';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runBare } = require('../bin/lib/bare.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { manualSteps } = require('../bin/lib/guide.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const setup = require('../bin/setup.js');

const helpers = {
  makePrompter: setup.makePrompter,
  Stop: setup.Stop,
  installEnvironment: setup.installEnvironment,
  keyProblem: setup.keyProblem,
  hookSnippet: setup.hookSnippet,
  PLACEHOLDER_KEY: setup.PLACEHOLDER_KEY,
  BARE_GUIDE: setup.BARE_GUIDE,
};

const GUIDE = 'https://docs.espressonotify.com/docs/react-native/bare';
const ALL = ['@espresso-notify/react-native', '@react-native-firebase/app', '@react-native-firebase/messaging', 'react-native-notify-kit'];
const PUBLIC_KEY = 'pk_test_abcdef123456';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

type AppOptions = { deps?: Record<string, string>; ios?: boolean; android?: boolean; files?: Record<string, string>; gemfile?: boolean };

/** An app of the 0.87.1 template with every package installed (so the only `spawn` is the one of `pod install`). */
function app(opts: AppOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'espresso-guide-'));
  dirs.push(dir);
  const pkg = JSON.parse(fixture('0.87.1', 'package.json'));
  for (const name of ALL) pkg.dependencies[name] = '^26.0.0';
  Object.assign(pkg.dependencies, opts.deps ?? {});
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  mkdirSync(join(dir, 'node_modules', 'react-native'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'react-native', 'package.json'), JSON.stringify({ version: '0.87.1' }));
  const copy = (rel: string) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    cpSync(join(FIXTURE_ROOT, '0.87.1', rel), join(dir, rel));
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
  if (opts.gemfile) writeFileSync(join(dir, 'Gemfile'), "source 'https://rubygems.org'\ngem 'cocoapods'\n");
  for (const [rel, text] of Object.entries(opts.files ?? {})) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

function snapshot(dir: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, snapshot(dir, rel));
    else result[rel] = readFileSync(join(dir, rel), 'utf8');
  }
  return result;
}

type RunOptions = { closeCode?: number; spawnError?: Error; stdin?: string; tty?: boolean; platform?: string; env?: Record<string, string | undefined> };

async function run(flags: Partial<{ dryRun: boolean; yes: boolean; key: string; pods: boolean }>, cwd: string, opts: RunOptions = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const spawn = jest.fn((_cmd: string, _args: string[], _options: any) => {
    const child: any = new EventEmitter();
    setImmediate(() => {
      if (opts.spawnError) return child.emit('error', opts.spawnError);
      return child.emit('close', opts.closeCode ?? 0);
    });
    return child;
  });
  const stdin = new PassThrough();
  if (opts.stdin !== undefined) stdin.end(opts.stdin);
  const code: number = await runBare(
    { dryRun: false, yes: true, pods: false, ...flags },
    {
      cwd,
      spawn,
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      stdin,
      isTTY: opts.tty ?? false,
      platform: opts.platform ?? 'darwin',
      env: opts.env ?? {},
      now: () => new Date(2026, 9, 23, 10, 0, 0),
    },
    helpers,
  );
  return { code, out: out.join(''), err: err.join(''), all: out.join('') + err.join(''), spawn };
}

describe('the Firebase files', () => {
  it('without google-services.json and GoogleService-Info.plist both paths and the place to get them are printed', async () => {
    const dir = app();
    const result = await run({}, dir);
    expect(result.code).toBe(0);
    expect(result.out).toContain('android/app/google-services.json');
    expect(result.out).toContain('ios/HelloWorld/GoogleService-Info.plist');
    expect(result.out).toMatch(/Firebase console/);
  });

  it('says that the Android build stops until google-services.json is in place', async () => {
    const dir = app();
    const result = await run({}, dir);
    expect(result.out).toMatch(/Android build (fails|stops) until/);
  });

  it('with both files in place they are not asked for', async () => {
    const dir = app({ files: { 'android/app/google-services.json': '{}', 'ios/HelloWorld/GoogleService-Info.plist': '<plist/>' } });
    const result = await run({}, dir);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain('android/app/google-services.json');
    expect(result.out).not.toContain('ios/HelloWorld/GoogleService-Info.plist');
  });

  it('only the missing one is listed', async () => {
    const dir = app({ files: { 'android/app/google-services.json': '{}' } });
    const result = await run({}, dir);
    expect(result.out).not.toContain('android/app/google-services.json');
    expect(result.out).toContain('ios/HelloWorld/GoogleService-Info.plist');
  });

  it('never creates either file', async () => {
    const dir = app();
    await run({}, dir);
    const names = Object.keys(snapshot(dir));
    expect(names).not.toContain('android/app/google-services.json');
    expect(names).not.toContain('ios/HelloWorld/GoogleService-Info.plist');
  });
});

describe('the steps the wizard does not do', () => {
  it('Xcode, the APNs key, the service account, index.js and iOS 27 are all there, with the link of the guide', async () => {
    const result = await run({}, app());
    expect(result.out).toMatch(/Push Notifications/);
    expect(result.out).toMatch(/Background Modes/);
    expect(result.out).toMatch(/Remote notifications/);
    expect(result.out).toMatch(/APNs/);
    expect(result.out).toMatch(/Cloud Messaging/);
    expect(result.out).toMatch(/service account/i);
    expect(result.out).toMatch(/Native Push/);
    expect(result.out).toContain('onBackgroundEvent');
    expect(result.out).toContain('AppRegistry.registerComponent');
    expect(result.out).toMatch(/iOS 27/);
    expect(result.out).toContain(GUIDE);
  });

  it('the Android 13 notification permission comes with react-native-notify-kit (D-246: the manifest is not edited)', async () => {
    const result = await run({}, app());
    expect(result.out).toContain('the notification permission android.permission.POST_NOTIFICATIONS comes with react-native-notify-kit;');
    expect(result.out).toContain('if you removed that package, add <uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>');
  });

  it('a project without android/ gets no step about the Android notification permission', async () => {
    const result = await run({}, app({ android: false }));
    expect(result.out).not.toContain('POST_NOTIFICATIONS');
  });

  it('the steps are in English', async () => {
    const result = await run({}, app());
    expect(result.out).not.toMatch(/[ãõçáéíóú]/i);
  });

  it('manualSteps keeps the iOS lines out when there is no ios folder', () => {
    const lines: string[] = manualSteps({
      hasIos: false, hasAndroid: true, iosAppDir: null, hasGoogleServicesJson: false, hasPlist: false, hasAsyncStorage: true, guideUrl: GUIDE,
    });
    const text = lines.join('\n');
    expect(text).toContain('android/app/google-services.json');
    expect(text).not.toMatch(/Xcode|APNs|GoogleService-Info/);
  });
});

describe('the hook and the public key', () => {
  it('the key given goes into the snippet and into no file', async () => {
    const dir = app();
    const before = snapshot(dir);
    const result = await run({ key: PUBLIC_KEY }, dir);
    expect(result.out).toContain(`projectId: '${PUBLIC_KEY}'`);
    const after = snapshot(dir);
    for (const [name, text] of Object.entries(after)) expect(text).not.toContain(PUBLIC_KEY);
    const added = Object.keys(after).filter((name) => !(name in before));
    expect(added.every((name) => name.endsWith('.bak'))).toBe(true);
  });

  it('without a key the snippet carries the placeholder', async () => {
    const result = await run({}, app());
    expect(result.out).toContain("projectId: 'pk_live_xxxxxxxxxxxx'");
  });

  it('on a terminal the wizard asks for the key, and a secret key typed there ends the run with 1 without repeating it', async () => {
    const dir = app();
    const result = await run({ yes: false }, dir, { tty: true, stdin: 'y\nn\nsk_live_supersecretvalue\n' });
    expect(result.code).toBe(1);
    expect(result.all).not.toContain('sk_live_supersecretvalue');
    expect(result.err).toMatch(/SECRET/);
  });

  it('a public key typed on a terminal goes into the snippet', async () => {
    const result = await run({ yes: false }, app(), { tty: true, stdin: `y\nn\n${PUBLIC_KEY}\n` });
    expect(result.code).toBe(0);
    expect(result.out).toContain(`projectId: '${PUBLIC_KEY}'`);
  });
});

describe('the hint about async-storage', () => {
  it('without @react-native-async-storage/async-storage the queue stays in memory and the hint says so', async () => {
    const result = await run({}, app());
    expect(result.out).toContain('@react-native-async-storage/async-storage');
    expect(result.out).toMatch(/memory/);
  });

  it('with it the hint is not printed', async () => {
    const result = await run({}, app({ deps: { '@react-native-async-storage/async-storage': '^2.0.0' } }));
    expect(result.out).not.toContain('@react-native-async-storage/async-storage');
  });
});

describe('pod install', () => {
  it('on macOS with a Gemfile the command is bundle exec pod install, run in ios/', async () => {
    const dir = app({ gemfile: true });
    const result = await run({ pods: true }, dir);
    expect(result.code).toBe(0);
    expect(result.spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = result.spawn.mock.calls[0];
    expect(cmd).toBe('bundle');
    expect(args).toEqual(['exec', 'pod', 'install']);
    expect(options.cwd).toBe(join(dir, 'ios'));
    expect(options.shell).toBe(false);
  });

  it('on macOS without a Gemfile it is pod install', async () => {
    const dir = app();
    const result = await run({ pods: true }, dir);
    const [cmd, args] = result.spawn.mock.calls[0];
    expect([cmd, ...args]).toEqual(['pod', 'install']);
  });

  it('--pods runs it once without asking, even on a terminal', async () => {
    const result = await run({ pods: true, yes: false }, app(), { tty: true, stdin: 'y\n' });
    expect(result.spawn).toHaveBeenCalledTimes(1);
    expect(result.out).not.toMatch(/Run pod install now/);
  });

  it('--yes without --pods does not run it and prints the command', async () => {
    const result = await run({ yes: true }, app({ gemfile: true }));
    expect(result.code).toBe(0);
    expect(result.spawn).not.toHaveBeenCalled();
    expect(result.out).toContain('bundle exec pod install');
  });

  it('without a terminal, --yes or --pods it does not run either', async () => {
    const result = await run({ yes: false }, app());
    expect(result.spawn).not.toHaveBeenCalled();
  });

  it('on a terminal it asks, and a yes runs it', async () => {
    const result = await run({ yes: false }, app(), { tty: true, stdin: 'y\ny\n\n' });
    expect(result.out).toMatch(/Run pod install now\? \[y\/N\]/);
    expect(result.spawn).toHaveBeenCalledTimes(1);
  });

  it.each(['n\n', '\n'])('on a terminal an answer of %j does not run it', async (answer) => {
    const result = await run({ yes: false }, app(), { tty: true, stdin: `y\n${answer}\n` });
    expect(result.spawn).not.toHaveBeenCalled();
    expect(result.out).toContain('pod install');
  });

  it.each(['linux', 'win32'])('on %s there is no question and no run, and the command is printed for a Mac', async (platform) => {
    const result = await run({ yes: false, pods: true }, app(), { platform, tty: true, stdin: 'y\n' });
    expect(result.spawn).not.toHaveBeenCalled();
    expect(result.out).not.toMatch(/Run pod install now/);
    expect(result.out).toMatch(/macOS/);
    expect(result.code).toBe(0);
  });

  it('an app without an ios folder has nothing to install', async () => {
    const result = await run({ pods: true }, app({ ios: false }));
    expect(result.spawn).not.toHaveBeenCalled();
    expect(result.code).toBe(0);
  });

  it('a failed pod install ends with 2, keeps the edits, and prints the command to run', async () => {
    const dir = app();
    const result = await run({ pods: true }, dir, { closeCode: 1 });
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/pod install/);
    expect(result.err).toMatch(/ios/);
    expect(readFileSync(join(dir, 'ios/Podfile'), 'utf8')).toContain('use_frameworks! :linkage => :dynamic');
  });

  it('an error from spawn ends with 2 as well', async () => {
    const result = await run({ pods: true }, app(), { spawnError: new Error('ENOENT') });
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/ENOENT/);
  });

  it('the step warns that USE_FRAMEWORKS=static at install time breaks Firebase', async () => {
    const result = await run({}, app());
    expect(result.out).toMatch(/USE_FRAMEWORKS=static/);
    expect(result.out).toMatch(/Firebase/);
  });

  it('with USE_FRAMEWORKS=static in the environment the wizard does not run it, even with --pods', async () => {
    const result = await run({ pods: true }, app(), { env: { USE_FRAMEWORKS: 'static' } });
    expect(result.spawn).not.toHaveBeenCalled();
    expect(result.out).toMatch(/USE_FRAMEWORKS=static/);
    expect(result.out).toMatch(/unset/i);
    expect(result.code).toBe(0);
  });

  it('--dry-run says what it would run and runs nothing', async () => {
    const result = await run({ dryRun: true, pods: true }, app());
    expect(result.spawn).not.toHaveBeenCalled();
    expect(result.out).toMatch(/Would run: pod install/);
    expect(result.out).toMatch(/Dry run: nothing was changed/);
  });

  it('the steps come in order: pods, hook, what is left, then the summary', async () => {
    const result = await run({}, app());
    const at = (text: string) => result.out.indexOf(text);
    expect(at('[4/6]')).toBeGreaterThan(at('[3/6]'));
    expect(at('[5/6]')).toBeGreaterThan(at('[4/6]'));
    expect(at('[6/6]')).toBeGreaterThan(at('[5/6]'));
    expect(at('Copies of the original files')).toBeGreaterThan(at('[6/6]'));
  });
});
