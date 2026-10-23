/**
 * @jest-environment node
 *
 * setup-wizard-bare-rn T6 (SWB-06): the AppDelegate patcher. In Swift it adds `import FirebaseCore` with the other imports
 * and, as the first thing of `didFinishLaunchingWithOptions`, `FirebaseApp.configure()` guarded so it runs only when
 * `GoogleService-Info.plist` is in the app (without the file Firebase aborts the launch). In Objective-C (`.mm`) the
 * equivalent. Run against the real template files of React Native 0.87.1 and 0.79.7.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { addedLines, FIXTURE_ROOT, fixture, onlyAddsLines, TEMPLATE_VERSIONS } from './helpers/bare-fixtures';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { appDelegate } = require('../bin/lib/patchers/appDelegate.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyPatch } = require('../bin/lib/patch.js');

const SWIFT = { file: '/app/ios/HelloWorld/AppDelegate.swift' };
const OBJC = { file: '/app/ios/HelloWorld/AppDelegate.mm' };

const GUARD = 'if Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil {';
const OBJC_GUARD = 'if ([[NSBundle mainBundle] pathForResource:@"GoogleService-Info" ofType:@"plist"]) {';

const crlf = (text: string) => text.replace(/\r?\n/g, '\r\n');

/** The AppDelegate.mm of the React Native 0.74 template, the last one written in Objective-C. */
const OBJC_TEMPLATE = `#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  self.moduleName = @"HelloWorld";
  // You can add your custom initial props in the dictionary below.
  // They will be passed down to the ViewController used by React Native.
  self.initialProps = @{};

  return [super application:application didFinishLaunchingWithOptions:launchOptions];
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

@end
`;

