/**
 * @jest-environment node
 *
 * rn-sdk-v1-calls T9 (RNV-28): the config plugin loads `expo/config-plugins`, else `@expo/config-plugins`.
 */

function fakeApi(tag: string, seen: string[]) {
  const pass = (name: string) => (config: any, cb: (c: any) => any) => {
    seen.push(`${tag}:${name}`);
    cb({ modResults: name === 'manifest' ? { manifest: {} } : {} });
    return config;
  };
  return {
    withAndroidManifest: pass('manifest'),
    withEntitlementsPlist: pass('entitlements'),
    withInfoPlist: pass('infoPlist'),
  };
}

function loadPlugin() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../app.plugin.js');
}

const absent = (name: string) => () => {
  const err: any = new Error(`Cannot find module '${name}'`);
  err.code = 'MODULE_NOT_FOUND';
  throw err;
};

describe('app.plugin.js config-plugins resolution (RNV-28)', () => {
  beforeEach(() => jest.resetModules());

  it('uses expo/config-plugins when it is present', () => {
    const seen: string[] = [];
    jest.doMock('expo/config-plugins', () => fakeApi('expo', seen), { virtual: true });
    jest.doMock('@expo/config-plugins', () => fakeApi('legacy', seen), { virtual: true });

    loadPlugin()({ name: 'app' });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.startsWith('expo:'))).toBe(true);
  });

  it('falls back to @expo/config-plugins when expo/config-plugins is absent', () => {
    const seen: string[] = [];
    jest.doMock('expo/config-plugins', absent('expo/config-plugins'), { virtual: true });
    jest.doMock('@expo/config-plugins', () => fakeApi('legacy', seen), { virtual: true });

    loadPlugin()({ name: 'app' });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.startsWith('legacy:'))).toBe(true);
  });

  it('says to install expo when neither module is present', () => {
    jest.doMock('expo/config-plugins', absent('expo/config-plugins'), { virtual: true });
    jest.doMock('@expo/config-plugins', absent('@expo/config-plugins'), { virtual: true });

    expect(() => loadPlugin()({ name: 'app' })).toThrow(/\[espresso-notify\].*expo/);
  });

  it('does not load either module when the pure helpers are imported', () => {
    jest.doMock('expo/config-plugins', absent('expo/config-plugins'), { virtual: true });
    jest.doMock('@expo/config-plugins', absent('@expo/config-plugins'), { virtual: true });

    expect(() => loadPlugin().setApsEnvironment({}, 'production')).not.toThrow();
  });
});

// A module, so that its top-level names do not clash with the other test files that are scripts.
export {}
