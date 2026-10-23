/**
 * @jest-environment node
 *
 * expo-setup-simpler T1 (ES-01): the Espresso config plugin applies the `expo-notifications`
 * config plugin itself, so the app lists only `@espresso-notify/react-native` in `plugins`.
 */

import * as os from 'os';

const absent = (name: string) => () => {
  const err: any = new Error(`Cannot find module '${name}'`);
  err.code = 'MODULE_NOT_FOUND';
  throw err;
};

/** A fake config-plugin API that runs every mod callback with an empty result. */
function fakeApi() {
  const pass = (name: string) => (config: any, cb: (c: any) => any) => {
    cb({ modResults: name === 'manifest' ? { manifest: {} } : {} });
    return config;
  };
  return {
    withAndroidManifest: pass('manifest'),
    withEntitlementsPlist: pass('entitlements'),
    withInfoPlist: pass('infoPlist'),
  };
}

/** Loads a fresh plugin with the fakes in place; `notifications` is what `expo-notifications/app.plugin` exports. */
function setup(notifications: unknown) {
  jest.resetModules();
  jest.doMock('expo/config-plugins', () => fakeApi(), { virtual: true });
  jest.doMock('expo-notifications/app.plugin', notifications as any, { virtual: true });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../app.plugin.js');
}

const ESPRESSO = '@espresso-notify/react-native';

describe('app.plugin.js applies expo-notifications (ES-01)', () => {
  it('applies the expo-notifications plugin once when the app lists only the Espresso plugin', () => {
    const applied = jest.fn((config: any, _props?: any) => ({ ...config, touchedByNotifications: true }));
    const plugin = setup(() => applied);

    const out = plugin({ name: 'app', plugins: [ESPRESSO] });

    expect(applied).toHaveBeenCalledTimes(1);
    expect(out.touchedByNotifications).toBe(true);
  });

  it('applies it when the app lists the Espresso plugin with options', () => {
    const applied = jest.fn((config: any, _props?: any) => config);
    const plugin = setup(() => applied);

    plugin({ name: 'app', plugins: [[ESPRESSO, { apsEnvironment: 'production' }]] }, { apsEnvironment: 'production' });

    expect(applied).toHaveBeenCalledTimes(1);
  });

  it('accepts a module that exports the plugin as `default`', () => {
    const applied = jest.fn((config: any, _props?: any) => config);
    const plugin = setup(() => ({ __esModule: true, default: applied }));

    plugin({ name: 'app' });

    expect(applied).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a string', 'expo-notifications'],
    ['a [name, options] pair', ['expo-notifications', { icon: './icon.png' }]],
    ['a subpath string', 'expo-notifications/app.plugin'],
  ])('does not apply it again when the app lists it as %s', (_label, entry) => {
    const applied = jest.fn((config: any, _props?: any) => config);
    const plugin = setup(() => applied);

    plugin({ name: 'app', plugins: [entry, ESPRESSO] });

    expect(applied).not.toHaveBeenCalled();
  });

  it('does not apply it again when the app lists it after the Espresso plugin', () => {
    const applied = jest.fn((config: any, _props?: any) => config);
    const plugin = setup(() => applied);

    plugin({ name: 'app', plugins: [ESPRESSO, 'expo-notifications'] });

    expect(applied).not.toHaveBeenCalled();
  });

  it('is not fooled by a different package whose name starts the same', () => {
    const applied = jest.fn((config: any, _props?: any) => config);
    const plugin = setup(() => applied);

    plugin({ name: 'app', plugins: ['expo-notifications-extras', ESPRESSO] });

    expect(applied).toHaveBeenCalledTimes(1);
  });
});

describe('the `notifications` option (ES-01)', () => {
  it('forwards it as the options of the expo-notifications plugin', () => {
    const applied = jest.fn((config: any, _props?: any) => config);
    const plugin = setup(() => applied);
    const notifications = { icon: './assets/n.png', color: '#ff7a00', sounds: ['./assets/ding.wav'] };

    plugin({ name: 'app', plugins: [ESPRESSO] }, { notifications });

    expect(applied).toHaveBeenCalledTimes(1);
    expect(applied.mock.calls[0][1]).toEqual(notifications);
  });

  it('does not pass the other Espresso options on to expo-notifications', () => {
    const applied = jest.fn((config: any, _props?: any) => config);
    const plugin = setup(() => applied);

    plugin({ name: 'app' }, { apsEnvironment: 'production', notifications: { color: '#fff' } });

    expect(applied.mock.calls[0][1]).toEqual({ color: '#fff' });
  });

  it('ignores it, with a warning, when the app lists expo-notifications itself', () => {
    const applied = jest.fn((config: any, _props?: any) => config);
    const plugin = setup(() => applied);
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    try {
      plugin({ name: 'app', plugins: ['expo-notifications', ESPRESSO] }, { notifications: { color: '#fff' } });
      expect(applied).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[espresso-notify\].*notifications/));
    } finally {
      warn.mockRestore();
    }
  });

  it.each([['a string', 'x'], ['an array', []], ['null', null], ['a number', 3]])(
    'fails the prebuild with an [espresso-notify] message when it is %s',
    (_label, value) => {
      const plugin = setup(() => (config: any) => config);

      expect(() => plugin({ name: 'app' }, { notifications: value })).toThrow(/\[espresso-notify\].*notifications/);
    },
  );
});

describe('expo-notifications is not installed (ES-01)', () => {
  it('fails the prebuild and says to run `npx expo install expo-notifications`', () => {
    jest.resetModules();
    jest.doMock('expo/config-plugins', () => fakeApi(), { virtual: true });
    jest.doMock('expo-notifications/app.plugin', absent('expo-notifications/app.plugin'), { virtual: true });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const plugin = require('../app.plugin.js');

    // the project root has no node_modules: the package is not there for the fallback lookup either
    const config = { name: 'app', plugins: [ESPRESSO], _internal: { projectRoot: os.tmpdir() } };

    expect(() => plugin(config)).toThrow(/\[espresso-notify\].*npx expo install expo-notifications/);
  });

  it('does not need the package when the app lists expo-notifications itself', () => {
    jest.resetModules();
    jest.doMock('expo/config-plugins', () => fakeApi(), { virtual: true });
    jest.doMock('expo-notifications/app.plugin', absent('expo-notifications/app.plugin'), { virtual: true });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const plugin = require('../app.plugin.js');

    expect(() => plugin({ name: 'app', plugins: ['expo-notifications', ESPRESSO] })).not.toThrow();
  });

  it('passes on an error from inside the expo-notifications plugin without turning it into the install message', () => {
    const plugin = setup(() => {
      throw new Error('boom from inside the plugin');
    });

    expect(() => plugin({ name: 'app' })).toThrow('boom from inside the plugin');
  });

  it('passes on a missing dependency of the expo-notifications plugin as it is', () => {
    const plugin = setup(absent('some-other-module'));

    expect(() => plugin({ name: 'app' })).toThrow("Cannot find module 'some-other-module'");
  });
});
