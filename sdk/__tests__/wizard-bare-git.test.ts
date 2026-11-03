/**
 * @jest-environment node
 *
 * wizard-backup-folder (WB-01 to WB-04, WB-10, WB-12): `createGitCheck`, the question "does git hold the original of this file?"
 * that decides whether the setup wizard makes a copy. It is true only for a file that is tracked and equal to HEAD. Two
 * parts: a fake `spawnSync` that proves the command lines, the failures and the Windows paths, and a real git repository in
 * a temporary folder that proves what git itself answers.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path, { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createGitCheck, hasUncommittedChanges, GIT_LIST_TRACKED, GIT_LIST_UNSTAGED, GIT_LIST_STAGED } = require('../bin/lib/git.js');

const list = (paths: string[]) => paths.map((p) => `${p}\0`).join('');

/**
 * A `spawnSync` that answers `ls-files` with `tracked`, `diff` (disk against stage) with `changed` and `diff --cached` (stage
 * against HEAD) with `staged`; null means git failed (exit 128).
 */
function fakeGit(answers: { tracked: string[] | null; changed: string[] | null; staged?: string[] | null }) {
  return jest.fn((_file: string, args: string[], _options: any) => {
    let paths: string[] | null;
    if (args.includes('ls-files')) paths = answers.tracked;
    else if (args.includes('--cached')) paths = answers.staged === undefined ? [] : answers.staged;
    else paths = answers.changed;
    return paths === null ? { status: 128, stdout: '', stderr: 'fatal' } : { status: 0, stdout: list(paths), stderr: '' };
  });
}

