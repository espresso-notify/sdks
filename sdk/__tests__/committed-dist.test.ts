/**
 * @jest-environment node
 *
 * SDKH-60/61 (sdk-ingest-hardening): no committed `dist` may point at a development URL.
 *
 * `sdk/dist` and `sdk-web/dist` are tracked in git and are what gets packed. A dev build
 * left in the working tree (`make sdk-build-dev`, `make sdk-build-examples`) would ship the
 * public key of every integrator to `http://localhost:8080`. Both builds keep their URL in plain
 * text (the React Native build is no longer obfuscated, D-54); the React Native build is also read
 * by loading it and asking the client which base URL it uses, which still holds if a build ever
 * assembles the URL at run time.
 *
 * To restore a clean tree after a dev build: `git checkout -- sdk/dist sdk-web/dist`.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

jest.setTimeout(60_000);

const SDK = resolve(__dirname, '..');
const WEB = resolve(SDK, '..', 'sdk-web');
const PROD_URL = 'https://api.espressonotify.com';
const DEV_URL = /localhost|127\.0\.0\.1|0\.0\.0\.0|10\.0\.2\.2|__ESPRESSO_API_URL__/;

/** Every `.js` file of `dir` that contains a development URL or an unreplaced placeholder. */
function textProblems(dir: string): string[] {
  const problems: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
    const hit = DEV_URL.exec(readFileSync(join(dir, file), 'utf-8'));
    if (hit) problems.push(`${file}: contains "${hit[0]}"`);
  }
  return problems;
}

/** The base URL the built `PushClient` uses, read by loading the build in a child process. */
function baseUrlOfBuild(distDir: string): string {
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      `const m = require(${JSON.stringify(join(distDir, 'index.js'))});` +
        `const c = new m.PushClient({ projectId: 'pk_live_abcdefghijklmnop', autoTrack: false });` +
        `process.stdout.write(String(c.baseURL)); c.destroy && c.destroy();`,
    ],
    { encoding: 'utf-8', env: { ...process.env, NODE_ENV: 'test' } },
  );
  if (probe.status !== 0) throw new Error(`probe failed for ${distDir}: ${probe.stderr}`);
  return probe.stdout;
}

/** Why a base URL cannot be shipped, or nothing. */
function urlProblems(url: string): string[] {
  const problems: string[] = [];
  if (!url.startsWith('https://')) problems.push(`"${url}" is not https`);
  if (DEV_URL.test(url)) problems.push(`"${url}" is a development address`);
  return problems;
}

describe('committed sdk-web/dist', () => {
  it('has no development URL and no unreplaced placeholder (AC 1)', () => {
    expect(textProblems(join(WEB, 'dist'))).toEqual([]);
  });

  it('uses the production API as its base URL (AC 1)', () => {
    const index = readFileSync(join(WEB, 'dist', 'index.js'), 'utf-8');
    expect(index).toContain(`API_URL = "${PROD_URL}"`);
  });

  // SFF-08 (FE-09): the service worker reports clicks to the URL compiled into it and
  // never to one carried by a push payload.
  it('compiles the production API into the service worker and reads no apiUrl from a push (SFF-08)', () => {
    const sw = readFileSync(join(WEB, 'dist', 'sw.js'), 'utf-8');
    expect(sw).toContain(`API_URL = "${PROD_URL}"`);
    expect(sw).not.toMatch(/apiUrl/);
  });
});

describe('committed sdk/dist', () => {
  it('has no development URL in clear text (AC 2)', () => {
    expect(textProblems(join(SDK, 'dist'))).toEqual([]);
  });

  it('has the production API in clear text (D-54)', () => {
    expect(readFileSync(join(SDK, 'dist', 'index.js'), 'utf-8').includes(PROD_URL)).toBe(true);
  });

  it('builds a client that talks to the production API (AC 2)', () => {
    const url = baseUrlOfBuild(join(SDK, 'dist'));
    expect(urlProblems(url)).toEqual([]);
    expect(url).toBe(PROD_URL);
  });
});

// BUG-1 of the Expo 53 run: the build step that puts the API URL in the package also rewrote the placeholder that
// `_extractHost` compares with, so the published `_extractHost('https://api.espressonotify.com')` returned null and
// certificate pinning never turned on. The host of the production API must come out of the built code.
describe('committed sdk/dist can pin the production host (BUG-1)', () => {
  it('_extractHost reads the host of the production API out of the published build', () => {
    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        `const m = require(${JSON.stringify(join(SDK, 'dist', 'index.js'))});` +
          `process.stdout.write(JSON.stringify([m._extractHost(${JSON.stringify(PROD_URL)}), m._extractHost('')]));`,
      ],
      { encoding: 'utf-8', env: { ...process.env, NODE_ENV: 'test' } },
    );
    expect(probe.stderr).toBe('');
    expect(JSON.parse(probe.stdout)).toEqual(['api.espressonotify.com', null]);
  });
});

describe('the guard itself (AC 3)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'espresso-dist-guard-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('names the file and the URL when a dist has a development URL', () => {
    writeFileSync(join(dir, 'index.js'), 'const API_URL = "http://localhost:8080";\n');
    writeFileSync(join(dir, 'clean.js'), 'const API_URL = "https://api.espressonotify.com";\n');
    expect(textProblems(dir)).toEqual(['index.js: contains "localhost"']);
  });

  it('catches the Android emulator address and an unreplaced placeholder', () => {
    writeFileSync(join(dir, 'a.js'), 'x = "http://10.0.2.2:8080";\n');
    writeFileSync(join(dir, 'b.js'), 'x = "__ESPRESSO_API_URL__";\n');
    expect(textProblems(dir)).toEqual(['a.js: contains "10.0.2.2"', 'b.js: contains "__ESPRESSO_API_URL__"']);
  });

  it('reads the base URL by running the build, even when the literal is split, and rejects a local one', () => {
    writeFileSync(
      join(dir, 'index.js'),
      'exports.PushClient = class { constructor() { this.baseURL = ["http://", "loc", "alhost", ":8080"].join(""); } destroy() {} };\n',
    );
    expect(textProblems(dir)).toEqual([]); // the literal is split: only execution shows it
    const url = baseUrlOfBuild(dir);
    expect(url).toBe('http://localhost:8080');
    expect(urlProblems(url)).toEqual(['"http://localhost:8080" is not https', '"http://localhost:8080" is a development address']);
  });

  it('accepts an https production URL', () => {
    expect(urlProblems(PROD_URL)).toEqual([]);
  });
});
