'use strict';

/**
 * The flow of the setup wizard for React Native CLI apps (no Expo). `bin/setup.js` decides the flow and calls `runBare`.
 *
 *   1. look at the project: React Native version (0.79 or newer), package manager, the native folders
 *   2. install `@espresso-notify/react-native`, `@react-native-firebase/app`, `@react-native-firebase/messaging` and
 *      `react-native-notify-kit` with the package manager of the project, the Firebase major chosen by the version table
 *   3. change the native files that fit in text (Podfile, the two Gradle files, the AppDelegate), each between markers,
 *      with a copy next to it; what the wizard does not recognize is left alone and its step is printed
 *
 * Exit codes: 0 done, nothing to do, or only steps left for you; 1 refused (not a React Native project, React Native below
 * 0.79 or unreadable, or a no at the confirmation); 2 the install or a write failed.
 *
 * Everything that touches the world comes in `io` (folder, `spawn`, streams, `platform`, `env`, optionally `fs`, `path` and
 * `now`), like the Expo flow, so the tests can fake it. No command line holds anything from the project: only constants and
 * the versions of the table, and `spawn` runs without a shell.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { detectProject } = require('./project.js');
const { applyPatch } = require('./patch.js');
const { podfile, MANUAL_STEP: PODFILE_STEP } = require('./patchers/podfile.js');
const { gradleProject, gradleApp, GOOGLE_SERVICES_VERSION } = require('./patchers/gradle.js');
const { appDelegate } = require('./patchers/appDelegate.js');
const { MIN_REACT_NATIVE_MINOR, firebaseMajorFor } = require('./versions.js');

const SDK_PACKAGE = '@espresso-notify/react-native';
const FIREBASE_APP = '@react-native-firebase/app';
const FIREBASE_MESSAGING = '@react-native-firebase/messaging';
const NOTIFY_KIT = 'react-native-notify-kit';
const PACKAGES = [SDK_PACKAGE, FIREBASE_APP, FIREBASE_MESSAGING, NOTIFY_KIT];

/** The command of each package manager; the manager the project uses picks a row, nothing else reaches the command. */
const MANAGERS = {
  npm: { command: 'npm', lead: ['install', '--'] },
  yarn: { command: 'yarn', lead: ['add'] },
  pnpm: { command: 'pnpm', lead: ['add'] },
  bun: { command: 'bun', lead: ['add'] },
};

// The command interpreter of Windows when the ComSpec variable is missing or is not an absolute path.
const WINDOWS_CMD = 'C:\\Windows\\System32\\cmd.exe';

/** The file and the arguments that run `file args` on `platform` (through `cmd.exe /d /s /c` on Windows, as the Expo flow does). */
function invocation(file, args, platform, env = process.env) {
  if (platform !== 'win32') return [file, args];
  const comspec = typeof env.ComSpec === 'string' ? env.ComSpec.trim() : '';
  const shell = comspec && nodePath.win32.isAbsolute(comspec) ? comspec : WINDOWS_CMD;
  return [shell, ['/d', '/s', '/c', file, ...args]];
}

