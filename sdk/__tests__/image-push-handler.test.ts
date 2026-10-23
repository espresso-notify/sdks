/**
 * @jest-environment node
 *
 * IMG-04: with the app open on Android, a push with an image is drawn by react-native-notify-kit with the large
 * picture, and expo-notifications is told not to draw it. Everything else keeps what the app's handler says.
 * The native packages are virtual mocks; no device is involved.
 */

const URL_IMG = 'https://cdn.example.com/photo.jpg';

const SHOWN = { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false };
const HIDDEN_BEHAVIOR = { shouldShowBanner: false, shouldShowList: false, shouldShowAlert: false };

/** An expo-notifications notification on Android, with or without an image. */
function androidPush(opts: { image?: string; data?: Record<string, unknown>; channelId?: string | null } = {}): any {
  const { image, data = { notificationId: '7', screen: 'orders' }, channelId = 'alerts' } = opts;
  return {
    request: {
      identifier: 'req-1',
      content: { title: 'New order', body: 'Order #7 is ready', data },
      trigger: {
        type: 'push',
        remoteMessage: { notification: { imageUrl: image, ...(channelId === null ? {} : { channelId }) } },
      },
    },
  };
}

type Display = jest.Mock<Promise<string>, any[]>;

function makeNotifyKit(display?: Display) {
  const displayNotification: Display = display ?? jest.fn(async () => 'nk-id');
  return {
    default: {
      displayNotification,
      onForegroundEvent: jest.fn(() => () => undefined),
      onBackgroundEvent: jest.fn(),
      getInitialNotification: jest.fn(async () => null),
    },
    AndroidStyle: { BIGPICTURE: 0 },
    EventType: { PRESS: 1, ACTION_PRESS: 2, DISMISSED: 3, DELIVERED: 4 },
    _display: displayNotification,
  };
}

/** Loads image-push with the given platform and notify-kit (null = not installed). */
function load(opts: { os?: string; notifyKit?: ReturnType<typeof makeNotifyKit> | null } = {}) {
  const { os = 'android', notifyKit = makeNotifyKit() } = opts;
  jest.resetModules();
  jest.doMock('react-native', () => ({ Platform: { OS: os } }), { virtual: true });
  jest.doMock(
    'react-native-notify-kit',
    () => {
      if (!notifyKit) throw new Error("Cannot find module 'react-native-notify-kit'");
      return notifyKit;
    },
    { virtual: true },
  );
  return require('../src/image-push') as typeof import('../src/image-push');
}

