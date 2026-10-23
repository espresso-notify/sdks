/**
 * @jest-environment node
 *
 * SDKFIX-01 (sdk-launch-fixes, D-54): the published build keeps every require
 * specifier a string literal, so Metro can resolve the optional native modules,
 * and it is readable code (no obfuscation).
 *
 * Builds the real `src/` with `tsc` into a temp dir, runs the real
 * `inject-url.mjs` there with the production URL, and checks the output. Never
 * touches the tracked `sdk/dist`.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

jest.setTimeout(240_000);

const SDK = resolve(__dirname, '..');
const TSC = join(SDK, 'node_modules', 'typescript', 'bin', 'tsc');
const INJECT = join(SDK, 'inject-url.mjs');
const PROD_URL = 'https://api.espressonotify.com';
const COMPUTED_REQUIRE = /require\((?!['"])/;

// Modules Metro must resolve in the two example apps (SDKFIX-01 AC 2, AC 5).
const CORE_MODULES = [
  'expo-notifications',
  '@react-native-firebase/messaging',
  'react-native',
  'react-native-notify-kit',
];

function sourceSpecifiers(): string[] {
  const dir = join(SDK, 'src');
  const names = new Set<string>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(join(dir, f), 'utf-8');
    for (const m of src.matchAll(/require\(['"]([^'"]+)['"]\)/g)) names.add(m[1]);
  }
  return [...names].sort();
}

function build(dir: string) {
  const t = spawnSync(process.execPath, [TSC, '-p', join(SDK, 'tsconfig.json'), '--outDir', join(dir, 'dist')], {
    encoding: 'utf-8',
  });
  expect(t.status).toBe(0);
  const env: NodeJS.ProcessEnv = { ...process.env, ESPRESSO_API_URL: PROD_URL };
  return spawnSync(process.execPath, [INJECT], { cwd: dir, env, encoding: 'utf-8' });
}

function distFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(join(dir, 'dist')).filter((n) => n.endsWith('.js'))) {
    out[f] = readFileSync(join(dir, 'dist', f), 'utf-8');
  }
  return out;
}

describe('production build (readable)', () => {
  let dir: string;
  let files: Record<string, string>;
  let run: ReturnType<typeof spawnSync>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'espresso-prod-build-'));
    run = build(dir);
    files = distFiles(dir);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('finishes and injects the URL', () => {
    expect(run.status).toBe(0);
  });

  it('has no computed require in any dist file (AC 1)', () => {
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['index.js', 'hooks.js']));
    for (const [name, code] of Object.entries(files)) {
      const hits = code.match(new RegExp(COMPUTED_REQUIRE.source + '.{0,30}', 'g')) ?? [];
      expect({ name, hits }).toEqual({ name, hits: [] });
    }
  });

  it('is not obfuscated: the source texts and names are in clear text, errors.js included', () => {
    expect(Object.keys(files).sort()).toEqual(expect.arrayContaining(['errors.js', 'hooks.js', 'index.js']));
    expect(files['errors.js']).toContain('EXPO_PROJECT_ID_MISSING_MESSAGE');
    for (const [name, code] of Object.entries(files)) {
      expect({ name, hex: /\b_0x[0-9a-f]{3,}\b/.test(code) }).toEqual({ name, hex: false });
    }
  });

  it('keeps every module required by src as a literal require (AC 2)', () => {
    const all = Object.values(files).join('\n');
    const specs = sourceSpecifiers();
    expect(specs).toEqual(expect.arrayContaining(CORE_MODULES));
    for (const spec of specs) {
      const literal = all.includes(`require('${spec}')`) || all.includes(`require("${spec}")`);
      expect({ spec, literal }).toEqual({ spec, literal: true });
    }
  });

  it('has the API URL and paths in clear text and no placeholder left (AC 3)', () => {
    const all = Object.values(files).join('\n');
    // Booleans, not toContain: a failure would otherwise print the whole build.
    expect(all.includes(PROD_URL)).toBe(true);
    expect(all.includes('/v1/devices/register')).toBe(true);
    expect(all.includes('__ESPRESSO_API_URL__')).toBe(false);

    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        `const m = require(${JSON.stringify(join(dir, 'dist', 'index.js'))});` +
          `const c = new m.PushClient({ projectId: 'pk_live_abcdefghijklmnop', autoTrack: false });` +
          `process.stdout.write(String(c.baseURL)); c.destroy && c.destroy();`,
      ],
      { encoding: 'utf-8', env: { ...process.env, NODE_ENV: 'test' } },
    );
    expect(probe.stdout).toBe(PROD_URL);
  });

  // BUG-1: the injection must not reach the code that compares with the placeholder.
  it('reads the host of the production API, so certificate pinning can turn on (BUG-1)', () => {
    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        `const m = require(${JSON.stringify(join(dir, 'dist', 'index.js'))});` +
          `process.stdout.write(JSON.stringify(m._extractHost(${JSON.stringify(PROD_URL)})));`,
      ],
      { encoding: 'utf-8', env: { ...process.env, NODE_ENV: 'test' } },
    );
    expect(JSON.parse(probe.stdout)).toBe('api.espressonotify.com');
  });
});
