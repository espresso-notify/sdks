'use strict';

/**
 * Espresso Notify Expo Config Plugin
 * Applies native push configuration during `npx expo prebuild` / EAS Build.
 *
 * Pure helper functions are exported so they can be unit-tested without
 * running the full Expo mod pipeline.
 */

// ---------------------------------------------------------------------------
// Pure helpers — no @expo/config-plugins dependency
// ---------------------------------------------------------------------------

/**
 * Sets the `aps-environment` entitlement value in the iOS entitlements plist.
 * @param {Record<string, unknown>} entitlements - The current entitlements object.
 * @param {'development' | 'production'} apsEnvironment - The target environment.
 * @returns {Record<string, unknown>} The mutated entitlements object.
 */
function setApsEnvironment(entitlements, apsEnvironment) {
  entitlements['aps-environment'] = apsEnvironment;
  return entitlements;
}

/**
 * Adds `remote-notification` to the `UIBackgroundModes` array in Info.plist.
 * Idempotent — safe to call multiple times.
 * @param {Record<string, unknown>} infoPlist - The current Info.plist object.
 * @returns {Record<string, unknown>} The mutated Info.plist object.
 */
function addRemoteNotificationBackgroundMode(infoPlist) {
  if (!Array.isArray(infoPlist.UIBackgroundModes)) {
    infoPlist.UIBackgroundModes = [];
  }
  if (!infoPlist.UIBackgroundModes.includes('remote-notification')) {
    infoPlist.UIBackgroundModes.push('remote-notification');
  }
  return infoPlist;
}

/**
 * Ensures `android.permission.POST_NOTIFICATIONS` is present in the
 * AndroidManifest uses-permission list.
 * Idempotent — safe to call multiple times, will not duplicate the entry.
 *
 * @param {{ manifest: { 'uses-permission'?: Array<{ $: { 'android:name': string } }> } }} androidManifest
 * @returns {typeof androidManifest} The mutated manifest object.
 */
function addPostNotificationsPermission(androidManifest) {
  const PERMISSION_NAME = 'android.permission.POST_NOTIFICATIONS';
  const manifest = androidManifest.manifest;

  if (!Array.isArray(manifest['uses-permission'])) {
    manifest['uses-permission'] = [];
  }

  const alreadyExists = manifest['uses-permission'].some(
    (perm) => perm.$ && perm.$['android:name'] === PERMISSION_NAME,
  );

  if (!alreadyExists) {
    manifest['uses-permission'].push({
      $: { 'android:name': PERMISSION_NAME },
    });
  }

  return androidManifest;
}

// ---------------------------------------------------------------------------
// Config plugin API
// ---------------------------------------------------------------------------

/**
 * The Expo config plugin API. `expo/config-plugins` is the entry point Expo asks
 * plugins to use (every Expo app has `expo`); `@expo/config-plugins` is the older
 * way to the same functions, kept as a fallback. The package declares neither as
 * a dependency: the plugin only runs inside an Expo project's prebuild.
 */
function loadConfigPlugins() {
  try {
    return require('expo/config-plugins');
  } catch (_) {
    // not found, or not loadable: try the older entry point
  }
  try {
    return require('@expo/config-plugins');
  } catch (_) {
    throw new Error(
      '[espresso-notify] The Expo config plugin needs the `expo` package (it provides `expo/config-plugins`). ' +
      'Run it from an Expo project, or install `expo`.',
    );
  }
}

// ---------------------------------------------------------------------------
// The expo-notifications config plugin
// ---------------------------------------------------------------------------

const EXPO_NOTIFICATIONS = 'expo-notifications';
const EXPO_NOTIFICATIONS_PLUGIN = 'expo-notifications/app.plugin';

/**
 * True when the app lists `expo-notifications` in its `plugins`, as a string or as a
 * `[name, options]` pair (also its `expo-notifications/...` subpaths).
 * @param {unknown} plugins - The `plugins` array of the Expo config.
 * @returns {boolean}
 */
function isExpoNotificationsListed(plugins) {
  if (!Array.isArray(plugins)) return false;
  return plugins.some((entry) => {
    const name = Array.isArray(entry) ? entry[0] : entry;
    return typeof name === 'string' &&
      (name === EXPO_NOTIFICATIONS || name.startsWith(EXPO_NOTIFICATIONS + '/'));
  });
}

/** True when `err` says that `moduleName` itself could not be found (not a module the plugin needs). */
function isModuleMissing(err, moduleName) {
  if (!err || err.code !== 'MODULE_NOT_FOUND') return false;
  const firstLine = String(err.message || '').split('\n')[0];
  return firstLine.includes("'" + moduleName + "'");
}

/**
 * Loads the config plugin function of `expo-notifications`. The plain `require` works when
 * the package sits next to this file; with the SDK linked (`file:`) the Node resolution
 * starts at the real SDK folder and misses the app's `node_modules`, so the project root
 * of the app (else the working directory) is tried as well. Throws an `[espresso-notify]` error that
 * says how to install the package when it is not there; any other error passes through.
 * @param {{ _internal?: { projectRoot?: string } }} config
 * @returns {(config: object, props?: object) => object}
 */
