/**
 * @jest-environment node
 *
 * FE-13 (security-sdk-fixes, SDKS-10 and SDKS-11): `scripts/verify-dist.mjs` rebuilds a
 * package in a temporary copy and compares the result with the tracked `dist`.
 *
 * It runs against tiny fixture packages whose "build" is a one-line node script, so the
 * tests exercise the comparison and the pin check, not the real build tools (that is
 * `npm run verify:dist`, which CI runs on the real packages).
 */
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

jest.setTimeout(60_000);

const SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'verify-dist.mjs');
const BUILD = `
const { mkdirSync, readFileSync, writeFileSync } = require('fs');
mkdirSync('dist', { recursive: true });
const src = readFileSync('src/main.txt', 'utf8');
writeFileSync('dist/main.js', 'module.exports = ' + JSON.stringify(src.toUpperCase()) + ';\\n');
writeFileSync('dist/main.d.ts', 'export declare const value: string;\\n');
writeFileSync('dist/url.txt', process.env.ESPRESSO_API_URL + '\\n');
`;

let pkg: string;

function fixture(devDependencies: Record<string, string> = {}) {
  pkg = mkdtempSync(join(tmpdir(), 'espresso-verify-dist-'));
  mkdirSync(join(pkg, 'src'));
  writeFileSync(join(pkg, 'src', 'main.txt'), 'hello');
  writeFileSync(join(pkg, 'build.cjs'), BUILD);
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { build: 'node build.cjs' }, devDependencies }),
  );
  // The tracked dist is what the source builds to.
  mkdirSync(join(pkg, 'dist'));
  writeFileSync(join(pkg, 'dist', 'main.js'), 'module.exports = "HELLO";\n');
  writeFileSync(join(pkg, 'dist', 'main.d.ts'), 'export declare const value: string;\n');
  writeFileSync(join(pkg, 'dist', 'url.txt'), 'https://api.espressonotify.com\n');
}

function installed(tool: string, version: string) {
  mkdirSync(join(pkg, 'node_modules', tool), { recursive: true });
  writeFileSync(join(pkg, 'node_modules', tool, 'package.json'), JSON.stringify({ name: tool, version }));
}

function run() {
  const env: NodeJS.ProcessEnv = { ...process.env, ESPRESSO_API_URL: 'http://localhost:8080' };
  return spawnSync(process.execPath, [SCRIPT, pkg], { encoding: 'utf-8', env });
}

