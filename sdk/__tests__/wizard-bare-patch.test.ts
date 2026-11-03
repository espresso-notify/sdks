/**
 * @jest-environment node
 *
 * setup-wizard-bare-rn T2 (SWB-07): the safe file writer of the bare setup wizard. Every test works in a temporary folder.
 * `applyPatch` is the only place that writes: it reads, asks a patcher (a pure text function) what to do, and writes with a
 * copy of the original in one backup folder (or none when git holds the original), through a temporary file and a rename,
 * keeping the line ending, the mode and the BOM.
 */
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'fs';
import * as realFs from 'fs';
import { tmpdir } from 'os';
import path, { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyPatch, createBackupSession, markers, MAX_FILE_BYTES } = require('../bin/lib/patch.js');

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'espresso-patch-'));
  dirs.push(dir);
  return dir;
}

/** 2026-10-23 10:15:30 in the local time zone, so the expected stamp does not depend on the machine's zone. */
const NOW = new Date(2026, 9, 23, 10, 15, 30);
const STAMP = '20261023T101530';
const BACKUP = '.espresso-notify-backup';

const BEGIN = '# espresso-notify:begin test';
const END = '# espresso-notify:end';

/** Adds a marked block after the line that equals `after`; `already` when the block is there; `unsupported` without the line. */
function addAfter(after: string, added = 'use_frameworks!') {
  return (text: string) => {
    if (text.includes(BEGIN)) return { status: 'already' };
    const lines = text.split(/\r?\n/);
    const at = lines.indexOf(after);
    if (at < 0) return { status: 'unsupported', reason: `no line "${after}"` };
    lines.splice(at + 1, 0, BEGIN, added, END);
    // A real patcher takes the line ending of its anchor; this one always writes LF to prove applyPatch keeps the file's own.
    return { status: 'patched', text: lines.join('\n') };
  };
}

function ls(dir: string): string[] {
  return readdirSync(dir).sort();
}

const SAMPLE = 'platform :ios\ntarget "App" do\n  use_react_native!\nend\n';

describe('markers', () => {
  it('writes a begin and an end comment in the syntax of each file', () => {
    expect(markers('#', 'podfile')).toEqual({ begin: '# espresso-notify:begin podfile', end: '# espresso-notify:end' });
    expect(markers('//', 'gradle')).toEqual({ begin: '// espresso-notify:begin gradle', end: '// espresso-notify:end' });
    expect(markers('<!--', 'permission')).toEqual({
      begin: '<!-- espresso-notify:begin permission -->',
      end: '<!-- espresso-notify:end -->',
    });
  });

  it('works without a name', () => {
    expect(markers('#').begin).toBe('# espresso-notify:begin');
    expect(markers('<!--').begin).toBe('<!-- espresso-notify:begin -->');
  });
});

/**
 * `applyPatch` needs the backup session of the run and never makes a folder of its own. This helper opens a session rooted at
 * the folder of the file, which is where these tests lay their files out; `now` and `fsApi` go to the session.
 */
function patch({ now = NOW, ...args }: Record<string, any>) {
  return applyPatch({ ...args, backup: createBackupSession({ root: path.dirname(args.file), now, fsApi: args.fsApi }) });
}

