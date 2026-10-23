/**
 * @jest-environment jsdom
 *
 * Tests for #811: received / dismissed / app_opened instrumentation.
 * Covers:
 *   - ExpoDisplayAdapter.onReceived (wired through PushClient auto-track)
 *   - BareDisplayAdapter.onReceived / onDismissed
 *   - Devices.trackReceived / trackDismissed / trackAppOpened
 *   - PushClient auto-track wiring + destroy() cleanup
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

type ForegroundCb = (event: { type: number; detail: any }) => void;

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

function mockBareEnv(nkMock: ReturnType<typeof makeNotifyKitModule>) {
  jest.doMock('react-native-notify-kit', () => nkMock, { virtual: true });
  jest.doMock('expo-notifications', () => { throw new Error('not found'); }, { virtual: true });
  jest.doMock('react-native', () => ({
    Platform: { OS: 'android', Version: 30 },
    AppState: null,
  }), { virtual: true });
}

const mockFetch = jest.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

// ─── ExpoDisplayAdapter.onReceived ────────────────────────────────────────────

describe('ExpoDisplayAdapter.onReceived() via PushClient auto-track', () => {
  beforeEach(() => {
    jest.resetModules();
    mockFetch.mockClear();
  });

  it('registers addNotificationReceivedListener when PushClient is constructed', () => {
    const addNotificationReceivedListener = jest.fn().mockReturnValue({ remove: jest.fn() });

    jest.doMock('expo-notifications', () => ({
      addNotificationReceivedListener,
      addNotificationResponseReceivedListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
    }), { virtual: true });
    jest.doMock('react-native', () => ({
      Platform: { OS: 'ios', Version: 16 },
      AppState: null,
    }), { virtual: true });

    const { PushClient } = require('../src/index');
    new PushClient({ projectId: 'pk_live_test' });

    expect(addNotificationReceivedListener).toHaveBeenCalledTimes(1);
  });

  it('fires cb with notificationId when notification received (camelCase data key)', async () => {
    let capturedCb: ((n: any) => void) = () => {};
    const addNotificationReceivedListener = jest.fn((cb: (n: any) => void) => {
      capturedCb = cb;
      return { remove: jest.fn() };
    });

    jest.doMock('expo-notifications', () => ({
      addNotificationReceivedListener,
      addNotificationResponseReceivedListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
    }), { virtual: true });
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: 16 }, AppState: null }), { virtual: true });

    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve('{}') });

    const { PushClient } = require('../src/index');
    const client = new PushClient({ projectId: 'pk_live_test', pushToken: 'tok' });

    capturedCb({ request: { content: { data: { notificationId: 42 } } } });

    // The auto-track wiring calls trackReceived, which waits a random 0 to 30 s before it calls fetch (T40): flush() sends it now
    await Promise.resolve();
    await Promise.resolve(); // two ticks to flush async chain
    await client.flush();

    const trackCalls = mockFetch.mock.calls.filter((c) => {
      try { return JSON.parse(c[1].body).event === 'received'; } catch { return false; }
    });
    expect(trackCalls.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(trackCalls[0][1].body).notification_id).toBe(42);
  });

  it('onReceived unsubscribe calls subscription.remove() on destroy()', () => {
    const fakeRemove = jest.fn();
    const addNotificationReceivedListener = jest.fn().mockReturnValue({ remove: fakeRemove });

    jest.doMock('expo-notifications', () => ({
      addNotificationReceivedListener,
      addNotificationResponseReceivedListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
    }), { virtual: true });
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: 16 }, AppState: null }), { virtual: true });

    const { PushClient } = require('../src/index');
    const client = new PushClient({ projectId: 'pk_live_test' });
    client.destroy();

    expect(fakeRemove).toHaveBeenCalled();
  });
});

// ─── BareDisplayAdapter.onReceived ────────────────────────────────────────────

describe('BareDisplayAdapter.onReceived()', () => {
  beforeEach(() => jest.resetModules());

  it('fires cb with notificationId when DELIVERED event arrives', () => {
    const nk = makeNotifyKitModule();
    mockBareEnv(nk);
    const { BareDisplayAdapter } = require('../src/index');

    const cb = jest.fn();
    new BareDisplayAdapter().onReceived(cb);

    // DELIVERED = 4
    nk._listeners[0]({ type: 4, detail: { notification: { data: { notificationId: 77 } } } });
    expect(cb).toHaveBeenCalledWith({ notificationId: 77 });
  });

  it('maps notification_id (snake_case) via DELIVERED event', () => {
    const nk = makeNotifyKitModule();
    mockBareEnv(nk);
    const { BareDisplayAdapter } = require('../src/index');

    const cb = jest.fn();
    new BareDisplayAdapter().onReceived(cb);
    nk._listeners[0]({ type: 4, detail: { notification: { data: { notification_id: 55 } } } });
    expect(cb).toHaveBeenCalledWith({ notificationId: 55 });
  });

  it('does NOT fire cb for non-DELIVERED events', () => {
    const nk = makeNotifyKitModule();
    mockBareEnv(nk);
    const { BareDisplayAdapter } = require('../src/index');

    const cb = jest.fn();
    new BareDisplayAdapter().onReceived(cb);
    nk._listeners[0]({ type: 1, detail: { notification: { data: { notificationId: 1 } } } }); // PRESS
    expect(cb).not.toHaveBeenCalled();
  });

  it('returns a working unsubscribe function', () => {
    const nk = makeNotifyKitModule();
    mockBareEnv(nk);
    const { BareDisplayAdapter } = require('../src/index');

    const unsub = new BareDisplayAdapter().onReceived(jest.fn());
    unsub();
    expect(nk._unsubscribe).toHaveBeenCalled();
  });

  it('returns no-op unsubscribe when notify-kit is absent', () => {
    jest.doMock('react-native-notify-kit', () => { throw new Error('not found'); }, { virtual: true });
    jest.doMock('expo-notifications', () => { throw new Error('not found'); }, { virtual: true });
    jest.doMock('react-native', () => ({ Platform: { OS: 'android', Version: 30 }, AppState: null }), { virtual: true });
    const { BareDisplayAdapter } = require('../src/index');

    const unsub = new BareDisplayAdapter().onReceived(jest.fn());
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });
});

// ─── BareDisplayAdapter.onDismissed ───────────────────────────────────────────

describe('BareDisplayAdapter.onDismissed()', () => {
  beforeEach(() => jest.resetModules());

  it('fires cb with notificationId when DISMISSED event arrives', () => {
    const nk = makeNotifyKitModule();
    mockBareEnv(nk);
    const { BareDisplayAdapter } = require('../src/index');

    const cb = jest.fn();
    new BareDisplayAdapter().onDismissed(cb);

    // DISMISSED = 3
    nk._listeners[0]({ type: 3, detail: { notification: { data: { notificationId: 88 } } } });
    expect(cb).toHaveBeenCalledWith({ notificationId: 88 });
  });

  it('maps notification_id (snake_case) via DISMISSED event', () => {
    const nk = makeNotifyKitModule();
    mockBareEnv(nk);
    const { BareDisplayAdapter } = require('../src/index');

    const cb = jest.fn();
    new BareDisplayAdapter().onDismissed(cb);
    nk._listeners[0]({ type: 3, detail: { notification: { data: { notification_id: 66 } } } });
    expect(cb).toHaveBeenCalledWith({ notificationId: 66 });
  });

  it('does NOT fire cb for non-DISMISSED events', () => {
    const nk = makeNotifyKitModule();
    mockBareEnv(nk);
    const { BareDisplayAdapter } = require('../src/index');

    const cb = jest.fn();
    new BareDisplayAdapter().onDismissed(cb);
    nk._listeners[0]({ type: 1, detail: { notification: { data: { notificationId: 1 } } } }); // PRESS
    expect(cb).not.toHaveBeenCalled();
  });

  it('returns a working unsubscribe function', () => {
    const nk = makeNotifyKitModule();
    mockBareEnv(nk);
    const { BareDisplayAdapter } = require('../src/index');

    const unsub = new BareDisplayAdapter().onDismissed(jest.fn());
    unsub();
    expect(nk._unsubscribe).toHaveBeenCalled();
  });

  it('returns no-op unsubscribe when notify-kit is absent', () => {
    jest.doMock('react-native-notify-kit', () => { throw new Error('not found'); }, { virtual: true });
    jest.doMock('expo-notifications', () => { throw new Error('not found'); }, { virtual: true });
    jest.doMock('react-native', () => ({ Platform: { OS: 'android', Version: 30 }, AppState: null }), { virtual: true });
    const { BareDisplayAdapter } = require('../src/index');

    const unsub = new BareDisplayAdapter().onDismissed(jest.fn());
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });
});

// ─── Devices.trackReceived ────────────────────────────────────────────────────

describe('Devices.trackReceived()', () => {
  beforeEach(() => {
    jest.resetModules();
    mockFetch.mockClear();
    jest.doMock('expo-notifications', () => ({
      addNotificationResponseReceivedListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
      addNotificationReceivedListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
    }), { virtual: true });
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: 16 }, AppState: null }), { virtual: true });
  });

  it('POSTs received event to /v1/notifications/track', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('{}') });

    const { PushClient } = require('../src/index');
    const c = new PushClient({ projectId: 'pk_live_test', pushToken: 'tok', autoTrack: false });
    await c.devices.trackReceived(42);
    await c.flush(); // received waits a random 0 to 30 s (T40); flush() sends it now

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/notifications/track'),
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.notification_id).toBe(42);
    expect(body.event).toBe('received');
    expect(body.push_token).toBe('tok');
  });

  it('accepts string notificationId and coerces to Number', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('{}') });

    const { PushClient } = require('../src/index');
    const c = new PushClient({ projectId: 'pk_live_test', pushToken: 'tok', autoTrack: false });
    await c.devices.trackReceived('123');
    await c.flush();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.notification_id).toBe(123);
  });

  it('is silent on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const { PushClient } = require('../src/index');
    const c = new PushClient({ projectId: 'pk_live_test', pushToken: 'tok', autoTrack: false });
    await expect(c.devices.trackReceived(42)).resolves.toBeUndefined();
  });

  it('does nothing when token is absent', async () => {
    const { PushClient } = require('../src/index');
    const c = new PushClient({ projectId: 'pk_live_test', autoTrack: false });
    await c.devices.trackReceived(42);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─── Devices.trackDismissed ───────────────────────────────────────────────────

describe('Devices.trackDismissed()', () => {
  beforeEach(() => {
    jest.resetModules();
    mockFetch.mockClear();
    jest.doMock('expo-notifications', () => ({
      addNotificationResponseReceivedListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
      addNotificationReceivedListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
    }), { virtual: true });
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: 16 }, AppState: null }), { virtual: true });
  });

  it('POSTs dismissed event to /v1/notifications/track', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('{}') });

    const { PushClient } = require('../src/index');
    const c = new PushClient({ projectId: 'pk_live_test', pushToken: 'tok', autoTrack: false });
    await c.devices.trackDismissed(7);
    await c.flush(); // dismissed waits a random 0 to 30 s (T40); flush() sends it now

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.notification_id).toBe(7);
    expect(body.event).toBe('dismissed');
    expect(body.push_token).toBe('tok');
  });

  it('is silent on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const { PushClient } = require('../src/index');
    const c = new PushClient({ projectId: 'pk_live_test', pushToken: 'tok', autoTrack: false });
    await expect(c.devices.trackDismissed(7)).resolves.toBeUndefined();
  });

  it('does nothing when token is absent', async () => {
    const { PushClient } = require('../src/index');
    const c = new PushClient({ projectId: 'pk_live_test', autoTrack: false });
    await c.devices.trackDismissed(7);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─── Devices.trackAppOpened ───────────────────────────────────────────────────

describe('Devices.trackAppOpened()', () => {
  beforeEach(() => {
    jest.resetModules();
    mockFetch.mockClear();
    jest.doMock('expo-notifications', () => ({
      addNotificationResponseReceivedListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
      addNotificationReceivedListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
    }), { virtual: true });
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: 16 }, AppState: null }), { virtual: true });
  });

  it('POSTs app_opened event to /v1/notifications/track with notification_id:0', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('{}') });

    const { PushClient } = require('../src/index');
    const c = new PushClient({ projectId: 'pk_live_test', pushToken: 'tok', autoTrack: false });
    await c.devices.trackAppOpened();

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/notifications/track'),
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.event).toBe('app_opened');
    expect(body.notification_id).toBe(0);
    expect(body.push_token).toBe('tok');
  });

  it('uses provided pushToken over constructor token', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('{}') });

    const { PushClient } = require('../src/index');
    const c = new PushClient({ projectId: 'pk_live_test', pushToken: 'ctor-tok', autoTrack: false });
    await c.devices.trackAppOpened('override-tok');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.push_token).toBe('override-tok');
  });

  it('does nothing when token is absent', async () => {
    const { PushClient } = require('../src/index');
    const c = new PushClient({ projectId: 'pk_live_test', autoTrack: false });
    await c.devices.trackAppOpened();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('is silent on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const { PushClient } = require('../src/index');
    const c = new PushClient({ projectId: 'pk_live_test', pushToken: 'tok', autoTrack: false });
    await expect(c.devices.trackAppOpened()).resolves.toBeUndefined();
  });
});

// ─── PushClient auto-track wiring ────────────────────────────────────────────

describe('PushClient auto-track: received/dismissed/app_opened wiring', () => {
  beforeEach(() => {
    jest.resetModules();
    mockFetch.mockClear();
  });

  it('wires onResponse + onReceived + onDismissed + AppState in _setupAutoTracking', () => {
    const mockOnResponse = jest.fn().mockReturnValue(() => {});
    const mockOnReceived = jest.fn().mockReturnValue(() => {});
    const mockOnDismissed = jest.fn().mockReturnValue(() => {});
    const mockAppStateAddEventListener = jest.fn().mockReturnValue({ remove: jest.fn() });

    jest.doMock('expo-notifications', () => ({
      addNotificationResponseReceivedListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
      addNotificationReceivedListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
    }), { virtual: true });
    jest.doMock('react-native', () => ({
      Platform: { OS: 'ios', Version: 16 },
      AppState: { addEventListener: mockAppStateAddEventListener, currentState: 'background' },
    }), { virtual: true });

    const mockAdapter = {
      onResponse: mockOnResponse,
      onReceived: mockOnReceived,
      onDismissed: mockOnDismissed,
      supportsCategories: () => false,
      setCategories: jest.fn().mockResolvedValue(undefined),
    };

    const { PushClient } = require('../src/index');
    new PushClient({
      projectId: 'pk_live_test',
      pushToken: 'tok',
      displayAdapter: mockAdapter,
    });

    expect(mockOnResponse).toHaveBeenCalledTimes(1);
    expect(mockOnReceived).toHaveBeenCalledTimes(1);
    expect(mockOnDismissed).toHaveBeenCalledTimes(1);
    expect(mockAppStateAddEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('AppState change background→active calls trackAppOpened', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve('{}') });

    let appStateListener: (state: string) => void = () => {};
    const mockAppState = {
      addEventListener: jest.fn((event: string, cb: (state: string) => void) => {
        if (event === 'change') appStateListener = cb;
        return { remove: jest.fn() };
      }),
      currentState: 'background',
    };

    jest.doMock('expo-notifications', () => ({
      addNotificationResponseReceivedListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
      addNotificationReceivedListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
    }), { virtual: true });
    jest.doMock('react-native', () => ({
      Platform: { OS: 'ios', Version: 16 },
      AppState: mockAppState,
    }), { virtual: true });

    const { PushClient } = require('../src/index');
    new PushClient({ projectId: 'pk_live_test', pushToken: 'app-tok' });

    // Simulate going to foreground
    appStateListener('active');
    await Promise.resolve();

    const trackCalls = mockFetch.mock.calls.filter((call) => {
      try { return JSON.parse(call[1].body).event === 'app_opened'; } catch { return false; }
    });
    expect(trackCalls.length).toBeGreaterThanOrEqual(1);
    const body = JSON.parse(trackCalls[0][1].body);
    expect(body.push_token).toBe('app-tok');
  });

  it('AppState active→active does not double-fire trackAppOpened', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve('{}') });

    let appStateListener: (state: string) => void = () => {};
    const mockAppState = {
      addEventListener: jest.fn((event: string, cb: (state: string) => void) => {
        if (event === 'change') appStateListener = cb;
        return { remove: jest.fn() };
      }),
      currentState: 'background',
    };

    jest.doMock('expo-notifications', () => ({
      addNotificationResponseReceivedListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
      addNotificationReceivedListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
    }), { virtual: true });
    jest.doMock('react-native', () => ({
      Platform: { OS: 'ios', Version: 16 },
      AppState: mockAppState,
    }), { virtual: true });

    const { PushClient } = require('../src/index');
    new PushClient({ projectId: 'pk_live_test', pushToken: 'app-tok' });

    // background → active (should fire)
    appStateListener('active');
    // active → active (should NOT fire again)
    appStateListener('active');
    await Promise.resolve();

    const trackCalls = mockFetch.mock.calls.filter((call) => {
      try { return JSON.parse(call[1].body).event === 'app_opened'; } catch { return false; }
    });
    expect(trackCalls).toHaveLength(1);
  });

  it('does not throw when AppState is absent (web/test env degradation)', () => {
    jest.doMock('expo-notifications', () => ({
      addNotificationResponseReceivedListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
      addNotificationReceivedListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
    }), { virtual: true });
    jest.doMock('react-native', () => ({
      Platform: { OS: 'ios', Version: 16 },
      AppState: null,
    }), { virtual: true });

    const { PushClient } = require('../src/index');
    expect(() => new PushClient({ projectId: 'pk_live_test', pushToken: 'tok' })).not.toThrow();
  });
});

// ─── PushClient.destroy() cleans up all subscriptions ────────────────────────

describe('PushClient.destroy() cleans up all subscriptions', () => {
  beforeEach(() => {
    jest.resetModules();
    mockFetch.mockClear();
  });

  it('calls all unsubscribe functions and is idempotent', () => {
    const unsubResponse = jest.fn();
    const unsubReceived = jest.fn();
    const unsubDismissed = jest.fn();
    const unsubAppState = jest.fn();

    const mockAdapter = {
      onResponse: jest.fn().mockReturnValue(unsubResponse),
      onReceived: jest.fn().mockReturnValue(unsubReceived),
      onDismissed: jest.fn().mockReturnValue(unsubDismissed),
      supportsCategories: () => false,
      setCategories: jest.fn().mockResolvedValue(undefined),
    };

    jest.doMock('expo-notifications', () => ({
      addNotificationResponseReceivedListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
      addNotificationReceivedListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
    }), { virtual: true });
    jest.doMock('react-native', () => ({
      Platform: { OS: 'ios', Version: 16 },
      AppState: {
        addEventListener: jest.fn().mockReturnValue({ remove: unsubAppState }),
        currentState: 'background',
      },
    }), { virtual: true });

    const { PushClient } = require('../src/index');
    const client = new PushClient({
      projectId: 'pk_live_test',
      pushToken: 'tok',
      displayAdapter: mockAdapter,
    });

    client.destroy();

    expect(unsubResponse).toHaveBeenCalledTimes(1);
    expect(unsubReceived).toHaveBeenCalledTimes(1);
    expect(unsubDismissed).toHaveBeenCalledTimes(1);
    expect(unsubAppState).toHaveBeenCalledTimes(1);

    // Second destroy is a no-op (idempotent)
    client.destroy();
    expect(unsubResponse).toHaveBeenCalledTimes(1);
    expect(unsubReceived).toHaveBeenCalledTimes(1);
    expect(unsubDismissed).toHaveBeenCalledTimes(1);
    expect(unsubAppState).toHaveBeenCalledTimes(1);
  });
});

// Torna o arquivo um módulo: sem isso o ts-jest o trata como script global e
// nomes de topo repetidos entre testes colidem (TS2451) em cache frio.
export {}