/** A fingerprint of every file of the package, to prove the check does not touch it. */
function snapshot(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(`${full.slice(dir.length)} ${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
    }
  };
  walk(dir);
  return out.join('\n');
}

afterEach(() => rmSync(pkg, { recursive: true, force: true }));

describe('verify-dist (SDKS-11)', () => {
  it('passes when every tracked file is what the source builds to, with the production URL', () => {
    fixture();
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('matches the rebuilt output (3 files');
  });

  it('does not touch the working tree', () => {
    fixture();
    const before = snapshot(pkg);
    run();
    expect(snapshot(pkg)).toBe(before);
  });

  it('fails and names the file when one byte of a tracked file differs', () => {
    fixture();
    writeFileSync(join(pkg, 'dist', 'main.js'), 'module.exports = "HELLO";\n// tampered\n');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/DIFFERS\s+main\.js/);
    expect(r.stderr).not.toMatch(/DIFFERS\s+main\.d\.ts/);
  });

  it('fails when the source changed and dist was not rebuilt', () => {
    fixture();
    writeFileSync(join(pkg, 'src', 'main.txt'), 'goodbye');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/DIFFERS\s+main\.js/);
  });

  it('fails when a tracked file is not built by the source (extra)', () => {
    fixture();
    writeFileSync(join(pkg, 'dist', 'collector.js'), 'steal();\n');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/EXTRA\s+collector\.js/);
  });

  it('fails when the source builds a file that is not tracked (missing)', () => {
    fixture();
    rmSync(join(pkg, 'dist', 'main.d.ts'));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/MISSING\s+main\.d\.ts/);
  });

  it('builds with the production URL, not the one of the caller environment', () => {
    fixture();
    writeFileSync(join(pkg, 'dist', 'url.txt'), 'http://localhost:8080\n');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/DIFFERS\s+url\.txt/);
  });

  it('exits 2 when the build itself fails', () => {
    fixture();
    writeFileSync(join(pkg, 'build.cjs'), 'process.exit(3);\n');
    expect(run().status).toBe(2);
  });
});

describe('verify-dist pins the build tools (SDKS-10)', () => {
  it('fails when a build tool is declared with a range', () => {
    fixture({ typescript: '^5.0.0' });
    installed('typescript', '5.9.3');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('pin an exact version');
  });

  it('fails when the installed version is not the pinned one', () => {
    fixture({ typescript: '5.9.3' });
    installed('typescript', '5.9.4');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('5.9.4 but package.json pins 5.9.3');
  });

  it('passes when the tools are pinned and installed at that version', () => {
    fixture({ typescript: '5.9.3' });
    installed('typescript', '5.9.3');
    expect(run().status).toBe(0);
  });
});

describe('the real packages declare exact build tools (SDKS-10)', () => {
  it.each([
    ['sdk', ['typescript']],
    ['sdk-web', ['typescript']],
  ])('%s', (dir, tools) => {
    const p = JSON.parse(readFileSync(resolve(__dirname, '..', '..', dir, 'package.json'), 'utf-8'));
    for (const tool of tools) expect(p.devDependencies[tool]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(p.scripts['verify:dist']).toBe('node ../scripts/verify-dist.mjs .');
  });
});

// A tarball made by `npm pack` or `npm publish` must never carry the placeholder of the API URL: a dist built without
// `ESPRESSO_API_URL` has it in `API_URL`, and every client of that build would call a host that does not exist.
describe('verify-dist --no-placeholder (the pack and publish guard)', () => {
  const PLACEHOLDER = '__ESPRESSO_API_URL__';
  const guard = (dir: string = pkg) => spawnSync(process.execPath, [SCRIPT, '--no-placeholder', dir], { encoding: 'utf-8' });

  it('passes when dist holds the production URL and no placeholder', () => {
    fixture();
    const r = guard();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no placeholder');
  });

  it('fails and names the file when a dist file still holds the placeholder', () => {
    fixture();
    writeFileSync(join(pkg, 'dist', 'main.js'), `const API_URL = "${PLACEHOLDER}";\n`);
    const r = guard();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/main\.js/);
    expect(r.stderr).not.toMatch(/main\.d\.ts/);
    expect(r.stderr).toContain('ESPRESSO_API_URL=https://api.espressonotify.com');
  });

  it('finds the placeholder in a nested file and in a declaration file', () => {
    fixture();
    mkdirSync(join(pkg, 'dist', 'nested'));
    writeFileSync(join(pkg, 'dist', 'nested', 'deep.js'), `x("${PLACEHOLDER}")\n`);
    writeFileSync(join(pkg, 'dist', 'main.d.ts'), `// ${PLACEHOLDER}\n`);
    const r = guard();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/nested\/deep\.js/);
    expect(r.stderr).toMatch(/main\.d\.ts/);
  });

  it('fails when there is no dist to pack at all', () => {
    fixture();
    rmSync(join(pkg, 'dist'), { recursive: true });
    const r = guard();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no dist/);
  });

  it('does not touch the package', () => {
    fixture();
    writeFileSync(join(pkg, 'dist', 'main.js'), `const API_URL = "${PLACEHOLDER}";\n`);
    const before = snapshot(pkg);
    guard();
    expect(snapshot(pkg)).toBe(before);
  });

  it('stops npm pack: a package whose prepack runs the guard makes no tarball while dist has the placeholder', () => {
    fixture();
    const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf-8'));
    manifest.scripts.prepack = `node ${JSON.stringify(SCRIPT)} --no-placeholder .`;
    manifest.files = ['dist'];
    writeFileSync(join(pkg, 'package.json'), JSON.stringify(manifest));
    const clean = spawnSync('npm', ['pack', '--dry-run'], { cwd: pkg, encoding: 'utf-8' });
    expect(clean.status).toBe(0);

    writeFileSync(join(pkg, 'dist', 'main.js'), `const API_URL = "${PLACEHOLDER}";\n`);
    const bad = spawnSync('npm', ['pack', '--dry-run'], { cwd: pkg, encoding: 'utf-8' });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain(PLACEHOLDER);
  });
});

describe('the real packages refuse to pack a dist with the placeholder', () => {
  it.each(['sdk', 'sdk-web'])('%s runs the guard in prepack', (dir) => {
    const p = JSON.parse(readFileSync(resolve(__dirname, '..', '..', dir, 'package.json'), 'utf-8'));
    expect(p.scripts.prepack).toBe('node ../scripts/verify-dist.mjs --no-placeholder .');
  });

  it.each(['sdk', 'sdk-web'])('%s tracks a dist without the placeholder', (dir) => {
    const r = spawnSync(process.execPath, [SCRIPT, '--no-placeholder', resolve(__dirname, '..', '..', dir)], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
  });
});