describe('applyPatch', () => {
  it('copies the file into the backup folder, equal to the original, before it writes', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    let backupAtRename: string | null = null;
    const fsApi = {
      ...realFs,
      renameSync: (from: string, to: string) => {
        const backup = join(dir, BACKUP, STAMP, 'Podfile');
        backupAtRename = existsSync(backup) ? readFileSync(backup, 'utf8') : null;
        return realFs.renameSync(from, to);
      },
    };
    const result = patch({ file, patcher: addAfter('platform :ios'), context: {}, now: NOW, fsApi });
    expect(result.status).toBe('patched');
    expect(backupAtRename).toBe(SAMPLE);
    expect(readFileSync(file, 'utf8')).toContain(BEGIN);
    expect(readFileSync(result.backup, 'utf8')).toBe(SAMPLE);
  });

  it('names the copy .espresso-notify-backup/<stamp>/<path of the file> and puts nothing next to the file', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    const result = patch({ file, patcher: addAfter('platform :ios'), context: {}, now: NOW });
    expect(result.backup).toBe(join(dir, BACKUP, STAMP, 'Podfile'));
    expect(ls(dir)).toEqual([BACKUP, 'Podfile']);
    expect(ls(join(dir, BACKUP))).toEqual([STAMP]);
    expect(ls(join(dir, BACKUP, STAMP))).toEqual(['Podfile']);
  });

  it('keeps the relative path of the file under the project root inside the folder', () => {
    const dir = folder();
    mkdirSync(join(dir, 'ios', 'App'), { recursive: true });
    const file = join(dir, 'ios', 'App', 'AppDelegate.swift');
    writeFileSync(file, SAMPLE);
    const backup = createBackupSession({ root: dir, now: NOW });
    const result = applyPatch({ file, patcher: addAfter('platform :ios'), context: {}, backup });
    expect(result.backup).toBe(join(dir, BACKUP, STAMP, 'ios', 'App', 'AppDelegate.swift'));
    expect(readFileSync(result.backup, 'utf8')).toBe(SAMPLE);
    expect(ls(join(dir, 'ios', 'App'))).toEqual(['AppDelegate.swift']);
    expect(ls(join(dir, 'ios'))).toEqual(['App']);
  });

  it('leaves no temporary file behind', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    patch({ file, patcher: addAfter('platform :ios'), context: {}, now: NOW });
    expect(ls(dir).filter((n) => n !== BACKUP)).toEqual(['Podfile']);
    expect(ls(join(dir, BACKUP, STAMP))).toEqual(['Podfile']);
  });

  it('dry run: no copy, no byte changed, and a preview of the added lines', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    const before = statSync(file);
    const result = patch({ file, patcher: addAfter('platform :ios'), context: {}, dryRun: true, now: NOW });
    expect(result.status).toBe('patched');
    expect(result.dryRun).toBe(true);
    expect(result.backup).toBeUndefined();
    expect(result.wouldBackup).toBe(join(dir, BACKUP, STAMP, 'Podfile'));
    expect(result.preview).toEqual([BEGIN, 'use_frameworks!', END]);
    expect(readFileSync(file, 'utf8')).toBe(SAMPLE);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(ls(dir)).toEqual(['Podfile']);
  });

  it('already: writes nothing and creates no copy', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, `platform :ios\n${BEGIN}\nuse_frameworks!\n${END}\n`);
    const result = patch({ file, patcher: addAfter('platform :ios'), context: {}, now: NOW });
    expect(result.status).toBe('already');
    expect(result.backup).toBeUndefined();
    expect(ls(dir)).toEqual(['Podfile']);
  });

  it('unsupported: writes nothing and says why', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, 'something else\n');
    const result = patch({ file, patcher: addAfter('platform :ios'), context: {}, now: NOW });
    expect(result.status).toBe('unsupported');
    expect(result.reason).toContain('platform :ios');
    expect(readFileSync(file, 'utf8')).toBe('something else\n');
    expect(ls(dir)).toEqual(['Podfile']);
  });

  it('a second run changes no byte and makes no second copy', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    const patcher = addAfter('platform :ios');
    expect(patch({ file, patcher, context: {}, now: NOW }).status).toBe('patched');
    const afterFirst = readFileSync(file);
    const later = new Date(NOW.getTime() + 60_000);
    const second = patch({ file, patcher, context: {}, now: later });
    expect(second.status).toBe('already');
    expect(readFileSync(file).equals(afterFirst)).toBe(true);
    expect(ls(dir)).toEqual([BACKUP, 'Podfile']);
    expect(ls(join(dir, BACKUP))).toEqual([STAMP]);
  });

  it('a folder that already has the same stamp gets a numeric suffix and is never overwritten', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    mkdirSync(join(dir, BACKUP, STAMP), { recursive: true });
    mkdirSync(join(dir, BACKUP, `${STAMP}-1`), { recursive: true });
    writeFileSync(join(dir, BACKUP, STAMP, 'Podfile'), 'older copy');
    writeFileSync(join(dir, BACKUP, `${STAMP}-1`, 'Podfile'), 'older copy 1');
    const result = patch({ file, patcher: addAfter('platform :ios'), context: {}, now: NOW });
    expect(result.status).toBe('patched');
    expect(result.backup).toBe(join(dir, BACKUP, `${STAMP}-2`, 'Podfile'));
    expect(readFileSync(join(dir, BACKUP, STAMP, 'Podfile'), 'utf8')).toBe('older copy');
    expect(readFileSync(join(dir, BACKUP, `${STAMP}-1`, 'Podfile'), 'utf8')).toBe('older copy 1');
    expect(readFileSync(result.backup, 'utf8')).toBe(SAMPLE);
  });

  it('skips a file of 1 MB + 1 byte, with the reason, and does not call the patcher', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, 'a'.repeat(MAX_FILE_BYTES + 1));
    const patcher = jest.fn();
    const result = patch({ file, patcher, context: {}, now: NOW });
    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/1 MB/);
    expect(patcher).not.toHaveBeenCalled();
    expect(ls(dir)).toEqual(['Podfile']);
  });

  it('reads a file of exactly 1 MB', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, 'a'.repeat(MAX_FILE_BYTES));
    const patcher = jest.fn(() => ({ status: 'already' }));
    expect(patch({ file, patcher, context: {}, now: NOW }).status).toBe('already');
    expect(patcher).toHaveBeenCalledTimes(1);
  });

  it('skips a file that is not valid UTF-8', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, Buffer.from([0x70, 0x6c, 0xff, 0xfe, 0x0a]));
    const patcher = jest.fn();
    const result = patch({ file, patcher, context: {}, now: NOW });
    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/UTF-8/);
    expect(patcher).not.toHaveBeenCalled();
    expect(ls(dir)).toEqual(['Podfile']);
  });

  it('skips a folder and reports a missing file', () => {
    const dir = folder();
    mkdirSync(join(dir, 'Podfile'));
    expect(patch({ file: join(dir, 'Podfile'), patcher: jest.fn(), context: {}, now: NOW }).status).toBe('skipped');
    const missing = patch({ file: join(dir, 'nope'), patcher: jest.fn(), context: {}, now: NOW });
    expect(missing.status).toBe('missing');
    expect(existsSync(join(dir, 'nope'))).toBe(false);
  });

  it('keeps CRLF: a patcher that writes bare LF gets the file\'s own line ending', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    const crlf = SAMPLE.replace(/\n/g, '\r\n');
    writeFileSync(file, crlf);
    const result = patch({ file, patcher: addAfter('platform :ios'), context: {}, now: NOW });
    expect(result.status).toBe('patched');
    const text = readFileSync(file, 'utf8');
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(text).toContain(`${BEGIN}\r\nuse_frameworks!\r\n${END}\r\n`);
    expect(readFileSync(result.backup, 'utf8')).toBe(crlf);
  });

  it('keeps LF, a missing final newline and a byte order mark', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, '﻿platform :ios\nend');
    patch({ file, patcher: addAfter('platform :ios'), context: {}, now: NOW });
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('﻿platform :ios\n')).toBe(true);
    expect(text.endsWith('\nend')).toBe(true);
    expect(text).not.toContain('\r');
  });

  it('leaves a file with mixed line endings as the patcher wrote it', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, 'a\r\nb\nc\r\n');
    const patcher = () => ({ status: 'patched', text: 'a\r\nb\nX\nc\r\n' });
    patch({ file, patcher, context: {}, now: NOW });
    expect(readFileSync(file, 'utf8')).toBe('a\r\nb\nX\nc\r\n');
  });

  it('keeps the mode of the file', () => {
    const dir = folder();
    const file = join(dir, 'gradlew');
    writeFileSync(file, SAMPLE);
    chmodSync(file, 0o755);
    patch({ file, patcher: addAfter('platform :ios'), context: {}, now: NOW });
    expect(statSync(file).mode & 0o777).toBe(0o755);
  });

  it('writes through a symbolic link: the link stays a link and its target changes', () => {
    const dir = folder();
    const target = join(dir, 'real-Podfile');
    const link = join(dir, 'Podfile');
    writeFileSync(target, SAMPLE);
    symlinkSync(target, link);
    const result = patch({ file: link, patcher: addAfter('platform :ios'), context: {}, now: NOW });
    expect(result.status).toBe('patched');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain(BEGIN);
  });

  it('a failed rename leaves the original intact and removes the temporary file', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    const fsApi = {
      ...realFs,
      renameSync: () => {
        throw new Error('EXDEV: simulated');
      },
    };
    const result = patch({ file, patcher: addAfter('platform :ios'), context: {}, now: NOW, fsApi });
    expect(result.status).toBe('error');
    expect(result.reason).toContain('EXDEV');
    expect(readFileSync(file, 'utf8')).toBe(SAMPLE);
    expect(ls(dir).filter((n) => n !== BACKUP)).toEqual(['Podfile']);
  });

  it('does not write when the copy cannot be made', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    const write = jest.fn();
    const fsApi = {
      ...realFs,
      copyFileSync: () => {
        throw new Error('ENOSPC: simulated');
      },
      writeFileSync: write,
      renameSync: write,
    };
    const result = patch({ file, patcher: addAfter('platform :ios'), context: {}, now: NOW, fsApi });
    expect(result.status).toBe('error');
    expect(result.reason).toContain('copy');
    expect(write).not.toHaveBeenCalled();
    expect(readFileSync(file, 'utf8')).toBe(SAMPLE);
  });

  it('turns a throwing patcher into an error and writes nothing', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    const result = patch({
      file,
      patcher: () => {
        throw new Error('boom');
      },
      context: {},
      now: NOW,
    });
    expect(result.status).toBe('error');
    expect(ls(dir)).toEqual(['Podfile']);
  });

  it('refuses a patch that would remove or reorder a line of the user', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    const dropsLine = () => ({ status: 'patched', text: 'platform :ios\nend\n' });
    const result = patch({ file, patcher: dropsLine, context: {}, now: NOW });
    expect(result.status).toBe('error');
    expect(result.reason).toMatch(/line/);
    expect(readFileSync(file, 'utf8')).toBe(SAMPLE);
    expect(ls(dir)).toEqual(['Podfile']);
  });

  it('hands the warning of a patcher back to the caller, for already and for patched', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    const already = patch({ file, patcher: () => ({ status: 'already', warning: 'careful' }), context: {}, now: NOW });
    expect(already).toMatchObject({ status: 'already', warning: 'careful' });
    const patched = patch({ file, patcher: (text: string) => ({ status: 'patched', text: `${text}x\n`, warning: 'careful' }), context: {}, now: NOW });
    expect(patched).toMatchObject({ status: 'patched', warning: 'careful' });
    expect(patch({ file, patcher: () => ({ status: 'already' }), context: {}, now: NOW }).warning).toBeUndefined();
  });

  it('passes the context to the patcher together with the text', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    const patcher = jest.fn(() => ({ status: 'already' }));
    patch({ file, patcher, context: { appName: 'App' }, now: NOW });
    expect(patcher).toHaveBeenCalledWith(SAMPLE, { appName: 'App' });
  });
});