function loadExpoNotificationsPlugin(config) {
  let mod;
  try {
    mod = require(EXPO_NOTIFICATIONS_PLUGIN);
  } catch (err) {
    if (!isModuleMissing(err, EXPO_NOTIFICATIONS_PLUGIN)) throw err;
    // Expo sets `_internal.projectRoot` while it evaluates the plugins of the app.
    const projectRoot = config && config._internal && config._internal.projectRoot;
    const paths = [typeof projectRoot === 'string' && projectRoot ? projectRoot : process.cwd()];
    try {
      mod = require(require.resolve(EXPO_NOTIFICATIONS_PLUGIN, { paths }));
    } catch (err2) {
      if (!isModuleMissing(err2, EXPO_NOTIFICATIONS_PLUGIN)) throw err2;
      throw new Error(
        '[espresso-notify] The package `expo-notifications` is not installed. The Espresso Notify plugin applies ' +
        'its config plugin for you. Run `npx expo install expo-notifications` and prebuild again.',
      );
    }
  }
  const plugin = typeof mod === 'function' ? mod : mod && mod.default;
  if (typeof plugin !== 'function') {
    throw new Error(
      '[espresso-notify] `expo-notifications/app.plugin` does not export a config plugin. ' +
      'Run `npx expo install expo-notifications` to get a version that does.',
    );
  }
  return plugin;
}

// ---------------------------------------------------------------------------
// Main config plugin
// ---------------------------------------------------------------------------

/**
 * Espresso Notify config plugin.
 *
 * @param {import('@expo/config-plugins').ExpoConfig} config
 * @param {{
 *   apsEnvironment?: 'development' | 'production'; // default 'development', only when no aps-environment is set yet
 *   enableBackgroundRemoteNotifications?: boolean;
 *   androidPostNotifications?: boolean;
 *   notifications?: Record<string, unknown>; // options of the expo-notifications plugin (icon, color, sounds...)
 * }} [options]
 * @returns {import('@expo/config-plugins').ExpoConfig}
 */
function withEspressoNotify(config, options) {
  // Lazy-load so that the pure helpers work without the Expo config plugin API present
  const {
    withAndroidManifest,
    withEntitlementsPlist,
    withInfoPlist,
  } = loadConfigPlugins();

  const {
    apsEnvironment = 'development',
    enableBackgroundRemoteNotifications = true,
    androidPostNotifications = true,
    notifications,
  } = options || {};

  if (
    notifications !== undefined &&
    (notifications === null || typeof notifications !== 'object' || Array.isArray(notifications))
  ) {
    throw new Error(
      '[espresso-notify] The `notifications` option must be an object: the options of the `expo-notifications` plugin ' +
      '(icon, color, sounds...).',
    );
  }

  // The expo-notifications plugin is applied last. A mod added later runs first, so the
  // aps-environment of that plugin (its `mode` option, else development) is written before
  // ours looks at it. An app that lists expo-notifications itself keeps its own plugin and
  // options: a second use would be dropped (it runs once) and would hide the app's options.
  const listedByApp = isExpoNotificationsListed(config && config.plugins);
  let applyExpoNotifications = null;
  if (listedByApp) {
    if (notifications !== undefined) {
      console.warn(
        '[espresso-notify] The app lists `expo-notifications` in `plugins`, so the `notifications` option of the ' +
        'Espresso Notify plugin is ignored. Put those options on the `expo-notifications` entry.',
      );
    }
  } else {
    applyExpoNotifications = loadExpoNotificationsPlugin(config);
  }

  // --- Android ---
  if (androidPostNotifications) {
    config = withAndroidManifest(config, (c) => {
      c.modResults = addPostNotificationsPermission(c.modResults);
      return c;
    });
  }

  // --- iOS entitlements ---
  // A value the app set itself (it passed `apsEnvironment`) always wins. Without one, an
  // `aps-environment` that another plugin or the app already wrote is left as it is; only a
  // missing one gets the default.
  //
  // An app that lists `expo-notifications` itself, and passed no `apsEnvironment`, gets the value that plugin writes
  // (its `mode`, else development), so this plugin registers no entitlements mod then. Mods run after every plugin has
  // been applied and the last one added runs first: when the app lists `expo-notifications` BEFORE this plugin, our
  // mod would run first, write the default, and `expo-notifications` (which keeps a value that is already set) would
  // lose its `mode`. `expo install` and the setup wizard add this plugin last, so that is the order they produce.
  const apsEnvironmentWasPassed = !!options && options.apsEnvironment !== undefined;
  if (apsEnvironmentWasPassed || !listedByApp) {
    config = withEntitlementsPlist(config, (c) => {
      if (!apsEnvironmentWasPassed && c.modResults['aps-environment']) {
        return c;
      }
      c.modResults = setApsEnvironment(c.modResults, apsEnvironment);
      return c;
    });
  }

  // --- iOS Info.plist ---
  if (enableBackgroundRemoteNotifications) {
    config = withInfoPlist(config, (c) => {
      c.modResults = addRemoteNotificationBackgroundMode(c.modResults);
      return c;
    });
  }

  // --- expo-notifications ---
  if (applyExpoNotifications) {
    config = applyExpoNotifications(config, notifications);
  }

  return config;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = withEspressoNotify;
module.exports.withEspressoNotify = withEspressoNotify;
module.exports.setApsEnvironment = setApsEnvironment;
module.exports.addRemoteNotificationBackgroundMode = addRemoteNotificationBackgroundMode;
module.exports.addPostNotificationsPermission = addPostNotificationsPermission;
module.exports.isExpoNotificationsListed = isExpoNotificationsListed;
