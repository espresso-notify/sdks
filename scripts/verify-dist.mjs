#!/usr/bin/env node
/**
 * verify-dist: prove that the tracked `dist` of an npm package is what its source builds to.
 *
 * Finding FE-13: `sdk/dist` is tracked in git and is what gets published. Nothing showed that
 * it corresponds to `sdk/src`, so a reviewer could not tell a legitimate change of `dist`
 * from a tampered one. This script rebuilds the package in a temporary copy (the working tree
 * is never touched), with the production API URL, and compares every file of the tracked
 * `dist` with the rebuilt one, byte by byte.
 *
 * It works only because the build is deterministic: `tsc` plus the URL injection of
 * `inject-url.mjs` (the code is readable, there is no obfuscator any more, D-54) and the build tool is
 * pinned to an exact version, which this script also checks (the installed version must be the one `package.json` pins).
 *
 *   node ../scripts/verify-dist.mjs .        (from a package directory; `npm run verify:dist`)
 *   node ../scripts/verify-dist.mjs --no-placeholder .   (the guard of `prepack`, and of the publish workflow)
 *
 * The second form does not rebuild anything: it fails when a file of `dist` still holds `__ESPRESSO_API_URL__`, the
 * placeholder that `tsc` leaves and `inject-url.mjs` replaces. A tarball made from such a dist would call a host that
 * does not exist, and `npm pack` alone (without the build with `ESPRESSO_API_URL`) makes exactly that tarball.
 *
 * Exit 0 when `dist` is exactly the rebuilt output; 1 when a file differs, is missing or is
 * extra (each is named), or a tool is not pinned; 2 on usage errors or when the build fails.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** The URL that the published builds carry (`committed-dist.test.ts` asserts the same). */
export const PRODUCTION_API_URL = 'https://api.espressonotify.com';

/** Build tools whose exact version decides the bytes of `dist` (the compiler). */
export const PINNED_TOOLS = ['typescript'];

const SKIP_COPY = new Set(['node_modules', 'dist', '__tests__', 'jest', 'coverage', '.git']);
const EXACT = /^\d+\.\d+\.\d+$/;

/** Every file under `dir`, as sorted relative paths with `/` separators. */
export function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Why the build tools are not pinned, as a list of messages (empty when they are). */
export function pinProblems(pkgDir) {
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  const problems = [];
  for (const tool of PINNED_TOOLS) {
    if (!(tool in declared)) continue;
    if (!EXACT.test(declared[tool])) {
      problems.push(`${tool} is "${declared[tool]}" in package.json; pin an exact version (x.y.z) so the build is reproducible`);
      continue;
    }
    const installedFile = path.join(pkgDir, 'node_modules', tool, 'package.json');
    const installed = existsSync(installedFile) ? JSON.parse(readFileSync(installedFile, 'utf8')).version : null;
    if (installed !== declared[tool]) {
      problems.push(`${tool} ${installed ?? 'is not installed'} but package.json pins ${declared[tool]}; run npm ci`);
    }
  }
  return problems;
}

/** Compare two `dist` directories. Returns the differing, missing and extra files. */
export function compareDist(tracked, rebuilt) {
  const a = listFiles(tracked);
  const b = listFiles(rebuilt);
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    differs: a.filter((f) => setB.has(f) && sha(path.join(tracked, f)) !== sha(path.join(rebuilt, f))),
    notRebuilt: a.filter((f) => !setB.has(f)),
    notTracked: b.filter((f) => !setA.has(f)),
    same: a.filter((f) => setB.has(f) && sha(path.join(tracked, f)) === sha(path.join(rebuilt, f))),
  };
}

/** The placeholder of the API URL that `inject-url.mjs` replaces in the build. */
export const PLACEHOLDER = '__ESPRESSO_API_URL__';

/** The files of `distDir` (relative paths) that still hold the placeholder. */
export function placeholderFiles(distDir) {
  return listFiles(distDir).filter((f) => readFileSync(path.join(distDir, f)).includes(PLACEHOLDER));
}

