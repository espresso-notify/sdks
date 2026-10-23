/**
 * @jest-environment node
 *
 * G-1 of the push-images validation: an app that also uses react-native-notify-kit itself.
 *  - The launch notification the SDK reads (notify-kit hands it out once) is kept when it is not the SDK's, and
 *    `getForeignInitialNotification()` gives it back to the app.
 *  - `installListeners: false` leaves the one `onBackgroundEvent` and the launch notification to the app, which
 *    forwards them with `handleImagePushBackgroundEvent` and `handleImagePushInitialNotification`.
 * notify-kit is a virtual mock; no device is involved.
 */
export {};

const ORIGINAL = { notificationId: '42', screen: 'orders' };
const EVENT_PRESS = 1;

function drawn(id = 'req-1') {
  return { id, title: 'New order', data: { _espressoImage: '1', _espressoData: JSON.stringify(ORIGINAL) } };
}

/** A launch notification of the app itself: no marker of the SDK. */
function foreign() {
  return { notification: { id: 'app-1', title: 'Mine', data: { screen: 'chat' } }, pressAction: { id: 'default' } };
}

function makeNotifyKit(initial: any = null) {
  let pending = initial;
  const kit = {
    onForegroundEvent: jest.fn(() => () => undefined),
    onBackgroundEvent: jest.fn(),
    // notify-kit hands the launch notification out once: the second read is null.
    getInitialNotification: jest.fn(async () => {
      const out = pending;
      pending = null;
      return out;
    }),
    displayNotification: jest.fn(),
  };
  return { default: kit, AndroidStyle: { BIGPICTURE: 0 }, _kit: kit };
}

function load(nk: ReturnType<typeof makeNotifyKit> | null, os = 'android') {
  jest.resetModules();
  jest.doMock('react-native', () => ({ Platform: { OS: os } }), { virtual: true });
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

describe('the launch notification that is not the SDK\'s', () => {
  it('is kept by the SDK and given back once by getForeignInitialNotification', async () => {
    const initial = foreign();
    const nk = makeNotifyKit(initial);
    const mod = load(nk);
    const cb = jest.fn();
    mod.subscribeImagePushTaps(cb);
    mod.installImagePush();
    await flush();

    expect(nk._kit.getInitialNotification).toHaveBeenCalledTimes(1); // the SDK read it, so the app cannot
    expect(await mod.getForeignInitialNotification()).toBe(initial);
    expect(await mod.getForeignInitialNotification()).toBeNull(); // once, as notify-kit does
    expect(cb).not.toHaveBeenCalled(); // not a tap on a notification of the SDK
  });

  it('is available even when the app asks before the SDK has finished reading it', async () => {
    const initial = foreign();
    const mod = load(makeNotifyKit(initial));
    mod.installImagePush();
    expect(await mod.getForeignInitialNotification()).toBe(initial); // no flush in between
  });

  it('is null when the app was launched from a notification of the SDK, which is delivered as a cold start', async () => {
    const nk = makeNotifyKit({ notification: drawn(), pressAction: { id: 'default' } });
    const mod = load(nk);
    const cb = jest.fn();
    mod.subscribeImagePushTaps(cb);
    mod.installImagePush();
    await flush();

    expect(await mod.getForeignInitialNotification()).toBeNull();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toMatchObject({ notificationId: '42', coldStart: true });
  });

  it('reads notify-kit directly when the SDK did not install its listeners (and still forwards a notification of the SDK)', async () => {
    const initial = foreign();
    const nk = makeNotifyKit(initial);
    const mod = load(nk);

    expect(await mod.getForeignInitialNotification()).toBe(initial);
    expect(nk._kit.getInitialNotification).toHaveBeenCalledTimes(1);

    const sdkLaunch = makeNotifyKit({ notification: drawn(), pressAction: { id: 'default' } });
    const mod2 = load(sdkLaunch);
    const cb = jest.fn();
    mod2.subscribeImagePushTaps(cb);
    expect(await mod2.getForeignInitialNotification()).toBeNull();
    expect(cb.mock.calls[0][0]).toMatchObject({ notificationId: '42', coldStart: true });
  });

  it('is null without notify-kit, and never throws when notify-kit fails', async () => {
    expect(await load(null).getForeignInitialNotification()).toBeNull();
    const nk = makeNotifyKit();
    nk._kit.getInitialNotification.mockRejectedValue(new Error('boom'));
    expect(await load(nk).getForeignInitialNotification()).toBeNull();
  });
});

describe('installListeners: false', () => {
  it('registers nothing in notify-kit and reads no launch notification', async () => {
    const nk = makeNotifyKit(foreign());
    const mod = load(nk);
    mod.createNotificationHandler(undefined, { installListeners: false });
    await flush();

    expect(nk._kit.onBackgroundEvent).not.toHaveBeenCalled();
    expect(nk._kit.onForegroundEvent).not.toHaveBeenCalled();
    expect(nk._kit.getInitialNotification).not.toHaveBeenCalled();
  });

  it('still registers them by default (the control of the case above)', async () => {
    const nk = makeNotifyKit();
    const mod = load(nk);
    mod.createNotificationHandler();
    expect(nk._kit.onBackgroundEvent).toHaveBeenCalledTimes(1);
    expect(nk._kit.onForegroundEvent).toHaveBeenCalledTimes(1);
    expect(nk._kit.getInitialNotification).toHaveBeenCalledTimes(1);
  });

  it('still draws the large picture (the option only concerns the listeners)', async () => {
    const nk = makeNotifyKit();
    nk._kit.displayNotification.mockResolvedValue('nk-id');
    const mod = load(nk);
    const handler = mod.createNotificationHandler(undefined, { installListeners: false });
    const behavior = await handler({
      request: { identifier: 'r1', content: { title: 'T', body: 'B', data: { image: 'https://cdn.example.com/a.jpg' } } },
    });
    expect(nk._kit.displayNotification).toHaveBeenCalledTimes(1);
    expect(behavior).toMatchObject({ shouldShowBanner: false, shouldShowList: false });
  });

  it('the app forwards its own background event, foreground event and launch notification to the SDK', async () => {
    const nk = makeNotifyKit();
    const mod = load(nk);
    const cb = jest.fn();
    mod.subscribeImagePushTaps(cb);
    mod.createNotificationHandler(undefined, { installListeners: false });

    await mod.handleImagePushBackgroundEvent({ type: EVENT_PRESS, detail: { notification: drawn('a'), pressAction: { id: 'default' } } });
    await mod.handleImagePushBackgroundEvent({ type: EVENT_PRESS, detail: { notification: foreign().notification } });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toMatchObject({ notificationId: '42', data: ORIGINAL });
    expect(cb.mock.calls[0][0].coldStart).toBeUndefined();

    // The launch notification the app read itself: true when it was the SDK's (handled), false when it is the app's.
    expect(mod.handleImagePushInitialNotification({ notification: drawn('b'), pressAction: { id: 'default' } })).toBe(true);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1][0]).toMatchObject({ notificationId: '42', coldStart: true });
    expect(mod.handleImagePushInitialNotification(foreign())).toBe(false);
    expect(mod.handleImagePushInitialNotification(null)).toBe(false);
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