describe('applyPatch never removes a line (property)', () => {
  /** A small deterministic generator, so a failure can be replayed. */
  function random(seed: number) {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  }

  const WORDS = ['', 'end', '  use_react_native!', 'platform :ios', 'target "A" do', '# note', '  x = 1', 'ü ñ ✓', '}', '  '];

  it.each(Array.from({ length: 40 }, (_, i) => i + 1))('seed %i: the new text holds every old line in the same order', (seed) => {
    const rand = random(seed);
    const count = Math.floor(rand() * 12);
    const lines = Array.from({ length: count }, () => WORDS[Math.floor(rand() * WORDS.length)]);
    const eol = rand() < 0.4 ? '\r\n' : '\n';
    const finalEol = rand() < 0.5 ? eol : '';
    const original = lines.join(eol) + finalEol;
    const dir = folder();
    const file = join(dir, 'f.txt');
    writeFileSync(file, original);
    const at = Math.floor(rand() * (count + 1));
    const patcher = (text: string) => {
      const parts = text.split(/\r?\n/);
      parts.splice(at, 0, BEGIN, 'inserted', END);
      return { status: 'patched', text: parts.join('\n') };
    };
    const result = patch({ file, patcher, context: {}, now: NOW });
    expect(result.status).toBe('patched');
    const newLines = readFileSync(file, 'utf8').split(/\r?\n/);
    let next = 0;
    const oldLines = original.split(/\r?\n/);
    for (const line of newLines) if (next < oldLines.length && line === oldLines[next]) next += 1;
    expect(next).toBe(oldLines.length);
    // the whole file uses one line ending, the one it had
    const text = readFileSync(file, 'utf8');
    if (original.includes('\r\n')) expect(text.replace(/\r\n/g, '')).not.toMatch(/\n/);
    else expect(text).not.toContain('\r');
    expect(readFileSync(result.backup, 'utf8')).toBe(original);
  });
});

