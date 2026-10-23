'use strict';

/**
 * The two Gradle patchers of the setup wizard (React Native Firebase needs the `google-services` Gradle plugin):
 *
 *   gradleProject  `classpath("com.google.gms:google-services:<version>")` inside `buildscript { dependencies { } }` of
 *                  `android/build.gradle`
 *   gradleApp      `apply plugin: 'com.google.gms.google-services'` at the end of `android/app/build.gradle`
 *
 * Both are pure `(text, context) => { status, text?, reason? }` functions for `applyPatch`; `context.file` is the path of
 * the file (a Kotlin DSL `.kts` file is never edited). A line the project already has, in any quoting or in a `plugins`
 * block, counts as done and wins over the wizard's version.
 */

const { markers } = require('../patch.js');
const { parseLines, renderLines, insertAfter, appendLines, isCode, indentOf, braceDepths } = require('./text.js');

/**
 * Version of the `com.google.gms:google-services` Gradle plugin the wizard writes. It is one constant, checked against the
 * React Native Firebase install guide (rnfirebase.io) when the documentation is written, and a contract test fails if it
 * goes away or stops being MAJOR.MINOR.PATCH.
 */
const GOOGLE_SERVICES_VERSION = '4.5.0';

const { begin: BEGIN, end: END } = markers('//', 'google-services');
const HAS_OUR_BLOCK = /espresso-notify:begin google-services/;

const KOTLIN_REASON = 'it is a Kotlin DSL file (.kts); the wizard edits only Groovy build.gradle files';

const isKotlinDsl = (context) => Boolean(context && typeof context.file === 'string' && /\.kts$/i.test(context.file));

const hasOurBlock = (lines) => lines.some((line) => HAS_OUR_BLOCK.test(line.text));

/** @type {(text: string, context?: { file?: string }) => { status: string, text?: string, reason?: string }} */
function gradleProject(text, context) {
  if (isKotlinDsl(context)) return { status: 'unsupported', reason: KOTLIN_REASON };
  const lines = parseLines(text);
  if (hasOurBlock(lines) || lines.some((line) => isCode(line.text) && /com\.google\.gms[:.]google-services/.test(line.text))) {
    return { status: 'already' };
  }

  const depths = braceDepths(lines);
  const open = lines.findIndex((line, i) => depths[i].start === 0 && /^\s*buildscript\s*\{\s*(\/\/.*)?$/.test(line.text));
  if (open < 0) return { status: 'unsupported', reason: 'there is no top-level `buildscript {` block' };
  const close = depths.findIndex((depth, i) => i >= open && depth.end === 0);
  if (close < 0) return { status: 'unsupported', reason: 'the braces of the `buildscript` block do not balance' };

  let deps = -1;
  for (let i = open + 1; i < close; i += 1) {
    if (depths[i].start === 1 && depths[i].end === 2 && /^\s*dependencies\s*\{\s*(\/\/.*)?$/.test(lines[i].text)) {
      deps = i;
      break;
    }
  }
  if (deps < 0) return { status: 'unsupported', reason: 'there is no multi-line `dependencies {` block inside `buildscript`' };

  const next = lines[deps + 1];
  const inner =
    next && next.text.trim() !== '' && !next.text.trimStart().startsWith('}') ? indentOf(next.text) : `${indentOf(lines[deps].text)}    `;
  insertAfter(lines, deps, [`${inner}${BEGIN}`, `${inner}classpath("com.google.gms:google-services:${GOOGLE_SERVICES_VERSION}")`, `${inner}${END}`]);
  return { status: 'patched', text: renderLines(lines) };
}

/** @type {(text: string, context?: { file?: string }) => { status: string, text?: string, reason?: string }} */
function gradleApp(text, context) {
  if (isKotlinDsl(context)) return { status: 'unsupported', reason: KOTLIN_REASON };
  const lines = parseLines(text);
  if (hasOurBlock(lines) || lines.some((line) => isCode(line.text) && /com\.google\.gms\.google-services/.test(line.text))) {
    return { status: 'already' };
  }
  if (!lines.some((line) => isCode(line.text) && /com\.android\.application/.test(line.text))) {
    return { status: 'unsupported', reason: 'it is not an Android application module: there is no `com.android.application` plugin' };
  }
  appendLines(lines, [BEGIN, "apply plugin: 'com.google.gms.google-services'", END]);
  return { status: 'patched', text: renderLines(lines) };
}

module.exports = { gradleProject, gradleApp, GOOGLE_SERVICES_VERSION };
