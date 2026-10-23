'use strict';

/**
 * Line helpers shared by the patchers. A text is a list of `{ text, eol }`, so a patcher can insert a line with the line
 * ending of the line next to it and a file that mixes CRLF and LF keeps both as they were.
 */

/** @typedef {{ text: string, eol: string }} Line */

/** The lines of `text`, each with the line ending that follows it ('' for a last line without one). */
function parseLines(text) {
  const parts = String(text).split(/(\r\n|\n)/);
  const lines = [];
  for (let i = 0; i < parts.length; i += 2) {
    const eol = parts[i + 1] || '';
    if (parts[i] === '' && eol === '') continue; // nothing after the final line break
    lines.push({ text: parts[i], eol });
  }
  return lines;
}

/** The text of a list of lines. */
const renderLines = (lines) => lines.map((line) => line.text + line.eol).join('');

/** The first line ending found in the file, LF when there is none. */
function fallbackEol(lines) {
  const hit = lines.find((line) => line.eol !== '');
  return hit ? hit.eol : '\n';
}

/**
 * Inserts `texts` as new lines right after `lines[index]`, with that line's ending. When the anchor is the last line and
 * has no ending, it gets one and the last new line gets none, so the file still ends the way it did.
 * @param {Line[]} lines
 * @param {number} index
 * @param {string[]} texts
 */
function insertAfter(lines, index, texts) {
  const anchor = lines[index];
  const eol = anchor.eol || fallbackEol(lines);
  const added = texts.map((text) => ({ text, eol }));
  if (anchor.eol === '') {
    anchor.eol = eol;
    added[added.length - 1].eol = '';
  }
  lines.splice(index + 1, 0, ...added);
}

/**
 * Appends `texts` at the end, after one blank line unless the file already ends with one. A file without a final line
 * break still has none afterwards.
 * @param {Line[]} lines
 * @param {string[]} texts
 */
function appendLines(lines, texts) {
  const last = lines[lines.length - 1];
  const eol = last && last.eol ? last.eol : fallbackEol(lines);
  const unterminated = Boolean(last) && last.eol === '';
  const added = [];
  if (last && last.text.trim() !== '') added.push({ text: '', eol });
  for (const text of texts) added.push({ text, eol });
  if (unterminated) {
    last.eol = eol;
    added[added.length - 1].eol = '';
  }
  lines.push(...added);
}

// True for a line that is not a comment: `//`, `#` when asked, or the start or middle of a block comment.
function isCode(text, { hash = false } = {}) {
  const trimmed = text.trimStart();
  if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return false;
  if (hash && trimmed.startsWith('#')) return false;
  return true;
}

const indentOf = (text) => /^[ \t]*/.exec(text)[0];

/**
 * The depth of `{ }` at the start and at the end of each line, counting only braces that are code: not inside a quoted
 * string, a `//` comment or a block comment. `depth.end` of the last line is 0 when the braces are balanced.
 * @param {Line[]} lines
 * @returns {{ start: number, end: number }[]}
 */
function braceDepths(lines) {
  const depths = [];
  let depth = 0;
  let inBlock = false;
  for (const { text } of lines) {
    const start = depth;
    let quote = null;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      const next = text[i + 1];
      if (inBlock) {
        if (c === '*' && next === '/') {
          inBlock = false;
          i += 1;
        }
      } else if (quote) {
        if (c === '\\') i += 1;
        else if (c === quote) quote = null;
      } else if (c === '/' && next === '/') {
        break;
      } else if (c === '/' && next === '*') {
        inBlock = true;
        i += 1;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '{') {
        depth += 1;
      } else if (c === '}') {
        depth -= 1;
      }
    }
    depths.push({ start, end: depth });
  }
  return depths;
}

module.exports = { parseLines, renderLines, insertAfter, appendLines, isCode, indentOf, braceDepths };
