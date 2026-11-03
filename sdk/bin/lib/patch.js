'use strict';

/**
 * The safe file writer of the setup wizard for React Native apps without Expo.
 *
 * A patcher is a pure function `(text, context) => { status, text?, reason? }` with `status` one of `patched`, `already`
 * or `unsupported`. `applyPatch` is the only place that touches the disk, and it follows these rules for every file:
 *
 *   - it reads a regular text file of at most 1 MB that is valid UTF-8; anything else is `skipped`, never written;
 *   - a patcher can only add lines: if the new text does not hold every old line in the same order, nothing is written;
 *   - before the first write it makes sure the original can come back: when git holds it (the caller says so with
 *     `gitHolds`: tracked, equal to `HEAD`) it makes no copy; otherwise it copies the file into
 *     `.espresso-notify-backup/<YYYYMMDDTHHMMSS>/<path of the file>` under the project folder (one folder for the whole run, a
 *     numeric suffix when that folder exists, a copy is never overwritten) and checks the copy is equal to the original; it
 *     never puts a copy next to a file and never edits a `.gitignore`;
 *   - it writes a temporary file in the same folder, gives it the mode of the original, and renames it over the file, so
 *     a failure leaves the original as it was;
 *   - it keeps the line ending (LF or CRLF), the byte order mark and the final newline the file had;
 *   - `already` and `unsupported` write nothing, make no copy and do not ask git; `dryRun` returns the lines that would be
 *     added, says whether git holds the file or where the copy would go, and writes nothing.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { TextDecoder } = require('node:util');

/** A file above this size is not edited (1 MB). */
const MAX_FILE_BYTES = 1024 * 1024;
const BOM = '﻿';
const MAX_COPY_SUFFIX = 1000;
/** The one folder of the copies, under the project folder. */
const BACKUP_DIR = '.espresso-notify-backup';

/**
 * The begin and end comments that frame a block the wizard added, in the comment syntax of the file.
 * @param {'#' | '//' | '<!--'} comment
 * @param {string} [name]
 * @returns {{ begin: string, end: string }}
 */
function markers(comment, name) {
  const begin = `espresso-notify:begin${name ? ` ${name}` : ''}`;
  const end = 'espresso-notify:end';
  if (comment === '<!--') return { begin: `<!-- ${begin} -->`, end: `<!-- ${end} -->` };
  return { begin: `${comment} ${begin}`, end: `${comment} ${end}` };
}

/** `YYYYMMDDTHHMMSS` in the local time zone, the one `ls -l` shows next to the file. */
function stamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Gives `text` the line ending of `original`: when the original uses only CRLF (or only LF) every line break of the new
 * text becomes that one. A file that mixes both is left as the patcher wrote it (the patcher takes the ending of its
 * anchor line).
 */
function keepLineEnding(original, text) {
  const crlf = (original.match(/\r\n/g) || []).length;
  const bareLf = (original.match(/(?<!\r)\n/g) || []).length;
  if (crlf > 0 && bareLf === 0) return text.replace(/\r?\n/g, '\r\n');
  if (bareLf > 0 && crlf === 0) return text.replace(/\r\n/g, '\n');
  return text;
}

const lineList = (text) => text.split(/\r?\n/);

/** True when every line of `oldLines` is in `newLines`, in the same order (the new text only added lines). */
function keepsEveryLine(oldLines, newLines) {
  let next = 0;
  for (const line of newLines) {
    if (next < oldLines.length && line === oldLines[next]) next += 1;
  }
  return next === oldLines.length;
}

/** The lines of `newLines` that are not the old ones, in order (what the dry run shows). */
function addedLines(oldLines, newLines) {
  const added = [];
  let next = 0;
  for (const line of newLines) {
    if (next < oldLines.length && line === oldLines[next]) next += 1;
    else added.push(line);
  }
  return added;
}

const message = (error) => (error && error.message ? error.message : String(error));

