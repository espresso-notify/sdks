/**
 * @jest-environment node
 *
 * setup-wizard-bare-rn T3 (SWB-01): `detectProject` tells what kind of project a folder is, which React Native it runs,
 * which package manager it uses and which native files the wizard can patch. It reads, and never writes.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { detectProject, reactNativeFromRange } = require('../bin/lib/project.js');

const FIXTURES = join(__dirname, 'fixtures', 'bare-templates');

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

type Files = Record<string, string | object>;

/** A project folder with the given files; a name ending in "/" makes an empty folder; objects are written as JSON. */
function project(files: Files): string {
  const dir = mkdtempSync(join(tmpdir(), 'espresso-detect-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith('/')) {
      mkdirSync(join(dir, name), { recursive: true });
      continue;
    }
    const file = join(dir, name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  }
  return dir;
}

const bareApp = (deps: Record<string, string> = { 'react-native': '0.87.1' }, extra: Files = {}): Files => ({
  'package.json': { name: 'app', dependencies: deps },
  ...extra,
});

/** Every path and size under `dir`, to prove nothing was written. */
function tree(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      return entry.isDirectory() ? [`${entry.name}/`, ...tree(full).map((p) => `${entry.name}/${p}`)] : [`${entry.name}:${statSync(full).size}`];
    })
    .sort();
}

describe('detectProject: the kind of project', () => {
  it('is expo when expo is a dependency, even with react-native next to it', () => {
    const dir = project(bareApp({ expo: '~57.0.26', 'react-native': '0.85.0' }));
    expect(detectProject(dir).kind).toBe('expo');
  });

  it('is expo when expo is only a devDependency', () => {
    const dir = project({ 'package.json': { devDependencies: { expo: '^53.0.0' } } });
    expect(detectProject(dir).kind).toBe('expo');
  });

  it('is bare when there is react-native and no expo', () => {
    const dir = project(bareApp());
    expect(detectProject(dir).kind).toBe('bare');
  });

  it('is none with neither, and says why', () => {
    const dir = project({ 'package.json': { dependencies: { react: '19.0.0' } } });
    const found = detectProject(dir);
    expect(found.kind).toBe('none');
    expect(found.reason).toBe('no-react-native');
  });

  it('is none without package.json, and with one that is not JSON', () => {
    const empty = project({});
    expect(detectProject(empty)).toMatchObject({ kind: 'none', reason: 'no-package-json' });
    const broken = project({ 'package.json': '{ not json' });
    expect(detectProject(broken)).toMatchObject({ kind: 'none', reason: 'unreadable-package-json' });
  });

  it('reads a package.json that starts with a byte order mark', () => {
    const dir = project({ 'package.json': '﻿{"dependencies":{"react-native":"0.79.7"}}' });
    expect(detectProject(dir).kind).toBe('bare');
  });
});

describe('detectProject: the React Native version', () => {
  it('reads the installed version from node_modules first', () => {
    const dir = project(
      bareApp({ 'react-native': '^0.79.0' }, { 'node_modules/react-native/package.json': { name: 'react-native', version: '0.79.7' } }),
    );
    expect(detectProject(dir).reactNative).toMatchObject({ major: 0, minor: 79, patch: 7, version: '0.79.7', source: 'installed' });
  });

  it.each([
    ['^0.79.7', 79],
    ['0.87.1', 87],
    ['~0.80.0', 80],
    ['0.79.x', 79],
    ['^0.81', 81],
    ['v0.82.1', 82],
    ['0.80.0-rc.2', 80],
  ])('reads the range %s from package.json when nothing is installed', (range, minor) => {
    const dir = project(bareApp({ 'react-native': range }));
    expect(detectProject(dir).reactNative).toMatchObject({ major: 0, minor, source: 'range' });
  });

  it.each(['latest', '>=0.79.0', 'file:../react-native', 'npm:react-native@0.79.7', 'nightly', ''])(
    'does not guess from %p',
    (range) => {
      const dir = project(bareApp({ 'react-native': range || '*' }));
      expect(detectProject(dir).reactNative).toBeNull();
    },
  );

  it('parses ranges without touching the disk', () => {
    expect(reactNativeFromRange('~0.80.0')).toMatchObject({ minor: 80 });
    expect(reactNativeFromRange('x')).toBeNull();
  });
});

