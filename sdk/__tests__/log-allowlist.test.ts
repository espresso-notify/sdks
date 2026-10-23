/**
 * @jest-environment node
 *
 * sdk-private-transport T11 (SPT-52, SPT-57): the SDK writes to the console only through the calls listed here.
 *
 * A static scan of `sdk/src/**\/*.ts` finds every use of `console` (outside comments and strings) and the helper that
 * forwards a message to it, and compares the `{file, method, start of the text, shape of the argument}` of each with
 * the list below. A new call, a changed text start, a value interpolated into a message that is not listed, or any
 * method other than `warn` fails the test until the list is edited on purpose, which puts the change in front of a
 * reviewer. The shape replaces each string literal by `S` and keeps every other piece of the argument, so a template
 * with `${token}` or a concatenation with a variable shows up as such.
 *
 * No call passes the text of an error that another package threw (the signer, the pinning library, the attestation
 * module): owner decision D-6 (sdk-private-transport T14a) turned the three warnings that did into fixed messages with
 * a code. The allow-list holds no `foreign` entry, so a new call that echoes `err.message`, a caught value or a rejected
 * string changes the shape of an entry or adds one, and fails.
 *
 * The SDK has no debug, verbose or logging option, and none is added: the option names of the client and of the hook
 * are checked here too.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

const SDK = resolve(__dirname, '..');
const SRC = join(SDK, 'src');

interface Call {
  file: string;
  method: string;
  /** The first 48 characters of the fixed text of the message (the string literals, joined). */
  start: string;
  /** The argument source with every string literal written as `S`, runs of `S + S` merged, spaces collapsed. */
  shape: string;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

interface Piece {
  shape: string;
  fixed: string;
  end: number;
}

/** Reads one string literal that opens at `i` (a quote or a backtick). */
function readString(text: string, i: number): Piece {
  const quote = text[i];
  let fixed = '';
  let shape = '';
  let j = i + 1;
  if (quote !== '`') {
    while (j < text.length && text[j] !== quote) {
      if (text[j] === '\\') {
        fixed += text[j + 1];
        j += 2;
      } else fixed += text[j++];
    }
    return { shape: 'S', fixed, end: j + 1 };
  }
  shape = 'T(';
  let literal = false;
  while (j < text.length && text[j] !== '`') {
    if (text[j] === '\\') {
      fixed += text[j + 1];
      literal = true;
      j += 2;
    } else if (text[j] === '$' && text[j + 1] === '{') {
      if (literal) shape += 'S';
      literal = false;
      const inner = readCode(text, j + 2, '}');
      shape += `{${inner.shape}}`;
      fixed += inner.fixed;
      j = inner.end;
    } else {
      fixed += text[j++];
      literal = true;
    }
  }
  if (literal) shape += 'S';
  return { shape: `${shape})`, fixed, end: j + 1 };
}

/** Reads code from `i` up to the `close` character at depth zero; comments are dropped, strings become `S`. */
function readCode(text: string, i: number, close: string): Piece {
  let shape = '';
  let fixed = '';
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const c = text[j];
    if (c === '/' && text[j + 1] === '/') {
      while (j < text.length && text[j] !== '\n') j++;
    } else if (c === '/' && text[j + 1] === '*') {
      j = text.indexOf('*/', j + 2) + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      const s = readString(text, j);
      shape += s.shape;
      fixed += s.fixed;
      j = s.end;
    } else if (depth === 0 && c === close) {
      break;
    } else {
      if (c === '(' || c === '{' || c === '[') depth++;
      if (c === ')' || c === '}' || c === ']') depth--;
      shape += c;
      j++;
    }
  }
  return { shape, fixed, end: j + 1 };
}

function tidy(shape: string): string {
  let out = shape.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
  let before = '';
  while (before !== out) {
    before = out;
    out = out.replace(/\bS \+ S\b/g, 'S').replace(/,$/, '');
  }
  return out;
}

