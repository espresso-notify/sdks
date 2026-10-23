/**
 * @jest-environment node
 *
 * setup-wizard-bare-rn T5 (SWB-05): the two Gradle patchers. The project file gets the `google-services` classpath inside
 * `buildscript { dependencies { } }`, the app file gets `apply plugin: 'com.google.gms.google-services'` at its end, both
 * framed by `// espresso-notify:begin` and `// espresso-notify:end`. Run against the real template files of React Native
 * 0.87.1 and 0.79.7, and through `applyPatch` on a temporary copy.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { addedLines, FIXTURE_ROOT, fixture, onlyAddsLines, TEMPLATE_VERSIONS } from './helpers/bare-fixtures';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { gradleProject, gradleApp, GOOGLE_SERVICES_VERSION } = require('../bin/lib/patchers/gradle.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyPatch } = require('../bin/lib/patch.js');

const CLASSPATH = `classpath("com.google.gms:google-services:${GOOGLE_SERVICES_VERSION}")`;
const APPLY = "apply plugin: 'com.google.gms.google-services'";
const BEGIN = '// espresso-notify:begin google-services';
const END = '// espresso-notify:end';

const crlf = (text: string) => text.replace(/\r?\n/g, '\r\n');

describe('the google-services version constant (contract)', () => {
  it('is a MAJOR.MINOR.PATCH string', () => {
    expect(GOOGLE_SERVICES_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is the version that goes into the classpath', () => {
    const patched = gradleProject(fixture('0.87.1', 'android/build.gradle'), {}).text;
    expect(patched).toContain(`com.google.gms:google-services:${GOOGLE_SERVICES_VERSION}`);
  });
});

describe.each(TEMPLATE_VERSIONS)('gradleProject on the template of React Native %s', (version) => {
  const original = fixture(version, 'android/build.gradle');

  it('puts the classpath inside buildscript { dependencies { } }, framed by markers, and only adds lines', () => {
    const result = gradleProject(original, {});
    expect(result.status).toBe('patched');
    expect(onlyAddsLines(original, result.text)).toBe(true);
    expect(addedLines(original, result.text)).toEqual([`        ${BEGIN}`, `        ${CLASSPATH}`, `        ${END}`]);
    const lines = result.text.split('\n');
    const opener = lines.findIndex((l: string) => /^\s+dependencies \{$/.test(l));
    const begin = lines.indexOf(`        ${BEGIN}`);
    const closer = lines.findIndex((l: string, i: number) => i > opener && l === '    }');
    expect(opener).toBeGreaterThan(lines.findIndex((l: string) => l.startsWith('buildscript')));
    expect(begin).toBeGreaterThan(opener);
    expect(begin).toBeLessThan(closer);
  });

  it('is idempotent: the patched text is already', () => {
    const once = gradleProject(original, {}).text;
    expect(gradleProject(once, {})).toEqual({ status: 'already' });
  });

  it('keeps CRLF', () => {
    const result = gradleProject(crlf(original), {});
    expect(result.status).toBe('patched');
    expect(result.text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(result.text).toContain(`${BEGIN}\r\n        ${CLASSPATH}\r\n        ${END}\r\n`);
  });
});

describe.each(TEMPLATE_VERSIONS)('gradleApp on the template of React Native %s', (version) => {
  const original = fixture(version, 'android/app/build.gradle');

  it('adds apply plugin at the end of the file, framed by markers, and only adds lines', () => {
    const result = gradleApp(original, {});
    expect(result.status).toBe('patched');
    expect(onlyAddsLines(original, result.text)).toBe(true);
    expect(result.text.endsWith(`${BEGIN}\n${APPLY}\n${END}\n`)).toBe(true);
    expect(result.text.startsWith(original)).toBe(true);
    expect(result.text.slice(original.length)).toBe(`\n${BEGIN}\n${APPLY}\n${END}\n`);
  });

  it('is idempotent', () => {
    const once = gradleApp(original, {}).text;
    expect(gradleApp(once, {})).toEqual({ status: 'already' });
  });

  it('keeps CRLF', () => {
    const result = gradleApp(crlf(original), {});
    expect(result.status).toBe('patched');
    expect(result.text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(result.text.endsWith(`${BEGIN}\r\n${APPLY}\r\n${END}\r\n`)).toBe(true);
  });
});

describe('gradleProject: what it recognizes as already done', () => {
  const base = fixture('0.87.1', 'android/build.gradle');
  const withLine = (line: string) => base.replace('classpath("com.android.tools.build:gradle")', `classpath("com.android.tools.build:gradle")\n        ${line}`);

  it.each([
    `classpath "com.google.gms:google-services:4.4.2"`,
    `classpath 'com.google.gms:google-services:4.3.15'`,
    `classpath("com.google.gms:google-services:4.4.2")`,
  ])('the user\'s own %s wins and the text is not touched', (line) => {
    expect(gradleProject(withLine(line), {})).toEqual({ status: 'already' });
  });

  it('a plugins block that declares the plugin id counts', () => {
    const text = `plugins {\n    id 'com.google.gms.google-services' version '4.4.2' apply false\n}\n${base}`;
    expect(gradleProject(text, {})).toEqual({ status: 'already' });
  });

  it('a commented-out classpath does not count', () => {
    const result = gradleProject(withLine(`// classpath 'com.google.gms:google-services:4.4.2'`), {});
    expect(result.status).toBe('patched');
  });

  it('the begin marker alone counts, so a second run never doubles the block', () => {
    expect(gradleProject(`buildscript {\n    dependencies {\n        ${BEGIN}\n    }\n}\n`, {})).toEqual({ status: 'already' });
  });
});

describe('gradleApp: what it recognizes as already done', () => {
  const base = fixture('0.87.1', 'android/app/build.gradle');

  it.each([
    `apply plugin: 'com.google.gms.google-services'`,
    `apply plugin: "com.google.gms.google-services"`,
    `    id 'com.google.gms.google-services'`,
    `    id("com.google.gms.google-services")`,
  ])('%s', (line) => {
    expect(gradleApp(`${base}\n${line}\n`, {})).toEqual({ status: 'already' });
  });

  it('a commented-out apply plugin does not count', () => {
    expect(gradleApp(`${base}\n// apply plugin: 'com.google.gms.google-services'\n`, {}).status).toBe('patched');
  });
});

describe('gradle patchers: what they refuse', () => {
  it('Kotlin DSL files', () => {
    const project = gradleProject(fixture('0.87.1', 'android/build.gradle'), { file: '/app/android/build.gradle.kts' });
    expect(project.status).toBe('unsupported');
    expect(project.reason).toMatch(/Kotlin/);
    const app = gradleApp(fixture('0.87.1', 'android/app/build.gradle'), { file: '/app/android/app/build.gradle.kts' });
    expect(app.status).toBe('unsupported');
  });

  it('a project file without buildscript, and one whose buildscript has no dependencies block', () => {
    expect(gradleProject('apply plugin: "com.facebook.react.rootproject"\n', {}).status).toBe('unsupported');
    const noDeps = 'buildscript {\n    repositories {\n        google()\n    }\n}\n';
    const result = gradleProject(noDeps, {});
    expect(result.status).toBe('unsupported');
    expect(result.reason).toMatch(/dependencies/);
  });

  it('a dependencies block that is not inside buildscript', () => {
    const text = 'buildscript {\n    repositories {\n        google()\n    }\n}\ndependencies {\n    implementation "x:y:1"\n}\n';
    expect(gradleProject(text, {}).status).toBe('unsupported');
  });

  it('a dependencies block written on one line, and unbalanced braces', () => {
    expect(gradleProject("buildscript {\n    dependencies { classpath 'a:b:1' }\n}\n", {}).status).toBe('unsupported');
    expect(gradleProject('buildscript {\n    dependencies {\n', {}).status).toBe('unsupported');
  });

  it('braces inside strings and comments do not confuse the block', () => {
    const text =
      "buildscript {\n    ext { note = '}' }\n    // }\n    dependencies {\n        classpath(\"a:b:1\")\n    }\n}\n";
    const result = gradleProject(text, {});
    expect(result.status).toBe('patched');
    expect(result.text.split('\n')[4]).toBe(`        ${BEGIN}`);
  });

  it('an app file that is not an Android application module', () => {
    const result = gradleApp('apply plugin: "com.android.library"\n', {});
    expect(result.status).toBe('unsupported');
    expect(result.reason).toMatch(/application/);
  });
});

describe('gradle patchers: line endings and the end of the file', () => {
  it('the app file without a final newline gets none added at the end', () => {
    const original = fixture('0.87.1', 'android/app/build.gradle').replace(/\n+$/, '');
    const result = gradleApp(original, {});
    expect(result.status).toBe('patched');
    expect(result.text.endsWith(`${END}`)).toBe(true);
    expect(onlyAddsLines(original, result.text)).toBe(true);
  });

  it('a mixed file takes the line ending of the anchor line', () => {
    const text = 'buildscript {\r\n    dependencies {\n        classpath("a:b:1")\n    }\r\n}\r\n';
    const result = gradleProject(text, {});
    expect(result.text).toContain(`    dependencies {\n        ${BEGIN}\n        ${CLASSPATH}\n        ${END}\n        classpath("a:b:1")`);
  });
});

describe('gradle patchers through applyPatch on a copy of the template', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it.each(TEMPLATE_VERSIONS)('React Native %s: first run adds, second run changes nothing and makes no copy', (version) => {
    const dir = mkdtempSync(join(tmpdir(), 'espresso-gradle-'));
    dirs.push(dir);
    const rels = ['android/build.gradle', 'android/app/build.gradle'];
    for (const rel of rels) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      cpSync(join(FIXTURE_ROOT, version, rel), join(dir, rel));
    }
    const now = new Date(2026, 9, 23, 10, 0, 0);
    const run = () => [
      applyPatch({ file: join(dir, rels[0]), patcher: gradleProject, context: { file: join(dir, rels[0]) }, now }),
      applyPatch({ file: join(dir, rels[1]), patcher: gradleApp, context: { file: join(dir, rels[1]) }, now }),
    ];
    const first = run();
    expect(first.map((r) => r.status)).toEqual(['patched', 'patched']);
    for (const rel of rels) {
      expect(onlyAddsLines(fixture(version, rel), readFileSync(join(dir, rel), 'utf8'))).toBe(true);
    }
    const afterFirst = rels.map((rel) => readFileSync(join(dir, rel), 'utf8'));
    const second = run();
    expect(second.map((r) => r.status)).toEqual(['already', 'already']);
    expect(rels.map((rel) => readFileSync(join(dir, rel), 'utf8'))).toEqual(afterFirst);
    expect(readdirSync(join(dir, 'android')).filter((n) => n.endsWith('.bak'))).toHaveLength(1);
    expect(readdirSync(join(dir, 'android/app')).filter((n) => n.endsWith('.bak'))).toHaveLength(1);
  });
});
