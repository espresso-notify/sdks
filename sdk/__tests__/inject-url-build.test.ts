/**
 * @jest-environment node
 *
 * D-54 (SDK without obfuscation): `inject-url.mjs` is the one step the build runs after `tsc`. It replaces the
 * placeholder with the API URL and nothing else: the code stays exactly what `tsc` wrote, readable.
 *
 * BUG-1 (Expo 53 run): it used to replace the placeholder wherever it appeared, including in the check of
 * `_extractHost` that tells a development build from a real URL, so the published `_extractHost` rejected the
 * production URL and certificate pinning never turned on. It now writes the URL into the `API_URL` constant only, and
 * the build fails when the placeholder is anywhere else.
 *
 * Runs the real script against a tiny fixture `dist/` in a temp dir.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCRIPT = resolve(__dirname, '..', 'inject-url.mjs');
const API_URL = 'https://api.example.test';

const FIXTURE = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildRegisterUrl = void 0;
const API_URL = "__ESPRESSO_API_URL__";
function joinRegisterPath(baseUrl) {
    const registerPath = "/v1/devices/register";
    return baseUrl + registerPath;
}
const buildRegisterUrl = () => joinRegisterPath(API_URL);
exports.buildRegisterUrl = buildRegisterUrl;
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'espresso-inject-'));
  mkdirSync(join(dir, 'dist'));
  for (const f of ['index.js', 'hooks.js', 'errors.js']) writeFileSync(join(dir, 'dist', f), FIXTURE);
  writeFileSync(join(dir, 'dist', 'index.d.ts'), 'export declare const x: "__ESPRESSO_API_URL__";\n');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(env: Record<string, string>) {
  const base: NodeJS.ProcessEnv = { ...process.env };
  delete base.ESPRESSO_API_URL;
  delete base.ESPRESSO_OBFUSCATE;
  return spawnSync(process.execPath, [SCRIPT], { cwd: dir, env: { ...base, ...env }, encoding: 'utf-8' });
}

const read = (f: string) => readFileSync(join(dir, 'dist', f), 'utf-8');

describe('inject-url.mjs', () => {
  it('replaces the placeholder in every .js file and changes nothing else', () => {
    const r = run({ ESPRESSO_API_URL: API_URL });
    expect(r.status).toBe(0);
    for (const f of ['index.js', 'hooks.js', 'errors.js']) {
      expect(read(f)).toBe(FIXTURE.split('__ESPRESSO_API_URL__').join(API_URL));
    }
    expect(read('index.d.ts')).toContain('__ESPRESSO_API_URL__'); // declarations are not code
  });

  it('leaves the code readable: identifiers, the API path and the URL are in clear text', () => {
    run({ ESPRESSO_API_URL: API_URL });
    const out = read('index.js');
    expect(out).toContain('joinRegisterPath');
    expect(out).toContain('/v1/devices/register');
    expect(out).toContain(API_URL);
    expect(out).not.toMatch(/_0x[0-9a-f]{3,}/);
  });

  it('the injected build works when loaded', () => {
    run({ ESPRESSO_API_URL: API_URL });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(require(join(dir, 'dist', 'index.js')).buildRegisterUrl()).toBe(`${API_URL}/v1/devices/register`);
  });

  it('is deterministic: two runs on the same input give the same bytes', () => {
    run({ ESPRESSO_API_URL: API_URL });
    const first = read('index.js');
    writeFileSync(join(dir, 'dist', 'index.js'), FIXTURE);
    run({ ESPRESSO_API_URL: API_URL });
    expect(read('index.js')).toBe(first);
  });

  it('ignores ESPRESSO_OBFUSCATE: there is no such switch any more', () => {
    const r = run({ ESPRESSO_API_URL: API_URL, ESPRESSO_OBFUSCATE: '1' });
    expect(r.status).toBe(0);
    expect(read('index.js')).toBe(FIXTURE.split('__ESPRESSO_API_URL__').join(API_URL));
  });

  it('writes the URL into the API_URL constant and nowhere else (BUG-1)', () => {
    run({ ESPRESSO_API_URL: API_URL });
    const out = read('index.js').split('\n');
    const before = FIXTURE.split('\n');
    const changed = before.map((line, i) => (line === out[i] ? null : i)).filter((i) => i !== null);
    expect(changed).toEqual([before.findIndex((l) => l.startsWith('const API_URL'))]);
    expect(out[changed[0] as number]).toBe(`const API_URL = "${API_URL}";`);
  });

  it('skips a file that has no API_URL constant, such as hooks.js in the real build', () => {
    writeFileSync(join(dir, 'dist', 'hooks.js'), 'exports.x = 1;\n');
    const r = run({ ESPRESSO_API_URL: API_URL });
    expect(r.status).toBe(0);
    expect(read('hooks.js')).toBe('exports.x = 1;\n');
  });

  it('fails, names the file and the line, and writes nothing when the placeholder is anywhere else (BUG-1)', () => {
    const bad = FIXTURE + 'function isDevBuild(url) { return url.includes("__ESPRESSO_API_URL__"); }\n';
    writeFileSync(join(dir, 'dist', 'hooks.js'), bad);
    const r = run({ ESPRESSO_API_URL: API_URL });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('hooks.js:');
    expect(r.stderr).toContain('outside the API_URL constant');
    expect(read('hooks.js')).toBe(bad);
    expect(read('index.js')).toBe(FIXTURE); // the file that was fine is not written either
  });

  it('fails without ESPRESSO_API_URL and touches nothing', () => {
    const r = run({});
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ESPRESSO_API_URL env var is required');
    expect(read('index.js')).toBe(FIXTURE);
  });

  it('fails when there is no dist to inject into', () => {
    rmSync(join(dir, 'dist'), { recursive: true });
    const r = run({ ESPRESSO_API_URL: API_URL });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('does not exist');
  });
});
