#!/usr/bin/env node
'use strict';

/**
 * Espresso Notify setup wizard for Expo apps.
 *
 *   npx @espresso-notify/react-native@latest setup [--dry-run] [--yes] [--key <pk>]
 *
 * Plain Node, no dependency of its own (prompts use `node:readline`). Six steps, each printed as it runs and
 * each idempotent: a second run changes nothing and says so.
 *
 *   1. detect an Expo project and its Expo SDK (53 or newer)
 *   2. `npx expo install` the SDK and the Expo packages it reads, so each version matches the project's Expo SDK
 *   3. add the config plugin to `app.json` or `app.config.json` by inserting one piece of text, so every other byte of the
 *      file stays as written (an `app.config.js` / `app.config.ts`, or a JSON file the wizard cannot extend without
 *      changing something, is never edited: the line is printed, the step is counted as left to you and the wizard does
 *      not say it is done)
 *   4. check `expo.extra.eas.projectId` (`eas init` is only recommended, never run)
 *   5. print the `usePushNotifications` snippet, filled with the public key when one is given (never written to disk)
 *   6. print what a wizard cannot do (credentials, development build)
 *
 * Exit codes: 0 done or nothing to do; 1 refused (not an Expo project, Expo SDK below 53, a secret key, an unknown
 * option, or a no at the confirmation); 2 a step failed or a manual step is left.
 *
 * It behaves the same on Linux, macOS and Windows: every path is built with `path.join`, a file name is matched without
 * regard to case, a file is written back with the line ending (and the byte order mark) it had, and on Windows `npx`
 * starts through `cmd.exe` with constant arguments, the folder of the project only in `cwd`.
 *
 * `run(argv, io)` takes everything that touches the world (folder, `spawn`, streams, and optionally `fs` and `path`) so
 * the tests can fake it, with `path.win32` among them.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const childProcess = require('node:child_process');

const PLUGIN = '@espresso-notify/react-native';
const EXPO_PACKAGES = ['expo-notifications', 'expo-constants', 'expo-device', 'expo-application', 'expo-localization', 'expo-secure-store'];
const INSTALL_ARGS = ['expo', 'install', PLUGIN, ...EXPO_PACKAGES];
const MIN_EXPO_SDK = 53;
// The command interpreter of Windows when the ComSpec variable is missing or is not an absolute path.
const WINDOWS_CMD = 'C:\\Windows\\System32\\cmd.exe';
const BARE_GUIDE = 'https://docs.espressonotify.com/docs/react-native/bare';
const PLACEHOLDER_KEY = 'pk_live_xxxxxxxxxxxx';

const USAGE = `Espresso Notify setup for Expo apps

Usage: npx @espresso-notify/react-native@latest setup [options]

Options:
  --dry-run     print what the wizard would do and change nothing
  --yes, -y     do not ask anything (for CI)
  --key <pk>    the public key of your project (pk_live_... or pk_test_...)
  --help, -h    print this text

Exit codes:
  0  done, or nothing to do
  1  refused: not an Expo project, Expo SDK below ${MIN_EXPO_SDK}, a secret key (sk_), an unknown option, or you said no
  2  a step failed, or a step is left for you (the plugin of an app.config.js / app.config.ts, an app.json with comments or one
     the wizard cannot extend without changing your values)
`;

/** Thrown to end the run with an exit code after the message was printed. */
class Stop extends Error {
  constructor(code) {
    super(`stop ${code}`);
    this.code = code;
  }
}

/**
 * @param {string[]} argv arguments after the program name (`setup`, flags)
 * @returns {{ help: boolean, dryRun: boolean, yes: boolean, key?: string, error?: string }}
 */
function parseArgs(argv) {
  const options = { help: false, dryRun: false, yes: false };
  const args = argv.filter((a, i) => !(i === 0 && a === 'setup'));
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--key') {
      options.key = args[i + 1];
      i += 1;
      if (options.key === undefined) options.error = '`--key` needs the public key after it.';
    } else if (arg.startsWith('--key=')) options.key = arg.slice('--key='.length);
    else options.error = `Unknown option: ${arg}`;
  }
  return options;
}

/** `null` when `key` is a public key; otherwise why it is not (never repeats the key). */
function keyProblem(key) {
  if (typeof key !== 'string' || !key) return 'The key is empty.';
  if (key.startsWith('sk_')) {
    return (
      'That looks like a SECRET key (it starts with sk_). A secret key must never go into an app or a terminal log: ' +
      'anyone who gets it can send notifications to all your users. Use the PUBLIC key of the project (pk_live_... or pk_test_...) ' +
      'and rotate the secret key if it was exposed.'
    );
  }
  if (!/^pk_[A-Za-z0-9_.-]{4,}$/.test(key)) {
    return 'That is not a public key. A public key starts with pk_live_ or pk_test_.';
  }
  return null;
}

/** Reads lines from `stdin` one question at a time; resolves '' once the input is closed. */
function makePrompter(stdin, stdout) {
  const rl = readline.createInterface({ input: stdin });
  const lines = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (line) => {
    if (waiters.length) waiters.shift()(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()('');
  });
  return {
    ask(question) {
      stdout.write(question);
      if (lines.length) return Promise.resolve(lines.shift());
      if (closed) return Promise.resolve('');
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      rl.close();
    },
  };
}

/**
 * The major of an `expo` version range from package.json, or `null` when the range does not name one: `~57.0.26`,
 * `^53.0.0`, `57.x` and `53` do; `>=52 <58`, `>=53`, `latest`, `*`, `||` lists and tags do not (the installed version
 * decides, and until it is installed the wizard does not guess).
 * @param {unknown} range
 * @returns {number | null}
 */
function majorFromRange(range) {
  const match = /^[\^~=]?\s*v?(\d+)(?:\.(?:\d+|[xX*])){0,2}(?:-[\w.]+)?$/.exec(String(range || '').trim());
  return match ? parseInt(match[1], 10) : null;
}

/** The major of the Expo SDK: from the installed `expo`, else from the range in package.json; `null` if unreadable. */
function expoSdkMajor(cwd, range, fsModule = fs, pathModule = path) {
  try {
    const installed = parseJson(fsModule.readFileSync(pathModule.join(cwd, 'node_modules', 'expo', 'package.json'), 'utf8'));
    const major = parseInt(String(installed.version).split('.')[0], 10);
    if (Number.isFinite(major)) return major;
  } catch (_) {
    // not installed yet: read the range
  }
  return majorFromRange(range);
}

/** JSON.parse that accepts a byte order mark, which Windows editors like to write at the top of a file. */
function parseJson(text) {
  return JSON.parse(String(text).replace(/^\uFEFF/, ''));
}

