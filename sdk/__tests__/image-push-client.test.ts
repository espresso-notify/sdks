/**
 * @jest-environment jsdom
 *
 * IMG-05 end to end inside the SDK: a PushClient in Expo mode, the wrapped notification handler drawing a push with
 * notify-kit, and the tap on that notification reaching the client as `opened` once and as `onNotificationOpened`
 * once, with the original data. expo-notifications, react-native and notify-kit are virtual mocks.
 */
export {}; // a module, so its top-level names do not collide with the other test files (TS2451)

const flushPromises = () => new Promise((r) => setTimeout(r, 0));

const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT';
const ORIGINAL = { notificationId: '42', screen: 'orders', nested: { ids: [1, 2], ok: true } };
const IMAGE = 'https://cdn.example.com/photo.jpg';

function expoMock() {
  const responseListeners: Array<(r: any) => void> = [];
  const receivedListeners: Array<(n: any) => void> = [];
  const mod: any = {
    DEFAULT_ACTION_IDENTIFIER: DEFAULT_ACTION,
    addNotificationResponseReceivedListener: jest.fn((cb: (r: any) => void) => {
      responseListeners.push(cb);
      return { remove: jest.fn() };
    }),
    addNotificationReceivedListener: jest.fn((cb: (n: any) => void) => {
      receivedListeners.push(cb);
      return { remove: jest.fn() };
    }),
    getLastNotificationResponseAsync: jest.fn().mockResolvedValue(null),
  };
  return { mod, fireResponse: (r: any) => responseListeners.forEach((l) => l(r)), fireReceived: (n: any) => receivedListeners.forEach((l) => l(n)) };
}

function notifyKitMock() {
  const foreground: Array<(e: any) => void> = [];
  const drawn: any[] = [];
  const kit = {
    displayNotification: jest.fn(async (n: any) => {
      drawn.push(n);
      return 'nk-id';
    }),
    onForegroundEvent: jest.fn((cb: (e: any) => void) => {
      foreground.push(cb);
      return () => {
        foreground.splice(foreground.indexOf(cb), 1);
      };
    }),
    onBackgroundEvent: jest.fn(),
    getInitialNotification: jest.fn(async () => null),
  };
  return {
    default: kit,
    AndroidStyle: { BIGPICTURE: 0 },
    EventType: { PRESS: 1, ACTION_PRESS: 2, DISMISSED: 3, DELIVERED: 4 },
    drawn,
    press: (n: any) => foreground.forEach((l) => l({ type: 1, detail: { notification: n, pressAction: { id: 'default' } } })),
  };
}

const fetchMock = jest.fn();

function load(opts: { notifyKit?: ReturnType<typeof notifyKitMock>; expo: ReturnType<typeof expoMock> }) {
  jest.resetModules();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, text: async () => '' });
  (globalThis as any).fetch = fetchMock;
  jest.doMock('expo-notifications', () => opts.expo.mod, { virtual: true });
  jest.doMock('react-native', () => ({ Platform: { OS: 'android', Version: 34 }, AppState: null, Linking: null }), { virtual: true });
  if (opts.notifyKit) jest.doMock('react-native-notify-kit', () => opts.notifyKit, { virtual: true });
  else jest.doMock('react-native-notify-kit', () => { throw new Error('not found'); }, { virtual: true });
  return require('../src/index');
}

function androidPush() {
  return {
    request: {
      identifier: 'req-1',
      content: { title: 'T', body: 'B', data: ORIGINAL },
      trigger: { type: 'push', remoteMessage: { notification: { imageUrl: IMAGE, channelId: 'default' } } },
    },
  };
}

/** Every body posted to /v1/notifications/track. */
function tracked(): any[] {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/notifications/track')).map(([, init]) => JSON.parse(init.body));
}

function makeClient(sdk: any) {
  return new sdk.PushClient({ projectId: 'pk_live_test', pushToken: 'ExponentPushToken[abc]', platform: 'android' });
}

