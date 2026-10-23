/**
 * @jest-environment node
 *
 * sdk-private-transport T18 (SPT-24): the SDK uses the native module only when it is present and speaks a contract
 * version the SDK lists. A module of another version, a module without `getConstants`, and an environment where
 * `react-native` cannot be loaded all give "no module", and the client then falls back to `fetch`.
 */
import { SUPPORTED_CONTRACTS, resolveNativeModule } from '../src/transport';

const MODULE_NAME = 'EspressoNotifyTransport';

function mockReactNative(factory: () => unknown) {
  jest.resetModules();
  jest.doMock('react-native', factory as () => object, { virtual: true });
}

afterEach(() => {
  jest.dontMock('react-native');
  jest.resetModules();
});

/** `resolveNativeModule` of a fresh copy of the file, so the mock of `react-native` of this test is the one it loads. */
function resolve(): ReturnType<typeof resolveNativeModule> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../src/transport').resolveNativeModule();
}

const goodModule = (contractVersion: number) => ({
  getConstants: () => ({ contractVersion }),
  request: jest.fn(),
  setPins: jest.fn(),
  clearPins: jest.fn(),
});

describe('resolveNativeModule (SPT-24)', () => {
  it('supports contract version 1 only', () => {
    expect(SUPPORTED_CONTRACTS).toEqual([1]);
  });

  it('asks the TurboModule registry for EspressoNotifyTransport and returns the module of version 1', () => {
    const mod = goodModule(1);
    const get = jest.fn((name: string) => (name === MODULE_NAME ? mod : null));
    mockReactNative(() => ({ TurboModuleRegistry: { get } }));
    expect(resolve()).toBe(mod);
    expect(get).toHaveBeenCalledWith(MODULE_NAME);
  });

  it('falls back to NativeModules when the registry has no such module (the old architecture)', () => {
    const mod = goodModule(1);
    mockReactNative(() => ({ TurboModuleRegistry: { get: () => null }, NativeModules: { [MODULE_NAME]: mod } }));
    expect(resolve()).toBe(mod);
  });

  it('gives null for a module of contract version 2', () => {
    mockReactNative(() => ({ TurboModuleRegistry: { get: () => goodModule(2) } }));
    expect(resolve()).toBeNull();
  });

  it('gives null for a version that is not a number', () => {
    mockReactNative(() => ({ TurboModuleRegistry: { get: () => goodModule('1' as unknown as number) } }));
    expect(resolve()).toBeNull();
  });

  it('gives null for a module without getConstants', () => {
    mockReactNative(() => ({ TurboModuleRegistry: { get: () => ({ request: jest.fn(), setPins: jest.fn(), clearPins: jest.fn() }) } }));
    expect(resolve()).toBeNull();
  });

  it('gives null for a module without request', () => {
    mockReactNative(() => ({ TurboModuleRegistry: { get: () => ({ getConstants: () => ({ contractVersion: 1 }) }) } }));
    expect(resolve()).toBeNull();
  });

  it('gives null when getConstants throws', () => {
    mockReactNative(() => ({
      TurboModuleRegistry: { get: () => ({ ...goodModule(1), getConstants: () => { throw new Error('native crash'); } }) },
    }));
    expect(resolve()).toBeNull();
  });

  it('gives null when no module is registered', () => {
    mockReactNative(() => ({ TurboModuleRegistry: { get: () => null }, NativeModules: {} }));
    expect(resolve()).toBeNull();
  });

  it('gives null when react-native cannot be loaded', () => {
    mockReactNative(() => {
      throw new Error('Cannot find module react-native');
    });
    expect(resolve()).toBeNull();
  });

  it('gives null where react-native is absent, as in the tests and on the web', () => {
    jest.resetModules();
    expect(resolveNativeModule()).toBeNull();
  });
});
