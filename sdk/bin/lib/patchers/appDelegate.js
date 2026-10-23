'use strict';

/**
 * The AppDelegate patcher of the setup wizard (React Native Firebase needs `FirebaseApp.configure()` at launch).
 *
 * Swift (`AppDelegate.swift`, the template of React Native 0.77 and newer):
 *     import FirebaseCore                       (with the other imports)
 *     if Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil {
 *       FirebaseApp.configure()                 (first thing of didFinishLaunchingWithOptions)
 *     }
 * Objective-C (`AppDelegate.mm`): `#import <Firebase.h>` and the same guard around `[FIRApp configure]`.
 *
 * The guard is there because `FirebaseApp.configure()` aborts the launch when the plist is not in the app, and the
 * plist is a file the wizard cannot create. A configure call the project already has (guarded or not) is left alone: the
 * answer is `already`, and an unguarded one comes with a `warning`. `context.file` tells Swift from Objective-C; without
 * it the content decides.
 */

const { markers } = require('../patch.js');
const { parseLines, renderLines, insertAfter, isCode, indentOf, braceDepths } = require('./text.js');

const IMPORT_MARKERS = markers('//', 'firebase-import');
const CONFIGURE_MARKERS = markers('//', 'firebase-configure');

const LANGUAGES = {
  swift: {
    configureCall: /\bFirebaseApp\s*\.\s*configure\s*\(/,
    signature: /\bfunc\s+application\s*\(/,
    importLine: /^\s*(?:@testable\s+)?import\s+\w/,
    firebaseImport: /^\s*import\s+Firebase(?:Core)?\s*$/,
    importText: 'import FirebaseCore',
    guardOpen: 'if Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil {',
    call: 'FirebaseApp.configure()',
    guardClose: '}',
    unguardedWarning:
      'FirebaseApp.configure() is called without checking that GoogleService-Info.plist is in the app, so the app aborts at ' +
      'launch until you add the file. Wrap the call in `if Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil { ... }`.',
  },
  objc: {
    configureCall: /\[\s*FIRApp\s+configure/,
    signature: /^\s*-\s*\(/,
    importLine: /^\s*#\s*(?:import|include)\s/,
    firebaseImport: /^\s*(?:#\s*import\s*[<"]Firebase(?:\.h|Core\/)|@import\s+Firebase)/,
    importText: '#import <Firebase.h>',
    guardOpen: 'if ([[NSBundle mainBundle] pathForResource:@"GoogleService-Info" ofType:@"plist"]) {',
    call: '[FIRApp configure];',
    guardClose: '}',
    unguardedWarning:
      '[FIRApp configure] is called without checking that GoogleService-Info.plist is in the app, so the app aborts at ' +
      'launch until you add the file. Wrap the call in `if ([[NSBundle mainBundle] pathForResource:@"GoogleService-Info" ofType:@"plist"]) { ... }`.',
  },
};

function languageOf(text, context) {
  const file = context && typeof context.file === 'string' ? context.file : '';
  if (/\.(mm|m)$/i.test(file)) return LANGUAGES.objc;
  if (/\.swift$/i.test(file)) return LANGUAGES.swift;
  return /@implementation\b/.test(text) ? LANGUAGES.objc : LANGUAGES.swift;
}

/** The body of a line without a trailing `//` comment. */
const code = (text) => text.replace(/\/\/.*$/, '').trimEnd();

/** @type {(text: string, context?: { file?: string }) => { status: string, text?: string, reason?: string, warning?: string }} */
function appDelegate(text, context) {
  const lang = languageOf(text, context);
  const lines = parseLines(text);

  const configureAt = lines.findIndex((line) => isCode(line.text) && lang.configureCall.test(line.text));
  if (configureAt >= 0) {
    const guarded = lines.slice(0, configureAt).some((line) => isCode(line.text) && /\b(?:if|guard)\b.*GoogleService-Info/.test(line.text));
    return guarded ? { status: 'already' } : { status: 'already', warning: lang.unguardedWarning };
  }

  const launchAt = lines.findIndex((line) => isCode(line.text) && /didFinishLaunchingWithOptions/.test(line.text));
  if (launchAt < 0) {
    return { status: 'unsupported', reason: 'there is no `didFinishLaunchingWithOptions` method to start Firebase in' };
  }
  let signatureAt = -1;
  for (let i = launchAt; i >= Math.max(0, launchAt - 8); i -= 1) {
    if (lang.signature.test(lines[i].text)) {
      signatureAt = i;
      break;
    }
  }
  if (signatureAt < 0) return { status: 'unsupported', reason: 'the signature of `didFinishLaunchingWithOptions` is not in the usual form' };

  const depths = braceDepths(lines);
  const depth = depths[signatureAt].start;
  const openAt = lines.findIndex((line, i) => i >= signatureAt && i <= signatureAt + 12 && line.text.includes('{'));
  if (openAt < 0 || depths[openAt].end <= depth || !code(lines[openAt].text).endsWith('{')) {
    return { status: 'unsupported', reason: 'the body of `didFinishLaunchingWithOptions` does not open with `{` at the end of a line' };
  }

  const importAt = lines.reduce((last, line, i) => (i < signatureAt && depths[i].start === 0 && isCode(line.text) && lang.importLine.test(line.text) ? i : last), -1);
  const needsImport = !lines.some((line) => isCode(line.text) && lang.firebaseImport.test(line.text)) && !lines.some((line) => line.text.includes(IMPORT_MARKERS.begin));
  if (needsImport && importAt < 0) return { status: 'unsupported', reason: 'the file has no import to put the Firebase import next to' };

  const firstInside = lines.findIndex((line, i) => i > openAt && line.text.trim() !== '');
  const inner =
    firstInside >= 0 && depths[firstInside].start === depth + 1 && !lines[firstInside].text.trimStart().startsWith('}')
      ? indentOf(lines[firstInside].text)
      : `${indentOf(lines[signatureAt].text)}  `;
  const outer = indentOf(lines[signatureAt].text);
  const unit = inner.startsWith(outer) && inner.length > outer.length ? inner.slice(outer.length) : '  ';

  // The later insertion first, so the earlier index stays valid.
  insertAfter(lines, openAt, [
    `${inner}${CONFIGURE_MARKERS.begin}`,
    `${inner}${lang.guardOpen}`,
    `${inner}${unit}${lang.call}`,
    `${inner}${lang.guardClose}`,
    `${inner}${CONFIGURE_MARKERS.end}`,
  ]);
  if (needsImport) insertAfter(lines, importAt, [IMPORT_MARKERS.begin, lang.importText, IMPORT_MARKERS.end]);
  return { status: 'patched', text: renderLines(lines) };
}

module.exports = { appDelegate };