describe('createGitCheck with a fake git', () => {
  const cwd = '/apps/hello';

  it('WB-01: a tracked file that is not changed is held by git', () => {
    const holds = createGitCheck({ cwd, spawnSync: fakeGit({ tracked: ['ios/Podfile'], changed: [] }) });
    expect(holds(`${cwd}/ios/Podfile`)).toBe(true);
  });

  it('WB-02: a tracked file with a change on disk, or one in the stage, is not held', () => {
    const spawnSync = fakeGit({ tracked: ['ios/Podfile', 'ios/Other', 'android/build.gradle'], changed: ['ios/Podfile'], staged: ['ios/Other'] });
    const holds = createGitCheck({ cwd, spawnSync });
    expect(holds(`${cwd}/ios/Podfile`)).toBe(false);
    expect(holds(`${cwd}/ios/Other`)).toBe(false);
    expect(holds(`${cwd}/android/build.gradle`)).toBe(true);
  });

  it('WB-03: a file that is not tracked (new or ignored) is not held', () => {
    const holds = createGitCheck({ cwd, spawnSync: fakeGit({ tracked: ['package.json'], changed: [] }) });
    expect(holds(`${cwd}/ios/Podfile`)).toBe(false);
  });

  it.each([
    ['the folder is not a work tree', { tracked: null, changed: null }],
    ['the comparison with the stage fails', { tracked: ['ios/Podfile'], changed: null }],
    ['the comparison of the stage with HEAD fails', { tracked: ['ios/Podfile'], changed: [], staged: null }],
  ])('WB-04: %s, so nothing is held', (_name, answers) => {
    const holds = createGitCheck({ cwd, spawnSync: fakeGit(answers) });
    expect(holds(`${cwd}/ios/Podfile`)).toBe(false);
  });

  it.each([
    ['git is not installed', () => ({ error: Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' }), status: null, stdout: null })],
    ['git runs past the time limit', () => ({ error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, stdout: '' })],
    ['git is killed by a signal', () => ({ status: null, signal: 'SIGKILL', stdout: list(['ios/Podfile']) })],
    ['the output is not text', () => ({ status: 0, stdout: null })],
    ['spawnSync throws', () => {
      throw new Error('EPERM');
    }],
  ])('WB-04: %s, so nothing is held', (_name, answer) => {
    const holds = createGitCheck({ cwd, spawnSync: jest.fn(answer as any) });
    expect(holds(`${cwd}/ios/Podfile`)).toBe(false);
  });

  it('asks git nothing until the first file, and only once for any number of files', () => {
    const spawnSync = fakeGit({ tracked: ['a', 'b', 'c'], changed: [] });
    const holds = createGitCheck({ cwd, spawnSync });
    expect(spawnSync).not.toHaveBeenCalled();
    holds(`${cwd}/a`);
    holds(`${cwd}/b`);
    holds(`${cwd}/c`);
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });

  it('runs git with constant arguments, in the app folder, without a shell', () => {
    const spawnSync = fakeGit({ tracked: [], changed: [] });
    createGitCheck({ cwd, spawnSync })(`${cwd}/ios/Podfile`);
    expect(spawnSync.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ['git', GIT_LIST_TRACKED],
      ['git', GIT_LIST_UNSTAGED],
      ['git', GIT_LIST_STAGED],
    ]);
    expect(GIT_LIST_TRACKED).toEqual(['--no-optional-locks', 'ls-files', '-z']);
    expect(GIT_LIST_UNSTAGED).toEqual(['--no-optional-locks', 'diff', '--no-ext-diff', '--name-only', '-z', '--relative']);
    expect(GIT_LIST_STAGED).toEqual(['--no-optional-locks', 'diff', '--no-ext-diff', '--cached', '--name-only', '-z', '--relative']);
    for (const [, , options] of spawnSync.mock.calls) {
      expect(options.cwd).toBe(cwd);
      expect(options.shell).toBe(false);
      expect(typeof options.timeout).toBe('number');
      expect(options.encoding).toBe('utf8');
    }
  });

  it('nothing from the project reaches the command line: the file asked about is not in it', () => {
    const spawnSync = fakeGit({ tracked: [], changed: [] });
    createGitCheck({ cwd, spawnSync })(`${cwd}/ios/Pod file; rm -rf $HOME`);
    for (const [file, args] of spawnSync.mock.calls) {
      expect([file, ...args].join(' ')).not.toMatch(/Pod file|rm -rf/);
    }
  });

  it('a file outside the app folder is not held', () => {
    const holds = createGitCheck({ cwd, spawnSync: fakeGit({ tracked: ['Podfile'], changed: [] }) });
    expect(holds('/elsewhere/Podfile')).toBe(false);
    expect(holds(`${cwd}/../hello2/Podfile`)).toBe(false);
  });

  it('a path with spaces, accents and a newline is compared as git lists it', () => {
    const names = ['ios/My App/AppDelegate.swift', 'ios/Aplicação/Podfile', 'ios/line\nbreak/File'];
    const holds = createGitCheck({ cwd, spawnSync: fakeGit({ tracked: names, changed: [] }) });
    for (const name of names) expect(holds(`${cwd}/${name}`)).toBe(true);
  });

  describe('WB-10: Windows', () => {
    const win = 'C:\\apps\\Hello';

    it('compares the backslash path of the disk with the slash path git prints', () => {
      const spawnSync = fakeGit({ tracked: ['ios/Hello/AppDelegate.swift', 'android/app/build.gradle'], changed: ['android/app/build.gradle'] });
      const holds = createGitCheck({ cwd: win, spawnSync, pathApi: path.win32 });
      expect(holds(`${win}\\ios\\Hello\\AppDelegate.swift`)).toBe(true);
      expect(holds(`${win}\\android\\app\\build.gradle`)).toBe(false);
      expect(holds(`${win}\\android\\build.gradle`)).toBe(false);
    });

    it('a file on another drive is not held', () => {
      const holds = createGitCheck({ cwd: win, spawnSync: fakeGit({ tracked: ['Podfile'], changed: [] }), pathApi: path.win32 });
      expect(holds('D:\\apps\\Hello\\Podfile')).toBe(false);
    });

    it('runs git.exe through the name git, with no shell and the safe environment the wizard gives its commands', () => {
      const spawnSync = fakeGit({ tracked: [], changed: [] });
      const environment = { env: { Path: 'C:\\Git\\cmd', NoDefaultCurrentDirectoryInExePath: '1' } };
      createGitCheck({ cwd: win, spawnSync, pathApi: path.win32, environment })(`${win}\\Podfile`);
      const [file, , options] = spawnSync.mock.calls[0];
      expect(file).toBe('git');
      expect(options.shell).toBe(false);
      expect(options.cwd).toBe(win);
      expect(options.env.NoDefaultCurrentDirectoryInExePath).toBe('1');
    });
  });
});

describe('createGitCheck with a real git repository', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, env, stdio: 'pipe' });

  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'espresso-git-'));
    dirs.push(dir);
    git(dir, 'init', '-q');
    mkdirSync(join(dir, 'ios'));
    writeFileSync(join(dir, 'ios', 'Podfile'), 'platform :ios\n');
    writeFileSync(join(dir, 'ios', 'Other'), 'other\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'first');
    return dir;
  }
  const check = (dir: string) => createGitCheck({ cwd: dir, pathApi: path });

  it('WB-01: a committed file with no change is held', () => {
    const dir = repo();
    expect(check(dir)(join(dir, 'ios', 'Podfile'))).toBe(true);
  });

  it('WB-02: a file changed on disk, and one changed and staged, are not held; the other file still is', () => {
    const dir = repo();
    writeFileSync(join(dir, 'ios', 'Podfile'), 'platform :ios\nchanged\n');
    writeFileSync(join(dir, 'ios', 'Other'), 'other\nstaged\n');
    git(dir, 'add', 'ios/Other');
    writeFileSync(join(dir, 'ios', 'Other'), 'other\n');
    const holds = check(dir);
    expect(holds(join(dir, 'ios', 'Podfile'))).toBe(false);
    expect(holds(join(dir, 'ios', 'Other'))).toBe(false);
    git(dir, 'checkout', 'HEAD', '--', 'ios/Other');
    expect(check(dir)(join(dir, 'ios', 'Other'))).toBe(true);
  });

  it('WB-03: an untracked file and an ignored file are not held', () => {
    const dir = repo();
    writeFileSync(join(dir, '.gitignore'), 'ignored/\n');
    mkdirSync(join(dir, 'ignored'));
    writeFileSync(join(dir, 'ignored', 'build.gradle'), 'x\n');
    writeFileSync(join(dir, 'ios', 'New'), 'new\n');
    const holds = check(dir);
    expect(holds(join(dir, 'ios', 'New'))).toBe(false);
    expect(holds(join(dir, 'ignored', 'build.gradle'))).toBe(false);
  });

  it('WB-04: a repository without a commit holds nothing, even a staged file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'espresso-git-'));
    dirs.push(dir);
    git(dir, 'init', '-q');
    writeFileSync(join(dir, 'Podfile'), 'x\n');
    git(dir, 'add', 'Podfile');
    expect(check(dir)(join(dir, 'Podfile'))).toBe(false);
  });

  it('WB-04: a folder that is not a work tree holds nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'espresso-nogit-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'Podfile'), 'x\n');
    // GIT_CEILING_DIRECTORIES stops git from finding a repository in a parent of the temporary folder
    const holds = createGitCheck({ cwd: dir, pathApi: path, environment: { env: { ...env, GIT_CEILING_DIRECTORIES: path.dirname(dir) } } });
    expect(holds(join(dir, 'Podfile'))).toBe(false);
  });

  it('an app folder inside a bigger repository (a monorepo) is answered by paths relative to the app', () => {
    const dir = repo();
    mkdirSync(join(dir, 'apps', 'hello', 'ios'), { recursive: true });
    writeFileSync(join(dir, 'apps', 'hello', 'ios', 'Podfile'), 'p\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'app');
    const app = join(dir, 'apps', 'hello');
    expect(check(app)(join(app, 'ios', 'Podfile'))).toBe(true);
    writeFileSync(join(app, 'ios', 'Podfile'), 'p\nchanged\n');
    expect(check(app)(join(app, 'ios', 'Podfile'))).toBe(false);
  });
});

