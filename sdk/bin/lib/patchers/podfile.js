'use strict';

/**
 * The Podfile patcher of the setup wizard: React Native Firebase needs dynamic frameworks on iOS, so the wizard puts
 *
 *     # espresso-notify:begin use-frameworks
 *     use_frameworks! :linkage => :dynamic
 *     # espresso-notify:end
 *
 * inside the app target, right before `use_react_native!`.
 *
 * The Podfile of the React Native CLI template (0.79 and 0.87) already holds this block:
 *
 *     linkage = ENV['USE_FRAMEWORKS']
 *     if linkage != nil
 *       Pod::UI.puts "Configuring Pod with #{linkage}ally linked Frameworks".green    (the template has this line)
 *       use_frameworks! :linkage => linkage.to_sym
 *     end
 *
 * That exact block is the template form: it does nothing unless `USE_FRAMEWORKS` is set at install time, so it does not
 * stop the patch and it is left as it is. Any other use of `ENV['USE_FRAMEWORKS']`, any static linkage, a `use_frameworks!`
 * whose linkage is not a literal, and a Podfile without exactly one top-level `target ... do` that calls `use_react_native!`
 * are `unsupported`, with the manual step in the reason. A `use_frameworks!` that is dynamic (or bare, which is dynamic)
 * is `already`.
 */

const { markers } = require('../patch.js');
const { parseLines, renderLines, insertAfter, isCode, indentOf } = require('./text.js');

const { begin: BEGIN, end: END } = markers('#', 'use-frameworks');
const HAS_OUR_BLOCK = /espresso-notify:begin use-frameworks/;
const LINE = 'use_frameworks! :linkage => :dynamic';

const MANUAL_STEP = `Add \`${LINE}\` inside your app target in ios/Podfile, before \`use_react_native!\`.`;

/** The lines of the stock template block, in order, as they are written once trimmed. The second to last may be missing. */
const STOCK = {
  first: "linkage = ENV['USE_FRAMEWORKS']",
  condition: 'if linkage != nil',
  puts: 'Pod::UI.puts "Configuring Pod with #{linkage}ally linked Frameworks".green',
  call: 'use_frameworks! :linkage => linkage.to_sym',
  last: 'end',
};

/** The indexes of the lines of the stock template blocks (the block, with or without its `Pod::UI.puts` line). */
function stockBlockLines(lines) {
  const inBlock = new Set();
  const at = (i) => (i < lines.length ? lines[i].text.trim() : null);
  for (let i = 0; i < lines.length; i += 1) {
    if (at(i) !== STOCK.first || at(i + 1) !== STOCK.condition) continue;
    let next = i + 2;
    if (at(next) === STOCK.puts) next += 1;
    if (at(next) === STOCK.call && at(next + 1) === STOCK.last) {
      for (let j = i; j <= next + 1; j += 1) inBlock.add(j);
    }
  }
  return inBlock;
}

/** @type {(text: string, context?: { file?: string }) => { status: string, text?: string, reason?: string }} */
function podfile(text) {
  const lines = parseLines(text);
  if (lines.some((line) => HAS_OUR_BLOCK.test(line.text))) return { status: 'already' };

  const stock = stockBlockLines(lines);
  const code = lines.map((line, i) => ({ i, text: line.text })).filter(({ i, text: t }) => !stock.has(i) && isCode(t, { hash: true }));

  if (code.some(({ text: t }) => /USE_FRAMEWORKS/.test(t))) {
    return {
      status: 'unsupported',
      reason:
        "the Podfile uses ENV['USE_FRAMEWORKS'] in a form other than the one in the React Native template, so the wizard cannot tell " +
        `which linkage it sets. ${MANUAL_STEP}`,
    };
  }

  const calls = code.filter(({ text: t }) => /\buse_frameworks!/.test(t));
  const dynamic = (t) => /^\s*use_frameworks!\s*(?:#.*)?$/.test(t) || /\blinkage\s*(?:=>\s*|:\s*)(?::dynamic|(['"])dynamic\1)(?!\w)/.test(t);
  const stat = calls.find(({ text: t }) => /\blinkage\s*(?:=>\s*|:\s*)(?::static|(['"])static\1)(?!\w)/.test(t));
  if (stat) {
    return {
      status: 'unsupported',
      reason: `the Podfile sets static linkage (\`:linkage => :static\`), but React Native Firebase needs dynamic frameworks. ${MANUAL_STEP}`,
    };
  }
  const unknown = calls.find(({ text: t }) => !dynamic(t));
  if (unknown) {
    return {
      status: 'unsupported',
      reason: `the Podfile calls use_frameworks! with a linkage the wizard cannot read. ${MANUAL_STEP}`,
    };
  }
  if (calls.length > 0) return { status: 'already' };

  const targets = code.filter(({ text: t }) => /^target\s+(['"]).+\1\s+do\s*(?:#.*)?$/.test(t));
  if (targets.length !== 1) {
    return {
      status: 'unsupported',
      reason:
        (targets.length === 0
          ? 'the Podfile has no top-level `target \'...\' do` block for the app'
          : 'the Podfile has more than one top-level target, so the wizard cannot tell which is the app') + `. ${MANUAL_STEP}`,
    };
  }
  const targetAt = targets[0].i;
  const endAt = code.find(({ i, text: t }) => i > targetAt && /^end\b/.test(t));
  const limit = endAt ? endAt.i : lines.length;
  const anchor = code.find(({ i, text: t }) => i > targetAt && i < limit && /^\s*use_react_native!(?:\s*\(|\s|$)/.test(t));
  if (!anchor) {
    return { status: 'unsupported', reason: `the app target does not call \`use_react_native!\`. ${MANUAL_STEP}` };
  }

  const indent = indentOf(lines[anchor.i].text);
  insertAfter(lines, anchor.i - 1, [`${indent}${BEGIN}`, `${indent}${LINE}`, `${indent}${END}`]);
  return { status: 'patched', text: renderLines(lines) };
}

module.exports = { podfile, MANUAL_STEP };