describe('createNotificationHandler: the big picture with the app open', () => {
  afterEach(() => {
    jest.useRealTimers();
    delete (globalThis as any).__DEV__;
  });

  it('draws a push that has an image with notify-kit (BIGPICTURE) and tells Expo to draw nothing', async () => {
    const nk = makeNotifyKit();
    const { createNotificationHandler } = load({ notifyKit: nk });
    const handler = createNotificationHandler(async () => SHOWN);

    const behavior = await handler(androidPush({ image: URL_IMG }));

    expect(nk._display).toHaveBeenCalledTimes(1);
    const arg = nk._display.mock.calls[0][0];
    expect(arg.id).toBe('req-1');
    expect(arg.title).toBe('New order');
    expect(arg.body).toBe('Order #7 is ready');
    expect(arg.android.style).toEqual({ type: 0, picture: URL_IMG });
    expect(arg.android.channelId).toBe('alerts');
    expect(arg.android.pressAction).toEqual({ id: 'default', launchActivity: 'default' });
    expect(arg.data._espressoImage).toBe('1');
    expect(JSON.parse(arg.data._espressoData)).toEqual({ notificationId: '7', screen: 'orders' });
    expect(behavior).toMatchObject(HIDDEN_BEHAVIOR);
  });

  it('keeps the other fields of the behavior the app returned', async () => {
    const { createNotificationHandler } = load();
    const handler = createNotificationHandler(async () => ({ ...SHOWN, shouldSetBadge: true }));
    const behavior = await handler(androidPush({ image: URL_IMG }));
    expect(behavior.shouldSetBadge).toBe(true);
    expect(behavior.shouldShowBanner).toBe(false);
  });

  it('uses the channel `default` when the message has no channelId', async () => {
    const nk = makeNotifyKit();
    const { createNotificationHandler } = load({ notifyKit: nk });
    await createNotificationHandler()(androidPush({ image: URL_IMG, channelId: null }));
    expect(nk._display.mock.calls[0][0].android.channelId).toBe('default');
  });

  it('passes the data the Expo push service wraps in body as the original data, unwrapped', async () => {
    const nk = makeNotifyKit();
    const { createNotificationHandler } = load({ notifyKit: nk });
    const wrapped = androidPush({
      image: URL_IMG,
      data: { body: JSON.stringify({ notificationId: '9', nested: { a: [1, 2] } }) },
    });
    await createNotificationHandler()(wrapped);
    expect(JSON.parse(nk._display.mock.calls[0][0].data._espressoData)).toMatchObject({
      notificationId: '9',
      nested: { a: [1, 2] },
    });
  });

  it('returns the behavior of the app unchanged when the app hides the notification (AC 3)', async () => {
    const nk = makeNotifyKit();
    const { createNotificationHandler } = load({ notifyKit: nk });
    const hide = { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: true };
    const behavior = await createNotificationHandler(async () => hide)(androidPush({ image: URL_IMG }));
    expect(nk._display).not.toHaveBeenCalled();
    expect(behavior).toEqual(hide);
  });

  it('treats the old shouldShowAlert: false as hidden too', async () => {
    const nk = makeNotifyKit();
    const { createNotificationHandler } = load({ notifyKit: nk });
    const hide = { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: false };
    const behavior = await createNotificationHandler(async () => hide)(androidPush({ image: URL_IMG }));
    expect(nk._display).not.toHaveBeenCalled();
    expect(behavior).toEqual(hide);
  });

  it('shows the image when only the banner or only the list is on', async () => {
    const nk = makeNotifyKit();
    const { createNotificationHandler } = load({ notifyKit: nk });
    await createNotificationHandler(async () => ({ shouldShowBanner: true, shouldShowList: false }))(
      androidPush({ image: URL_IMG }),
    );
    expect(nk._display).toHaveBeenCalledTimes(1);
  });
});

describe('createNotificationHandler: small icon and failures (AC 4)', () => {
  it('tries notification_icon before ic_launcher and stops at the first icon notify-kit accepts', async () => {
    const display: Display = jest.fn(async (n: any) => {
      if (n.android.smallIcon === 'notification_icon') throw new Error('icon not found');
      return 'ok';
    });
    const nk = makeNotifyKit(display);
    const { createNotificationHandler } = load({ notifyKit: nk });
    const behavior = await createNotificationHandler()(androidPush({ image: URL_IMG }));
    expect(display.mock.calls.map((c) => c[0].android.smallIcon)).toEqual(['notification_icon', 'ic_launcher']);
    expect(behavior).toMatchObject(HIDDEN_BEHAVIOR);
  });

  it('tries options.smallIcon before the two defaults', async () => {
    const display: Display = jest.fn(async () => {
      throw new Error('no');
    });
    const nk = makeNotifyKit(display);
    const { createNotificationHandler } = load({ notifyKit: nk });
    await createNotificationHandler(undefined, { smallIcon: 'my_icon' })(androidPush({ image: URL_IMG }));
    expect(display.mock.calls.map((c) => c[0].android.smallIcon)).toEqual(['my_icon', 'notification_icon', 'ic_launcher']);
  });

  it('returns the behavior of the app, and does not throw, when notify-kit refuses with every icon it tries', async () => {
    const display: Display = jest.fn(async () => {
      throw new Error('Channel not found');
    });
    const nk = makeNotifyKit(display);
    const { createNotificationHandler } = load({ notifyKit: nk });
    const behavior = await createNotificationHandler(async () => SHOWN)(androidPush({ image: URL_IMG }));
    expect(display).toHaveBeenCalledTimes(2); // notification_icon, then ic_launcher
    expect(behavior).toEqual(SHOWN);
  });

  it('counts a display that does not answer in 2.5 s as shown', async () => {
    jest.useFakeTimers();
    const display: Display = jest.fn(() => new Promise<string>(() => undefined));
    const nk = makeNotifyKit(display);
    const { createNotificationHandler } = load({ notifyKit: nk });
    const pending = Promise.resolve(createNotificationHandler(async () => SHOWN)(androidPush({ image: URL_IMG })));
    await jest.advanceTimersByTimeAsync(2400);
    let settled = false;
    void pending.then(() => { settled = true; });
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(200);
    expect(await pending).toMatchObject(HIDDEN_BEHAVIOR);
    expect(display).toHaveBeenCalledTimes(1);
  });
});

