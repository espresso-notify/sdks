/**
 * @jest-environment jsdom
 *
 * Unit tests for BareDisplayAdapter (#804 — bare React Native display adapter
 * backed by react-native-notify-kit). All native modules are virtual mocks —
 * no device required. Mirrors the bare-provider.test.ts style.
 */

type ForegroundCb = (event: { type: number; detail: any }) => void;

/** Build a react-native-notify-kit module mock. */
function makeNotifyKitModule(
  overrides: Partial<{
    onForegroundEvent: (cb: ForegroundCb) => () => void;
    getInitialNotification: () => Promise<any>;
    setNotificationCategories: (cats: any[]) => Promise<void>;
  }> = {},
) {
  const listeners: ForegroundCb[] = [];
  const unsubscribe = jest.fn();
  const instance = {
    onForegroundEvent: jest.fn((cb: ForegroundCb) => {
      listeners.push(cb);
      return unsubscribe;
    }),
    getInitialNotification: jest.fn().mockResolvedValue(null),
    setNotificationCategories: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return {
    default: instance,
    EventType: { PRESS: 1, ACTION_PRESS: 2, DISMISSED: 3, DELIVERED: 4 },
    _instance: instance,
    _listeners: listeners,
    _unsubscribe: unsubscribe,
  };
}

/** Mock so resolution picks the bare adapter: expo absent, notify-kit present. */
function mockBareEnv(nkMock: ReturnType<typeof makeNotifyKitModule>) {
  jest.doMock('react-native-notify-kit', () => nkMock, { virtual: true });
  jest.doMock('expo-notifications', () => { throw new Error('not found'); }, { virtual: true });
  jest.doMock('react-native', () => ({ Platform: { OS: 'android', Version: 30 } }), { virtual: true });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('BareDisplayAdapter.onResponse()', () => {
  beforeEach(() => jest.resetModules());

  it('maps a PRESS event to { notificationId }', () => {
    const nk = makeNotifyKitModule();
    mockBareEnv(nk);
    const { BareDisplayAdapter } = require('../src/index');

    const cb = jest.fn();
    new BareDisplayAdapter().onResponse(cb);
    nk._listeners[0]({ type: 1, detail: { notification: { data: { notificationId: 42 } } } });

    expect(cb).toHaveBeenCalledWith({ notificationId: 42 });
  });

  it('maps an ACTION_PRESS event to { notificationId, actionId }', () => {
    const nk = makeNotifyKitModule();
    mockBareEnv(nk);
    const { BareDisplayAdapter } = require('../src/index');

    const cb = jest.fn();
    new BareDisplayAdapter().onResponse(cb);
    nk._listeners[0]({
      type: 2,
      detail: { notification: { data: { notification_id: 7 } }, pressAction: { id: 'reply' } },
    });

    expect(cb).toHaveBeenCalledWith({ notificationId: 7, actionId: 'reply' });
  });

  it('fires the callback for a cold-start notification (getInitialNotification)', async () => {
    const nk = makeNotifyKitModule({
      getInitialNotification: jest
        .fn()
        .mockResolvedValue({ notification: { data: { notificationId: 99 } }, pressAction: { id: 'open' } }),
    });
    mockBareEnv(nk);
    const { BareDisplayAdapter } = require('../src/index');

    const cb = jest.fn();
    new BareDisplayAdapter().onResponse(cb);
    await flush();

    expect(cb).toHaveBeenCalledWith({ notificationId: 99, actionId: 'open' });
  });

  it('returns a working unsubscribe function', () => {
    const nk = makeNotifyKitModule();
    mockBareEnv(nk);
    const { BareDisplayAdapter } = require('../src/index');

    const unsub = new BareDisplayAdapter().onResponse(jest.fn());
    unsub();

    expect(nk._unsubscribe).toHaveBeenCalled();
  });

  it('returns a no-op unsubscribe when notify-kit is absent', () => {
    jest.doMock('react-native-notify-kit', () => { throw new Error('not found'); }, { virtual: true });
    jest.doMock('expo-notifications', () => { throw new Error('not found'); }, { virtual: true });
    jest.doMock('react-native', () => ({ Platform: { OS: 'android', Version: 30 } }), { virtual: true });
    const { BareDisplayAdapter } = require('../src/index');

    const cb = jest.fn();
    const unsub = new BareDisplayAdapter().onResponse(cb);
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });
});

describe('BareDisplayAdapter categories', () => {
  beforeEach(() => jest.resetModules());

  it('supportsCategories() is true when notify-kit is present, false when absent', () => {
    const nk = makeNotifyKitModule();
    mockBareEnv(nk);
    let mod = require('../src/index');
    expect(new mod.BareDisplayAdapter().supportsCategories()).toBe(true);

    jest.resetModules();
    jest.doMock('react-native-notify-kit', () => { throw new Error('not found'); }, { virtual: true });
    jest.doMock('expo-notifications', () => { throw new Error('not found'); }, { virtual: true });
    jest.doMock('react-native', () => ({ Platform: { OS: 'android', Version: 30 } }), { virtual: true });
    mod = require('../src/index');
    expect(new mod.BareDisplayAdapter().supportsCategories()).toBe(false);
  });

  it('setCategories maps CategoryDef to notify-kit shape and applies defaults', async () => {
    const nk = makeNotifyKitModule();
    mockBareEnv(nk);
    const { BareDisplayAdapter } = require('../src/index');

    await new BareDisplayAdapter().setCategories([
      {
        identifier: 'order',
        actions: [
          { identifier: 'track', buttonTitle: 'Track', opensAppToForeground: true, isDestructive: false },
          { identifier: 'cancel', buttonTitle: 'Cancel' }, // defaults applied
        ],
      },
    ]);

    expect(nk._instance.setNotificationCategories).toHaveBeenCalledWith([
      {
        id: 'order',
        actions: [
          { id: 'track', title: 'Track', foreground: true, destructive: false },
          { id: 'cancel', title: 'Cancel', foreground: true, destructive: false },
        ],
      },
    ]);
  });
});

describe('DisplayAdapter resolution (bare env)', () => {
  beforeEach(() => jest.resetModules());

  it('PushClient auto-track wires to notify-kit when expo absent + notify-kit present', () => {
    const nk = makeNotifyKitModule();
    mockBareEnv(nk);
    const { PushClient } = require('../src/index');

    // Constructing with autoTrack (default) must register a notify-kit foreground
    // listener — proving BareDisplayAdapter was selected by resolveDisplayAdapter.
    new PushClient({ projectId: 'pk_live_test' });
    expect(nk._instance.onForegroundEvent).toHaveBeenCalled();
  });
});

// Torna o arquivo um módulo: sem isso o ts-jest o trata como script global e
// nomes de topo repetidos entre testes colidem (TS2451) em cache frio.
export {}
