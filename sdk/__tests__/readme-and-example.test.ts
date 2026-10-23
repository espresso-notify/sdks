/**
 * @jest-environment node
 *
 * sdk-setup-fixes (SSF-04.3, SSF-04.4): what the README of the SDK and the integration example say is true.
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import * as ts from 'typescript';

const SDK = resolve(__dirname, '..');
const EXAMPLE = resolve(SDK, '..', 'examples', 'react-native-integration.ts');
const wizard = require('../bin/setup.js'); // eslint-disable-line @typescript-eslint/no-require-imports

jest.setTimeout(60_000);

describe('the README of the SDK', () => {
  const readme = readFileSync(join(SDK, 'README.md'), 'utf8');

  it('counts the Expo packages the wizard installs: six, not five (SSF-04.3)', () => {
    const expoPackages = wizard.INSTALL_ARGS.filter((name: string) => name.startsWith('expo-'));

    expect(expoPackages).toHaveLength(6);
    expect(readme).toContain('the six Expo packages');
    expect(readme).not.toMatch(/five Expo packages/);
  });

  it('says when a code config ends with exit code 2 and when it only asks to check the file, as the reference page does (SSF-02.15, SSF-02.16)', () => {
    const line = readme.split('\n').find((text) => text.includes('adds the config plugin to `app.json` or `app.config.json`'))!;

    expect(line).toContain('and no `app.json` that lists it is spread into it with `...config`');
    expect(line).toContain('says `1 manual step left` and exits with `2`');
    expect(line).toContain('when the file mentions the plugin, or spreads the `config` of an `app.json` that lists it');
    expect(line).toContain('asks you to check it and exits with `0`, and never says the project is set up');
    expect(line).not.toContain('it prints the line, says `1 manual step left` and exits with `2`), checks');
  });
});

describe('the README and SECURITY.md say what the private transport does and does not (SPT-66)', () => {
  const readme = readFileSync(join(SDK, 'README.md'), 'utf8');
  const security = readFileSync(join(SDK, 'SECURITY.md'), 'utf8');
  const section = readme.slice(readme.indexOf('## Private transport'), readme.indexOf('## Event Tracking'));

  it('has a section on the private transport that the table of contents links', () => {
    expect(readme).toContain('- [Private transport](#private-transport)');
    expect(readme).toContain('\n## Private transport\n');
    expect(section.length).toBeGreaterThan(500);
  });

  it('describes the option, the three values, the read-back and the error code', () => {
    for (const text of ['privateTransport', "'auto'", "'native'", "'js'", 'client.transportKind', 'capabilities().nativeTransport', 'NATIVE_TRANSPORT_UNAVAILABLE']) {
      expect(section).toContain(text);
    }
    expect(readme).toMatch(/\| `privateTransport` \| `'auto' \\\| 'native' \\\| 'js'` \|/);
    expect(readme).toMatch(/\| `NATIVE_TRANSPORT_UNAVAILABLE` \|/);
    expect(readme).toMatch(/\| `nativeTransport` \| `boolean` \|/);
    expect(readme).toMatch(/client\.transportKind\s+\/\/ 'native' \| 'js' \| 'custom'/);
  });

  it('says the fallback, the rebuild and the honest limits, as the limitations page does', () => {
    expect(section).toContain('not a security boundary');
    expect(section).toContain('Expo Go');
    expect(section).toContain('native build');
    for (const text of ['Charles, Proxyman or mitmproxy', 'native profiler', 'release build', 'exp.host', "tokenStrategy: 'device'", 'ignoreUrls', 'api\\.example\\.com']) {
      expect(section).toContain(text);
    }
  });

  it('does not claim more than that, and does not claim a device run', () => {
    expect(readme).not.toMatch(/invisible|hidden from everything|undetectable/i);
    expect(section).not.toMatch(/\bsecure\b/i);
    expect(section).not.toMatch(/verified on a (physical )?device|tested on a (physical )?device/i);
  });

  it('no longer says that the SDK needs no native module, or that its transport is only fetch', () => {
    expect(readme).not.toContain('No native HTTP module is required');
    expect(readme).not.toContain('Default: `FetchTransport`');
    expect(readme).not.toContain('(including those made by the SDK\'s `FetchTransport`)');
  });

  it('lists the option of the hook and the pinning of the native module', () => {
    expect(readme).toMatch(/\| `privateTransport` \| `'auto' \\\| 'native' \\\| 'js'` \| `'auto'` \|/);
    expect(readme).toContain('pins of the native module');
  });

  it('keeps internal names out of a published file', () => {
    for (const text of [readme, security]) {
      expect(text).not.toMatch(/\bSPT-\d+|sdk-private-transport|\.specs\/|\bT\d{2}\b/);
    }
  });

  it('SECURITY.md says it is not a security boundary and what stays visible', () => {
    expect(security).toContain('not a security boundary');
    for (const text of ['privateTransport', 'proxy', 'native profiler', 'release build']) {
      expect(security).toContain(text);
    }
  });
});

describe('examples/react-native-integration.ts (SSF-04.4)', () => {
  it('compiles against the source of the SDK with no error, and uses externalId, not userId, in the hook options', () => {
    const options: ts.CompilerOptions = {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      baseUrl: SDK,
      paths: {
        '@espresso-notify/react-native': ['src/index.ts'],
        '@espresso-notify/react-native/hooks': ['src/hooks.ts'],
      },
      types: ['node'],
    };
    const program = ts.createProgram([EXAMPLE], options);
    const own = ts.getPreEmitDiagnostics(program).filter((d) => d.file && resolve(d.file.fileName) === EXAMPLE);
    const text = own.map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);

    expect(text).toEqual([]);
    const source = readFileSync(EXAMPLE, 'utf8');
    expect(source).toMatch(/externalId: userId/);
    expect(source).not.toMatch(/^\s+userId,$/m);
  });
});