/** The line ending a text uses: CRLF when it has more of them than bare LFs, else LF. */
function detectEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/** The indentation, the final newline, the line ending and the byte order mark of a JSON text, so the rewrite looks like the original. */
function jsonStyle(text) {
  const body = text.replace(/^\uFEFF/, '');
  const indent = /^([ \t]+)"/m.exec(body);
  return {
    indent: indent ? indent[1] : '  ',
    newline: /\n$/.test(body),
    eol: detectEol(body),
    bom: text.startsWith('\uFEFF') ? '\uFEFF' : '',
  };
}

/** The text of `json` written the way `style` says. */
function formatJson(json, style) {
  const body = JSON.stringify(json, null, style.indent).replace(/\n/g, style.eol);
  return style.bom + body + (style.newline ? style.eol : '');
}

/**
 * Whether a `plugins` entry (a name or a `[name, options]` pair) is this plugin, however it is written: by its name, by
 * `.../app.plugin.js`, by `./node_modules/@espresso-notify/react-native/app.plugin.js`, with `/` or `\`. The comparison
 * is made on the normalized path, with the `path` module of the system the project is on.
 * @param {unknown} entry
 * @param {typeof path} [pathModule]
 */
function isEspressoPlugin(entry, pathModule = path) {
  const specifier = Array.isArray(entry) ? entry[0] : entry;
  if (typeof specifier !== 'string' || !specifier.trim()) return false;
  let name = path.posix.normalize(pathModule.normalize(specifier.trim()).replace(/\\/g, '/'));
  const modules = name.lastIndexOf('node_modules/');
  if (modules >= 0) name = name.slice(modules + 'node_modules/'.length);
  name = name.replace(/^\.\//, '').replace(/\/+$/, '').replace(/\/app\.plugin(?:\.js)?$/, '');
  return name === PLUGIN;
}

const listsPlugin = (plugins, pathModule = path) =>
  Array.isArray(plugins) && plugins.some((entry) => isEspressoPlugin(entry, pathModule));

/** The string of a `plugins` entry (a name, or the first item of a `[name, options]` pair). */
const specifierOf = (entry) => (Array.isArray(entry) ? entry[0] : entry);

/**
 * The first entry of `plugins` that is this plugin written with a backslash (`.\node_modules\@espresso-notify\react-native\app.plugin.js`,
 * `@espresso-notify\react-native`), or `undefined`. `isEspressoPlugin` accepts it, and Expo resolves it on Windows only: on
 * macOS and Linux, where EAS Build runs, `@expo/config-plugins` fails with "Failed to resolve plugin for module".
 */
function backslashPlugin(plugins, pathModule = path) {
  if (!Array.isArray(plugins)) return undefined;
  return plugins.find((entry) => isEspressoPlugin(entry, pathModule) && String(specifierOf(entry)).includes('\\'));
}

/**
 * The name, as it is on disk, of the first of `wanted` that is a file of `entries`. The match ignores case, because macOS
 * and Windows do (`App.json` is `app.json` there) and the wizard must find the same file on every system.
 * @param {{ name: string, directory: boolean }[]} entries
 * @param {string[]} wanted
 * @returns {string | undefined}
 */
function findFile(entries, wanted) {
  for (const name of wanted) {
    const hit =
      entries.find((entry) => !entry.directory && entry.name === name) ||
      entries.find((entry) => !entry.directory && entry.name.toLowerCase() === name);
    if (hit) return hit.name;
  }
  return undefined;
}

/** The name, as it is on disk, of the folder called `wanted` (ignoring case), if there is one. */
function findFolder(entries, wanted) {
  const hit = entries.find((entry) => entry.directory && entry.name.toLowerCase() === wanted);
  return hit ? hit.name : undefined;
}

/** The entries of a folder as `{ name, directory }`; empty when it cannot be read. */
function listFolder(fsModule, dir) {
  try {
    return fsModule.readdirSync(dir, { withFileTypes: true }).map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
  } catch (_) {
    return [];
  }
}

/** `text` without comments and without commas before a closing bracket (what Expo reads as JSON5), strings left alone. */
function relaxedJson(text) {
  let stripped = '';
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      stripped += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      stripped += ' ';
      i = end < 0 ? text.length : end + 2;
    } else {
      stripped += c;
      i += 1;
    }
  }
  let result = '';
  for (let i = 0; i < stripped.length; ) {
    const c = stripped[i];
    if (c === '"') {
      let j = i + 1;
      while (j < stripped.length && stripped[j] !== '"') j += stripped[j] === '\\' ? 2 : 1;
      result += stripped.slice(i, j + 1);
      i = j + 1;
    } else if (c === ',' && /^\s*[}\]]/.test(stripped.slice(i + 1))) {
      i += 1;
    } else {
      result += c;
      i += 1;
    }
  }
  return result;
}