/** Every `console` use and every call of the queue's warning helper in a source file. */
function scan(file: string, text: string): { calls: Call[]; strayConsole: number } {
  const calls: Call[] = [];
  let strayConsole = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      i = readString(text, i).end;
    } else {
      const rest = text.slice(i, i + 40);
      const prev = i === 0 ? ' ' : text[i - 1];
      const bare = !/[\w$.]/.test(prev) && !/function\s+$/.test(text.slice(Math.max(0, i - 12), i));
      const consoleCall = bare ? /^console\.(\w+)\(/.exec(rest) : null;
      const helperCall = bare ? /^_queueWarnOnce\(/.exec(rest) : null;
      const opening = consoleCall ?? helperCall;
      if (opening) {
        const method = consoleCall ? consoleCall[1] : '_queueWarnOnce';
        const args = readCode(text, i + opening[0].length, ')');
        calls.push({ file, method, start: args.fixed.slice(0, 48), shape: tidy(args.shape) });
        i = args.end;
      } else if (bare && /^console\b/.test(rest)) {
        strayConsole++;
        i += 7;
      } else {
        i++;
      }
    }
  }
  return { calls, strayConsole };
}

const files = sourceFiles(SRC);
const scanned = files.map((path) => scan(relative(SRC, path), readFileSync(path, 'utf8')));
const found = scanned.flatMap((s) => s.calls);

/**
 * The calls the SDK may make. `why` says what each interpolated value is and why it is safe.
 * `_queueWarnOnce` is the helper that prints a queue warning once; its definition is the only `console.warn(message)`.
 */
const ALLOWED: { call: Call; why?: string }[] = [
  {
    call: { file: 'hooks.ts', method: 'warn', start: '[espresso-notify] enableAttestation has no effec', shape: 'S' },
  },
  {
    call: { file: 'image-push.ts', method: 'warn', start: '[espresso-notify] A push with an image arrived w', shape: 'S' },
  },
  {
    call: { file: 'index.ts', method: 'warn', start: '[espresso-notify] Neither expo-secure-store nor ', shape: 'S' },
  },
  {
    call: { file: 'random.ts', method: 'warn', start: '[espresso-notify] crypto.getRandomValues is not ', shape: 'S' },
  },
  {
    call: { file: 'index.ts', method: 'warn', start: '[espresso-notify] @react-native-firebase/app-che', shape: 'S' },
  },
  {
    call: { file: 'index.ts', method: 'warn', start: '[espresso-notify] request signing failed (SIGNIN', shape: 'S' },
  },
  {
    call: { file: 'index.ts', method: 'warn', start: '', shape: 'message' },
    why: 'the queue helper: its callers are the three _queueWarnOnce calls below',
  },
  {
    call: { file: 'index.ts', method: '_queueWarnOnce', start: 'memory[espresso-notify] offline queue: neither @', shape: 'S, S' },
  },
  {
    call: { file: 'index.ts', method: '_queueWarnOnce', start: 'full[espresso-notify] offline queue is full ( ev', shape: 'S, T(S{this._maxItems}S) + S' },
    why: 'the configured size of the queue, a number the app chose',
  },
  {
    call: { file: 'index.ts', method: '_queueWarnOnce', start: 'refused::[espresso-notify] offline queue: an eve', shape: 'T(S{outcome.status}S{outcome.code ?? S}), T(S{outcome.status}) + T({outcome.code ? T(S{outcome.code}) : S}S)' },
    why: 'the HTTP status and the error code of the server answer, never a request value',
  },
  {
    call: { file: 'index.ts', method: 'warn', start: 'refused[espresso-notify] handleDeepLinks: a noti', shape: 'verdict === S ? S : S' },
    why: 'the verdict is one of two words; the link itself is never in the text',
  },
  {
    call: { file: 'index.ts', method: 'warn', start: '⚠️ Warning: projectId should typically start wit', shape: 'S' },
  },
  {
    call: { file: 'index.ts', method: 'warn', start: '[espresso-notify] The native transport is not us', shape: 'S + (reason === S ? S : S) + S' },
    why: 'the reason is one of two words the SDK chose (module not linked, contract version not supported); no URL, no value of the module',
  },
  {
    call: { file: 'index.ts', method: 'warn', start: '[espresso-notify] Some device metadata fields wi', shape: 'T(S{fieldList}S) + T(S) + T(S{missing.map((m) => m.pkg).join(S)}S) + T(S{pkgList}) + timeZoneNote + T(S)' },
    why: 'names of optional packages and of metadata fields, fixed by the SDK',
  },
  {
    call: { file: 'index.ts', method: 'warn', start: '[espresso-notify] react-native-ssl-public-key-pi', shape: 'S' },
  },
  {
    call: { file: 'index.ts', method: 'warn', start: '[espresso-notify] Certificate pinning initializa', shape: 'S' },
  },
  {
    call: { file: 'index.ts', method: 'warn', start: '[espresso-notify] enableEspressoPinning: API_URL', shape: 'S' },
  },
  {
    call: { file: 'index.ts', method: 'warn', start: '[espresso-notify] trackEvent: the name passed is', shape: 'S' },
  },
  {
    call: { file: 'index.ts', method: 'warn', start: '[espresso-notify] device attestation is not supp', shape: 'S' },
  },
  {
    call: { file: 'index.ts', method: 'warn', start: '[espresso-notify] device attestation failed (ATT', shape: 'S' },
  },
  {
    call: { file: 'index.ts', method: 'warn', start: '[espresso-notify] enableSigning is on but react-', shape: 'S' },
  },
  {
    call: { file: 'index.ts', method: 'warn', start: '[espresso-notify] trackConversion: the value pas', shape: 'S' },
  },
];

