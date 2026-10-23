/**
 * @jest-environment node
 *
 * sdk-private-transport T34 (SPT-28, SPT-29, SPT-55): the native sources of the transport module.
 *
 * The module is a transport and nothing else. Two things must hold in the code that ships:
 *   - it never writes to a log (no identifier, token, key or payload can leave through the platform's log), and
 *   - it never goes through the networking of React Native or the shared sessions an inspector can observe: Android
 *     builds its own `OkHttpClient` with no interceptor, iOS builds its own ephemeral `NSURLSession`.
 *
 * T37 adds one rule about the iOS module on the old architecture: it must not export a method named `getConstants`. The
 * bridge of React Native (`NativeModules.js`, `genModule`) builds `getConstants()` from `constantsToExport` and warns
 * "Unable to define method 'getConstants()'" when the module has one of that name.
 *
 * The scan reads `sdk/android/src` and `sdk/ios/Sources`, drops comments and the text of string literals (a sentence that
 * explains what is forbidden is not a use of it) and looks for the forbidden names in what is left. The last test proves
 * the scanner itself on planted mutants, so a pattern that stopped matching would not pass in silence.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

const SDK = resolve(__dirname, '..');
const ANDROID = join(SDK, 'android', 'src');
const IOS = join(SDK, 'ios', 'Sources');

type Rule = { name: string; pattern: RegExp };

/** A log call, on either platform. `Log.` is matched with its level so an unrelated `Catalog.` is not. */
const ANDROID_LOGS: Rule[] = [
  { name: 'android.util.Log', pattern: /\bandroid\.util\.Log\b/ },
  { name: 'Log.<level>(', pattern: /(?<![\w.])Log\.(v|d|i|w|e|wtf)\(/ },
  { name: 'println', pattern: /\bprintln\b/ },
  { name: 'Logger', pattern: /\bLogger\b/ },
];
const IOS_LOGS: Rule[] = [
  { name: 'NSLog', pattern: /\bNSLog\b/ },
  { name: 'os_log', pattern: /\bos_log\b/ },
  { name: 'print(', pattern: /(?<![\w.])print\(/ },
];
/** The networking of React Native, and the interceptors that would let another party see a request. */
const ANDROID_NETWORK: Rule[] = [
  { name: 'OkHttpClientProvider', pattern: /\bOkHttpClientProvider\b/ },
  { name: 'NetworkingModule', pattern: /\bNetworkingModule\b/ },
  { name: 'addInterceptor', pattern: /\baddInterceptor\b/ },
  { name: 'addNetworkInterceptor', pattern: /\baddNetworkInterceptor\b/ },
];
const IOS_NETWORK: Rule[] = [
  { name: 'defaultSessionConfiguration', pattern: /\bdefaultSessionConfiguration\b/ },
  { name: 'sharedSession', pattern: /\bsharedSession\b/ },
  { name: 'URLSession.shared', pattern: /\bURLSession\.shared\b/ },
  { name: 'RCTNetworking', pattern: /\bRCTNetworking\b/ },
];

/** A generator that is not the platform CSPRNG: the bytes of the device id and of the nonce must never come from one. */
const ANDROID_WEAK_RANDOM: Rule[] = [
  { name: 'java.util.Random', pattern: /\bjava\.util\.Random\b/ },
  { name: 'kotlin.random', pattern: /\bkotlin\.random\b/ },
  { name: 'ThreadLocalRandom', pattern: /\bThreadLocalRandom\b/ },
  { name: 'Random(', pattern: /(?<![\w.])Random\(/ },
  { name: 'Math.random', pattern: /\bMath\.random\b/ },
];
const IOS_WEAK_RANDOM: Rule[] = [
  { name: 'drand48', pattern: /\bs?drand48\b/ },
  { name: 'rand(', pattern: /(?<![\w.])s?rand\(/ },
  { name: 'random()', pattern: /(?<![\w.])s?random\(/ },
];

/** A method called `getConstants` exported to the old bridge: the bridge defines that name itself and warns about a second. */
const IOS_OLD_ARCH: Rule[] = [{ name: 'exported getConstants', pattern: /\bRCT_EXPORT_(?:BLOCKING_SYNCHRONOUS_)?METHOD\s*\(\s*getConstants\b/ }];

function filesUnder(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path, keep));
    else if (keep(name)) out.push(path);
  }
  return out;
}

/**
 * Comments and string literals removed, for Kotlin, Java, Objective-C(++) and Swift: `//` and block comments, `"..."`
 * (with `@"..."` of Objective-C), `"""..."""` of Kotlin and `'c'` of Kotlin and Java.
 */
export function codeOnly(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      out += ' ';
    } else if (c === '"' && text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3);
      i = end === -1 ? text.length : end + 3;
      out += ' ';
    } else if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
      i++;
      out += ' ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The names of the rules that match the code of `text`. */
export function findForbidden(text: string, rules: Rule[]): string[] {
  const code = codeOnly(text);
  return rules.filter((rule) => rule.pattern.test(code)).map((rule) => rule.name);
}

/** The sources to scan; a scan that found none (a moved folder) must not pass for nothing. */
function sources(dir: string, keep: RegExp, mustHave: RegExp[]): string[] {
  const files = filesUnder(dir, (n) => keep.test(n));
  for (const must of mustHave) {
    expect(files.map((f) => relative(dir, f)).some((f) => must.test(f))).toBe(true);
  }
  return files;
}
const androidFiles = () => sources(ANDROID, /\.(kt|java)$/, [/core\/HttpCore\.kt$/, /core\/PinStore\.kt$/, /core\/RandomBytes\.kt$/]);
const iosFiles = () => sources(IOS, /\.(h|m|mm|swift)$/, [/ESPTransportClient\.m$/, /ESPPinStore\.m$/, /ESPRandomBytes\.m$/]);

function violations(files: string[], rules: Rule[]): string[] {
  return files.flatMap((file) =>
    findForbidden(readFileSync(file, 'utf8'), rules).map((name) => `${relative(SDK, file)}: ${name}`),
  );
}

describe('native sources of the transport module', () => {
  it('writes no log on Android (android.util.Log, println, Logger)', () => {
    expect(violations(androidFiles(), ANDROID_LOGS)).toEqual([]);
  });

  it('uses neither the networking of React Native nor an interceptor on Android', () => {
    expect(violations(androidFiles(), ANDROID_NETWORK)).toEqual([]);
  });

  it('writes no log on iOS (NSLog, os_log, print)', () => {
    expect(violations(iosFiles(), IOS_LOGS)).toEqual([]);
  });

  it('uses no shared or default session and no RCTNetworking on iOS, and builds its own ephemeral configuration', () => {
    expect(violations(iosFiles(), IOS_NETWORK)).toEqual([]);
    const core = iosFiles().filter((f) => f.includes('EspressoNotifyTransportCore'));
    expect(core.map((f) => readFileSync(f, 'utf8')).join('\n')).toContain('ephemeralSessionConfiguration');
  });

  it('does not export getConstants to the old bridge, which defines it from constantsToExport', () => {
    expect(violations(iosFiles(), IOS_OLD_ARCH)).toEqual([]);
    const module = readFileSync(join(IOS, 'EspressoNotifyTransport', 'EspressoNotifyTransport.mm'), 'utf8');
    expect(module).toContain('constantsToExport');
    expect(findForbidden(module + '\nRCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getConstants) { return @{}; }\n', IOS_OLD_ARCH)).toEqual([
      'exported getConstants',
    ]);
    expect(findForbidden(module + '\nRCT_EXPORT_METHOD(getConstants) {}\n', IOS_OLD_ARCH)).toEqual(['exported getConstants']);
    // A comment that explains the rule is not a use of it.
    expect(findForbidden('// RCT_EXPORT_METHOD(getConstants)\n', IOS_OLD_ARCH)).toEqual([]);
  });

  it('the scanner catches planted mutants, one pattern per platform, and ignores comments and strings', () => {
    const http = readFileSync(join(ANDROID, 'main', 'java', 'com', 'espressonotify', 'transport', 'core', 'HttpCore.kt'), 'utf8');
    const client = readFileSync(join(IOS, 'EspressoNotifyTransportCore', 'ESPTransportClient.m'), 'utf8');
    // The real files are clean, so a hit below is the mutant.
    expect(findForbidden(http, [...ANDROID_LOGS, ...ANDROID_NETWORK])).toEqual([]);
    expect(findForbidden(client, [...IOS_LOGS, ...IOS_NETWORK])).toEqual([]);
    expect(findForbidden(http + '\nval c = builder.addInterceptor(x)\n', ANDROID_NETWORK)).toEqual(['addInterceptor']);
    expect(findForbidden(http + '\nprintln(token)\n', ANDROID_LOGS)).toEqual(['println']);
    expect(findForbidden(client + '\nNSURLSession *s = [NSURLSession sharedSession];\n', IOS_NETWORK)).toEqual(['sharedSession']);
    expect(findForbidden(client + '\nNSLog(@"%@", token);\n', IOS_LOGS)).toEqual(['NSLog']);
    // A sentence that names what is forbidden, in a comment or a string, is not a use of it.
    expect(
      findForbidden('// never NSLog\n/* os_log and print( too */\nNSString *s = @"NSLog sharedSession";\nval t = "println Logger"\n', [
        ...IOS_LOGS,
        ...IOS_NETWORK,
        ...ANDROID_LOGS,
      ]),
    ).toEqual([]);
  });

  // sdk-secure-device-id T3 (SRID-13, SRID-14): the module serves secure bytes and nothing weaker.
  describe('the random bytes of the module (sdk-secure-device-id)', () => {
    const androidModule = readFileSync(join(ANDROID, 'main', 'java', 'com', 'espressonotify', 'transport', 'EspressoNotifyTransportModule.kt'), 'utf8');
    const androidCore = readFileSync(join(ANDROID, 'main', 'java', 'com', 'espressonotify', 'transport', 'core', 'RandomBytes.kt'), 'utf8');
    const iosModule = readFileSync(join(IOS, 'EspressoNotifyTransport', 'EspressoNotifyTransport.mm'), 'utf8');
    const iosCore = readFileSync(join(IOS, 'EspressoNotifyTransportCore', 'ESPRandomBytes.m'), 'utf8');
    const codegen = readFileSync(join(SDK, 'src', 'native', 'NativeEspressoNotifyTransport.ts'), 'utf8');

    it('is declared in the codegen spec as a promise of a string, with the contract version still 1', () => {
      expect(codegen).toMatch(/randomBytes\(count: number\): Promise<string>;/);
      expect(readFileSync(join(ANDROID, 'main', 'java', 'com', 'espressonotify', 'transport', 'core', 'Contract.kt'), 'utf8')).toMatch(
        /const val CONTRACT_VERSION = 1\b/,
      );
    });

    it('is exported by both modules, which answer through the core and reject with the code only', () => {
      expect(androidModule).toMatch(/@ReactMethod\s+fun randomBytes\(count: Double, promise: Promise\)/);
      expect(androidModule).toContain('RandomBytes.hex(');
      expect(androidModule).toContain('promise.reject(ErrorCodes.INVALID_REQUEST, ErrorCodes.INVALID_REQUEST)');
      expect(iosModule).toMatch(/RCT_EXPORT_METHOD\(randomBytes\s*:\s*\(double\)count/);
      expect(iosModule).toContain('[ESPRandomBytes hexWithCount:');
      expect(iosModule).toContain('reject(code, code, nil)');
    });

    it('draws from the platform generator and from no weaker one', () => {
      expect(androidCore).toContain('SecureRandom()');
      expect(iosCore).toContain('SecRandomCopyBytes(kSecRandomDefault');
      expect(violations(androidFiles(), ANDROID_WEAK_RANDOM)).toEqual([]);
      expect(violations(iosFiles(), IOS_WEAK_RANDOM)).toEqual([]);
      // The scanner sees a planted weak generator, and `SecureRandom(` is not taken for `Random(`.
      expect(findForbidden(androidCore + '\nval r = java.util.Random(1)\n', ANDROID_WEAK_RANDOM)).toContain('java.util.Random');
      expect(findForbidden(androidCore + '\nval r = Random(1)\n', ANDROID_WEAK_RANDOM)).toEqual(['Random(']);
      expect(findForbidden(iosCore + '\nint x = rand();\n', IOS_WEAK_RANDOM)).toEqual(['rand(']);
      expect(findForbidden(iosCore + '\nlong x = random();\n', IOS_WEAK_RANDOM)).toEqual(['random()']);
    });
  });
});