describe('hasUncommittedChanges (WB-12)', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, env, stdio: 'pipe' });
  const ask = (cwd: string) => hasUncommittedChanges({ cwd, environment: { env } });

  /** A repository whose app lives in apps/hello, everything committed. */
  function monorepo(): { root: string; app: string } {
    const root = mkdtempSync(join(tmpdir(), 'espresso-status-'));
    dirs.push(root);
    git(root, 'init', '-q');
    const app = join(root, 'apps', 'hello');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'package.json'), '{}\n');
    writeFileSync(join(root, 'README.md'), 'root\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'first');
    return { root, app };
  }

  it('is false for a clean work tree', () => {
    expect(ask(monorepo().app)).toBe(false);
  });

  it('is true for a change on disk, a staged change and an untracked file', () => {
    const one = monorepo();
    writeFileSync(join(one.app, 'package.json'), '{"a":1}\n');
    expect(ask(one.app)).toBe(true);
    const two = monorepo();
    writeFileSync(join(two.app, 'package.json'), '{"a":1}\n');
    git(two.root, 'add', '-A');
    expect(ask(two.app)).toBe(true);
    const three = monorepo();
    writeFileSync(join(three.app, 'new.txt'), 'x\n');
    expect(ask(three.app)).toBe(true);
  });

  it('looks at the app folder only: a change elsewhere in the repository does not count', () => {
    const { root, app } = monorepo();
    writeFileSync(join(root, 'README.md'), 'changed outside the app\n');
    expect(ask(app)).toBe(false);
  });

  it('is null when git cannot tell: not a work tree, git missing, a failed or non-text answer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'espresso-status-none-'));
    dirs.push(dir);
    expect(hasUncommittedChanges({ cwd: dir, environment: { env: { ...env, GIT_CEILING_DIRECTORIES: path.dirname(dir) } } })).toBeNull();
    const fake = (answer: any) => hasUncommittedChanges({ cwd: '/apps/hello', spawnSync: (() => answer) as any });
    expect(fake({ error: new Error('ENOENT'), status: null, stdout: '' })).toBeNull();
    expect(fake({ status: 128, stdout: '' })).toBeNull();
    expect(fake({ status: 0, stdout: null })).toBeNull();
    expect(hasUncommittedChanges({ cwd: '/apps/hello', spawnSync: (() => { throw new Error('boom'); }) as any })).toBeNull();
  });

  it('asks with constant arguments, without a shell, in the app folder', () => {
    const spawnSync = jest.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    hasUncommittedChanges({ cwd: '/apps/hello', spawnSync: spawnSync as any, environment: { env: { Path: 'x' } } });
    const [file, args, options]: any = spawnSync.mock.calls[0];
    expect(file).toBe('git');
    expect(args).toEqual(['--no-optional-locks', 'status', '--porcelain', '-z', '--', '.']);
    expect(options.shell).toBe(false);
    expect(options.cwd).toBe('/apps/hello');
    expect(options.env).toEqual({ Path: 'x' });
  });
});