/** The major a package is on: the installed version, else the range of package.json; `null` when neither names one. */
function declaredMajor(cwd, name, range, fsm, pathm) {
  try {
    const installed = JSON.parse(String(fsm.readFileSync(pathm.join(cwd, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).replace(/^﻿/, ''));
    const match = /^(\d+)\./.exec(String(installed.version));
    if (match) return { major: parseInt(match[1], 10), version: String(installed.version) };
  } catch (_) {
    // not installed: read the range
  }
  const match = /^[\^~=]?\s*v?(\d+)(?:\.|$)/.exec(String(range || '').trim());
  return match ? { major: parseInt(match[1], 10), version: String(range).trim() } : null;
}

/** The native files the wizard edits, in order. `step` is the instruction printed when the wizard leaves the file alone. */
const NATIVE_FILES = [
  { key: 'podfile', platform: 'ios', fallback: 'ios/Podfile', patcher: podfile, step: () => PODFILE_STEP },
  {
    key: 'gradleProject',
    platform: 'android',
    fallback: 'android/build.gradle',
    patcher: gradleProject,
    step: (rel) =>
      `Add \`classpath("com.google.gms:google-services:${GOOGLE_SERVICES_VERSION}")\` to the \`dependencies\` block inside \`buildscript\` in ${rel}.`,
  },
  {
    key: 'gradleApp',
    platform: 'android',
    fallback: 'android/app/build.gradle',
    patcher: gradleApp,
    step: (rel) => `Add \`apply plugin: 'com.google.gms.google-services'\` at the end of ${rel}.`,
  },
  {
    key: 'appDelegate',
    platform: 'ios',
    fallback: 'ios/<YourApp>/AppDelegate.swift',
    patcher: appDelegate,
    step: (rel) =>
      /\.mm?$/i.test(rel)
        ? `In ${rel} add \`#import <Firebase.h>\` and, at the start of \`application:didFinishLaunchingWithOptions:\`, ` +
          '`if ([[NSBundle mainBundle] pathForResource:@"GoogleService-Info" ofType:@"plist"]) { [FIRApp configure]; }`.'
        : `In ${rel} add \`import FirebaseCore\` and, at the start of \`application(_:didFinishLaunchingWithOptions:)\`, ` +
          '`if Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil { FirebaseApp.configure() }`.',
  },
];

/**
 * Runs the flow.
 * @param {{ dryRun: boolean, yes: boolean, key?: string, pods?: boolean }} options
 * @param {{ cwd: string, spawn: Function, stdout: {write: Function}, stderr: {write: Function}, stdin: object, isTTY: boolean, platform: string, env?: object, fs?: object, path?: object, now?: Function }} io
 * @param {{ makePrompter: Function, Stop: Function, installEnvironment: Function }} helpers from `bin/setup.js`
 * @returns {Promise<number>} the exit code
 */
async function runBare(options, io, helpers) {
  const { makePrompter, Stop, installEnvironment } = helpers;
  const out = (text = '') => io.stdout.write(text + '\n');
  const err = (text = '') => io.stderr.write(text + '\n');
  const fsm = io.fs || nodeFs;
  const pathm = io.path || nodePath;
  const interactive = io.isTTY && !options.yes && !options.dryRun;
  const prompter = interactive ? makePrompter(io.stdin, io.stdout) : null;
  const state = { changed: false, failed: false, manual: [], backups: [] };
  const display = (file, fallback) => (file ? pathm.relative(io.cwd, file).split(pathm.sep).join('/') : fallback);

  try {
    // 1. Look ---------------------------------------------------------------------------------------------------
    out('[1/6] Looking at the project');
    const project = detectProject(io.cwd, fsm, pathm);
    if (project.kind !== 'bare') {
      const why = {
        'no-package-json': 'There is no readable package.json here. Run the wizard from the root folder of your app.',
        'unreadable-package-json': 'There is no readable package.json here. Run the wizard from the root folder of your app.',
        'no-react-native': 'This is not a React Native project: `react-native` is not in package.json.',
      }[project.reason || ''];
      err(`[espresso-notify] ${why || 'This project uses Expo, which has its own setup flow.'}`);
      throw new Stop(1);
    }
    const rn = project.reactNative;
    if (!rn) {
      const range = (project.packageJson.devDependencies || {})['react-native'] || (project.packageJson.dependencies || {})['react-native'];
      err(
        `[espresso-notify] Could not tell the React Native version from "${range}". Run your package manager's install so that react-native is ` +
        'in node_modules (or write an exact version in package.json), then run the wizard again.',
      );
      throw new Stop(1);
    }
    const firebaseMajor = firebaseMajorFor(rn);
    if (firebaseMajor === null) {
      err(
        `[espresso-notify] This project is on React Native ${rn.version}. The SDK needs React Native 0.${MIN_REACT_NATIVE_MINOR} or newer. ` +
        'Upgrade first (https://reactnative.dev/docs/upgrading), then run the wizard again.',
      );
      throw new Stop(1);
    }
    out(`      React Native CLI project, React Native ${rn.version}${rn.source === 'installed' ? ' (installed)' : ' (from package.json)'}, ${project.packageManager}.`);
    for (const warning of project.warnings) out(`      ${warning}`);
    if (!project.hasIos) out('      There is no ios/ folder: the iOS steps are printed for you.');
    if (!project.hasAndroid) out('      There is no android/ folder: the Android steps are printed for you.');

    if (prompter) {
      const answer = (await prompter.ask('      Install the packages and change the native files? [Y/n] ')).trim().toLowerCase();
      if (answer && answer !== 'y' && answer !== 'yes') {
        err('[espresso-notify] Cancelled. Nothing was changed.');
        throw new Stop(1);
      }
    }

    // 2. Install ------------------------------------------------------------------------------------------------
    out('[2/6] Installing the packages');
    const deps = { ...(project.packageJson.devDependencies || {}), ...(project.packageJson.dependencies || {}) };
    for (const name of [FIREBASE_APP, FIREBASE_MESSAGING]) {
      if (!deps[name]) continue;
      const found = declaredMajor(io.cwd, name, deps[name], fsm, pathm);
      if (found && found.major !== firebaseMajor) {
        out(
          `      Warning: ${name} is on ${found.version}, and React Native ${rn.version} works with major ${firebaseMajor}. ` +
          'The wizard does not change it.',
        );
      }
    }
    const missing = PACKAGES.filter((name) => !deps[name]);
    const specs = missing.map((name) => (name === FIREBASE_APP || name === FIREBASE_MESSAGING ? `${name}@${firebaseMajor}` : name));
    const manager = MANAGERS[project.packageManager] || MANAGERS.npm;
    const installArgs = [...manager.lead, ...specs];
    const command = `${manager.command} ${installArgs.join(' ')}`;
    if (missing.length === 0) {
      out('      Already installed: nothing to do.');
    } else if (options.dryRun) {
      out(`      Would run: ${command}`);
    } else {
      out(`      Running: ${command}`);
      const code = await new Promise((resolve) => {
        let child;
        try {
          const [file, args] = invocation(manager.command, installArgs, io.platform, io.env);
          child = io.spawn(file, args, {
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
      if (code !== 0) {
        err(
          `[espresso-notify] The install did not finish${code instanceof Error ? ` (${code.message})` : ` (exit code ${code})`}. ` +
          `Run it yourself from the project folder, then run the wizard again:\n  ${command}`,
        );
        throw new Stop(2);
      }
      state.changed = true;
    }

    // 3. Native files -------------------------------------------------------------------------------------------
    out('[3/6] Changing the native files');
    const context = { appName: project.appName, reactNative: rn, googleServicesVersion: GOOGLE_SERVICES_VERSION };
    for (const spec of NATIVE_FILES) {
      const file = project.files[spec.key];
      const rel = display(file, spec.fallback);
      let result;
      if (!file) {
        const folder = spec.platform === 'ios' ? project.hasIos : project.hasAndroid;
        result = {
          status: 'missing',
          reason: folder ? `${rel} was not found` : `there is no ${spec.platform}/ folder`,
        };
      } else {
        result = applyPatch({ file, patcher: spec.patcher, context: { ...context, file }, dryRun: options.dryRun, now: io.now, fsApi: fsm });
      }
      if (result.warning) out(`      Warning (${rel}): ${result.warning}`);
      if (result.status === 'patched') {
        if (options.dryRun) {
          out(`      Would add to ${rel}:`);
          for (const line of result.preview || []) out(`        + ${line}`);
        } else {
          const copy = display(result.backup, '');
          out(`      ${rel}: added ${(result.preview || []).length} lines between espresso-notify markers. Copy of the original: ${copy}`);
          state.backups.push(copy);
          state.changed = true;
        }
      } else if (result.status === 'already') {
        out(`      ${rel}: already set up.`);
      } else if (result.status === 'error') {
        err(`[espresso-notify] ${rel}: ${result.reason}`);
        if (result.backup) state.backups.push(display(result.backup, ''));
        state.failed = true;
      } else {
        const step = spec.step(rel);
        out(`      ${rel}: left alone, ${result.reason}.`);
        if (!String(result.reason).includes(step)) out(`      By hand: ${step}`);
        state.manual.push(`${rel}: ${step}`);
      }
    }

    // The end ---------------------------------------------------------------------------------------------------
    out('');
    if (options.dryRun) {
      if (state.manual.length > 0) out(`${state.manual.length} native step${state.manual.length > 1 ? 's' : ''} would be left for you (see above).`);
      out('Dry run: nothing was changed.');
      return state.failed ? 2 : 0;
    }
    if (state.backups.length > 0) {
      out(`Copies of the original files are next to them (${state.backups.length}):`);
      for (const copy of state.backups) out(`  - ${copy}`);
      out('Check the changes, then delete the copies you do not need.');
    }
    if (state.failed) {
      out('Some steps did not finish. See the messages above.');
      return 2;
    }
    if (state.manual.length > 0) {
      const n = state.manual.length;
      out(`Finished what the wizard can do. ${n} native step${n > 1 ? 's are' : ' is'} left for you:`);
      for (const step of state.manual) out(`  - ${step}`);
    } else if (!state.changed) out('Nothing to change: this project is already set up.');
    else out('Done.');
    return 0;
  } catch (error) {
    if (error instanceof Stop) return error.code;
    err(`[espresso-notify] The wizard stopped: ${error && error.message ? error.message : error}`);
    return 2;
  } finally {
    if (prompter) prompter.close();
  }
}

module.exports = { runBare, PACKAGES, MANAGERS };