/** Guard for `prepack` and for the publish job: 0 when `dist` holds no placeholder, 1 when it does or is missing. */
export function checkNoPlaceholder(pkgDirArg) {
  const pkgDir = realpathSync(path.resolve(pkgDirArg));
  const name = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).name;
  const dist = path.join(pkgDir, 'dist');
  if (listFiles(dist).length === 0) {
    console.error(`[verify-dist] ${name}: there is no dist to pack. Build it with: ESPRESSO_API_URL=${PRODUCTION_API_URL} npm run build`);
    return 1;
  }
  const bad = placeholderFiles(dist);
  if (bad.length > 0) {
    for (const f of bad) console.error(`[verify-dist] ${name}: dist/${f} still holds ${PLACEHOLDER}`);
    console.error(
      `[verify-dist] ${name}: refusing to pack a dist built without the API URL (every client of it would call a host that does not exist). ` +
        `Build it with: ESPRESSO_API_URL=${PRODUCTION_API_URL} npm run build`,
    );
    return 1;
  }
  console.log(`[verify-dist] ${name}: no placeholder in dist (${listFiles(dist).length} files)`);
  return 0;
}

export function verify(pkgDirArg) {
  const pkgDir = realpathSync(path.resolve(pkgDirArg));
  const name = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).name;
  const log = (m) => console.log(`[verify-dist] ${name}: ${m}`);

  const pins = pinProblems(pkgDir);
  if (pins.length > 0) {
    for (const p of pins) console.error(`[verify-dist] ${name}: ${p}`);
    return 1;
  }

  const work = mkdtempSync(path.join(tmpdir(), 'verify-dist-'));
  try {
    cpSync(pkgDir, work, { recursive: true, filter: (src) => !SKIP_COPY.has(path.basename(src)) || src === pkgDir });
    if (existsSync(path.join(pkgDir, 'node_modules'))) symlinkSync(path.join(pkgDir, 'node_modules'), path.join(work, 'node_modules'));

    log(`rebuilding in ${work} with ESPRESSO_API_URL=${PRODUCTION_API_URL}`);
    const env = { ...process.env, ESPRESSO_API_URL: PRODUCTION_API_URL };
    const build = spawnSync('npm', ['run', 'build'], { cwd: work, env, encoding: 'utf8' });
    if (build.status !== 0) {
      console.error(build.stdout);
      console.error(build.stderr);
      console.error(`[verify-dist] ${name}: the build failed (exit ${build.status})`);
      return 2;
    }

    const result = compareDist(path.join(pkgDir, 'dist'), path.join(work, 'dist'));
    for (const f of result.same) log(`ok        ${f}  ${sha(path.join(pkgDir, 'dist', f)).slice(0, 16)}`);
    for (const f of result.differs) console.error(`[verify-dist] ${name}: DIFFERS   ${f}  (tracked ${sha(path.join(pkgDir, 'dist', f)).slice(0, 16)}, rebuilt ${sha(path.join(work, 'dist', f)).slice(0, 16)})`);
    for (const f of result.notRebuilt) console.error(`[verify-dist] ${name}: EXTRA     ${f}  (tracked, but the source does not build it)`);
    for (const f of result.notTracked) console.error(`[verify-dist] ${name}: MISSING   ${f}  (the source builds it, but it is not in dist)`);
    const bad = result.differs.length + result.notRebuilt.length + result.notTracked.length;
    if (bad > 0) {
      console.error(`[verify-dist] ${name}: dist is NOT what the source builds to (${bad} file(s)). Rebuild it with the production URL and commit it.`);
      return 1;
    }
    log(`dist matches the rebuilt output (${result.same.length} files, byte for byte)`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const guard = args[0] === '--no-placeholder';
  const target = guard ? args[1] : args[0];
  if (!target) {
    console.error('usage: node scripts/verify-dist.mjs [--no-placeholder] <package directory>');
    process.exit(2);
  }
  process.exit(guard ? checkNoPlaceholder(target) : verify(target));
}
