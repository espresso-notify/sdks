'use strict';

/**
 * Looks at a folder and says what the setup wizard is dealing with. It only reads: nothing is created, changed or removed.
 *
 *   kind            'expo' (`expo` is a dependency: the Expo flow), 'bare' (`react-native` and no `expo`) or 'none'
 *   reactNative     the version of React Native: the installed one, else the one the range in package.json names
 *   packageManager  from the lock file: yarn, pnpm, bun or npm (npm when there is none)
 *   hasIos/hasAndroid, appName and the five native files the patchers read (a path, or null when the file is not there)
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

/** Lock files in priority order, the manager they belong to. With two, the first one wins and the wizard warns. */
const LOCKS = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'package-lock.json', manager: 'npm' },
];

/** JSON.parse that accepts a byte order mark. */
const parseJson = (text) => JSON.parse(String(text).replace(/^﻿/, ''));

/**
 * The React Native version a range from package.json names, or `null` when it does not name one: `^0.79.7`, `0.87.1`,
 * `~0.80.0`, `0.79.x`, `^0.81` and `v0.82.1` do; `latest`, `>=0.79.0`, `file:...`, `npm:...` and tags do not.
 * @param {unknown} range
 * @returns {{ major: number, minor: number, patch: number | null, version: string, source: 'range' } | null}
 */
function reactNativeFromRange(range) {
  const match = /^[\^~=]?\s*v?(\d+)\.(\d+)(?:\.(\d+|[xX*]))?(?:-[\w.]+)?$/.exec(String(range || '').trim());
  if (!match) return null;
  const patch = match[3] !== undefined && /^\d+$/.test(match[3]) ? parseInt(match[3], 10) : null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch,
    version: String(range).trim(),
    source: 'range',
  };
}

/** The version of the installed `react-native`, or `null` when it is not installed or unreadable. */
function installedReactNative(cwd, fsApi, pathApi) {
  try {
    const installed = parseJson(fsApi.readFileSync(pathApi.join(cwd, 'node_modules', 'react-native', 'package.json'), 'utf8'));
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(installed.version));
    if (!match) return null;
    return {
      major: parseInt(match[1], 10),
      minor: parseInt(match[2], 10),
      patch: parseInt(match[3], 10),
      version: String(installed.version),
      source: 'installed',
    };
  } catch (_) {
    return null;
  }
}

function isFile(fsApi, file) {
  try {
    return fsApi.statSync(file).isFile();
  } catch (_) {
    return false;
  }
}

/** The entries of a folder as `{ name, directory }`; empty when it cannot be read. */
function listFolder(fsApi, dir) {
  try {
    return fsApi.readdirSync(dir, { withFileTypes: true }).map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
  } catch (_) {
    return [];
  }
}

const isDirectory = (fsApi, dir) => {
  try {
    return fsApi.statSync(dir).isDirectory();
  } catch (_) {
    return false;
  }
};

/** The name of the app: the `ios/<Name>.xcodeproj` folder (not Pods), else `name` of `app.json`, else `null`. */
function findAppName(cwd, iosEntries, fsApi, pathApi) {
  const projects = iosEntries
    .filter((entry) => entry.directory && entry.name.endsWith('.xcodeproj') && entry.name !== 'Pods.xcodeproj')
    .map((entry) => entry.name.slice(0, -'.xcodeproj'.length))
    .sort();
  if (projects.length > 0) return projects[0];
  try {
    const appJson = parseJson(fsApi.readFileSync(pathApi.join(cwd, 'app.json'), 'utf8'));
    if (appJson && typeof appJson.name === 'string' && appJson.name.trim()) return appJson.name.trim();
  } catch (_) {
    // no app.json, or not JSON
  }
  return null;
}

