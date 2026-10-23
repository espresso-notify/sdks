/**
 * @jest-environment node
 *
 * setup-wizard-bare-rn T1 (SWB-04, SWB-05, SWB-06): the text files of the React Native CLI template that the wizard's
 * patchers read, kept as fixtures so every patcher is tested against the real shape and not against what we imagine.
 * This test only checks that the fixtures are what the patchers need (present, UTF-8, small, with their anchors, and
 * free of real data).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const FIXTURES = join(__dirname, 'fixtures', 'bare-templates');
const VERSIONS = ['0.87.1', '0.79.7'];

/** The files each template version must carry, relative to its folder. HelloWorld is the template's own app name. */
const FILES = {
  podfile: 'ios/Podfile',
  appDelegate: 'ios/HelloWorld/AppDelegate.swift',
  gradleProject: 'android/build.gradle',
  gradleApp: 'android/app/build.gradle',
  manifest: 'android/app/src/main/AndroidManifest.xml',
  packageJson: 'package.json',
};

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? allFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe.each(VERSIONS)('template fixtures %s', (version) => {
  const root = join(FIXTURES, version);
  const read = (name: keyof typeof FILES) => readFileSync(join(root, FILES[name]), 'utf8');

  it.each(Object.entries(FILES))('has %s at %s', (_name, file) => {
    expect(existsSync(join(root, file))).toBe(true);
  });

  it('keeps only text files under 1 MB, valid UTF-8, and none of the generated or project files', () => {
    const files = allFiles(root);
    expect(files.length).toBe(Object.keys(FILES).length);
    for (const file of files) {
      const rel = relative(root, file);
      expect(statSync(file).size).toBeLessThan(1024 * 1024);
      const bytes = readFileSync(file);
      expect(new TextEncoder().encode(new TextDecoder('utf-8', { fatal: true }).decode(bytes))).toEqual(new Uint8Array(bytes));
      expect(rel).not.toMatch(/(^|\/)(Pods|node_modules|build|DerivedData)\//);
      expect(rel).not.toMatch(/\.(xcodeproj|xcworkspace|pbxproj|keystore|png|jar)$/);
    }
  });

  it('has the Podfile anchors: the app target and use_react_native!', () => {
    const podfile = read('podfile');
    expect(podfile).toMatch(/^target '[^']+' do$/m);
    expect(podfile).toMatch(/^\s+use_react_native!\(/m);
    expect(podfile.indexOf("target '")).toBeLessThan(podfile.indexOf('use_react_native!'));
  });

  it('has the Gradle anchors: buildscript with dependencies in the project file, the plugin list in the app file', () => {
    const project = read('gradleProject');
    expect(project).toMatch(/^buildscript \{/m);
    expect(project).toMatch(/^\s+dependencies \{/m);
    expect(project.indexOf('buildscript')).toBeLessThan(project.indexOf('dependencies'));
    expect(read('gradleApp')).toMatch(/^apply plugin: "com\.android\.application"$/m);
  });

  it('has the AppDelegate anchors: the Swift method and the module imports', () => {
    const delegate = read('appDelegate');
    expect(delegate).toContain('didFinishLaunchingWithOptions');
    expect(delegate).toMatch(/^import UIKit$/m);
    expect(delegate).toMatch(/^class AppDelegate\b/m);
  });

  it('has the manifest anchor: <application and a manifest without POST_NOTIFICATIONS', () => {
    const manifest = read('manifest');
    expect(manifest).toContain('<application');
    expect(manifest).not.toContain('POST_NOTIFICATIONS');
  });

  it('is the template of that React Native version', () => {
    const pkg = JSON.parse(read('packageJson'));
    expect(pkg.dependencies['react-native']).toBe(version);
  });

  it('has no real data: no machine path, no key, no customer name', () => {
    for (const file of allFiles(root)) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\\\|\/private\/tmp/);
      expect(text).not.toMatch(/AIza[0-9A-Za-z_-]{20}|sk_(live|test)_|pk_(live|test)_|-----BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{12}/);
      expect(text).not.toMatch(/espresso|caffeee|fabrica|sg2|barepushtest/i);
    }
  });
});

describe('template fixtures README', () => {
  it('says where the files came from, when, and for which versions', () => {
    const readme = readFileSync(join(FIXTURES, 'README.md'), 'utf8');
    expect(readme).toContain('@react-native-community/template');
    for (const version of VERSIONS) expect(readme).toContain(version);
    expect(readme).toMatch(/20\d\d-\d\d-\d\d/);
  });
});