/** True when `text` is not JSON but becomes JSON once its comments and trailing commas are taken out. */
function isJson5Like(text) {
  try {
    parseJson(relaxedJson(text));
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Where the members of the objects and the elements of the arrays of a JSON text sit in it. The text has already been
 * accepted by `JSON.parse`, so this reads positions only and never checks syntax.
 * @param {string} text
 */
function scanJson(text) {
  let i = 0;
  const skipSpace = () => {
    while (i < text.length && ' \t\r\n'.includes(text[i])) i += 1;
  };
  const skipString = () => {
    i += 1;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i += 1;
  };
  const readValue = () => {
    skipSpace();
    const start = i;
    const c = text[i];
    if (c === '{' || c === '[') {
      const members = [];
      const elements = [];
      i += 1;
      skipSpace();
      if (text[i] === (c === '{' ? '}' : ']')) {
        i += 1;
        return { type: c === '{' ? 'object' : 'array', start, end: i, members, elements };
      }
      i = start + 1;
      for (;;) {
        const from = i;
        skipSpace();
        if (c === '{') {
          const keyStart = i;
          skipString();
          const keyEnd = i;
          skipSpace();
          i += 1; // the colon
          const value = readValue();
          members.push({ key: JSON.parse(text.slice(keyStart, keyEnd)), from, keyStart, keyEnd, value, between: text.slice(keyEnd, value.start) });
        } else {
          const value = readValue();
          elements.push({ from, value });
        }
        skipSpace();
        const delimiter = text[i];
        i += 1;
        if (delimiter !== ',') return { type: c === '{' ? 'object' : 'array', start, end: i, members, elements };
      }
    }
    if (c === '"') skipString();
    else while (i < text.length && !' \t\r\n,]}'.includes(text[i])) i += 1;
    return { type: 'value', start, end: i, members: [], elements: [] };
  };
  return readValue();
}

/**
 * `text` (the JSON of an Expo config) with `name` added to the list of plugins, by inserting text at one place: every
 * other byte stays as the person wrote it (a `1.0`, a number above 2^53, a `é`, a repeated key, the line endings, the
 * indentation, the byte order mark). The new text copies the layout around it.
 *
 * It never re-serializes the file. When the place cannot be told without a doubt (the root is not an object, "expo" or
 * "plugins" has another shape or is written twice), or when the result parsed is not the original plus the plugin, it
 * returns `{ problem }` and the caller leaves the file alone.
 * @param {string} text the file as read
 * @param {string} name the plugin to add
 * @param {(body: string) => object} scan reads the positions (replaceable so a test can prove the check at the end)
 * @returns {{ text: string } | { problem: string }}
 */
function insertPlugin(text, name, scan) {
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const body = text.slice(bom.length);
  let expected;
  let root;
  try {
    expected = JSON.parse(body);
    root = scan(body);
  } catch (_) {
    return { problem: 'is not valid JSON' };
  }
  if (expected === null || typeof expected !== 'object') return { problem: 'does not hold a JSON object (it is a plain value)' };
  if (Array.isArray(expected)) return { problem: 'holds a JSON array, not an object' };

  const only = (node, key) => node.members.filter((member) => member.key === key);
  const wrappers = only(root, 'expo');
  if (wrappers.length > 1) return { problem: 'writes the key "expo" twice' };
  // Expo reads `config.expo ?? config`: an "expo" that is present and is not null is the config, so it must be an object.
  const hasExpo = wrappers.length === 1 && expected.expo !== null;
  if (hasExpo && (typeof expected.expo !== 'object' || Array.isArray(expected.expo))) return { problem: 'has an "expo" that is not an object' };
  const wrapped = hasExpo;
  const target = wrapped ? expected.expo : expected;
  const node = wrapped ? wrappers[0].value : root;

  const lists = only(node, 'plugins');
  if (lists.length > 1) return { problem: 'writes the key "plugins" twice' };
  if (lists.length === 1 && !Array.isArray(target.plugins)) return { problem: 'has a "plugins" that is not a list' };

  const eol = detectEol(body);
  const unit = jsonStyle(text).indent;
  const quoted = JSON.stringify(name);
  const lastLine = (space) => space.slice(space.lastIndexOf('\n') + 1);
  let at;
  let insertion;
  if (lists.length === 1) {
    const list = lists[0].value;
    if (list.elements.length > 0) {
      const last = list.elements[list.elements.length - 1];
      const lead = body.slice(last.from, last.value.start);
      at = last.value.end;
      insertion = `,${list.elements.length === 1 && lead === '' ? ' ' : lead}${quoted}`;
    } else {
      const inside = body.slice(list.start + 1, list.end - 1);
      at = list.start + 1;
      insertion = inside.includes('\n') ? `${eol}${lastLine(inside)}${unit}${quoted}` : quoted;
    }
  } else if (node.members.length > 0) {
    const last = node.members[node.members.length - 1];
    const lead = body.slice(last.from, last.keyStart);
    const indent = lastLine(lead);
    const list = lead.includes('\n') ? `[${eol}${indent}${unit}${quoted}${eol}${indent}]` : `[${quoted}]`;
    at = last.value.end;
    insertion = `,${lead.includes('\n') ? eol + indent : lead}"plugins"${last.between}${list}`;
  } else {
    const inside = body.slice(node.start + 1, node.end - 1);
    const indent = lastLine(inside) + unit;
    at = node.start + 1;
    insertion = inside.includes('\n')
      ? `${eol}${indent}"plugins": [${eol}${indent}${unit}${quoted}${eol}${indent}]`
      : `"plugins": [${quoted}]`;
  }

  target.plugins = [...(Array.isArray(target.plugins) ? target.plugins : []), name];
  const result = body.slice(0, at) + insertion + body.slice(at);
  try {
    if (JSON.stringify(JSON.parse(result)) !== JSON.stringify(expected)) throw new Error('differs');
  } catch (_) {
    return { problem: 'has a layout the wizard cannot extend without risking a change to your values' };
  }
  return { text: bom + result };
}

/**
 * `text` with every one of `names` added to the list of plugins, one insertion after the other (each one goes in right
 * after the previous one, so together they are still one piece of text); stops at the first one that cannot go in.
 * @param {string} text
 * @param {string[]} [names]
 * @param {(body: string) => object} [scan]
 * @returns {{ text: string } | { problem: string }}
 */
function addPluginsToJsonText(text, names = [PLUGIN], scan = scanJson) {
  let current = text;
  for (const name of names) {
    const step = insertPlugin(current, name, scan);
    if (step.problem) return step;
    current = step.text;
  }
  return { text: current };
}

/**
 * Whether a JSON Expo config lists this plugin (read the way the wizard reads it: inside "expo" when that is an object, else
 * at the root). `false` for a text that is not plain JSON.
 */
function jsonConfigListsPlugin(text, pathModule = path) {
  try {
    const json = parseJson(text);
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return false;
    // `expo ?? root`, as Expo reads it: an "expo" that is false, 0 or a list is the config, and lists nothing
    const target = json.expo ?? json;
    return listsPlugin(target.plugins, pathModule);
  } catch (_) {
    return false;
  }
}

/** The entry of a JSON Expo config that spells this plugin with a backslash (read as `jsonConfigListsPlugin` reads it), if there is one. */
function jsonConfigBackslashPlugin(text, pathModule = path) {
  try {
    const json = parseJson(text);
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return undefined;
    return backslashPlugin((json.expo ?? json).plugins, pathModule);
  } catch (_) {
    return undefined;
  }
}

/** The entries of `plugins` of a JSON Expo config (inside "expo" when that is an object, else at the root); `null` when the text cannot be read. */
function listedPlugins(text) {
  let json;
  try {
    json = parseJson(text);
  } catch (_) {
    try {
      json = parseJson(relaxedJson(text));
    } catch (__) {
      return null;
    }
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return [];
  const target = json.expo && typeof json.expo === 'object' && !Array.isArray(json.expo) ? json.expo : json;
  return Array.isArray(target.plugins) ? target.plugins : [];
}

/** `bytes` (a Buffer, or the string of an in-memory file system) as text, however damaged: only to compare plugin names. */
const looseText = (bytes) => (typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8'));

const sameBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/**
 * The text of the bytes of a file when they are valid UTF-8 (a byte order mark is kept as U+FEFF), else `null`: a file in
 * a legacy code page (`é` as the byte E9) or in UTF-16 would be written back with other bytes. An in-memory file system
 * hands back a string, which is its own text.
 * @param {Buffer | string} bytes
 * @returns {string | null}
 */
function strictUtf8(bytes) {
  if (typeof bytes === 'string') return bytes;
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

/**
 * The plugins (names) that are in the config `after` and were not in the config `before`: what `expo install` added. The
 * comparison is of the plugins listed, not of the bytes. When `before` cannot be read at all (JSON5 with unquoted keys,
 * for instance), a name counts as already there if the old text holds it between quotes.
 * @param {Buffer | string} beforeBytes
 * @param {Buffer | string} afterBytes
 * @returns {string[]}
 */
function pluginsAdded(beforeBytes, afterBytes) {
  const after = listedPlugins(looseText(afterBytes));
  if (!after) return [];
  const beforeText = looseText(beforeBytes);
  const before = listedPlugins(beforeText);
  const known = (entry) =>
    before
      ? before.some((old) => JSON.stringify(old) === JSON.stringify(entry))
      : beforeText.includes(JSON.stringify(entry)) || beforeText.includes(`'${entry}'`);
  const added = after.filter((entry) => typeof entry === 'string' && !known(entry));
  return [...new Set(added)];
}

/**
 * What the file system says about `file` besides its bytes: where a symbolic link points (`link` is its text, `target` the
 * path it resolves to) and the permission bits (`mode`, those of the file that is read, through a link). Everything is
 * `null` when the file system cannot say (an in-memory one used in tests has no `lstatSync`).
 */
function fileFacts(fsm, pathm, file) {
  const facts = { link: null, target: null, mode: null };
  if (typeof fsm.lstatSync !== 'function') return facts;
  try {
    if (fsm.lstatSync(file).isSymbolicLink()) {
      facts.link = fsm.readlinkSync(file);
      facts.target = pathm.resolve(pathm.dirname(file), facts.link);
    }
    facts.mode = fsm.statSync(file).mode & 0o7777;
  } catch (_) {
    // a dangling link, or a file that is gone: nothing more to know
  }
  return facts;
}

/**
 * The JSON configs of the folder with their exact bytes, read before `expo install` runs: it adds config plugins to the
 * static config by itself (`@expo/cli` `install/applyPlugins.js` calls `autoAddConfigPluginsAsync`, which ends in
 * `modifyConfigAsync`) and writes the file again from the parsed object, through a new file: a symbolic link is gone
 * afterwards and the permissions are the default ones. So the snapshot keeps the link and the mode too.
 * `app.config.json` goes before `app.json`, as in Expo.
 * @returns {{ name: string, file: string, bytes: Buffer | string, link: string | null, target: string | null, mode: number | null }[]}
 */
function snapshotJsonConfigs(fsm, pathm, cwd) {
  const folder = listFolder(fsm, cwd);
  const found = [];
  for (const wanted of ['app.config.json', 'app.json']) {
    const name = findFile(folder, [wanted]);
    if (!name) continue;
    const file = pathm.join(cwd, name);
    try {
      found.push({ name, file, bytes: fsm.readFileSync(file), ...fileFacts(fsm, pathm, file) });
    } catch (_) {
      // unreadable: nothing to put back
    }
  }
  return found;
}

/** The permission bits as the digits of `chmod` (`0o600` -> `600`). */
const modeDigits = (mode) => (mode & 0o777).toString(8).padStart(3, '0');

/** The code of a failure (`EPERM`), or its message. */
const reasonOf = (error) => (error && (error.code || error.message)) || String(error);

/**
 * Why `file` cannot be written (`EACCES`, `EROFS`), or `null` when it can. A dry run asks this instead of writing, so it
 * ends with the code the real run ends with for a read-only config; a file system that cannot be asked (an in-memory one
 * used in tests) says it can.
 */
function whyNotWritable(fsm, file) {
  if (typeof fsm.accessSync !== 'function') return null;
  try {
    fsm.accessSync(file, (fsm.constants || fs.constants).W_OK);
    return null;
  } catch (error) {
    return reasonOf(error);
  }
}

/** `fsm.readFileSync(file)`, or `null` when it cannot be read. */
function readOrNull(fsm, file) {
  try {
    return fsm.readFileSync(file);
  } catch (_) {
    return null;
  }
}

/**
 * Puts back, byte for byte, every config of `snapshots` that `expo install` changed, and says what Expo had added to each
 * (the plugins), so the wizard can insert them as text. Besides the bytes it puts back a symbolic link that Expo replaced by
 * a regular file (the file the link points to gets the bytes only if they changed) and the permissions. What it cannot put
 * back (a link on Windows can need a privilege: `EPERM`) is returned in `problems`, never thrown.
 * @returns {{ name: string, added: string[], gone: boolean, link: string | null, mode: number | null, problems: { kind: 'link' | 'mode', reason: string, now?: number }[] }[]} the configs that were changed
 */
function restoreJsonConfigs(snapshots, fsm, pathm) {
  const rewritten = [];
  for (const snap of snapshots) {
    const now = readOrNull(fsm, snap.file);
    let facts = fileFacts(fsm, pathm, snap.file);
    const linkLost = snap.link !== null && facts.link !== snap.link;
    const bytesChanged = now === null || !sameBytes(now, snap.bytes);
    const modeChanged = snap.mode !== null && facts.mode !== null && facts.mode !== snap.mode;
    if (!linkLost && !bytesChanged && !modeChanged) continue;
    const item = { name: snap.name, added: now === null ? [] : pluginsAdded(snap.bytes, now), gone: now === null, link: snap.link, mode: snap.mode, problems: [] };
    if (linkLost) {
      // the link points to a file Expo did not touch: it gets the bytes only if they are not the ones it had
      const target = readOrNull(fsm, snap.target);
      if (target === null || !sameBytes(target, snap.bytes)) fsm.writeFileSync(snap.target, snap.bytes);
      // the link is made beside the file and renamed over it, so a failure leaves the file as it is
      const spare = `${snap.file}.espresso-${process.pid}.tmp`;
      try {
        fsm.symlinkSync(snap.link, spare);
        fsm.renameSync(spare, snap.file);
      } catch (error) {
        try {
          fsm.unlinkSync(spare);
        } catch (_) {
          // not there
        }
        item.problems.push({ kind: 'link', reason: reasonOf(error) });
        if (facts.link !== null) fsm.unlinkSync(snap.file); // another link: never write through it
        fsm.writeFileSync(snap.file, snap.bytes);
      }
    } else if (bytesChanged) {
      fsm.writeFileSync(snap.file, snap.bytes);
    }
    facts = fileFacts(fsm, pathm, snap.file);
    if (snap.mode !== null && facts.mode !== null && facts.mode !== snap.mode) {
      try {
        fsm.chmodSync(snap.file, snap.mode);
      } catch (error) {
        item.problems.push({ kind: 'mode', reason: reasonOf(error), now: facts.mode });
      }
    }
    rewritten.push(item);
  }
  return rewritten;
}

/**
 * `code` with its comments blanked and, when `blankStrings` is set, the inside of its strings and templates too. The text
 * keeps its length and its lines, so a word that is left was written as code (or, without `blankStrings`, as a key too).
 */
function codeOutside(code, blankStrings) {
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  let result = '';
  for (let i = 0; i < code.length; ) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '/') {
      let end = code.indexOf('\n', i);
      if (end < 0) end = code.length;
      result += blank(code.slice(i, end));
      i = end;
    } else if (c === '/' && code[i + 1] === '*') {
      const close = code.indexOf('*/', i + 2);
      const end = close < 0 ? code.length : close + 2;
      result += blank(code.slice(i, end));
      i = end;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === '\\' ? 2 : 1;
      const literal = code.slice(i, j + 1);
      result += blankStrings ? c + blank(literal.slice(1, -1)) + (literal.length > 1 ? c : '') : literal;
      i = j + 1;
    } else {
      result += c;
      i += 1;
    }
  }
  return result;
}

/**
 * What a code config does with the `config` it is given, which Expo fills with the content of `app.json` (or
 * `app.config.json`): `'plain'` when it only spreads it (`{ ...config` or `, ...config`, outside comments and strings, with
 * `config` the parameter of the function, no `.expo`/`.plugins` after it) and never writes `plugins` itself, so the plugins
 * of the JSON may reach Expo; `'none'` when it does not spread it; `'unsure'` otherwise (`plugins` set next to the spread, a
 * spread of something taken from `config`, a `config` that is not the parameter), where the wizard cannot tell and says so.
 * A heuristic on the text: it never runs the file, so not even `'plain'` is a proof (a second spread, a spread into a
 * variable that is not returned or in one branch only look the same): the caller asks to check the file in both cases.
 * @param {string} code
 * @returns {'plain' | 'none' | 'unsure'}
 */
function configSpread(code) {
  const bare = codeOutside(code, true);
  if (!/\.\.\.\s*config\b/.test(bare)) return 'none';
  const plain = /[{,]\s*\.\.\.\s*config\b(?!\s*[.[(?])/.test(bare);
  const parameter = /\([^()]*\bconfig\b[^()]*\)\s*(?::\s*[^=;{]+?)?=>|\bconfig\s*=>|function\s*\w*\s*\([^()]*\bconfig\b[^()]*\)/.test(bare);
  const setsPlugins = /\bplugins\b/.test(codeOutside(code, false));
  return plain && parameter && !setsPlugins ? 'plain' : 'unsure';
}

/** The snippet of the last step. */
function hookSnippet(key) {
  return [
    "import { usePushNotifications } from '@espresso-notify/react-native/hooks'",
    '',
    'export function PushSetup() {',
    '  const { userId } = useAuth() // your own auth context',
    '',
    '  usePushNotifications({',
    `    projectId: '${key}', // the public key of your project`,
    '    externalId: userId, // null while nobody is logged in',
    '  })',
    '',
    '  return null',
    '}',
  ].join('\n');
}

/**
 * Runs the wizard.
 * @param {string[]} argv
 * @param {{ cwd: string, spawn: Function, stdout: {write: Function}, stderr: {write: Function}, stdin: object, isTTY: boolean, platform: string, env?: object }} io
 * @returns {Promise<number>} the exit code
 */
async function run(argv, io) {
  const out = (text = '') => io.stdout.write(text + '\n');
  const err = (text = '') => io.stderr.write(text + '\n');
  const options = parseArgs(argv);

  if (options.help) {
    out(USAGE);
    return 0;
  }
  if (options.error) {
    err(`${options.error}\n`);
    err(USAGE);
    return 1;
  }
  if (options.key !== undefined) {
    const problem = keyProblem(options.key);
    if (problem) {
      err(`[espresso-notify] ${problem}`);
      return 1;
    }
  }

  const fsm = io.fs || fs;
  const pathm = io.path || path;
  const interactive = io.isTTY && !options.yes && !options.dryRun;
  const prompter = interactive ? makePrompter(io.stdin, io.stdout) : null;
  // `manual` holds the steps the wizard could not do and the person must; with one left the run is not "done".
  const state = { changed: false, failed: false, blocked: false, key: options.key, manual: [], check: [] };
  /**
   * A plugin written with a backslash in `file`. Off Windows Expo cannot resolve it (EAS Build runs there): a manual step, the
   * file left alone. On Windows it resolves, so it counts as present, with a warning that EAS Build needs `/`.
   * @returns {boolean} whether the plugin is NOT usable here (the caller leaves the file alone)
   */
  const reportBackslash = (file, entry, alsoAdd = []) => {
    const spelled = JSON.stringify(specifierOf(entry));
    if (io.platform === 'win32') {
      out(`      ${file} lists the plugin as ${spelled}, written with "\\": that resolves on Windows, but EAS Build runs on Linux or macOS, where Expo cannot resolve it. Write it as "${PLUGIN}".`);
      state.check.push(`Check ${file}: the plugin is written with "\\" (${spelled}), and EAS Build (Linux or macOS) needs "${PLUGIN}" with "/".`);
      return false;
    }
    err(
      `[espresso-notify] ${file} lists the plugin as ${spelled}, a path written with "\\". Expo cannot resolve that on macOS and Linux ` +
      `(EAS Build runs there), so the file was left alone. Write it as "${PLUGIN}" (with "/") yourself.`,
    );
    const more = alsoAdd.length > 0 ? ` and add ${alsoAdd.map((name) => `"${name}"`).join(', ')} to the same list` : '';
    state.manual.push(`write the plugin as "${PLUGIN}" (with "/", not "\\") in the "plugins" list of ${file}${more}: Expo cannot resolve ${spelled} on macOS and Linux, where EAS Build runs`);
    state.blocked = true;
    return true;
  };

  try {
    // 1. Detect ------------------------------------------------------------------------------------------------
    out('[1/6] Looking at the project');
    const packagePath = pathm.join(io.cwd, 'package.json');
    let pkg;
    try {
      pkg = parseJson(fsm.readFileSync(packagePath, 'utf8'));
    } catch (_) {
      err('[espresso-notify] There is no readable package.json here. Run the wizard from the root folder of your app.');
      throw new Stop(1);
    }
    const deps = { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) };
    if (!deps.expo) {
      err(
        '[espresso-notify] This is not an Expo project: `expo` is not in package.json.\n' +
        `For a React Native CLI app follow the manual guide: ${BARE_GUIDE}`,
      );
      throw new Stop(1);
    }
    const major = expoSdkMajor(io.cwd, deps.expo, fsm, pathm);
    if (major === null) {
      out(`      Could not tell the Expo SDK from "${deps.expo}"; going on. The SDK needs Expo SDK ${MIN_EXPO_SDK} or newer.`);
    } else if (major < MIN_EXPO_SDK) {
      err(
        `[espresso-notify] This project is on Expo SDK ${major}. The SDK needs Expo SDK ${MIN_EXPO_SDK} or newer. ` +
        'Upgrade first (https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/), then run the wizard again.',
      );
      throw new Stop(1);
    } else {
      out(`      Expo project, Expo SDK ${major}.`);
    }

    if (prompter) {
      const answer = (await prompter.ask(
        `      Install the packages and add the plugin to app.json? [Y/n] `,
      )).trim().toLowerCase();
      if (answer && answer !== 'y' && answer !== 'yes') {
        err('[espresso-notify] Cancelled. Nothing was changed.');
        throw new Stop(1);
      }
    }

    // 2. Install -----------------------------------------------------------------------------------------------
    out('[2/6] Installing the packages');
    const wanted = [PLUGIN, ...EXPO_PACKAGES];
    const missing = wanted.filter((name) => !deps[name]);
    /** The packages of `wanted` that package.json lists now (read again), or `null` when it cannot be read. */
    const stillMissing = () => {
      try {
        const now = parseJson(fsm.readFileSync(packagePath, 'utf8'));
        const listed = { ...(now.devDependencies || {}), ...(now.dependencies || {}) };
        return wanted.filter((name) => !listed[name]);
      } catch (_) {
        return null;
      }
    };
    const command = `npx ${INSTALL_ARGS.join(' ')}`;
    /** The plugins that `expo install` added to each JSON config it rewrote (file name -> names). */
    const expoAdded = new Map();
    if (missing.length === 0) {
      out('      Already installed: nothing to do.');
    } else if (options.dryRun) {
      out(`      Would run: ${command}`);
    } else {
      out(`      Running: ${command}`);
      // `expo install` rewrites app.json / app.config.json on its own when it adds the plugins of the packages: keep the bytes.
      const snapshots = snapshotJsonConfigs(fsm, pathm, io.cwd);
      const code = await new Promise((resolve) => {
        let child;
        try {
          child = io.spawn(...installInvocation(io.platform, io.env), {
            cwd: io.cwd,
            stdio: 'inherit',
            shell: false,
            ...installEnvironment(io.platform, io.env),
          });
        } catch (spawnError) {
          resolve(spawnError);
          return;
        }
        child.on('error', (spawnError) => resolve(spawnError));
        child.on('close', (exitCode) => resolve(exitCode));
      });
      for (const rewritten of restoreJsonConfigs(snapshots, fsm, pathm)) {
        const name = rewritten.name;
        if (rewritten.gone && rewritten.problems.length === 0) {
          out(`      ${name} was gone after \`expo install\`. The wizard put it back as you wrote it; step 3 adds the plugins as text.`);
        } else if (rewritten.problems.length === 0) {
          out(
            `      Expo rewrote ${name} on its own (it drops comments and changes line endings and numbers). ` +
            'The wizard put your file back as you wrote it; step 3 adds the plugins as text.',
          );
        } else {
          // Something could not be put back: say exactly what, never "as you wrote it".
          const said = rewritten.problems.map((problem) =>
            problem.kind === 'link'
              ? `${name} was a link to ${rewritten.link} and is a regular file now (the wizard could not make the link again: ${problem.reason}); its content is the one you wrote, and ${rewritten.link} was not changed`
              : `the permissions of ${name} are ${modeDigits(problem.now)} instead of ${modeDigits(rewritten.mode)} (the wizard could not set them back: ${problem.reason})`,
          );
          out(`      Expo rewrote ${name} on its own. The wizard put the bytes back, but not everything: ${said.join('; ')}. Step 3 adds the plugins as text.`);
          for (const problem of rewritten.problems) {
            if (problem.kind === 'link') {
              state.manual.push(
                `${name} is a regular file now, not the link to ${rewritten.link} it was (the wizard could not make the link again: ${problem.reason}): the plugins go into ${name}; ` +
                `to keep the link, add them to ${rewritten.link} too and make the link again`,
              );
            } else {
              state.check.push(`Check the permissions of ${name}: they are ${modeDigits(problem.now)} and were ${modeDigits(rewritten.mode)}, and the wizard could not set them back.`);
            }
          }
        }
        expoAdded.set(name, rewritten.added);
      }
      if (code !== 0) {
        // `expo install` installs the packages first and only then tries to add the plugin to the config; with an
        // app.config.js / app.config.ts it cannot, and it exits 1 after a good install. package.json says which happened.
        const left = code instanceof Error ? null : stillMissing();
        if (left && left.length === 0) {
          err(
            `[espresso-notify] \`expo install\` exited with code ${code}, but every package is in package.json now. ` +
            'It does this when it cannot add the plugin to a config that is code (app.config.js / app.config.ts); the wizard goes on.',
          );
        } else {
          err(
            `[espresso-notify] The install did not finish${code instanceof Error ? ` (${code.message})` : ` (exit code ${code})`}. ` +
            `Run it yourself from the project folder, then run the wizard again:\n  ${command}`,
          );
          throw new Stop(2);
        }
      }
      state.changed = true;
    }

    // 3. Plugin ------------------------------------------------------------------------------------------------
    out('[3/6] Adding the config plugin');
    const folder = listFolder(fsm, io.cwd);
    const dynamic = findFile(folder, ['app.config.js', 'app.config.ts', 'app.config.mjs', 'app.config.cjs']);
    const jsonConfig = findFile(folder, ['app.config.json', 'app.json']);
    let projectId;
    let unreadable = ''; // the config file the wizard could not read
    if (dynamic) {
      let code = '';
      try {
        code = fsm.readFileSync(pathm.join(io.cwd, dynamic), 'utf8');
      } catch (_) {
        // unreadable: treated as not mentioning the plugin
      }
      let staticListsPlugin = false; // app.json (or app.config.json) lists the plugin
      let staticBackslash; // ... and one of its entries is the plugin written with a backslash
      if (jsonConfig) {
        try {
          const staticText = fsm.readFileSync(pathm.join(io.cwd, jsonConfig), 'utf8');
          staticListsPlugin = jsonConfigListsPlugin(staticText, pathm);
          staticBackslash = jsonConfigBackslashPlugin(staticText, pathm);
        } catch (_) {
          // unreadable: no proof
        }
      }
      const spread = staticListsPlugin ? configSpread(code) : 'none';
      if (staticBackslash !== undefined && reportBackslash(jsonConfig, staticBackslash)) {
        // the JSON the code file would pass on is itself wrong here: fix it first, the next run judges the code file
      } else if (code.includes(PLUGIN)) {
        out(`      ${dynamic} is code, so the wizard does not edit it. It mentions "${PLUGIN}"; make sure the name is in its "plugins" list.`);
        // A name found in a file is not a plugin listed: it may be a comment. The run does not end as "set up".
        state.check.push(`Check that ${dynamic} lists "${PLUGIN}" in "plugins": the name is in the file, but the wizard cannot tell code from a comment.`);
      } else if (spread === 'plain') {
        // The wizard never runs the file, so a spread that looks right is still no proof: no success line, a request to check.
        out(`      ${jsonConfig} lists the plugin and ${dynamic} spreads "config" (Expo fills it with ${jsonConfig}), but the wizard does not run ${dynamic}, so it cannot be sure that the plugin reaches Expo.`);
        state.check.push(`Check that ${dynamic} keeps "${PLUGIN}" in the "plugins" it returns: ${jsonConfig} lists it and ${dynamic} spreads "config", but the wizard does not run the file, so it cannot be sure that the plugin gets through.`);
      } else if (spread === 'unsure') {
        out(`      ${jsonConfig} lists the plugin, but the wizard cannot tell that ${dynamic} keeps it: Expo uses what ${dynamic} returns, and ${dynamic} sets "plugins" or spreads "config" in a way the wizard does not recognise.`);
        state.check.push(`Check that ${dynamic} keeps "${PLUGIN}" in the "plugins" it returns: ${jsonConfig} lists it, but the wizard cannot tell whether ${dynamic} passes it on.`);
      } else if (staticListsPlugin) {
        out(`      ${jsonConfig} lists the plugin, but Expo uses what ${dynamic} returns, and ${dynamic} does not seem to pass ${jsonConfig} on (it has no "...config").`);
        out(`      ${dynamic} is code, so the wizard does not edit it. Add this line to its "plugins" list, or return "...config" from it:`);
        out(`        "${PLUGIN}"`);
        state.manual.push(`add "${PLUGIN}" to the "plugins" list of ${dynamic}, or spread "...config" in it: Expo uses what ${dynamic} returns, not ${jsonConfig}`);
      } else {
        out(`      ${dynamic} found: it is code, so the wizard does not edit it. Add this line to its "plugins" list:`);
        out(`        "${PLUGIN}"`);
        state.manual.push(`add "${PLUGIN}" to the "plugins" list of ${dynamic}`);
      }
    } else if (!jsonConfig) {
      err(
        '[espresso-notify] There is no app.json, app.config.json or app.config.js here. Add the plugin to the Expo config of the app yourself:\n' +
        `  "plugins": ["${PLUGIN}"]`,
      );
      state.failed = true;
    } else {
      const configPath = pathm.join(io.cwd, jsonConfig);
      const text = strictUtf8(fsm.readFileSync(configPath));
      // The plugins `expo install` added to this file (it was put back as written): they go in as text, with ours last.
      const fromExpo = (expoAdded.get(jsonConfig) || []).filter((name) => !isEspressoPlugin(name, pathm));
      const quoteAll = (names) => names.map((name) => `"${name}"`).join(', ');
      let json;
      if (text === null) {
        // Not UTF-8 (a legacy code page, UTF-16): writing it back would change bytes the person did not touch.
        const lines = [...fromExpo, PLUGIN];
        unreadable = jsonConfig;
        err(`[espresso-notify] ${jsonConfig} is not saved as UTF-8 text (a legacy code page or UTF-16, maybe), so it was left alone. Add ${quoteAll(lines)} to "plugins" yourself.`);
        state.failed = true;
        state.manual.push(`add ${quoteAll(lines)} to the "plugins" list of ${jsonConfig}`);
        state.blocked = true;
      } else {
        try {
          json = parseJson(text);
        } catch (_) {
          const relaxed = isJson5Like(text);
          unreadable = jsonConfig;
          const reason = relaxed
            ? `${jsonConfig} has comments or a trailing comma. Expo accepts that, but the wizard reads plain JSON only and would lose the comments if it rewrote the file,`
            : `${jsonConfig} is not valid JSON,`;
          const lines = [...fromExpo, PLUGIN];
          err(`[espresso-notify] ${reason} so it was left alone. Add ${quoteAll(lines)} to "plugins" yourself.`);
          if (!relaxed) state.failed = true;
          state.manual.push(`add ${quoteAll(lines)} to the "plugins" list of ${jsonConfig}`);
          state.blocked = true;
        }
      }
      if (json !== undefined) {
        const plain = json !== null && typeof json === 'object' && !Array.isArray(json);
        const target = plain && json.expo && typeof json.expo === 'object' && !Array.isArray(json.expo) ? json.expo : json;
        projectId = plain ? target.extra && target.extra.eas && target.extra.eas.projectId : undefined;
        // an "expo" that is present and is not null or an object is what Expo reads, so the root proves nothing
        const expoIsNotAnObject = plain && json.expo !== undefined && json.expo !== null && target === json;
        const listed = plain && !expoIsNotAnObject && Array.isArray(target.plugins) ? target.plugins : [];
        const fromExpoToAdd = fromExpo.filter((name) => !listed.some((entry) => JSON.stringify(entry) === JSON.stringify(name)));
        const lines = [...fromExpoToAdd, ...(listsPlugin(listed, pathm) ? [] : [PLUGIN])];
        const backslashed = backslashPlugin(listed, pathm);
        if (backslashed !== undefined && reportBackslash(jsonConfig, backslashed, fromExpoToAdd)) {
          // left alone: Expo cannot resolve the entry here, so the person writes it with "/" (a manual step)
        } else if (lines.length === 0) {
          // with a backslash spelling (Windows) reportBackslash has just said what the file lists
          if (backslashed === undefined) out(`      ${jsonConfig} already lists the plugin: nothing to do.`);
        } else {
          // The plugins are put in by inserting text: the file is never written again from the parsed object, which would
          // change values the person wrote (1.0, a big integer, an escape, a repeated key).
          const edit = addPluginsToJsonText(text, lines);
          if (edit.problem) {
            err(`[espresso-notify] ${jsonConfig} ${edit.problem}, so it was left alone. Add ${quoteAll(lines)} to "plugins" yourself.`);
            state.manual.push(`add ${quoteAll(lines)} to the "plugins" list of ${jsonConfig}`);
            state.blocked = true;
          } else if (options.dryRun) {
            const unwritable = whyNotWritable(fsm, configPath);
            if (unwritable === null) {
              out(`      Would add ${quoteAll(lines)} to expo.plugins in ${jsonConfig}.`);
            } else {
              // a read-only file: the real run could not write it either, so the dry run says so and ends with 2
              err(`[espresso-notify] ${jsonConfig} could not be written (${unwritable}), so it would be left alone. Add ${quoteAll(lines)} to "plugins" yourself.`);
              state.manual.push(`add ${quoteAll(lines)} to the "plugins" list of ${jsonConfig}`);
              state.blocked = true;
            }
          } else {
            try {
              fsm.writeFileSync(configPath, edit.text);
              out(`      Added ${quoteAll(lines)} to expo.plugins in ${jsonConfig}.`);
              state.changed = true;
            } catch (writeError) {
              // a read-only file, for instance: it was not written, so the person adds the lines
              err(`[espresso-notify] ${jsonConfig} could not be written (${reasonOf(writeError)}), so it was left alone. Add ${quoteAll(lines)} to "plugins" yourself.`);
              state.manual.push(`add ${quoteAll(lines)} to the "plugins" list of ${jsonConfig}`);
              state.blocked = true;
            }
          }
        }
      }
    }
    const nativeFolders = ['ios', 'android'].map((name) => findFolder(folder, name)).filter(Boolean);
    if (nativeFolders.length > 0) {
      out(`      The ${nativeFolders.map((name) => `${name}/`).join(' and ')} folder${nativeFolders.length > 1 ? 's' : ''} already exist${nativeFolders.length > 1 ? '' : 's'}: the plugin changes the native projects only when you run`);
      out('      `npx expo prebuild`, so run it after this step. Do not add --clean if you keep changes of your own in those folders:');
      out('      it builds them again from nothing.');
    }

    // 4. EAS project id ----------------------------------------------------------------------------------------
    out('[4/6] Checking the EAS project id');
    if (dynamic) {
      out(`      Make sure ${dynamic} sets extra.eas.projectId. If it does not, run: eas init`);
    } else if (unreadable) {
      out(`      ${unreadable} was not read: make sure it sets extra.eas.projectId. If it does not, run: eas init`);
    } else if (projectId) {
      out('      extra.eas.projectId is set.');
    } else {
      out('      extra.eas.projectId is missing. Run `eas init` in this folder: it creates the EAS project and writes the id.');
      out('      The wizard does not run it for you.');
    }

    // 5. Public key and snippet --------------------------------------------------------------------------------
    out('[5/6] The hook');
    if (state.key === undefined && prompter) {
      const typed = (await prompter.ask(
        '      Public key of your project (pk_live_... or pk_test_..., Enter to skip): ',
      )).trim();
      if (typed) {
        const problem = keyProblem(typed);
        if (problem) {
          err(`[espresso-notify] ${problem}`);
          throw new Stop(1);
        }
        state.key = typed;
      }
    }
    out('      Render this once at the root of the app, inside your auth provider. The key is not saved anywhere:');
    out('');
    out(hookSnippet(state.key || PLACEHOLDER_KEY).split('\n').map((l) => (l ? `        ${l}` : l)).join('\n'));
    out('');

    // 6. What is left ------------------------------------------------------------------------------------------
    out('[6/6] What the wizard cannot do for you');
    out('      - Android: create a Firebase project, put google-services.json in the project and point');
    out('        android.googleServicesFile at it; then run `eas credentials` and upload an FCM V1 service account key.');
    out('      - iOS: the APNs push key is part of your app credentials; EAS manages it when you build with your');
    out('        Apple Developer account (or add one with `eas credentials`).');
    out('      - Build a development build: `npx expo run:ios` / `npx expo run:android` or EAS Build.');
    out('        Expo Go does not receive remote push.');
    out('');

    if (options.dryRun) {
      out('Dry run: nothing was changed.');
      // `blocked`: a JSON config the wizard cannot edit, which ends a real run with 2, so the dry run says 2 too.
      return state.failed || state.blocked ? 2 : 0;
    }
    if (state.manual.length > 0) {
      const n = state.manual.length;
      out(`${n} manual step${n > 1 ? 's' : ''} left. The setup is NOT finished until you do ${n > 1 ? 'them' : 'it'}:`);
      for (const step of state.manual) out(`  - ${step}`);
      out('Then run the wizard again to check.');
      return 2;
    }
    if (state.failed) out('Some steps did not finish. See the messages above.');
    else if (state.check.length > 0) {
      // Exit 0, but not a success claim: the wizard cannot tell, from the text of a code config, that the plugin is in what it returns.
      out(`Finished what the wizard can do. ${state.check.join(' ')}`);
    } else if (!state.changed) out('Nothing to change: this project is already set up.');
    else out('Done.');
    return state.failed ? 2 : 0;
  } catch (error) {
    if (error instanceof Stop) return error.code;
    err(`[espresso-notify] The wizard stopped: ${error && error.message ? error.message : error}`);
    return 2;
  } finally {
    if (prompter) prompter.close();
  }
}

/**
 * The file and the arguments that run `npx expo install ...` on `platform`. On Windows `npx` is `npx.cmd`, and since the
 * April 2024 security releases (CVE-2024-27980) Node throws EINVAL when it spawns a .cmd or .bat without a shell, so
 * there the command goes through `cmd.exe /d /s /c npx ...`. The arguments are constants: `shell: true` would build one
 * string, and nothing from the project reaches this command line. The interpreter is the one Windows names in the
 * `ComSpec` variable (an absolute path), or the System32 one: a bare `cmd.exe` is found by the search path, which on
 * Windows starts with the current folder, so a `cmd.exe` planted in the project would run in its place.
 * @param {string} platform - `process.platform`.
 * @param {Record<string, string | undefined>} [env] - `process.env`.
 * @returns {[string, string[]]}
 */
function installInvocation(platform, env = process.env) {
  if (platform !== 'win32') return ['npx', INSTALL_ARGS];
  const comspec = typeof env.ComSpec === 'string' ? env.ComSpec.trim() : '';
  const shell = comspec && path.win32.isAbsolute(comspec) ? comspec : WINDOWS_CMD;
  return [shell, ['/d', '/s', '/c', 'npx', ...INSTALL_ARGS]];
}

/**
 * The `env` option of the `npx` process: on Windows the environment with `NoDefaultCurrentDirectoryInExePath=1`, so the
 * command interpreter looks for `npx` in the folders of `PATH` and not first in the current folder (the project), where a
 * planted `npx.cmd` would run; nothing on the other systems, whose process inherits the environment as it is. The
 * environment of the caller is copied, never changed, and a name written with other capitals (Windows ignores case) is replaced.
 * @param {string} platform - `process.platform`.
 * @param {Record<string, string | undefined>} [env] - `process.env`.
 * @returns {{ env: Record<string, string | undefined> } | {}}
 */
function installEnvironment(platform, env = process.env) {
  if (platform !== 'win32') return {};
  const kept = Object.fromEntries(Object.entries(env).filter(([name]) => name.toLowerCase() !== 'nodefaultcurrentdirectoryinexepath'));
  return { env: { ...kept, NoDefaultCurrentDirectoryInExePath: '1' } };
}

module.exports = {
  run,
  parseArgs,
  keyProblem,
  installInvocation,
  installEnvironment,
  INSTALL_ARGS,
  majorFromRange,
  isEspressoPlugin,
  detectEol,
  jsonStyle,
  formatJson,
  findFile,
  findFolder,
  isJson5Like,
  scanJson,
  addPluginsToJsonText,
};

if (require.main === module) {
  run(process.argv.slice(2), {
    cwd: process.cwd(),
    spawn: childProcess.spawn,
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    isTTY: !!(process.stdin.isTTY && process.stdout.isTTY),
    platform: process.platform,
    env: process.env,
  }).then((code) => {
    process.exitCode = code;
  });
}