/** `AppDelegate.swift` or `AppDelegate.mm` of the app: in the folder named like the app, else the only one under ios/. */
function findAppDelegate(iosDir, iosEntries, appName, fsApi, pathApi) {
  const inFolder = (folder) => {
    for (const name of ['AppDelegate.swift', 'AppDelegate.mm']) {
      const file = pathApi.join(iosDir, folder, name);
      if (isFile(fsApi, file)) return file;
    }
    return null;
  };
  if (appName) {
    const named = inFolder(appName);
    if (named) return named;
  }
  const found = iosEntries
    .filter((entry) => entry.directory && !/^(Pods|build|DerivedData)$/.test(entry.name) && !entry.name.endsWith('.xcodeproj') && !entry.name.endsWith('.xcworkspace'))
    .map((entry) => inFolder(entry.name))
    .filter(Boolean);
  return found.length === 1 ? found[0] : null;
}

/** A Gradle file: the Groovy one, else the Kotlin DSL one, else `null`. */
function findGradle(dir, fsApi, pathApi) {
  for (const name of ['build.gradle', 'build.gradle.kts']) {
    const file = pathApi.join(dir, name);
    if (isFile(fsApi, file)) return file;
  }
  return null;
}

/**
 * @param {string} cwd
 * @param {typeof import('node:fs')} [fsApi]
 * @param {typeof import('node:path')} [pathApi]
 */
function detectProject(cwd, fsApi = nodeFs, pathApi = nodePath) {
  const empty = {
    kind: 'none',
    packageJson: null,
    reactNative: null,
    packageManager: 'npm',
    warnings: [],
    hasIos: false,
    hasAndroid: false,
    appName: null,
    files: { podfile: null, gradleProject: null, gradleApp: null, appDelegate: null, manifest: null },
  };

  let pkg;
  try {
    pkg = parseJson(fsApi.readFileSync(pathApi.join(cwd, 'package.json'), 'utf8'));
  } catch (error) {
    return { ...empty, reason: error && error.code === 'ENOENT' ? 'no-package-json' : 'unreadable-package-json' };
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return { ...empty, reason: 'unreadable-package-json' };

  const deps = { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) };
  if (deps.expo) return { ...empty, kind: 'expo', packageJson: pkg };
  if (!deps['react-native']) return { ...empty, packageJson: pkg, reason: 'no-react-native' };

  const reactNative = installedReactNative(cwd, fsApi, pathApi) || reactNativeFromRange(deps['react-native']);

  const locks = LOCKS.filter((lock) => isFile(fsApi, pathApi.join(cwd, lock.file)));
  const warnings = [];
  if (locks.length > 1) {
    const names = locks.map((lock) => lock.file).join(' and ');
    warnings.push(`${names} are both here; using ${locks[0].manager} (${locks[0].file}). Delete the lock file you do not use.`);
  }

  const iosDir = pathApi.join(cwd, 'ios');
  const androidDir = pathApi.join(cwd, 'android');
  const hasIos = isDirectory(fsApi, iosDir);
  const hasAndroid = isDirectory(fsApi, androidDir);
  const iosEntries = hasIos ? listFolder(fsApi, iosDir) : [];
  const appName = findAppName(cwd, iosEntries, fsApi, pathApi);

  const pick = (file) => (isFile(fsApi, file) ? file : null);
  const files = {
    podfile: hasIos ? pick(pathApi.join(iosDir, 'Podfile')) : null,
    appDelegate: hasIos ? findAppDelegate(iosDir, iosEntries, appName, fsApi, pathApi) : null,
    gradleProject: hasAndroid ? findGradle(androidDir, fsApi, pathApi) : null,
    gradleApp: hasAndroid ? findGradle(pathApi.join(androidDir, 'app'), fsApi, pathApi) : null,
    manifest: hasAndroid ? pick(pathApi.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml')) : null,
  };

  return {
    kind: 'bare',
    packageJson: pkg,
    reactNative,
    packageManager: locks.length > 0 ? locks[0].manager : 'npm',
    warnings,
    hasIos,
    hasAndroid,
    appName,
    files,
  };
}

module.exports = { detectProject, reactNativeFromRange, LOCKS };