/**
 * Applies one patcher to one file.
 * @param {object} args
 * @param {string} args.file path of the file
 * @param {(text: string, context: any) => { status: string, text?: string, reason?: string }} args.patcher
 * @param {any} [args.context] given to the patcher
 * @param {boolean} [args.dryRun] compute the change and write nothing
 * @param {typeof import('node:fs')} [args.fsApi] the file system
 * @param {(file: string) => boolean} [args.gitHolds] true when git holds the original of the file, so no copy is made; only
 *   the answer `true` counts, and a file reached through a link is always copied
 * @param {ReturnType<typeof createBackupSession>} args.backup the backup folder of the run (required: this function never
 *   makes a folder of its own, so a copy can never land next to a file); a missing one throws
 * @returns {{ file: string, status: 'patched' | 'already' | 'unsupported' | 'missing' | 'skipped' | 'error',
 *   backup?: string, git?: true, wouldBackup?: string, reason?: string, warning?: string, preview?: string[], dryRun?: boolean }}
 *   `backup` is the copy that was made, `git` says git holds the original (no copy), `wouldBackup` is the copy a dry run
 *   would make
 */
function applyPatch({ file, patcher, context, dryRun = false, fsApi = nodeFs, gitHolds, backup: folder }) {
  if (!folder || typeof folder.copy !== 'function' || typeof folder.pathFor !== 'function') {
    throw new TypeError('applyPatch needs `backup`, the backup session of the run (createBackupSession), so that no copy is made next to a file');
  }
  let warning;
  const result = (status, extra) => ({ file, status, ...(warning ? { warning } : {}), ...extra });

  let target = file;
  let stat;
  try {
    stat = fsApi.statSync(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return result('missing', { reason: 'the file does not exist' });
    return result('skipped', { reason: `the file cannot be read: ${message(error)}` });
  }
  if (!stat.isFile()) return result('skipped', { reason: 'it is not a regular file' });
  if (stat.size > MAX_FILE_BYTES) return result('skipped', { reason: 'the file is larger than 1 MB' });

  let bytes;
  try {
    // A link to the file is followed so the rename replaces the file and the link stays a link.
    if (fsApi.lstatSync(file).isSymbolicLink()) target = fsApi.realpathSync(file);
    bytes = fsApi.readFileSync(target);
  } catch (error) {
    return result('skipped', { reason: `the file cannot be read: ${message(error)}` });
  }
  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (_) {
    return result('skipped', { reason: 'the file is not valid UTF-8 text' });
  }
  const hasBom = decoded.startsWith(BOM);
  const original = hasBom ? decoded.slice(1) : decoded;

  let outcome;
  try {
    outcome = patcher(original, context);
  } catch (error) {
    return result('error', { reason: `the patcher failed: ${message(error)}` });
  }
  // A patcher may add a `warning` to any answer (a line of the project that works but is risky); it goes to the caller.
  if (outcome && typeof outcome.warning === 'string') warning = outcome.warning;
  if (!outcome || outcome.status === 'already') return result('already');
  if (outcome.status === 'unsupported') return result('unsupported', { reason: outcome.reason });
  if (outcome.status !== 'patched' || typeof outcome.text !== 'string') {
    return result('error', { reason: 'the patcher returned an unknown answer' });
  }

  const patched = keepLineEnding(original, outcome.text);
  if (patched === original) return result('already');
  const oldLines = lineList(original);
  const newLines = lineList(patched);
  if (!keepsEveryLine(oldLines, newLines)) {
    return result('error', {
      reason: 'the change would remove or reorder a line of the file, so nothing was written',
    });
  }
  const preview = addedLines(oldLines, newLines);

  // Git is the backup when it holds the original. A link is never taken for held: git tracks the link, not the file it points to.
  const inGit = target === file && holdsOriginal(gitHolds, file);
  if (dryRun) {
    return result('patched', { dryRun: true, preview, ...(inGit ? { git: true } : { wouldBackup: folder.pathFor(file) }) });
  }
  let backup = { path: undefined };
  if (!inGit) {
    backup = folder.copy({ file, target, bytes });
    if (backup.error) return result('error', { reason: backup.error });
  }

  const mode = stat.mode & 0o7777;
  const tmp = nodePath.join(
    nodePath.dirname(target),
    `.${nodePath.basename(target)}.espresso-notify-tmp-${process.pid}-${Date.now()}`,
  );
  try {
    fsApi.writeFileSync(tmp, Buffer.from((hasBom ? BOM : '') + patched, 'utf8'), { mode, flag: 'wx' });
    fsApi.chmodSync(tmp, mode);
    fsApi.renameSync(tmp, target);
  } catch (error) {
    try {
      fsApi.unlinkSync(tmp);
    } catch (_) {
      // the temporary file was never created
    }
    return result('error', {
      backup: backup.path,
      reason: `the file could not be written, it is as it was: ${message(error)}`,
    });
  }
  return result('patched', { ...(inGit ? { git: true } : { backup: backup.path }), preview });
}

/** True only when `gitHolds` answers `true`; a question that throws is "not held". */
function holdsOriginal(gitHolds, file) {
  if (typeof gitHolds !== 'function') return false;
  try {
    return gitHolds(file) === true;
  } catch (_) {
    return false;
  }
}

/**
 * The backup folder of one run: `<root>/.espresso-notify-backup/<YYYYMMDDTHHMMSS>`, chosen the first time it is needed (a
 * numeric suffix when that name exists) and kept for every file of the run, so the copies of one run sit together. Nothing is
 * created until a file is copied.
 * @param {object} args
 * @param {string} args.root the project folder
 * @param {Date | (() => Date)} [args.now] the clock
 * @param {Pick<typeof import('node:fs'), 'existsSync'> & Partial<typeof import('node:fs')>} [args.fsApi]
 * @param {typeof import('node:path')} [args.pathApi] the `path` module of the platform
 */
function createBackupSession({ root, now, fsApi = nodeFs, pathApi = nodePath }) {
  let chosen = null;
  const folder = () => {
    if (chosen) return chosen;
    const date = typeof now === 'function' ? now() : now || new Date();
    const base = pathApi.join(root, BACKUP_DIR, stamp(date));
    for (let n = 0; n <= MAX_COPY_SUFFIX; n += 1) {
      const candidate = n === 0 ? base : `${base}-${n}`;
      if (!fsApi.existsSync(candidate)) {
        chosen = candidate;
        return chosen;
      }
    }
    return null;
  };
  /** Where the copy of `file` goes: its path under `root`, or its name when it is not under `root`. */
  const pathFor = (file) => {
    const where = folder();
    if (!where) return null;
    const rel = pathApi.relative(root, file);
    const outside = !rel || rel === '..' || rel.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(rel);
    return pathApi.join(where, outside ? pathApi.basename(file) : rel);
  };
  /** Copies the bytes of `target` into the folder and checks the copy; returns `{ path }` or `{ error }`. */
  const copy = ({ file, target, bytes }) => {
    const destination = pathFor(file);
    if (!destination) {
      return { error: 'could not make the backup copy: too many backup folders with this name, so nothing was written' };
    }
    try {
      fsApi.mkdirSync(pathApi.dirname(destination), { recursive: true });
      fsApi.copyFileSync(target, destination, fsApi.constants.COPYFILE_EXCL);
    } catch (error) {
      return { error: `could not make the backup copy, so nothing was written: ${message(error)}` };
    }
    try {
      if (!fsApi.readFileSync(destination).equals(bytes)) throw new Error('the copy differs from the file');
    } catch (error) {
      try {
        fsApi.unlinkSync(destination);
      } catch (_) {
        // leave it
      }
      return { error: `could not verify the backup copy, so nothing was written: ${message(error)}` };
    }
    return { path: destination };
  };
  return { folder, pathFor, copy };
}

module.exports = { applyPatch, createBackupSession, markers, stamp, keepLineEnding, BACKUP_DIR, MAX_FILE_BYTES };
