/**
 * @jest-environment node
 *
 * setup-wizard-bare-rn T2 (SWB-07): the safe file writer of the bare setup wizard. Every test works in a temporary folder.
 * `applyPatch` is the only place that writes: it reads, asks a patcher (a pure text function) what to do, and writes with a
 * backup next to the file, through a temporary file and a rename, keeping the line ending, the mode and the BOM.
 */
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'fs';
import * as realFs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyPatch, markers, MAX_FILE_BYTES } = require('../bin/lib/patch.js');

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

describe('applyPatch', () => {
  it('copies the file next to it, equal to the original, before it writes', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    let backupAtRename: string | null = null;
    const fsApi = {
      ...realFs,
      renameSync: (from: string, to: string) => {
        const backup = readdirSync(dir).find((n) => n.endsWith('.bak'));
        backupAtRename = backup ? readFileSync(join(dir, backup), 'utf8') : null;
        return realFs.renameSync(from, to);
      },
    };
    const result = applyPatch({ file, patcher: addAfter('platform :ios'), context: {}, now: NOW, fsApi });
    expect(result.status).toBe('patched');
    expect(backupAtRename).toBe(SAMPLE);
    expect(readFileSync(file, 'utf8')).toContain(BEGIN);
    expect(readFileSync(result.backup, 'utf8')).toBe(SAMPLE);
  });

  it('names the copy <file>.espresso-notify-<stamp>.bak', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    const result = applyPatch({ file, patcher: addAfter('platform :ios'), context: {}, now: NOW });
    expect(result.backup).toBe(`${file}.espresso-notify-${STAMP}.bak`);
    expect(ls(dir)).toEqual(['Podfile', `Podfile.espresso-notify-${STAMP}.bak`]);
  });

  it('leaves no temporary file behind', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    applyPatch({ file, patcher: addAfter('platform :ios'), context: {}, now: NOW });
    expect(ls(dir).filter((n) => !n.endsWith('.bak'))).toEqual(['Podfile']);
  });

  it('dry run: no copy, no byte changed, and a preview of the added lines', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    const before = statSync(file);
    const result = applyPatch({ file, patcher: addAfter('platform :ios'), context: {}, dryRun: true, now: NOW });
    expect(result.status).toBe('patched');
    expect(result.dryRun).toBe(true);
    expect(result.backup).toBeUndefined();
    expect(result.preview).toEqual([BEGIN, 'use_frameworks!', END]);
    expect(readFileSync(file, 'utf8')).toBe(SAMPLE);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(ls(dir)).toEqual(['Podfile']);
  });

  it('already: writes nothing and creates no copy', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, `platform :ios\n${BEGIN}\nuse_frameworks!\n${END}\n`);
    const result = applyPatch({ file, patcher: addAfter('platform :ios'), context: {}, now: NOW });
    expect(result.status).toBe('already');
    expect(result.backup).toBeUndefined();
    expect(ls(dir)).toEqual(['Podfile']);
  });

  it('unsupported: writes nothing and says why', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, 'something else\n');
    const result = applyPatch({ file, patcher: addAfter('platform :ios'), context: {}, now: NOW });
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
    expect(applyPatch({ file, patcher, context: {}, now: NOW }).status).toBe('patched');
    const afterFirst = readFileSync(file);
    const later = new Date(NOW.getTime() + 60_000);
    const second = applyPatch({ file, patcher, context: {}, now: later });
    expect(second.status).toBe('already');
    expect(readFileSync(file).equals(afterFirst)).toBe(true);
    expect(ls(dir)).toEqual(['Podfile', `Podfile.espresso-notify-${STAMP}.bak`]);
  });

  it('a copy that already has the same stamp gets a numeric suffix and is never overwritten', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    writeFileSync(`${file}.espresso-notify-${STAMP}.bak`, 'older copy');
    writeFileSync(`${file}.espresso-notify-${STAMP}-1.bak`, 'older copy 1');
    const result = applyPatch({ file, patcher: addAfter('platform :ios'), context: {}, now: NOW });
    expect(result.status).toBe('patched');
    expect(result.backup).toBe(`${file}.espresso-notify-${STAMP}-2.bak`);
    expect(readFileSync(`${file}.espresso-notify-${STAMP}.bak`, 'utf8')).toBe('older copy');
    expect(readFileSync(`${file}.espresso-notify-${STAMP}-1.bak`, 'utf8')).toBe('older copy 1');
    expect(readFileSync(result.backup, 'utf8')).toBe(SAMPLE);
  });

  it('skips a file of 1 MB + 1 byte, with the reason, and does not call the patcher', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, 'a'.repeat(MAX_FILE_BYTES + 1));
    const patcher = jest.fn();
    const result = applyPatch({ file, patcher, context: {}, now: NOW });
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
    expect(applyPatch({ file, patcher, context: {}, now: NOW }).status).toBe('already');
    expect(patcher).toHaveBeenCalledTimes(1);
  });

  it('skips a file that is not valid UTF-8', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, Buffer.from([0x70, 0x6c, 0xff, 0xfe, 0x0a]));
    const patcher = jest.fn();
    const result = applyPatch({ file, patcher, context: {}, now: NOW });
    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/UTF-8/);
    expect(patcher).not.toHaveBeenCalled();
    expect(ls(dir)).toEqual(['Podfile']);
  });

  it('skips a folder and reports a missing file', () => {
    const dir = folder();
    mkdirSync(join(dir, 'Podfile'));
    expect(applyPatch({ file: join(dir, 'Podfile'), patcher: jest.fn(), context: {}, now: NOW }).status).toBe('skipped');
    const missing = applyPatch({ file: join(dir, 'nope'), patcher: jest.fn(), context: {}, now: NOW });
    expect(missing.status).toBe('missing');
    expect(existsSync(join(dir, 'nope'))).toBe(false);
  });

  it('keeps CRLF: a patcher that writes bare LF gets the file\'s own line ending', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    const crlf = SAMPLE.replace(/\n/g, '\r\n');
    writeFileSync(file, crlf);
    const result = applyPatch({ file, patcher: addAfter('platform :ios'), context: {}, now: NOW });
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
    applyPatch({ file, patcher: addAfter('platform :ios'), context: {}, now: NOW });
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
    applyPatch({ file, patcher, context: {}, now: NOW });
    expect(readFileSync(file, 'utf8')).toBe('a\r\nb\nX\nc\r\n');
  });

  it('keeps the mode of the file', () => {
    const dir = folder();
    const file = join(dir, 'gradlew');
    writeFileSync(file, SAMPLE);
    chmodSync(file, 0o755);
    applyPatch({ file, patcher: addAfter('platform :ios'), context: {}, now: NOW });
    expect(statSync(file).mode & 0o777).toBe(0o755);
  });

  it('writes through a symbolic link: the link stays a link and its target changes', () => {
    const dir = folder();
    const target = join(dir, 'real-Podfile');
    const link = join(dir, 'Podfile');
    writeFileSync(target, SAMPLE);
    symlinkSync(target, link);
    const result = applyPatch({ file: link, patcher: addAfter('platform :ios'), context: {}, now: NOW });
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
    const result = applyPatch({ file, patcher: addAfter('platform :ios'), context: {}, now: NOW, fsApi });
    expect(result.status).toBe('error');
    expect(result.reason).toContain('EXDEV');
    expect(readFileSync(file, 'utf8')).toBe(SAMPLE);
    expect(ls(dir).filter((n) => !n.endsWith('.bak'))).toEqual(['Podfile']);
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
    const result = applyPatch({ file, patcher: addAfter('platform :ios'), context: {}, now: NOW, fsApi });
    expect(result.status).toBe('error');
    expect(result.reason).toContain('copy');
    expect(write).not.toHaveBeenCalled();
    expect(readFileSync(file, 'utf8')).toBe(SAMPLE);
  });

  it('turns a throwing patcher into an error and writes nothing', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    const result = applyPatch({
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
    const result = applyPatch({ file, patcher: dropsLine, context: {}, now: NOW });
    expect(result.status).toBe('error');
    expect(result.reason).toMatch(/line/);
    expect(readFileSync(file, 'utf8')).toBe(SAMPLE);
    expect(ls(dir)).toEqual(['Podfile']);
  });

  it('hands the warning of a patcher back to the caller, for already and for patched', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    const already = applyPatch({ file, patcher: () => ({ status: 'already', warning: 'careful' }), context: {}, now: NOW });
    expect(already).toMatchObject({ status: 'already', warning: 'careful' });
    const patched = applyPatch({ file, patcher: (text: string) => ({ status: 'patched', text: `${text}x\n`, warning: 'careful' }), context: {}, now: NOW });
    expect(patched).toMatchObject({ status: 'patched', warning: 'careful' });
    expect(applyPatch({ file, patcher: () => ({ status: 'already' }), context: {}, now: NOW }).warning).toBeUndefined();
  });

  it('passes the context to the patcher together with the text', () => {
    const dir = folder();
    const file = join(dir, 'Podfile');
    writeFileSync(file, SAMPLE);
    const patcher = jest.fn(() => ({ status: 'already' }));
    applyPatch({ file, patcher, context: { appName: 'App' }, now: NOW });
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
    const result = applyPatch({ file, patcher, context: {}, now: NOW });
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