describe('applyPatch when git holds the original', () => {
  const patcher = addAfter('platform :ios');

  it('WB-01: a file git holds is patched with no copy and no backup folder', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    const asked: string[] = [];
    const gitHolds = (f: string) => {
      asked.push(f);
      return true;
    };
    const result = patch({ file, patcher, context: {}, now: NOW, gitHolds });
    expect(result.status).toBe('patched');
    expect(result.git).toBe(true);
    expect(result.backup).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toContain(BEGIN);
    expect(ls(dir)).toEqual(['Podfile']);
    expect(asked).toEqual([file]);
  });

  it('WB-02: when git does not hold the file the copy is made in the folder', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    const result = patch({ file, patcher, context: {}, now: NOW, gitHolds: () => false });
    expect(result.git).toBeUndefined();
    expect(result.backup).toBe(join(dir, BACKUP, STAMP, 'Podfile'));
    expect(readFileSync(result.backup, 'utf8')).toBe(SAMPLE);
  });

  it('WB-04: a question to git that throws counts as "git does not hold it" and the copy is made', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    const result = patch({
      file,
      patcher,
      context: {},
      now: NOW,
      gitHolds: () => {
        throw new Error('git exploded');
      },
    });
    expect(result.status).toBe('patched');
    expect(readFileSync(result.backup, 'utf8')).toBe(SAMPLE);
  });

  it('only the answer true skips the copy', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    const result = patch({ file, patcher, context: {}, now: NOW, gitHolds: (() => 'yes') as any });
    expect(result.git).toBeUndefined();
    expect(readFileSync(result.backup, 'utf8')).toBe(SAMPLE);
  });

  it('a link to the file is copied even when git holds the link: git does not hold the file the link points to', () => {
    const dir = folder();
    const real = join(dir, 'real-Podfile');
    const link = join(dir, 'Podfile');
    writeFileSync(real, SAMPLE);
    symlinkSync(real, link);
    const result = patch({ file: link, patcher, context: {}, now: NOW, gitHolds: () => true });
    expect(result.status).toBe('patched');
    expect(result.git).toBeUndefined();
    expect(readFileSync(result.backup, 'utf8')).toBe(SAMPLE);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('WB-07: dry run with git holding the file says so and creates nothing; without git it names the copy and creates nothing', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    const held = patch({ file, patcher, context: {}, dryRun: true, now: NOW, gitHolds: () => true });
    expect(held.git).toBe(true);
    expect(held.wouldBackup).toBeUndefined();
    const free = patch({ file, patcher, context: {}, dryRun: true, now: NOW, gitHolds: () => false });
    expect(free.git).toBeUndefined();
    expect(free.wouldBackup).toBe(join(dir, BACKUP, STAMP, 'Podfile'));
    expect(readFileSync(file, 'utf8')).toBe(SAMPLE);
    expect(ls(dir)).toEqual(['Podfile']);
  });

  it('WB-08: a file that is already set up neither asks git nor copies', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, `platform :ios\n${BEGIN}\nuse_frameworks!\n${END}\n`);
    const gitHolds = jest.fn(() => true);
    const result = patch({ file, patcher, context: {}, now: NOW, gitHolds });
    expect(result.status).toBe('already');
    expect(gitHolds).not.toHaveBeenCalled();
    expect(ls(dir)).toEqual(['Podfile']);
  });

  it('WB-09: with git holding the file the write still goes through a temporary file and a rename, and keeps CRLF and the mode', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    const crlf = SAMPLE.replace(/\n/g, '\r\n');
    writeFileSync(file, crlf);
    chmodSync(file, 0o640);
    const renames: string[][] = [];
    const fsApi = {
      ...realFs,
      renameSync: (from: string, to: string) => {
        renames.push([from, to]);
        return realFs.renameSync(from, to);
      },
    };
    const result = patch({ file, patcher, context: {}, now: NOW, fsApi, gitHolds: () => true });
    expect(result.status).toBe('patched');
    expect(renames).toHaveLength(1);
    expect(renames[0][0]).not.toBe(file);
    expect(renames[0][1]).toBe(file);
    expect(readFileSync(file, 'utf8')).toContain(`${BEGIN}\r\nuse_frameworks!\r\n${END}\r\n`);
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(ls(dir)).toEqual(['Podfile']);
  });
});