describe('detectProject: the package manager', () => {
  it.each([
    ['yarn.lock', 'yarn'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ])('%s means %s', (lock, manager) => {
    const dir = project(bareApp(undefined, { [lock]: '' }));
    const found = detectProject(dir);
    expect(found.packageManager).toBe(manager);
    expect(found.warnings).toEqual([]);
  });

  it('is npm without a lock file', () => {
    expect(detectProject(project(bareApp())).packageManager).toBe('npm');
  });

  it('with two locks takes the one of highest priority and warns', () => {
    const dir = project(bareApp(undefined, { 'yarn.lock': '', 'package-lock.json': '{}' }));
    const found = detectProject(dir);
    expect(found.packageManager).toBe('yarn');
    expect(found.warnings).toHaveLength(1);
    expect(found.warnings[0]).toContain('yarn.lock');
    expect(found.warnings[0]).toContain('package-lock.json');
  });

  it('prefers pnpm over yarn and bun over npm when they are together', () => {
    expect(detectProject(project(bareApp(undefined, { 'pnpm-lock.yaml': '', 'yarn.lock': '' }))).packageManager).toBe('pnpm');
    expect(detectProject(project(bareApp(undefined, { 'bun.lock': '', 'package-lock.json': '{}' }))).packageManager).toBe('bun');
  });
});

describe('detectProject: ios and android', () => {
  it('reports hasIos and hasAndroid false when the folders are missing', () => {
    const found = detectProject(project(bareApp()));
    expect(found.hasIos).toBe(false);
    expect(found.hasAndroid).toBe(false);
    expect(found.files).toEqual({ podfile: null, gradleProject: null, gradleApp: null, appDelegate: null, manifest: null });
  });

  it('reports each folder on its own', () => {
    const iosOnly = detectProject(project(bareApp(undefined, { 'ios/': '' })));
    expect(iosOnly).toMatchObject({ hasIos: true, hasAndroid: false });
    const androidOnly = detectProject(project(bareApp(undefined, { 'android/': '' })));
    expect(androidOnly).toMatchObject({ hasIos: false, hasAndroid: true });
  });

  it('takes the app name from the .xcodeproj folder', () => {
    const dir = project(bareApp(undefined, { 'ios/Shopper.xcodeproj/project.pbxproj': '', 'ios/Pods/Pods.xcodeproj/x': '', 'app.json': { name: 'Other' } }));
    expect(detectProject(dir).appName).toBe('Shopper');
  });

  it('ignores Pods.xcodeproj and falls back to app.json', () => {
    const dir = project(bareApp(undefined, { 'ios/Pods.xcodeproj/project.pbxproj': '', 'app.json': { name: 'FromJson', displayName: 'Nice' } }));
    expect(detectProject(dir).appName).toBe('FromJson');
  });

  it('takes the name from app.json when there is no .xcodeproj, and is null with neither', () => {
    expect(detectProject(project(bareApp(undefined, { 'app.json': { name: 'JustJson' } }))).appName).toBe('JustJson');
    expect(detectProject(project(bareApp(undefined, { 'ios/': '' }))).appName).toBeNull();
  });

  it('finds the five native files of a template app', () => {
    const dir = project(bareApp());
    for (const rel of ['ios/Podfile', 'ios/HelloWorld/AppDelegate.swift', 'android/build.gradle', 'android/app/build.gradle', 'android/app/src/main/AndroidManifest.xml']) {
      cpSync(join(FIXTURES, '0.87.1', rel), join(dir, rel), { recursive: true });
    }
    mkdirSync(join(dir, 'ios', 'HelloWorld.xcodeproj'), { recursive: true });
    const found = detectProject(dir);
    expect(found.appName).toBe('HelloWorld');
    expect(found.files).toEqual({
      podfile: join(dir, 'ios/Podfile'),
      appDelegate: join(dir, 'ios/HelloWorld/AppDelegate.swift'),
      gradleProject: join(dir, 'android/build.gradle'),
      gradleApp: join(dir, 'android/app/build.gradle'),
      manifest: join(dir, 'android/app/src/main/AndroidManifest.xml'),
    });
  });

  it('finds AppDelegate.mm when there is no .swift', () => {
    const dir = project(bareApp(undefined, { 'ios/Old.xcodeproj/x': '', 'ios/Old/AppDelegate.mm': '#import "AppDelegate.h"\n' }));
    expect(detectProject(dir).files.appDelegate).toBe(join(dir, 'ios/Old/AppDelegate.mm'));
  });

  it('prefers AppDelegate.swift when both exist', () => {
    const dir = project(bareApp(undefined, { 'ios/Old.xcodeproj/x': '', 'ios/Old/AppDelegate.mm': '', 'ios/Old/AppDelegate.swift': '' }));
    expect(detectProject(dir).files.appDelegate).toBe(join(dir, 'ios/Old/AppDelegate.swift'));
  });

  it('finds an AppDelegate whose folder is not named like the project when it is the only one', () => {
    const dir = project(bareApp(undefined, { 'ios/App.xcodeproj/x': '', 'ios/Source/AppDelegate.swift': '', 'ios/Pods/Foo/AppDelegate.swift': '' }));
    expect(detectProject(dir).files.appDelegate).toBe(join(dir, 'ios/Source/AppDelegate.swift'));
  });

  it('leaves appDelegate null when two folders have one and none is named like the project', () => {
    const dir = project(bareApp(undefined, { 'ios/App.xcodeproj/x': '', 'ios/A/AppDelegate.swift': '', 'ios/B/AppDelegate.swift': '' }));
    expect(detectProject(dir).files.appDelegate).toBeNull();
  });

  it('reports Kotlin DSL Gradle files so the wizard can say it does not edit them', () => {
    const dir = project(bareApp(undefined, { 'android/build.gradle.kts': '', 'android/app/build.gradle.kts': '' }));
    const found = detectProject(dir);
    expect(found.files.gradleProject).toBe(join(dir, 'android/build.gradle.kts'));
    expect(found.files.gradleApp).toBe(join(dir, 'android/app/build.gradle.kts'));
  });
});

describe('detectProject: it writes nothing', () => {
  it('leaves the folder tree as it was', () => {
    const dir = project(
      bareApp(undefined, {
        'yarn.lock': '',
        'app.json': { name: 'A' },
        'ios/A.xcodeproj/project.pbxproj': 'x',
        'ios/A/AppDelegate.swift': 'class A {}\n',
        'ios/Podfile': "target 'A' do\nend\n",
        'android/app/build.gradle': '',
        'android/build.gradle': '',
      }),
    );
    const before = tree(dir);
    detectProject(dir);
    detectProject(dir);
    expect(tree(dir)).toEqual(before);
  });
});
