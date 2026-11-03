'use strict';

/**
 * The question "does git hold the original of this file?", asked by the setup wizard for React Native apps before it makes a
 * copy of a file it is about to edit. The answer is true only for a file that is tracked and equal to `HEAD`, so a
 * `git checkout HEAD -- <file>` brings the original back. Everything else (an untracked or ignored file, a file with a change on
 * disk or in the stage, a folder that is not a work tree, a repository without a commit, git missing, any failure) is false,
 * and the wizard makes the copy: the safe answer is always to copy.
 *
 * Three commands, all with constant arguments (nothing from the project is in a command line), run once, in the app folder,
 * without a shell:
 *   - `git ls-files -z`: the tracked files under the folder;
 *   - `git diff --name-only -z --relative`: the tracked files whose content on disk differs from the stage;
 *   - `git diff --cached --name-only -z --relative`: the tracked files whose stage differs from `HEAD` (every staged file
 *     when the repository has no commit yet).
 * A file is held when it is tracked and in neither list of changes: then the disk, the stage and `HEAD` are the same, and
 * `git checkout HEAD -- <file>` brings that content back without losing any work of the user. All print paths relative to
 * the app folder, separated by NUL, with `/` on every platform. The path of a file is turned into that form with the `path` module of the platform (`path.win32` on Windows) before the lookup, so a path with `\` finds
 * its entry.
 *
 * On Windows `git` is started by its name, which Windows resolves to `git.exe` (it is not a `.cmd` file, so it needs no
 * `cmd.exe` and no shell); the caller gives the environment that keeps the current folder out of the search for the program.
 */

const nodeChildProcess = require('node:child_process');
const nodePath = require('node:path');

/** The tracked files under the app folder. */
const GIT_LIST_TRACKED = Object.freeze(['--no-optional-locks', 'ls-files', '-z']);
/** The tracked files whose content on disk differs from the stage. */
const GIT_LIST_UNSTAGED = Object.freeze(['--no-optional-locks', 'diff', '--no-ext-diff', '--name-only', '-z', '--relative']);
/** The tracked files whose stage differs from `HEAD`. */
const GIT_LIST_STAGED = Object.freeze(['--no-optional-locks', 'diff', '--no-ext-diff', '--cached', '--name-only', '-z', '--relative']);

/** The entries of the app folder that have an uncommitted change: modified, staged, deleted, renamed or untracked. */
const GIT_STATUS = Object.freeze(['--no-optional-locks', 'status', '--porcelain', '-z', '--', '.']);

/** Longest wait for one command (15 s) and largest output kept (64 MiB); past either one the answer is "not held". */
const GIT_TIMEOUT_MS = 15000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Runs one git command; returns its output, or `null` when it did not finish well, for any reason. */
function runGit(args, { cwd, spawnSync, environment }) {
  try {
    const done = spawnSync('git', [...args], {
      cwd,
      shell: false,
      encoding: 'utf8',
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'ignore'],
      ...environment,
    });
    if (!done || done.error || done.status !== 0 || typeof done.stdout !== 'string') return null;
    return done.stdout;
  } catch (_) {
    return null;
  }
}

const names = (output) => new Set(output.split('\0').filter(Boolean));

/**
 * @param {object} args
 * @param {string} args.cwd the folder of the app, where git runs
 * @param {Function} [args.spawnSync] `child_process.spawnSync`, or a stand-in
 * @param {object} [args.environment] extra `spawnSync` options, such as the `env` of the wizard on Windows
 * @param {typeof import('node:path')} [args.pathApi] the `path` module of the platform
 * @returns {(file: string) => boolean} true when git holds the original of `file`; git is asked once, at the first file
 */
function createGitCheck({ cwd, spawnSync = nodeChildProcess.spawnSync, environment = {}, pathApi = nodePath }) {
  let view; // undefined: not asked yet; null: git cannot tell; else { tracked, changed }
  const load = () => {
    const tracked = runGit(GIT_LIST_TRACKED, { cwd, spawnSync, environment });
    if (tracked === null) return null;
    const unstaged = runGit(GIT_LIST_UNSTAGED, { cwd, spawnSync, environment });
    if (unstaged === null) return null;
    const staged = runGit(GIT_LIST_STAGED, { cwd, spawnSync, environment });
    if (staged === null) return null;
    return { tracked: names(tracked), changed: new Set([...names(unstaged), ...names(staged)]) };
  };
  return (file) => {
    if (view === undefined) view = load();
    if (view === null) return false;
    const rel = pathApi.relative(cwd, file);
    if (!rel || rel === '..' || rel.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(rel)) return false;
    const key = rel.split(pathApi.sep).join('/');
    return view.tracked.has(key) && !view.changed.has(key);
  };
}

/**
 * Whether the app folder has uncommitted changes, as `expo prebuild` asks before it writes: one `git status --porcelain` of the
 * folder, with constant arguments, without a shell.
 * @param {object} args
 * @param {string} args.cwd the folder of the app, where git runs
 * @param {Function} [args.spawnSync] `child_process.spawnSync`, or a stand-in
 * @param {object} [args.environment] extra `spawnSync` options, such as the `env` of the wizard on Windows
 * @returns {boolean | null} true when git lists a change, false when the folder is clean, `null` when git cannot tell (not a
 *   work tree, git missing, any failure): the caller then says nothing
 */
function hasUncommittedChanges({ cwd, spawnSync = nodeChildProcess.spawnSync, environment = {} }) {
  const listed = runGit(GIT_STATUS, { cwd, spawnSync, environment });
  return listed === null ? null : listed.length > 0;
}

module.exports = { createGitCheck, hasUncommittedChanges, GIT_STATUS, GIT_LIST_TRACKED, GIT_LIST_UNSTAGED, GIT_LIST_STAGED, GIT_TIMEOUT_MS, GIT_MAX_BUFFER };
