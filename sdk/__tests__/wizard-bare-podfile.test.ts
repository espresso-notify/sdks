/**
 * @jest-environment node
 *
 * setup-wizard-bare-rn T4 (SWB-04): the Podfile patcher. It puts `use_frameworks! :linkage => :dynamic` inside the app
 * target, before `use_react_native!`, framed by `# espresso-notify:begin` and `# espresso-notify:end`. The stock block of
 * the React Native CLI template (`linkage = ENV['USE_FRAMEWORKS']` ... `use_frameworks! :linkage => linkage.to_sym`) is
 * the template form and does not stop the patch (owner decision of 2026-10-23, SWB-04.2). Run against the real template
 * files of React Native 0.87.1 and 0.79.7, and through `applyPatch` on a temporary copy.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { addedLines, FIXTURE_ROOT, fixture, onlyAddsLines, TEMPLATE_VERSIONS } from './helpers/bare-fixtures';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { podfile } = require('../bin/lib/patchers/podfile.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyPatch } = require('../bin/lib/patch.js');

const BEGIN = '# espresso-notify:begin use-frameworks';
const END = '# espresso-notify:end';
const LINE = 'use_frameworks! :linkage => :dynamic';

const crlf = (text: string) => text.replace(/\r?\n/g, '\r\n');

/** The stock block as the owner quoted it, without the template's `Pod::UI.puts` line. */
const STOCK_SHORT = `linkage = ENV['USE_FRAMEWORKS']
if linkage != nil
  use_frameworks! :linkage => linkage.to_sym
end
`;

/** A small Podfile of the template form, with the stock block replaced by `middle`. */
const podfileWith = (middle: string, target = "target 'MyApp' do") => `platform :ios, min_ios_version_supported
prepare_react_native_project!

${middle}${target}
  config = use_native_modules!

  use_react_native!(
    :path => config[:reactNativePath]
  )
end
`;