describe.each(TEMPLATE_VERSIONS)('appDelegate (Swift) on the template of React Native %s', (version) => {
  const original = fixture(version, 'ios/HelloWorld/AppDelegate.swift');

  it('adds the import after the others and the guarded configure as the first line of the method, between markers', () => {
    const result = appDelegate(original, SWIFT);
    expect(result.status).toBe('patched');
    expect(onlyAddsLines(original, result.text)).toBe(true);
    expect(addedLines(original, result.text)).toEqual([
      '// espresso-notify:begin firebase-import',
      'import FirebaseCore',
      '// espresso-notify:end',
      '    // espresso-notify:begin firebase-configure',
      `    ${GUARD}`,
      '      FirebaseApp.configure()',
      '    }',
      '    // espresso-notify:end',
    ]);
    const lines = result.text.split('\n');
    const imports = lines.map((l: string, i: number) => (/^import /.test(l) ? i : -1)).filter((i: number) => i >= 0);
    const importAt = lines.indexOf('import FirebaseCore');
    expect(importAt).toBeGreaterThan(Math.max(...imports.filter((i: number) => i !== importAt)) - 1);
    const methodEnd = lines.findIndex((l: string) => l.includes(') -> Bool {'));
    expect(lines[methodEnd + 1]).toBe('    // espresso-notify:begin firebase-configure');
    expect(lines[methodEnd + 6]).toBe('    let delegate = ReactNativeDelegate()');
  });

  it('is idempotent', () => {
    const once = appDelegate(original, SWIFT).text;
    expect(appDelegate(once, SWIFT)).toEqual({ status: 'already' });
  });

  it('keeps CRLF', () => {
    const result = appDelegate(crlf(original), SWIFT);
    expect(result.status).toBe('patched');
    expect(result.text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(result.text).toContain('\r\n    // espresso-notify:begin firebase-configure\r\n');
  });
});

describe('appDelegate (Swift): the example app and the user\'s own configure', () => {
  // The example app lives in the private monorepo only; the public SDK mirror (D-137) has no examples/ to read.
  const EXAMPLE_DELEGATE = join(__dirname, '..', '..', 'examples', 'bare-push-test', 'native', 'ios', 'AppDelegate.swift');
  (existsSync(EXAMPLE_DELEGATE) ? it : it.skip)('the example app of this repository, which already configures guarded, is already without a warning', () => {
    const example = readFileSync(EXAMPLE_DELEGATE, 'utf8');
    expect(appDelegate(example, SWIFT)).toEqual({ status: 'already' });
  });

  it('an unguarded FirebaseApp.configure() of the user is already, untouched, with a warning that it aborts without the plist', () => {
    const original = fixture('0.87.1', 'ios/HelloWorld/AppDelegate.swift').replace(
      'let delegate = ReactNativeDelegate()',
      'FirebaseApp.configure()\n    let delegate = ReactNativeDelegate()',
    );
    const result = appDelegate(original, SWIFT);
    expect(result.status).toBe('already');
    expect(result.text).toBeUndefined();
    expect(result.warning).toMatch(/GoogleService-Info\.plist/);
    expect(result.warning).toMatch(/abort|crash|close/i);
  });

  it('FirebaseApp.configure(options:) also counts, and a configure in a comment does not', () => {
    const base = fixture('0.87.1', 'ios/HelloWorld/AppDelegate.swift');
    const options = base.replace('let delegate = ReactNativeDelegate()', 'FirebaseApp.configure(options: o)\n    let delegate = ReactNativeDelegate()');
    expect(appDelegate(options, SWIFT).status).toBe('already');
    const commented = base.replace('let delegate = ReactNativeDelegate()', '// FirebaseApp.configure()\n    let delegate = ReactNativeDelegate()');
    expect(appDelegate(commented, SWIFT).status).toBe('patched');
  });

  it('import Firebase or import FirebaseCore that the project already has is not added twice', () => {
    const base = fixture('0.87.1', 'ios/HelloWorld/AppDelegate.swift');
    for (const existing of ['import FirebaseCore', 'import Firebase']) {
      const withImport = base.replace('import UIKit', `import UIKit\n${existing}`);
      const result = appDelegate(withImport, SWIFT);
      expect(result.status).toBe('patched');
      expect(result.text.match(/^import Firebase(Core)?$/gm)).toHaveLength(1);
      expect(result.text).toContain('FirebaseApp.configure()');
    }
  });

  it('a project with a tab indentation gets tabs', () => {
    const original = fixture('0.87.1', 'ios/HelloWorld/AppDelegate.swift').replace(/^ {4}/gm, '\t\t').replace(/^ {2}/gm, '\t');
    const result = appDelegate(original, SWIFT);
    expect(result.status).toBe('patched');
    expect(result.text).toContain(`\t\t// espresso-notify:begin firebase-configure\n\t\t${GUARD}\n\t\t\tFirebaseApp.configure()\n\t\t}\n`);
  });
});

describe('appDelegate (Swift): what it refuses', () => {
  it('a file without didFinishLaunchingWithOptions', () => {
    const result = appDelegate('import UIKit\n\nclass AppDelegate {\n}\n', SWIFT);
    expect(result.status).toBe('unsupported');
    expect(result.reason).toBe('there is no `didFinishLaunchingWithOptions` method to start Firebase in');
  });

  it('a file without any import to put FirebaseCore next to', () => {
    const original = 'class AppDelegate {\n  func application(_ a: UIApplication, didFinishLaunchingWithOptions o: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {\n    return true\n  }\n}\n';
    expect(appDelegate(original, SWIFT).status).toBe('unsupported');
  });

  it('a method whose body does not open on its own line end', () => {
    const original = 'import UIKit\nclass A {\n  func application(_ a: UIApplication, didFinishLaunchingWithOptions o: [UIApplication.LaunchOptionsKey: Any]?) -> Bool { return true }\n}\n';
    expect(appDelegate(original, SWIFT).status).toBe('unsupported');
  });
});

describe('appDelegate (Objective-C) on an AppDelegate.mm', () => {
  it('adds #import <Firebase.h> and the guarded [FIRApp configure] as the first line of the method', () => {
    const result = appDelegate(OBJC_TEMPLATE, OBJC);
    expect(result.status).toBe('patched');
    expect(onlyAddsLines(OBJC_TEMPLATE, result.text)).toBe(true);
    expect(addedLines(OBJC_TEMPLATE, result.text)).toEqual([
      '// espresso-notify:begin firebase-import',
      '#import <Firebase.h>',
      '// espresso-notify:end',
      '  // espresso-notify:begin firebase-configure',
      `  ${OBJC_GUARD}`,
      '    [FIRApp configure];',
      '  }',
      '  // espresso-notify:end',
    ]);
    const lines = result.text.split('\n');
    const brace = lines.findIndex((l: string) => l === '{');
    expect(lines[brace + 1]).toBe('  // espresso-notify:begin firebase-configure');
    expect(lines.indexOf('#import <Firebase.h>')).toBeGreaterThan(lines.indexOf('#import <React/RCTBundleURLProvider.h>'));
  });

  it('is idempotent, and recognizes a configure of the user', () => {
    const once = appDelegate(OBJC_TEMPLATE, OBJC).text;
    expect(appDelegate(once, OBJC)).toEqual({ status: 'already' });
    const own = OBJC_TEMPLATE.replace('  self.moduleName', '  [FIRApp configure];\n  self.moduleName');
    const result = appDelegate(own, OBJC);
    expect(result.status).toBe('already');
    expect(result.warning).toMatch(/GoogleService-Info\.plist/);
  });

  it('a guarded configure of the user is already without a warning', () => {
    const own = OBJC_TEMPLATE.replace('  self.moduleName', `  ${OBJC_GUARD}\n    [FIRApp configure];\n  }\n  self.moduleName`);
    expect(appDelegate(own, OBJC)).toEqual({ status: 'already' });
  });

  it('keeps CRLF and refuses a file without the method', () => {
    const result = appDelegate(crlf(OBJC_TEMPLATE), OBJC);
    expect(result.status).toBe('patched');
    expect(result.text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(appDelegate('#import "AppDelegate.h"\n@implementation AppDelegate\n@end\n', OBJC).status).toBe('unsupported');
  });

  it('picks the language from the content when the context has no file', () => {
    expect(appDelegate(OBJC_TEMPLATE, {}).text).toContain('[FIRApp configure];');
    expect(appDelegate(fixture('0.87.1', 'ios/HelloWorld/AppDelegate.swift'), {}).text).toContain('FirebaseApp.configure()');
  });
});

describe('appDelegate through applyPatch on a copy of the template', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it.each(TEMPLATE_VERSIONS)('React Native %s: first run adds, second run changes nothing', (version) => {
    const dir = mkdtempSync(join(tmpdir(), 'espresso-appdelegate-'));
    dirs.push(dir);
    const rel = 'ios/HelloWorld/AppDelegate.swift';
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    cpSync(join(FIXTURE_ROOT, version, rel), join(dir, rel));
    const file = join(dir, rel);
    const now = new Date(2026, 9, 23, 10, 0, 0);
    const first = applyPatch({ file, patcher: appDelegate, context: { file }, now });
    expect(first.status).toBe('patched');
    expect(onlyAddsLines(fixture(version, rel), readFileSync(file, 'utf8'))).toBe(true);
    const after = readFileSync(file, 'utf8');
    expect(applyPatch({ file, patcher: appDelegate, context: { file }, now }).status).toBe('already');
    expect(readFileSync(file, 'utf8')).toBe(after);
  });
});