describe('applyPatch without a backup session (W-49, WB-05)', () => {
  it('throws a clear error instead of putting a backup folder next to the file, even in a dry run', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    const args = { file, patcher: addAfter('platform :ios'), context: {} };
    expect(() => applyPatch(args)).toThrow(/backup/);
    expect(() => applyPatch({ ...args, dryRun: true })).toThrow(/createBackupSession/);
    expect(() => applyPatch({ ...args, backup: {} })).toThrow(/backup/);
    expect(readFileSync(file, 'utf8')).toBe(SAMPLE);
    expect(ls(dir)).toEqual(['Podfile']);
  });
});

describe('createBackupSession', () => {
  it('WB-06: every file of one session goes to the same folder, and the folder is chosen once', () => {
    const dir = folder();
    mkdirSync(join(dir, 'android', 'app'), { recursive: true });
    const a = join(dir, 'android', 'build.gradle');
    const b = join(dir, 'android', 'app', 'build.gradle');
    writeFileSync(a, SAMPLE);
    writeFileSync(b, SAMPLE);
    let tick = 0;
    const now = () => new Date(2026, 9, 23, 10, 15, 30 + tick++);
    const backup = createBackupSession({ root: dir, now });
    const first = applyPatch({ file: a, patcher: addAfter('platform :ios'), context: {}, backup });
    const second = applyPatch({ file: b, patcher: addAfter('platform :ios'), context: {}, backup });
    expect(first.backup).toBe(join(dir, BACKUP, STAMP, 'android', 'build.gradle'));
    expect(second.backup).toBe(join(dir, BACKUP, STAMP, 'android', 'app', 'build.gradle'));
    expect(ls(join(dir, BACKUP))).toEqual([STAMP]);
  });

  it('a session that copies nothing creates nothing', () => {
    const dir = folder();
    const backup = createBackupSession({ root: dir, now: NOW });
    expect(backup.folder()).toBe(join(dir, BACKUP, STAMP));
    expect(ls(dir)).toEqual([]);
  });

  it('WB-10: on Windows the folder and the copy are named with backslashes under the project root', () => {
    // `pathApi` is `path.win32` and the file system is a stub: this proves the names, no disk is touched.
    const backup = createBackupSession({ root: 'C:\\apps\\Hello', now: NOW, fsApi: { existsSync: () => false }, pathApi: path.win32 });
    expect(backup.folder()).toBe(`C:\\apps\\Hello\\${BACKUP}\\${STAMP}`);
    expect(backup.pathFor('C:\\apps\\Hello\\ios\\Hello\\AppDelegate.swift')).toBe(
      `C:\\apps\\Hello\\${BACKUP}\\${STAMP}\\ios\\Hello\\AppDelegate.swift`,
    );
  });

  it('a file outside the project root is kept by its name, still inside the folder', () => {
    const backup = createBackupSession({ root: '/apps/hello', now: NOW, fsApi: { existsSync: () => false } });
    expect(backup.pathFor('/elsewhere/Podfile')).toBe(`/apps/hello/${BACKUP}/${STAMP}/Podfile`);
    const win = createBackupSession({ root: 'C:\\apps\\Hello', now: NOW, fsApi: { existsSync: () => false }, pathApi: path.win32 });
    expect(win.pathFor('D:\\other\\Podfile')).toBe(`C:\\apps\\Hello\\${BACKUP}\\${STAMP}\\Podfile`);
  });
});