describe.each(TEMPLATE_VERSIONS)('podfile on the template of React Native %s', (version) => {
  const original = fixture(version, 'ios/Podfile');

  it('the template carries the stock USE_FRAMEWORKS block (the form the owner decided on)', () => {
    expect(original).toContain("linkage = ENV['USE_FRAMEWORKS']");
    expect(original).toContain('use_frameworks! :linkage => linkage.to_sym');
  });

  it('puts the line inside the app target, before use_react_native!, framed by markers, and only adds lines', () => {
    const result = podfile(original, {});
    expect(result.status).toBe('patched');
    expect(onlyAddsLines(original, result.text)).toBe(true);
    expect(addedLines(original, result.text)).toEqual([`  ${BEGIN}`, `  ${LINE}`, `  ${END}`]);
    const lines = result.text.split('\n');
    const target = lines.findIndex((l: string) => /^target 'HelloWorld' do$/.test(l));
    const begin = lines.indexOf(`  ${BEGIN}`);
    const reactNative = lines.findIndex((l: string) => l.startsWith('  use_react_native!'));
    const closer = lines.findIndex((l: string, i: number) => i > target && l === 'end');
    expect(target).toBeGreaterThan(-1);
    expect(begin).toBeGreaterThan(target);
    expect(lines[begin + 1]).toBe(`  ${LINE}`);
    expect(lines[begin + 2]).toBe(`  ${END}`);
    expect(lines[begin + 3]).toBe('  use_react_native!(');
    expect(begin).toBeLessThan(reactNative);
    expect(begin).toBeLessThan(closer);
  });

  it('is idempotent: the patched text is already', () => {
    const once = podfile(original, {}).text;
    expect(podfile(once, {})).toEqual({ status: 'already' });
  });

  it('keeps CRLF', () => {
    const result = podfile(crlf(original), {});
    expect(result.status).toBe('patched');
    expect(result.text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(result.text).toContain(`  ${BEGIN}\r\n  ${LINE}\r\n  ${END}\r\n  use_react_native!(`);
  });
});

describe('podfile: the stock block of the template', () => {
  it('the block as the owner quoted it (without the Pod::UI.puts line) is the template form too', () => {
    const text = podfileWith(`${STOCK_SHORT}\n`);
    const result = podfile(text, {});
    expect(result.status).toBe('patched');
    expect(addedLines(text, result.text)).toEqual([`  ${BEGIN}`, `  ${LINE}`, `  ${END}`]);
  });

  it('the block is left as it is: the patch adds lines and removes none', () => {
    const text = fixture('0.87.1', 'ios/Podfile');
    expect(podfile(text, {}).text).toContain("linkage = ENV['USE_FRAMEWORKS']");
  });

  it.each([
    ['another condition', "linkage = ENV['USE_FRAMEWORKS']\nif linkage == 'dynamic'\n  use_frameworks! :linkage => linkage.to_sym\nend\n"],
    ['a different use of the variable', "linkage = ENV['USE_FRAMEWORKS']\nif linkage != nil\n  use_frameworks! :linkage => :static\nend\n"],
    ['a double-quoted key', 'linkage = ENV["USE_FRAMEWORKS"]\nif linkage != nil\n  use_frameworks! :linkage => linkage.to_sym\nend\n'],
    ['an extra statement in the block', "linkage = ENV['USE_FRAMEWORKS']\nif linkage != nil\n  use_frameworks! :linkage => linkage.to_sym\n  puts linkage\nend\n"],
  ])('%s is not the stock block: unsupported, with the reason and the manual step', (_name, block) => {
    const result = podfile(podfileWith(`${block}\n`), {});
    expect(result.status).toBe('unsupported');
    expect(result.reason).toMatch(/USE_FRAMEWORKS|static/);
    expect(result.reason).toContain(LINE);
  });

  it('any other use of ENV[\'USE_FRAMEWORKS\'] next to the stock block is unsupported', () => {
    const text = podfileWith(`${STOCK_SHORT}\nputs ENV['USE_FRAMEWORKS']\n`);
    const result = podfile(text, {});
    expect(result.status).toBe('unsupported');
    expect(result.reason).toMatch(/USE_FRAMEWORKS/);
  });

  it('a mention of USE_FRAMEWORKS in a comment does not count', () => {
    const text = podfileWith("# set ENV['USE_FRAMEWORKS'] to change this\n");
    expect(podfile(text, {}).status).toBe('patched');
  });
});

describe('podfile: what it recognizes as already done', () => {
  it('the Podfile of the example (use_frameworks! :linkage => :dynamic at the top, no marker)', () => {
    const text = readFileSync(join(__dirname, '..', '..', 'examples', 'bare-push-test', 'native', 'ios', 'Podfile'), 'utf8');
    expect(podfile(text, {})).toEqual({ status: 'already' });
  });

  it.each([
    ['inside the target', podfileWith('', "target 'MyApp' do\n  use_frameworks! :linkage => :dynamic")],
    ['at the top', podfileWith('use_frameworks! :linkage => :dynamic\n\n')],
    ['bare use_frameworks! (dynamic by default)', podfileWith('use_frameworks!\n\n')],
    ['linkage: :dynamic in the new hash syntax', podfileWith('use_frameworks! linkage: :dynamic\n\n')],
  ])('%s', (_name, text) => {
    expect(podfile(text, {})).toEqual({ status: 'already' });
  });

  it('the begin marker alone counts, so a second run never doubles the block', () => {
    expect(podfile(podfileWith('', `target 'MyApp' do\n  ${BEGIN}`), {})).toEqual({ status: 'already' });
  });

  it('a commented-out static line does not count', () => {
    const result = podfile(podfileWith('# use_frameworks! :linkage => :static\n\n'), {});
    expect(result.status).toBe('patched');
  });
});

describe('podfile: what it refuses', () => {
  it.each([
    ['at the top', podfileWith('use_frameworks! :linkage => :static\n\n')],
    ['inside the target', podfileWith('', "target 'MyApp' do\n  use_frameworks! :linkage => :static")],
    ['in the new hash syntax', podfileWith('use_frameworks! linkage: :static\n\n')],
  ])('static linkage %s: unsupported, with the reason and the manual step', (_name, text) => {
    const result = podfile(text, {});
    expect(result.status).toBe('unsupported');
    expect(result.reason).toMatch(/static/);
    expect(result.reason).toContain(LINE);
  });

  it('a use_frameworks! whose linkage is not a literal', () => {
    const result = podfile(podfileWith('use_frameworks! :linkage => ENV["X"].to_sym\n\n'), {});
    expect(result.status).toBe('unsupported');
  });

  it('a Podfile without a target', () => {
    const result = podfile('platform :ios, 13\nuse_react_native!(:path => "x")\n', {});
    expect(result.status).toBe('unsupported');
    expect(result.reason).toMatch(/target/);
    expect(result.reason).toContain(LINE);
  });

  it('a Podfile with more than one top-level target', () => {
    const text = `${podfileWith('')}\ntarget 'MyApp-tvOS' do\n  use_react_native!(:path => "x")\nend\n`;
    const result = podfile(text, {});
    expect(result.status).toBe('unsupported');
    expect(result.reason).toMatch(/target/);
  });

  it('a target without use_react_native!', () => {
    const result = podfile("platform :ios, 13\ntarget 'MyApp' do\n  pod 'Foo'\nend\n", {});
    expect(result.status).toBe('unsupported');
    expect(result.reason).toMatch(/use_react_native!/);
  });

  it('a use_react_native! that is only in a comment', () => {
    const result = podfile("target 'MyApp' do\n  # use_react_native!(:path => 'x')\nend\n", {});
    expect(result.status).toBe('unsupported');
  });
});

describe('podfile: indentation, line endings and the end of the file', () => {
  it('takes the indentation of the use_react_native! line, tabs included', () => {
    const text = "target 'MyApp' do\n\tconfig = use_native_modules!\n\tuse_react_native!(:path => 'x')\nend\n";
    const result = podfile(text, {});
    expect(addedLines(text, result.text)).toEqual([`\t${BEGIN}`, `\t${LINE}`, `\t${END}`]);
  });

  it('a mixed file takes the line ending of the anchor line', () => {
    const text = "target 'MyApp' do\r\n  config = use_native_modules!\n  use_react_native!(:path => 'x')\nend\r\n";
    const result = podfile(text, {});
    expect(result.text).toContain(`use_native_modules!\n  ${BEGIN}\n  ${LINE}\n  ${END}\n  use_react_native!`);
  });

  it('a Podfile with no final newline stays without one', () => {
    const text = "target 'MyApp' do\n  use_react_native!(:path => 'x')\nend";
    const result = podfile(text, {});
    expect(result.status).toBe('patched');
    expect(result.text.endsWith('\nend')).toBe(true);
  });
});

describe('podfile through applyPatch on a copy of the template', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it.each(TEMPLATE_VERSIONS)('React Native %s: first run adds, second run changes nothing and makes no copy', (version) => {
    const dir = mkdtempSync(join(tmpdir(), 'espresso-podfile-'));
    dirs.push(dir);
    const rel = 'ios/Podfile';
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    cpSync(join(FIXTURE_ROOT, version, rel), join(dir, rel));
    const file = join(dir, rel);
    const now = new Date(2026, 9, 23, 10, 0, 0);
    const run = () => applyPatch({ file, patcher: podfile, context: { file }, now });

    expect(run().status).toBe('patched');
    expect(onlyAddsLines(fixture(version, rel), readFileSync(file, 'utf8'))).toBe(true);
    const afterFirst = readFileSync(file, 'utf8');
    expect(run().status).toBe('already');
    expect(readFileSync(file, 'utf8')).toBe(afterFirst);
    expect(readdirSync(join(dir, 'ios')).filter((n) => n.endsWith('.bak'))).toHaveLength(1);
  });

  it('a static Podfile is not touched and gets no copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'espresso-podfile-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'ios'));
    const file = join(dir, 'ios', 'Podfile');
    const text = podfileWith('use_frameworks! :linkage => :static\n\n');
    require('fs').writeFileSync(file, text);
    const result = applyPatch({ file, patcher: podfile, context: { file } });
    expect(result.status).toBe('unsupported');
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(readdirSync(join(dir, 'ios'))).toEqual(['Podfile']);
  });
});
