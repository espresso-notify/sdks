/**
 * @jest-environment node
 *
 * IMG-05: the tap on a notification the SDK drew with notify-kit reaches the client as an `opened` with the original
 * data, once, from the three places notify-kit reports it: the foreground event, the background event and the
 * notification that launched the app. notify-kit is a virtual mock; no device is involved.
 */
export {}; // a module, so its top-level names do not collide with the other test files (TS2451)

const ORIGINAL = { notificationId: '42', screen: 'orders', nested: { ids: [1, 2, 3], ok: true } };

/** The notification the SDK drew: what createNotificationHandler passed to displayNotification. */
function drawn(overrides: { id?: string; data?: Record<string, unknown> } = {}) {
  return {
    id: overrides.id ?? 'req-1',
    title: 'New order',
    data: overrides.data ?? { _espressoImage: '1', _espressoData: JSON.stringify(ORIGINAL) },
  };
}

type NkEvent = { type: number; detail: any };
const EventType = { PRESS: 1, ACTION_PRESS: 2, DISMISSED: 3, DELIVERED: 4 };

function makeNotifyKit(initial: any = null) {
  const foreground: Array<(e: NkEvent) => void> = [];
  const background: Array<(e: NkEvent) => Promise<void>> = [];
  const kit = {
    onForegroundEvent: jest.fn((cb: (e: NkEvent) => void) => {
      foreground.push(cb);
      return () => undefined;
    }),
    onBackgroundEvent: jest.fn((cb: (e: NkEvent) => Promise<void>) => {
      background.push(cb);
    }),
    getInitialNotification: jest.fn(async () => initial),
    displayNotification: jest.fn(),
  };
  return { default: kit, EventType, AndroidStyle: { BIGPICTURE: 0 }, _kit: kit, _foreground: foreground, _background: background };
}

