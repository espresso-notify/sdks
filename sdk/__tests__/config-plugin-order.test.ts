/**
 * @jest-environment node
 *
 * fix-d (G1 and G9 of the verification of expo-setup-simpler): the `aps-environment` that the app chose must win,
 * whatever the order of `plugins`; and the project-root lookup of `expo-notifications` has a test.
 *
 * The fake config-plugin API of the other tests runs a mod at once, so it cannot see the order. This one chains the
 * mods the way Expo does: they run after every plugin has been applied, and the LAST one added runs FIRST.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ESPRESSO = '@espresso-notify/react-native';
type Entitlements = Record<string, unknown>;

/** A config-plugin API whose entitlements mods run last-added-first on one shared plist. */
function chain() {
  const mods: Array<(c: { modResults: Entitlements }) => unknown> = [];
  const api = {
    withAndroidManifest: (config: any) => config,
    withInfoPlist: (config: any) => config,
    withEntitlementsPlist: (config: any, cb: (c: any) => any) => {
      mods.push(cb);
      return config;
    },
  };
  const run = (): Entitlements => {
    const c = { modResults: {} as Entitlements };
    for (const mod of [...mods].reverse()) mod(c);
    return c.modResults;
  };
  return { api, run };
}

/** The `expo-notifications` plugin as it really is: its `mode` (else development), only when nothing is set yet. */
function expoNotificationsPlugin(api: ReturnType<typeof chain>['api']) {
  return (config: any, props: { mode?: string } = {}) =>
    api.withEntitlementsPlist(config, (c: any) => {
      if (!c.modResults['aps-environment']) {
        c.modResults['aps-environment'] = props.mode === 'production' ? 'production' : 'development';
      }
      return c;
    });
}

type Entry = string | [string, Record<string, unknown>];

/** Applies the plugins of an app in the order it lists them, then runs the mods. */
function prebuild(plugins: Entry[], espressoOptions?: Record<string, unknown>): Entitlements {
  jest.resetModules();
  const { api, run } = chain();
  const notifications = expoNotificationsPlugin(api);
  jest.doMock('expo/config-plugins', () => api, { virtual: true });
  jest.doMock('expo-notifications/app.plugin', () => notifications, { virtual: true });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const espresso = require('../app.plugin.js');
  let config: any = { name: 'app', plugins };
  for (const entry of plugins) {
    const [name, props] = Array.isArray(entry) ? entry : [entry, undefined];
    if (name === 'expo-notifications') config = notifications(config, props as any);
    else if (name === ESPRESSO) config = espresso(config, espressoOptions ?? props);
  }
  return run();
}

describe('aps-environment, whatever the order of the plugins (G1)', () => {
  const production: Entry = ['expo-notifications', { mode: 'production' }];

  it('keeps the mode of the expo-notifications entry that the app lists BEFORE the Espresso plugin', () => {
    expect(prebuild([production, ESPRESSO])['aps-environment']).toBe('production');
  });

  it('keeps it when the app lists expo-notifications AFTER the Espresso plugin', () => {
    expect(prebuild([ESPRESSO, production])['aps-environment']).toBe('production');
  });

  it('writes development when the listed expo-notifications has no mode, in both orders', () => {
    expect(prebuild(['expo-notifications', ESPRESSO])['aps-environment']).toBe('development');
    expect(prebuild([ESPRESSO, 'expo-notifications'])['aps-environment']).toBe('development');
  });

  it('lets apsEnvironment, when the app passes it, win over the mode of expo-notifications in both orders', () => {
    const dev: Entry = ['expo-notifications', { mode: 'development' }];
    expect(prebuild([dev, [ESPRESSO, { apsEnvironment: 'production' }]])['aps-environment']).toBe('production');
    expect(prebuild([[ESPRESSO, { apsEnvironment: 'production' }], dev])['aps-environment']).toBe('production');
    expect(prebuild([production, [ESPRESSO, { apsEnvironment: 'development' }]])['aps-environment']).toBe('development');
  });

  it('still defaults to development, and honours apsEnvironment, when the app does not list expo-notifications', () => {
    expect(prebuild([ESPRESSO])['aps-environment']).toBe('development');
    expect(prebuild([[ESPRESSO, { apsEnvironment: 'production' }]])['aps-environment']).toBe('production');
  });

  it('uses the mode forwarded in the notifications option when the Espresso plugin applies expo-notifications', () => {
    expect(prebuild([[ESPRESSO, { notifications: { mode: 'production' } }]])['aps-environment']).toBe('production');
  });
});

describe('the project-root lookup of expo-notifications (G9)', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('finds the plugin in the node_modules of _internal.projectRoot when the plain require cannot', () => {
    const root = mkdtempSync(join(tmpdir(), 'espresso-root-'));
    dirs.push(root);
    mkdirSync(join(root, 'node_modules', 'expo-notifications'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'expo-notifications', 'package.json'), '{"name":"expo-notifications","version":"0.0.0"}');
    writeFileSync(
      join(root, 'node_modules', 'expo-notifications', 'app.plugin.js'),
      'module.exports = (config) => ({ ...config, foundFromProjectRoot: true });',
    );

    jest.resetModules();
    jest.doMock('expo/config-plugins', () => chain().api, { virtual: true });
    jest.doMock(
      'expo-notifications/app.plugin',
      () => {
        const err: any = new Error("Cannot find module 'expo-notifications/app.plugin'");
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      },
      { virtual: true },
    );
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const plugin = require('../app.plugin.js');

    const out = plugin({ name: 'app', plugins: [ESPRESSO], _internal: { projectRoot: root } });

    expect(out.foundFromProjectRoot).toBe(true);
  });
});