describe('createNotificationHandler: when it does nothing', () => {
  afterEach(() => {
    delete (globalThis as any).__DEV__;
  });

  it('returns the behavior of the app when notify-kit is not installed, and warns once in development (AC 5)', async () => {
    (globalThis as any).__DEV__ = true;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { createNotificationHandler } = load({ notifyKit: null });
    const handler = createNotificationHandler(async () => SHOWN);

    expect(await handler(androidPush({ image: URL_IMG }))).toEqual(SHOWN);
    expect(await handler(androidPush({ image: URL_IMG }))).toEqual(SHOWN);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('react-native-notify-kit');
    warn.mockRestore();
  });

  it('does not warn when __DEV__ is false or absent', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { createNotificationHandler } = load({ notifyKit: null });
    await createNotificationHandler(async () => SHOWN)(androidPush({ image: URL_IMG }));
    (globalThis as any).__DEV__ = false;
    await createNotificationHandler(async () => SHOWN)(androidPush({ image: URL_IMG }));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never calls notify-kit with bigPicture: false (AC 6)', async () => {
    const nk = makeNotifyKit();
    const { createNotificationHandler } = load({ notifyKit: nk });
    const behavior = await createNotificationHandler(async () => SHOWN, { bigPicture: false })(
      androidPush({ image: URL_IMG }),
    );
    expect(nk._display).not.toHaveBeenCalled();
    expect(behavior).toEqual(SHOWN);
  });

  it('leaves iOS to expo-notifications (AC 7)', async () => {
    const nk = makeNotifyKit();
    const { createNotificationHandler } = load({ os: 'ios', notifyKit: nk });
    const behavior = await createNotificationHandler(async () => SHOWN)(androidPush({ image: URL_IMG }));
    expect(nk._display).not.toHaveBeenCalled();
    expect(behavior).toEqual(SHOWN);
  });

  it('leaves a push without an image, or with an http image, to expo-notifications (AC 7)', async () => {
    const nk = makeNotifyKit();
    const { createNotificationHandler } = load({ notifyKit: nk });
    const handler = createNotificationHandler(async () => SHOWN);
    expect(await handler(androidPush())).toEqual(SHOWN);
    expect(await handler(androidPush({ image: 'http://cdn.example.com/a.jpg' }))).toEqual(SHOWN);
    expect(nk._display).not.toHaveBeenCalled();
  });

  it('uses the default behavior of the spec for a push without an image when the app has no handler (AC 8)', async () => {
    const { createNotificationHandler } = load();
    const behavior = await createNotificationHandler()(androidPush());
    expect(behavior).toEqual({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false });
  });

  it('lets an error of the handler of the app through', async () => {
    const { createNotificationHandler } = load();
    const handler = createNotificationHandler(async () => {
      throw new Error('app handler failed');
    });
    await expect(handler(androidPush({ image: URL_IMG }))).rejects.toThrow('app handler failed');
  });
});

// A module, not a script: ts-jest type-checks script files in one shared scope, where two of them declaring the same
// top-level name fail to compile.
export {};
