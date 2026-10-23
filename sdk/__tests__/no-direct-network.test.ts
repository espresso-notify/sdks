/**
 * @jest-environment node
 *
 * sdk-private-transport T24 (SPT-27, SPT-64): the SDK reaches the network in one place only.
 *
 * `sdk/src` may hold exactly one `fetch(` call, inside `FetchTransport`, and no `XMLHttpRequest`. Any other way out
 * (a second `fetch(`, a `fetch` kept in a variable, an XHR) would send a request that the native transport does not
 * carry, and the zero-capture proof of `private-transport-capture.test.ts` would stop being true for it. The scan
 * ignores comments and the text of strings, and reads the expressions inside template literals, because a call there
 * runs.
 *
 * The tracked `sdk/dist` is the other half of SPT-64: it carries the production URL, so the build placeholder appears in
 * no file of it; in the source it appears once, in the declaration of `API_URL`, which `inject-url.mjs` replaces.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

const SDK = resolve(__dirname, '..');
const SRC = join(SDK, 'src');
const DIST = join(SDK, 'dist');
const PLACEHOLDER = '__ESPRESSO_API_URL__';

function filesUnder(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path, keep));
    else if (keep(name)) out.push(path);
  }
  return out;
}

/**
 * The source with comments removed and the text of every string literal blanked, so only code is left. Template literals
 * keep the code of their `${...}` expressions. Positions are not preserved; the output is for matching only.
 */
function codeOnly(text: string): string {
  let out = '';
  let i = 0;
  // A stack of open template literals: each entry is the brace depth at which its `${` was opened.
  const templates: number[] = [];
  let depth = 0;
  const readTemplateText = () => {
    // Inside a template literal, up to the next `${` (returns true) or the closing backtick (returns false).
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') i += 2;
      else if (c === '`') {
        i++;
        return false;
      } else if (c === '$' && text[i + 1] === '{') {
        i += 2;
        return true;
      } else i++;
    }
    return false;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (c === "'" || c === '"') {
      i++;
      while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1;
      i++;
      out += ' ';
    } else if (c === '`') {
      i++;
      out += ' ';
      if (readTemplateText()) {
        templates.push(depth);
        depth++;
        out += ' ';
      }
    } else if (c === '{') {
      depth++;
      out += c;
      i++;
    } else if (c === '}') {
      depth--;
      i++;
      if (templates.length && templates[templates.length - 1] === depth) {
        templates.pop();
        out += ' ';
        if (readTemplateText()) {
          templates.push(depth);
          depth++;
        }
      } else out += c;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The `{ ... }` body that follows the first `marker` in `code`, or '' when there is none. */
function bodyAfter(code: string, marker: RegExp): string {
  const found = marker.exec(code);
  if (!found) return '';
  const open = code.indexOf('{', found.index + found[0].length);
  if (open === -1) return '';
  let depth = 0;
  for (let j = open; j < code.length; j++) {
    if (code[j] === '{') depth++;
    else if (code[j] === '}' && --depth === 0) return code.slice(open, j + 1);
  }
  return '';
}

const CALL = /(?<![\w$])fetch\s*\(/g; // `fetch(` and `globalThis.fetch(`, never `refetch(` or `.fetch` of a name that ends in a word
const IDENT = /(?<![\w$])fetch(?![\w$])/g; // the word `fetch` in code, however it is used

interface Finding {
  calls: number;
  identifiers: number;
  /** How many of the `fetch(` calls sit inside the body of `class FetchTransport`. */
  insideFetchTransport: number;
}

function scanFetch(text: string): Finding {
  const code = codeOnly(text);
  const inside = bodyAfter(code, /class\s+FetchTransport\b/);
  return {
    calls: (code.match(CALL) ?? []).length,
    identifiers: (code.match(IDENT) ?? []).length,
    insideFetchTransport: (inside.match(CALL) ?? []).length,
  };
}

const sources = filesUnder(SRC, (name) => /\.tsx?$/.test(name) && !name.endsWith('.d.ts'));

describe('the SDK sources reach the network in one place (SPT-27)', () => {
  it('holds exactly one fetch( call, inside FetchTransport, no other use of fetch and no XMLHttpRequest (not even in a comment)', () => {
    const totals = sources.map((path) => ({ file: relative(SRC, path), ...scanFetch(readFileSync(path, 'utf8')) }));
    expect(totals.filter((t) => t.calls > 0 || t.identifiers > 0)).toEqual([
      { file: 'index.ts', calls: 1, identifiers: 1, insideFetchTransport: 1 },
    ]);
    const xhr = sources.filter((path) => /XMLHttpRequest/.test(readFileSync(path, 'utf8'))).map((path) => relative(SRC, path));
    expect(xhr).toEqual([]);
  });

  it('the scan sees a second fetch( however it is written, and ignores comments and strings', () => {
    const base = 'class FetchTransport { async request() { return fetch(url, init); } }\n';
    expect(scanFetch(base)).toEqual({ calls: 1, identifiers: 1, insideFetchTransport: 1 });

    // A second call anywhere breaks the "exactly one inside FetchTransport" rule.
    expect(scanFetch(`${base}function leak() { fetch(url); }`)).toEqual({ calls: 2, identifiers: 2, insideFetchTransport: 1 });
    expect(scanFetch(`${base}const f = globalThis.fetch;`)).toMatchObject({ calls: 1, identifiers: 2 });
    expect(scanFetch(`${base}const g = \`\${await fetch(url)}\`;`)).toMatchObject({ calls: 2, identifiers: 2 });
    expect(scanFetch('class NativeTransport { go() { return fetch(url); } }')).toEqual({ calls: 1, identifiers: 1, insideFetchTransport: 0 });
    // A name that merely ends in fetch is not the global.
    expect(scanFetch('function refetch() {} refetch(); obj.prefetch();')).toEqual({ calls: 0, identifiers: 0, insideFetchTransport: 0 });

    // Text that is not code does not count.
    const quiet = [
      '// fetch(url)',
      '/** goes through fetch(url) when the module is absent */',
      'const a = "fetch(url)"; const b = \'fetch(\'; const c = `the fetch( call`;',
      'const d = `${1 + 1} fetch( ${2}`;',
    ].join('\n');
    expect(scanFetch(quiet)).toEqual({ calls: 0, identifiers: 0, insideFetchTransport: 0 });
  });
});

describe('the placeholder of the API url stays in one declaration (SPT-64)', () => {
  it('appears once in the sources, in the declaration of API_URL', () => {
    const hits = sources.flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.includes(PLACEHOLDER))
        .map((line) => `${relative(SRC, path)}: ${line.trim()}`),
    );
    expect(hits).toEqual([`index.ts: const API_URL = "${PLACEHOLDER}";`]);
  });

  it('is in no file of the committed dist, which carries the production url', () => {
    const files = filesUnder(DIST, () => true);
    expect(files.map((f) => relative(DIST, f))).toEqual(expect.arrayContaining(['index.js', 'transport.js', 'transport.d.ts']));
    const hits = files.filter((path) => readFileSync(path, 'utf8').includes(PLACEHOLDER)).map((path) => relative(DIST, path));
    expect(hits).toEqual([]);
  });
});

export {};
