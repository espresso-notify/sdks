/**
 * @jest-environment node
 *
 * Tests for #810 (SDK-RN-10): Expo config plugin (app.plugin.js).
 *
 * These tests exercise the PURE helper functions directly without requiring
 * the full Expo mod pipeline.  The withEspressoNotify function itself is
 * smoke-tested for type only.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require('../app.plugin.js');

const {
  withEspressoNotify,
  setApsEnvironment,
  addRemoteNotificationBackgroundMode,
  addPostNotificationsPermission,
} = plugin;

// ---------------------------------------------------------------------------
// Export shape
// ---------------------------------------------------------------------------
describe('app.plugin.js module exports', () => {
  it('default export is a function (withEspressoNotify)', () => {
    expect(typeof plugin).toBe('function');
  });

  it('withEspressoNotify named export is a function', () => {
    expect(typeof withEspressoNotify).toBe('function');
  });

  it('setApsEnvironment is exported', () => {
    expect(typeof setApsEnvironment).toBe('function');
  });

  it('addRemoteNotificationBackgroundMode is exported', () => {
    expect(typeof addRemoteNotificationBackgroundMode).toBe('function');
  });

  it('addPostNotificationsPermission is exported', () => {
    expect(typeof addPostNotificationsPermission).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// setApsEnvironment
// ---------------------------------------------------------------------------
describe('setApsEnvironment', () => {
  it('sets aps-environment to production', () => {
    const result = setApsEnvironment({}, 'production');
    expect(result).toEqual({ 'aps-environment': 'production' });
  });

  it('sets aps-environment to development', () => {
    const result = setApsEnvironment({}, 'development');
    expect(result).toEqual({ 'aps-environment': 'development' });
  });

  it('overwrites an existing value', () => {
    const entitlements = { 'aps-environment': 'development' };
    const result = setApsEnvironment(entitlements, 'production');
    expect(result['aps-environment']).toBe('production');
  });

  it('preserves other entitlement keys', () => {
    const entitlements = { 'com.apple.developer.associated-domains': ['applinks:example.com'] };
    const result = setApsEnvironment(entitlements, 'production');
    expect(result['com.apple.developer.associated-domains']).toEqual(['applinks:example.com']);
    expect(result['aps-environment']).toBe('production');
  });

  it('mutates and returns the same object reference', () => {
    const entitlements: Record<string, unknown> = {};
    const result = setApsEnvironment(entitlements, 'development');
    expect(result).toBe(entitlements);
  });
});

// ---------------------------------------------------------------------------
// addRemoteNotificationBackgroundMode
// ---------------------------------------------------------------------------
describe('addRemoteNotificationBackgroundMode', () => {
  it('adds UIBackgroundModes with remote-notification when none existed', () => {
    const result = addRemoteNotificationBackgroundMode({});
    expect(result.UIBackgroundModes).toEqual(['remote-notification']);
  });

  it('appends remote-notification to an existing UIBackgroundModes array', () => {
    const infoPlist = { UIBackgroundModes: ['fetch'] };
    const result = addRemoteNotificationBackgroundMode(infoPlist);
    expect(result.UIBackgroundModes).toContain('fetch');
    expect(result.UIBackgroundModes).toContain('remote-notification');
  });

  it('is idempotent — does not duplicate remote-notification', () => {
    const infoPlist = { UIBackgroundModes: ['remote-notification'] };
    addRemoteNotificationBackgroundMode(infoPlist);
    addRemoteNotificationBackgroundMode(infoPlist);
    const count = infoPlist.UIBackgroundModes.filter(
      (m: string) => m === 'remote-notification',
    ).length;
    expect(count).toBe(1);
  });

  it('is idempotent when called on a fresh object twice', () => {
    const infoPlist = {};
    addRemoteNotificationBackgroundMode(infoPlist);
    addRemoteNotificationBackgroundMode(infoPlist);
    expect((infoPlist as Record<string, unknown[]>).UIBackgroundModes.length).toBe(1);
  });

  it('mutates and returns the same object reference', () => {
    const infoPlist: Record<string, unknown> = {};
    const result = addRemoteNotificationBackgroundMode(infoPlist);
    expect(result).toBe(infoPlist);
  });
});

// ---------------------------------------------------------------------------
// addPostNotificationsPermission
// ---------------------------------------------------------------------------
describe('addPostNotificationsPermission', () => {
  const PERM = 'android.permission.POST_NOTIFICATIONS';

  it('adds permission when manifest has no uses-permission array', () => {
    const manifest = { manifest: {} };
    const result = addPostNotificationsPermission(manifest);
    const perms: Array<{ $: { 'android:name': string } }> =
      result.manifest['uses-permission'];
    expect(perms).toBeDefined();
    expect(perms.some((p) => p.$['android:name'] === PERM)).toBe(true);
  });

  it('adds permission to an existing uses-permission array', () => {
    const manifest = {
      manifest: {
        'uses-permission': [
          { $: { 'android:name': 'android.permission.INTERNET' } },
        ],
      },
    };
    const result = addPostNotificationsPermission(manifest);
    const perms: Array<{ $: { 'android:name': string } }> =
      result.manifest['uses-permission'];
    expect(perms.some((p) => p.$['android:name'] === PERM)).toBe(true);
  });

  it('preserves existing permissions', () => {
    const existingPerm = 'android.permission.INTERNET';
    const manifest = {
      manifest: {
        'uses-permission': [{ $: { 'android:name': existingPerm } }],
      },
    };
    addPostNotificationsPermission(manifest);
    const perms: Array<{ $: { 'android:name': string } }> =
      manifest.manifest['uses-permission'];
    expect(perms.some((p) => p.$['android:name'] === existingPerm)).toBe(true);
  });

  it('is idempotent — does not duplicate the permission', () => {
    const manifest: { manifest: Record<string, unknown> } = { manifest: {} };
    addPostNotificationsPermission(manifest);
    addPostNotificationsPermission(manifest);
    const perms = manifest.manifest['uses-permission'] as Array<{ $: { 'android:name': string } }>;
    const count = perms.filter((p) => p.$['android:name'] === PERM).length;
    expect(count).toBe(1);
  });

  it('is idempotent when permission already present from the start', () => {
    const manifest = {
      manifest: {
        'uses-permission': [{ $: { 'android:name': PERM } }],
      },
    };
    addPostNotificationsPermission(manifest);
    const perms: Array<{ $: { 'android:name': string } }> =
      manifest.manifest['uses-permission'];
    const count = perms.filter((p) => p.$['android:name'] === PERM).length;
    expect(count).toBe(1);
  });

  it('mutates and returns the same object reference', () => {
    const manifest = { manifest: {} };
    const result = addPostNotificationsPermission(manifest);
    expect(result).toBe(manifest);
  });
});

// Torna o arquivo um módulo: sem isso o ts-jest o trata como script global e
// nomes de topo repetidos entre testes colidem (TS2451) em cache frio.
export {}
