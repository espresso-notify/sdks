'use strict';

/**
 * The safe file writer of the setup wizard for React Native apps without Expo.
 *
 * A patcher is a pure function `(text, context) => { status, text?, reason? }` with `status` one of `patched`, `already`
 * or `unsupported`. `applyPatch` is the only place that touches the disk, and it follows these rules for every file:
 *
 *   - it reads a regular text file of at most 1 MB that is valid UTF-8; anything else is `skipped`, never written;
 *   - a patcher can only add lines: if the new text does not hold every old line in the same order, nothing is written;
 *   - before the first write it copies the file to `<file>.espresso-notify-<YYYYMMDDTHHMMSS>.bak` next to it (a numeric
 *     suffix when that name exists, a copy is never overwritten) and checks the copy is equal to the original;
 *   - it writes a temporary file in the same folder, gives it the mode of the original, and renames it over the file, so
 *     a failure leaves the original as it was;
 *   - it keeps the line ending (LF or CRLF), the byte order mark and the final newline the file had;
 *   - `already` and `unsupported` write nothing and make no copy; `dryRun` returns the lines that would be added and
 *     writes nothing.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { TextDecoder } = require('node:util');

/** A file above this size is not edited (1 MB). */
const MAX_FILE_BYTES = 1024 * 1024;
const BOM = '﻿';
const MAX_COPY_SUFFIX = 1000;

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
 * @param {Date | (() => Date)} [args.now] the clock, for the name of the copy
 * @param {typeof import('node:fs')} [args.fsApi] the file system
 * @returns {{ file: string, status: 'patched' | 'already' | 'unsupported' | 'missing' | 'skipped' | 'error',
 *   backup?: string, reason?: string, warning?: string, preview?: string[], dryRun?: boolean }}
 */
function applyPatch({ file, patcher, context, dryRun = false, now, fsApi = nodeFs }) {
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
  if (dryRun) return result('patched', { dryRun: true, preview });

  const backup = makeCopy({ target, bytes, now, fsApi });
  if (backup.error) return result('error', { reason: backup.error });

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
  return result('patched', { backup: backup.path, preview });
}

/** Copies the file next to itself and checks the copy; returns `{ path }` or `{ error }`. */
function makeCopy({ target, bytes, now, fsApi }) {
  const date = typeof now === 'function' ? now() : now || new Date();
  const base = `${target}.espresso-notify-${stamp(date)}`;
  for (let n = 0; n <= MAX_COPY_SUFFIX; n += 1) {
    const candidate = `${base}${n === 0 ? '' : `-${n}`}.bak`;
    try {
      fsApi.copyFileSync(target, candidate, fsApi.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error && error.code === 'EEXIST') continue;
      return { error: `could not make the backup copy, so nothing was written: ${message(error)}` };
    }
    try {
      if (!fsApi.readFileSync(candidate).equals(bytes)) throw new Error('the copy differs from the file');
    } catch (error) {
      try {
        fsApi.unlinkSync(candidate);
      } catch (_) {
        // leave it
      }
      return { error: `could not verify the backup copy, so nothing was written: ${message(error)}` };
    }
    return { path: candidate };
  }
  return { error: 'could not make the backup copy: too many copies with this name, so nothing was written' };
}

module.exports = { applyPatch, markers, stamp, keepLineEnding, MAX_FILE_BYTES };
