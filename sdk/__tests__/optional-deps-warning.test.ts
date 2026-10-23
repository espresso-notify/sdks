/**
 * @jest-environment node
 *
 * expo-setup-simpler T2 (ES-02, ES-07): the SDK warns ONCE per app run, in development only,
 * when one of expo-device / expo-application / expo-localization is missing. It never throws.
 */

// A module, not a script: two test files that declare `ABSENT` in the global scope collide (TS2451) in a whole-suite run.
export {};

const ABSENT = () => {
  throw new Error('not found');
};

type Present = { device?: boolean; application?: boolean; localization?: boolean };

/** A fresh SDK module with expo-notifications present and the three optional packages as asked. */
function freshSdk(present: Present = {}) {
  jest.resetModules();
  jest.doMock('expo-notifications', () => ({}), { virtual: true });
  jest.doMock('expo-device', present.device ? () => ({ osVersion: '17.0' }) : ABSENT, { virtual: true });
  jest.doMock('expo-application', present.application ? () => ({ nativeApplicationVersion: '1.0.0' }) : ABSENT, { virtual: true });
  jest.doMock('expo-localization', present.localization ? () => ({}) : ABSENT, { virtual: true });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../src/index') as typeof import('../src/index');
}

const g = globalThis as any;
const originalEnv = process.env.NODE_ENV;
let warn: jest.SpyInstance;

beforeEach(() => {
  process.env.NODE_ENV = 'development'; // the SDK stays quiet under jest's own 'test'
  warn = jest.spyOn(console, 'warn').mockImplementation();
});

afterEach(() => {
  warn.mockRestore();
  process.env.NODE_ENV = originalEnv;
  delete g.__DEV__;
});

const sdkWarnings = () => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('[espresso-notify]') && m.includes('expo-'));

describe('optional Expo packages warning (ES-02)', () => {
  it('warns once, naming the packages and the fields lost, when __DEV__ is true', () => {
    g.__DEV__ = true;
    const { PushClient } = freshSdk();

    new PushClient({ projectId: 'pk_live_test-key' });

    const messages = sdkWarnings();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('expo-device');
    expect(messages[0]).toContain('expo-application');
    expect(messages[0]).toContain('expo-localization');
    expect(messages[0]).toContain('os_version');
    expect(messages[0]).toContain('app_version');
    expect(messages[0]).toContain('npx expo install');
  });

  it('warns only once per app run, however many clients are created', () => {
    g.__DEV__ = true;
    const { PushClient } = freshSdk();

    new PushClient({ projectId: 'pk_live_test-key' });
    new PushClient({ projectId: 'pk_live_test-key' });
    new PushClient({ projectId: 'pk_live_test-key' });

    expect(sdkWarnings()).toHaveLength(1);
  });

  it('names only the packages that are missing', () => {
    g.__DEV__ = true;
    const { PushClient } = freshSdk({ device: true, application: true });

    new PushClient({ projectId: 'pk_live_test-key' });

    const [message] = sdkWarnings();
    expect(message).toContain('expo-localization');
    expect(message).not.toContain('expo-device');
    expect(message).not.toContain('expo-application');
  });

  it('is silent when the three packages are installed', () => {
    g.__DEV__ = true;
    const { PushClient } = freshSdk({ device: true, application: true, localization: true });

    new PushClient({ projectId: 'pk_live_test-key' });

    expect(sdkWarnings()).toHaveLength(0);
  });

  it.each([['false', false], ['undefined', undefined]])('never warns when __DEV__ is %s (production build)', (_label, value) => {
    if (value !== undefined) g.__DEV__ = value;
    const { PushClient } = freshSdk();

    new PushClient({ projectId: 'pk_live_test-key' });

    expect(sdkWarnings()).toHaveLength(0);
  });

  it('does not throw when console.warn itself throws', () => {
    g.__DEV__ = true;
    warn.mockImplementation(() => {
      throw new Error('console is broken');
    });
    const { PushClient } = freshSdk();

    expect(() => new PushClient({ projectId: 'pk_live_test-key' })).not.toThrow();
  });
});

describe('expo-localization is singled out (ES-07)', () => {
  it('says that without it the time zone is not sent and what that costs', () => {
    g.__DEV__ = true;
    const { PushClient } = freshSdk({ device: true, application: true });

    new PushClient({ projectId: 'pk_live_test-key' });

    const [message] = sdkWarnings();
    expect(message).toMatch(/time zone/i);
    expect(message).toMatch(/best-hour/i);
    expect(message).toMatch(/quiet hours/i);
  });

  it('leaves that sentence out when expo-localization is installed', () => {
    g.__DEV__ = true;
    const { PushClient } = freshSdk({ localization: true });

    new PushClient({ projectId: 'pk_live_test-key' });

    const [message] = sdkWarnings();
    expect(message).toContain('expo-device');
    expect(message).not.toMatch(/time zone/i);
  });
});