const key = (c: Call) => `${c.file} | ${c.method} | ${c.start} | ${c.shape}`;

describe('the console calls of the SDK (SPT-52)', () => {
  it('are exactly the calls of the allow-list, with the same text start and the same shape', () => {
    expect(found.map(key).sort()).toEqual(ALLOWED.map((a) => key(a.call)).sort());
  });

  it('use only console.warn, and name console nowhere else (no alias, no other method)', () => {
    expect(found.filter((c) => c.method !== 'warn' && c.method !== '_queueWarnOnce')).toEqual([]);
    expect(found.filter((c) => c.method === 'warn')).toHaveLength(ALLOWED.filter((a) => a.call.method === 'warn').length);
    expect(scanned.reduce((n, s) => n + s.strayConsole, 0)).toBe(0);
  });

  it('never read the message of an error nor a caught value, so no text of another package reaches the console (D-6)', () => {
    expect(found.filter((c) => /\.message\b|\berr(or)?\b|\be\b/.test(c.shape)).map(key)).toEqual([]);
    expect(ALLOWED.filter((a) => /foreign/.test(JSON.stringify(a)))).toEqual([]);
  });
});

describe('the options of the SDK (SPT-57)', () => {
  /** The option names of an exported interface: the properties at two spaces of indent. */
  function optionNames(file: string, name: string): string[] {
    const text = readFileSync(join(SRC, file), 'utf8');
    const open = text.indexOf(`export interface ${name} {`);
    expect(open).toBeGreaterThanOrEqual(0);
    let depth = 0;
    let i = text.indexOf('{', open);
    const from = i;
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++;
      if (text[i] === '}' && --depth === 0) break;
    }
    return [...text.slice(from + 1, i).matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
  }

  it('has no debug, verbose or logging option on the client or on the hook', () => {
    const names = [
      ...optionNames('index.ts', 'ClientConfig'),
      ...optionNames('hooks.ts', 'UsePushNotificationsConfig'),
      ...optionNames('index.ts', 'OfflineQueueConfig'),
    ];
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((n) => /debug|verbose|logg|^log|[a-z]Log/i.test(n))).toEqual([]);
  });
});