function load(nk: ReturnType<typeof makeNotifyKit> | null) {
  jest.resetModules();
  jest.doMock('react-native', () => ({ Platform: { OS: 'android' } }), { virtual: true });
  jest.doMock(
    'react-native-notify-kit',
    () => {
      if (!nk) throw new Error("Cannot find module 'react-native-notify-kit'");
      return nk;
    },
    { virtual: true },
  );
  return require('../src/image-push') as typeof import('../src/image-push');
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('the funnel of taps', () => {
  afterEach(() => jest.restoreAllMocks());

  it('delivers a PRESS with the original data, notificationId and the default action (AC 1)', async () => {
    const nk = makeNotifyKit();
    const mod = load(nk);
    const cb = jest.fn();
    mod.subscribeImagePushTaps(cb);
    mod.installImagePush();

    nk._foreground[0]({ type: EventType.PRESS, detail: { notification: drawn(), pressAction: { id: 'default' } } });

    expect(cb).toHaveBeenCalledTimes(1);
    const info = cb.mock.calls[0][0];
    expect(info.notificationId).toBe('42');
    expect(info.data).toEqual(ORIGINAL); // nested objects included, same values
    expect(info.actionId).toBe('default');
    expect(info.coldStart).toBeUndefined();
  });

  it('delivers the notification that launched the app with coldStart (AC 2)', async () => {
    const nk = makeNotifyKit({ notification: drawn(), pressAction: { id: 'default' } });
    const mod = load(nk);
    const cb = jest.fn();
    mod.subscribeImagePushTaps(cb);
    mod.installImagePush();
    await flush();

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toMatchObject({ notificationId: '42', data: ORIGINAL, coldStart: true });
  });

  it('delivers a tap that arrives through onBackgroundEvent once (AC 3)', async () => {
    const nk = makeNotifyKit();
    const mod = load(nk);
    const cb = jest.fn();
    mod.subscribeImagePushTaps(cb);
    mod.installImagePush();

    await nk._background[0]({ type: EventType.PRESS, detail: { notification: drawn(), pressAction: { id: 'default' } } });

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toMatchObject({ notificationId: '42', data: ORIGINAL });
  });

  it('delivers the same tap once when it comes by onBackgroundEvent and by getInitialNotification (AC 4)', async () => {
    const initial = { notification: drawn(), pressAction: { id: 'default' } };
    const nk = makeNotifyKit(initial);
    const mod = load(nk);
    const cb = jest.fn();
    mod.subscribeImagePushTaps(cb);

    await mod.handleImagePushBackgroundEvent({ type: EventType.PRESS, detail: initial });
    mod.installImagePush();
    await flush();

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('delivers a button tap and a body tap on the same notification: the dedupe key holds the action id', async () => {
    const nk = makeNotifyKit();
    const mod = load(nk);
    const cb = jest.fn();
    mod.subscribeImagePushTaps(cb);
    mod.installImagePush();

    nk._foreground[0]({ type: EventType.ACTION_PRESS, detail: { notification: drawn(), pressAction: { id: 'reply' } } });
    nk._foreground[0]({ type: EventType.PRESS, detail: { notification: drawn(), pressAction: { id: 'default' } } });
    // the same action again inside the window is still one
    nk._foreground[0]({ type: EventType.PRESS, detail: { notification: drawn(), pressAction: { id: 'default' } } });

    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls.map((c) => c[0].actionId)).toEqual(['reply', 'default']);
  });

  it('delivers the same notification again after the window of duplicates has passed', async () => {
    const nk = makeNotifyKit();
    const mod = load(nk);
    const cb = jest.fn();
    mod.subscribeImagePushTaps(cb);
    mod.installImagePush();
    const press = { type: EventType.PRESS, detail: { notification: drawn(), pressAction: { id: 'default' } } };

    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    nk._foreground[0](press);
    now += 11_000;
    nk._foreground[0](press);

    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('keeps a tap that arrives before any client and hands it to the first client only (AC 5)', async () => {
    const nk = makeNotifyKit();
    const mod = load(nk);
    mod.installImagePush();
    await nk._background[0]({ type: EventType.PRESS, detail: { notification: drawn(), pressAction: { id: 'default' } } });

    const first = jest.fn();
    const second = jest.fn();
    mod.subscribeImagePushTaps(first);
    mod.subscribeImagePushTaps(second);

    expect(first).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0][0]).toMatchObject({ notificationId: '42', data: ORIGINAL, coldStart: true });
    expect(second).not.toHaveBeenCalled();
  });

  it('ignores a tap on a notification the SDK did not draw (AC 6)', async () => {
    const nk = makeNotifyKit({ notification: { id: 'x', data: { notificationId: '1' } }, pressAction: { id: 'default' } });
    const mod = load(nk);
    const cb = jest.fn();
    mod.subscribeImagePushTaps(cb);
    mod.installImagePush();
    await flush();
    nk._foreground[0]({ type: EventType.PRESS, detail: { notification: { id: 'y', data: { a: '1' } } } });
    await nk._background[0]({ type: EventType.PRESS, detail: { notification: { id: 'z' } } });

    expect(cb).not.toHaveBeenCalled();
  });

  it('ignores events that are not taps (dismissed, delivered)', async () => {
    const nk = makeNotifyKit();
    const mod = load(nk);
    const cb = jest.fn();
    mod.subscribeImagePushTaps(cb);
    mod.installImagePush();
    nk._foreground[0]({ type: EventType.DISMISSED, detail: { notification: drawn() } });
    nk._foreground[0]({ type: EventType.DELIVERED, detail: { notification: drawn() } });
    expect(cb).not.toHaveBeenCalled();
  });

  it('passes the id of an action button on ACTION_PRESS', async () => {
    const nk = makeNotifyKit();
    const mod = load(nk);
    const cb = jest.fn();
    mod.subscribeImagePushTaps(cb);
    mod.installImagePush();
    nk._foreground[0]({ type: EventType.ACTION_PRESS, detail: { notification: drawn(), pressAction: { id: 'reply' } } });
    expect(cb.mock.calls[0][0].actionId).toBe('reply');
  });

  it('reads the notification id from notification_id too, and gives {} when the original data is unreadable', async () => {
    const nk = makeNotifyKit();
    const mod = load(nk);
    const cb = jest.fn();
    mod.subscribeImagePushTaps(cb);
    mod.installImagePush();
    nk._foreground[0]({
      type: EventType.PRESS,
      detail: { notification: drawn({ id: 'a', data: { _espressoImage: '1', _espressoData: JSON.stringify({ notification_id: 5 }) } }) },
    });
    nk._foreground[0]({
      type: EventType.PRESS,
      detail: { notification: drawn({ id: 'b', data: { _espressoImage: '1', _espressoData: '{broken' } }) },
    });
    expect(cb.mock.calls[0][0].notificationId).toBe(5);
    expect(cb.mock.calls[1][0].data).toEqual({});
  });

  it('stops delivering to a client after its unsubscribe', async () => {
    const nk = makeNotifyKit();
    const mod = load(nk);
    const cb = jest.fn();
    const off = mod.subscribeImagePushTaps(cb);
    mod.installImagePush();
    off();
    nk._foreground[0]({ type: EventType.PRESS, detail: { notification: drawn() } });
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('installImagePush', () => {
  it('registers the notify-kit listeners once, however often it is called', () => {
    const nk = makeNotifyKit();
    const mod = load(nk);
    mod.installImagePush();
    mod.installImagePush();
    expect(nk._kit.onBackgroundEvent).toHaveBeenCalledTimes(1);
    expect(nk._kit.onForegroundEvent).toHaveBeenCalledTimes(1);
    expect(nk._kit.getInitialNotification).toHaveBeenCalledTimes(1);
  });

  it('does nothing and does not throw when notify-kit is not installed', () => {
    const mod = load(null);
    expect(() => mod.installImagePush()).not.toThrow();
  });

  it('handleImagePushBackgroundEvent delivers as the registration of the SDK does', async () => {
    const nk = makeNotifyKit();
    const mod = load(nk);
    const cb = jest.fn();
    mod.subscribeImagePushTaps(cb);
    await mod.handleImagePushBackgroundEvent({ type: EventType.PRESS, detail: { notification: drawn(), pressAction: { id: 'default' } } });
    expect(cb.mock.calls[0][0]).toMatchObject({ notificationId: '42', data: ORIGINAL });
  });

  it('survives a listener that throws', async () => {
    const nk = makeNotifyKit();
    const mod = load(nk);
    const bad = jest.fn(() => {
      throw new Error('boom');
    });
    const good = jest.fn();
    mod.subscribeImagePushTaps(bad);
    mod.subscribeImagePushTaps(good);
    mod.installImagePush();
    expect(() => nk._foreground[0]({ type: EventType.PRESS, detail: { notification: drawn() } })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });
});
