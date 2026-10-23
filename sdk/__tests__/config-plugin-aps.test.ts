/**
 * @jest-environment node
 *
 * rn-sdk-v1-calls T14 (RNV-24): the plugin does not overwrite an aps-environment it did not set.
 */

/** Runs withEspressoNotify with a fake mod API and returns the entitlements it leaves. */
function entitlementsAfter(existing: Record<string, unknown>, options?: Record<string, unknown>) {
  jest.resetModules();
  let result: Record<string, unknown> = existing;
  jest.doMock(
    'expo/config-plugins',
    () => ({
      withAndroidManifest: (config: any) => config,
      withInfoPlist: (config: any) => config,
      withEntitlementsPlist: (config: any, cb: (c: any) => any) => {
        const c = cb({ modResults: existing });
        result = c.modResults;
        return config;
      },
    }),
    { virtual: true },
  );
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../app.plugin.js')({ name: 'app' }, options);
  return result;
}

describe('aps-environment of the config plugin (RNV-24)', () => {
  it('keeps an aps-environment that is already there when the app passed no apsEnvironment', () => {
    expect(entitlementsAfter({ 'aps-environment': 'production' })['aps-environment']).toBe('production');
    expect(entitlementsAfter({ 'aps-environment': 'production' }, {})['aps-environment']).toBe('production');
  });

  it('sets development when nothing is there and the app passed nothing', () => {
    expect(entitlementsAfter({})['aps-environment']).toBe('development');
    expect(entitlementsAfter({}, {})['aps-environment']).toBe('development');
  });

  it('sets the value the app passed, over an existing one', () => {
    expect(entitlementsAfter({ 'aps-environment': 'development' }, { apsEnvironment: 'production' })['aps-environment']).toBe('production');
    expect(entitlementsAfter({ 'aps-environment': 'production' }, { apsEnvironment: 'development' })['aps-environment']).toBe('development');
    expect(entitlementsAfter({}, { apsEnvironment: 'production' })['aps-environment']).toBe('production');
  });

  it('leaves the other entitlements alone', () => {
    const out = entitlementsAfter({ 'com.apple.developer.associated-domains': ['applinks:x.com'] });
    expect(out['com.apple.developer.associated-domains']).toEqual(['applinks:x.com']);
    expect(out['aps-environment']).toBe('development');
  });
});

// A module, so that its top-level names do not clash with the other test files that are scripts.
export {}