describe('a push drawn by the SDK, then tapped', () => {
  it('records opened once and calls onNotificationOpened once with the original data (IMG-05 AC 1)', async () => {
    const expo = expoMock();
    const nk = notifyKitMock();
    const sdk = load({ expo, notifyKit: nk });
    const client = makeClient(sdk);
    const opened = jest.fn();
    client.onNotificationOpened(opened);

    const handler = sdk.createNotificationHandler();
    const behavior = await handler(androidPush());
    expect(behavior.shouldShowBanner).toBe(false);
    expect(nk.drawn).toHaveLength(1);

    nk.press(nk.drawn[0]);
    await flushPromises();

    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls[0][0]).toEqual({ notificationId: '42', data: ORIGINAL, url: undefined, actionId: undefined });
    expect(tracked()).toEqual([{ notification_id: 42, event: 'opened', push_token: 'ExponentPushToken[abc]' }]);
  });

  it('records opened once even when the same tap also comes as the launch notification (AC 4)', async () => {
    const expo = expoMock();
    const nk = notifyKitMock();
    const sdk = load({ expo, notifyKit: nk });
    const client = makeClient(sdk);
    const opened = jest.fn();
    client.onNotificationOpened(opened);
    await sdk.createNotificationHandler()(androidPush());

    nk.press(nk.drawn[0]);
    await sdk.handleImagePushBackgroundEvent({ type: 1, detail: { notification: nk.drawn[0], pressAction: { id: 'default' } } });
    await flushPromises();

    expect(opened).toHaveBeenCalledTimes(1);
    expect(tracked()).toHaveLength(1);
  });

  it('reaches a client created after the tap, once, as a launch tap (IMG-05 AC 5)', async () => {
    const expo = expoMock();
    const nk = notifyKitMock();
    const sdk = load({ expo, notifyKit: nk });
    await sdk.createNotificationHandler()(androidPush());
    nk.press(nk.drawn[0]); // no client exists yet

    const client = makeClient(sdk);
    const opened = jest.fn();
    client.onNotificationOpened(opened);
    await flushPromises();

    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls[0][0].data).toEqual(ORIGINAL);
  });

  it('stops reporting taps once the client is destroyed', async () => {
    const expo = expoMock();
    const nk = notifyKitMock();
    const sdk = load({ expo, notifyKit: nk });
    const client = makeClient(sdk);
    const opened = jest.fn();
    client.onNotificationOpened(opened);
    await sdk.createNotificationHandler()(androidPush());

    client.destroy();
    nk.press(nk.drawn[0]);
    await flushPromises();

    expect(opened).not.toHaveBeenCalled();
  });
});

describe('what the SDK does not change (IMG-05 AC 7)', () => {
  it('still reports a tap on a notification expo-notifications drew, once, and a received one', async () => {
    const expo = expoMock();
    const nk = notifyKitMock();
    const sdk = load({ expo, notifyKit: nk });
    const client = makeClient(sdk);
    const opened = jest.fn();
    client.onNotificationOpened(opened);
    await sdk.createNotificationHandler()(androidPush());

    expo.fireResponse({
      actionIdentifier: DEFAULT_ACTION,
      notification: { date: 1_700_000_000, request: { identifier: 'req-2', content: { data: { notificationId: '7', k: 'v' } } } },
    });
    await flushPromises();

    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls[0][0]).toMatchObject({ notificationId: '7', data: { notificationId: '7', k: 'v' } });
    expect(expo.mod.addNotificationReceivedListener).toHaveBeenCalled();
  });

  it('does not touch notify-kit when the handler is created with bigPicture: false', async () => {
    const expo = expoMock();
    const nk = notifyKitMock();
    const sdk = load({ expo, notifyKit: nk });
    sdk.createNotificationHandler(undefined, { bigPicture: false });
    expect(nk.default.onBackgroundEvent).not.toHaveBeenCalled();
    expect(nk.default.onForegroundEvent).not.toHaveBeenCalled();
    expect(nk.default.getInitialNotification).not.toHaveBeenCalled();
  });

  it('registers the notify-kit listeners when the handler is created on Android', async () => {
    const expo = expoMock();
    const nk = notifyKitMock();
    const sdk = load({ expo, notifyKit: nk });
    sdk.createNotificationHandler();
    sdk.createNotificationHandler();
    expect(nk.default.onBackgroundEvent).toHaveBeenCalledTimes(1);
  });
});
