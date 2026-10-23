/**
 * Images in a push with the app open, on Android.
 *
 * With the app closed or in the background Android's FCM client draws the push itself, and a push that has an
 * image gets the large expandable picture. With the app open `expo-notifications` draws it, and it only
 * has a thumbnail (`setLargeIcon`). This module draws the large picture with `react-native-notify-kit`
 * in that one case, and tells `expo-notifications` not to draw the push again. Everything else (iOS,
 * a push without an image, an app without notify-kit) is left to `expo-notifications` as it was.
 *
 * Nothing here runs unless the app wraps its notification handler with `createNotificationHandler`.
 */

/** True for a plain object (not null, not an array). */
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The object a value carries: the object itself, or the object a JSON string holds; undefined for anything else. */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  if (isObject(value)) return value;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.charAt(0) !== '{') return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The most characters of an image URL the SDK passes on. */
const MAX_IMAGE_URL_LENGTH = 2048;

/** The URL when it is an https URL without spaces; undefined otherwise. */
function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const url = value.trim();
  if (url.length > MAX_IMAGE_URL_LENGTH || !/^https:\/\/[^\s/?#]+[^\s]*$/i.test(url)) return undefined;
  return url;
}

/** The `image` key of a value that is an object or a JSON string of one. */
function imageOf(value: unknown): unknown {
  return objectOf(value)?.image;
}

/**
 * The push data of an expo-notifications content, as the SDK reads it everywhere else: `data`, with the keys of
 * the JSON the Expo push service wraps in `body` (and `dataString`) merged in; a key at the top level wins.
 * A copy of `_unwrapPushData` in `index.ts`, which imports this module and so cannot be imported here.
 */
export function unwrapPushData(content: any): Record<string, unknown> {
  const base = isObject(content?.data) ? content.data : {};
  const wrapped = [objectOf(base.body), objectOf(base.dataString), objectOf(content?.dataString)];
  if (wrapped.every((w) => w === undefined)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const inner of wrapped) {
    if (!inner) continue;
    for (const key of Object.keys(inner)) if (!(key in out)) out[key] = inner[key];
  }
  return out;
}

/**
 * The https URL of the image of a push, from an expo-notifications notification, or undefined. The shapes, in the
 * order they are tried (the first one that holds an https URL wins):
 *  1. `request.trigger.remoteMessage.notification.imageUrl` (Android: the FCM message the Expo push service sends),
 *  2. `data.body._richContent.image` (the body the Expo push service wraps, an object or a JSON string),
 *  3. `data._richContent.image`, 4. `data.richContent.image`, 5. `data.image`, 6. `data.fcm_options.image`.
 * The values `_richContent`, `richContent` and `fcm_options` may be objects or JSON strings. Never throws.
 */
export function pickPushImage(notification: any): string | undefined {
  try {
    const request = notification?.request;
    const content = request?.content;
    const raw: Record<string, unknown> = isObject(content?.data) ? content.data : {};
    const body = objectOf(raw.body) ?? objectOf(raw.dataString) ?? objectOf(content?.dataString);
    const candidates: unknown[] = [
      request?.trigger?.remoteMessage?.notification?.imageUrl,
      imageOf(body?._richContent),
      imageOf(raw._richContent),
      imageOf(raw.richContent),
      raw.image,
      imageOf(raw.fcm_options),
    ];
    for (const candidate of candidates) {
      const url = httpsUrl(candidate);
      if (url) return url;
    }
  } catch { /* an unreadable notification has no image */ }
  return undefined;
}

// ─── The handler: the large picture with the app open ──────────────────────────────────────────────────────

/** React Native sets `__DEV__`: true in development, false in a production build; web and Node have none. */
declare const __DEV__: boolean | undefined;

/** What `expo-notifications` asks a notification handler for (the old `shouldShowAlert` and the two that replace it). */
export interface NotificationBehaviorLike {
  shouldShowBanner?: boolean;
  shouldShowList?: boolean;
  /** Deprecated in expo-notifications, still honored by older versions. */
  shouldShowAlert?: boolean;
  shouldPlaySound?: boolean;
  shouldSetBadge?: boolean;
  [key: string]: unknown;
}

/** The `handleNotification` of `Notifications.setNotificationHandler`. */
export type NotificationHandlerFn<B extends NotificationBehaviorLike = NotificationBehaviorLike> = (
  notification: any,
) => Promise<B> | B;

/** What the wrapped handler returns when the app has none: every field `expo-notifications` requires, set. */
export interface DefaultNotificationBehavior extends NotificationBehaviorLike {
  shouldShowBanner: boolean;
  shouldShowList: boolean;
  shouldPlaySound: boolean;
  shouldSetBadge: boolean;
}

export interface ImagePushOptions {
  /**
   * Draw the large picture with `react-native-notify-kit` when the app is open on Android. Default: **true**.
   * `false` leaves every push to expo-notifications, as if the handler were not wrapped.
   */
  bigPicture?: boolean;
  /**
   * The name of the Android drawable used as the small icon of the notification that notify-kit draws, tried before
   * `notification_icon` (the icon the config plugin of expo-notifications generates) and `ic_launcher`.
   */
  smallIcon?: string;
  /**
   * Register the listeners of notify-kit (the foreground and background events and the launch notification) so the
   * taps on the pictures reach the client. Default: **true**. `false` is for an app that handles notify-kit itself:
   * it forwards the events with `handleImagePushBackgroundEvent` and `handleImagePushInitialNotification`.
   */
  installListeners?: boolean;
}

/** What the handler returns for a push when the app has no handler of its own: show it, no sound, no badge. */
const DEFAULT_BEHAVIOR: DefaultNotificationBehavior = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

/** The marker the SDK puts in the `data` of a notification it draws, and the key that holds the original data as JSON. */
export const IMAGE_PUSH_MARKER = '_espressoImage';
export const IMAGE_PUSH_DATA_KEY = '_espressoData';

/** How long the SDK waits for notify-kit to draw before it counts the notification as drawn (it may still be downloading). */
const DISPLAY_WAIT_MS = 2500;

// The optional packages are required once, here at the top level and inside a `try` (a require that runs later, from a
// function, is fatal in a Metro release build when the package is absent: see optional-peers-load.test.ts, BUG-4).
let NotifyKit: any = null;
let NotifyKitAndroidStyle: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nk = require('react-native-notify-kit');
  NotifyKit = nk?.default && typeof nk.default.displayNotification === 'function' ? nk.default : null;
  NotifyKitAndroidStyle = nk?.AndroidStyle ?? null;
} catch { /* not installed: the push keeps the thumbnail of expo-notifications */ }

let RNPlatform: { OS?: string } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  RNPlatform = require('react-native')?.Platform ?? null;
} catch { /* not available: web or a test */ }

/** react-native-notify-kit, or null when it is not installed. */
function loadNotifyKit(): { kit: any; androidStyle: any } | null {
  return NotifyKit ? { kit: NotifyKit, androidStyle: NotifyKitAndroidStyle } : null;
}

/** True on Android. */
function isAndroid(): boolean {
  return RNPlatform?.OS === 'android';
}

/** True once the warning about a missing notify-kit was logged: it shows once per app run. */
let missingNotifyKitWarned = false;

function warnMissingNotifyKitOnce(): void {
  try {
    if (missingNotifyKitWarned) return;
    if (typeof __DEV__ === 'undefined' || __DEV__ !== true) return;
    missingNotifyKitWarned = true;
    console.warn(
      '[espresso-notify] A push with an image arrived with the app open, and react-native-notify-kit is not installed, ' +
        'so Android shows only a small thumbnail. Install react-native-notify-kit to show the large picture, or pass ' +
        '{ bigPicture: false } to createNotificationHandler to silence this warning.',
    );
  } catch { /* a logger that throws changes nothing */ }
}

/** True when the behavior the app chose shows nothing: no banner and no list (or the old alert switched off). */
function behaviorHides(behavior: NotificationBehaviorLike): boolean {
  if (behavior.shouldShowBanner === false && behavior.shouldShowList === false) return true;
  return behavior.shouldShowBanner === undefined && behavior.shouldShowList === undefined && behavior.shouldShowAlert === false;
}

/** The first non-empty string of the arguments. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === 'string' && value !== '') return value;
  return undefined;
}

/**
 * Draws the notification with notify-kit and the large picture. True when it was drawn (or is still being drawn after
 * 2.5 s); false when notify-kit is missing or refuses with every small icon.
 */
async function presentBigPicture(notification: any, imageUrl: string, options: ImagePushOptions): Promise<boolean> {
  const loaded = loadNotifyKit();
  if (!loaded) {
    warnMissingNotifyKitOnce();
    return false;
  }
  const request = notification?.request ?? {};
  const content = request.content ?? {};
  const channelId = firstString(request.trigger?.remoteMessage?.notification?.channelId) ?? 'default';
  const bigPicture = loaded.androidStyle?.BIGPICTURE ?? 0;
  const icons = [options.smallIcon, 'notification_icon', 'ic_launcher'].filter(
    (icon, index, all): icon is string => typeof icon === 'string' && icon !== '' && all.indexOf(icon) === index,
  );

  for (const smallIcon of icons) {
    try {
      const drawing: Promise<unknown> = Promise.resolve(
        loaded.kit.displayNotification({
          ...(firstString(request.identifier) ? { id: request.identifier } : {}),
          ...(firstString(content.title) ? { title: content.title } : {}),
          ...(firstString(content.body) ? { body: content.body } : {}),
          data: {
            [IMAGE_PUSH_MARKER]: '1',
            [IMAGE_PUSH_DATA_KEY]: JSON.stringify(unwrapPushData(content)),
          },
          android: {
            channelId,
            smallIcon,
            pressAction: { id: 'default', launchActivity: 'default' },
            style: { type: bigPicture, picture: imageUrl },
          },
        }),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DISPLAY_WAIT_MS);
      });
      try {
        await Promise.race([drawing, waited]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        drawing.catch(() => { /* a late refusal after the wait is not ours to handle */ });
      }
      return true;
    } catch { /* this icon was refused: try the next one */ }
  }
  return false;
}

/**
 * Wraps the notification handler of the app so a push with an image shows the large picture on Android with the app
 * open. Use it where you call `Notifications.setNotificationHandler`:
 *
 *     Notifications.setNotificationHandler({ handleNotification: createNotificationHandler(myHandler) })
 *
 * It calls `userHandler` (when there is none, it shows the push with no sound and no badge). If the app chose to show
 * the notification, the platform is Android, the push has an https image and `react-native-notify-kit` is installed,
 * notify-kit draws the notification with `AndroidStyle.BIGPICTURE` and the handler tells expo-notifications to draw
 * nothing, so the push shows once. In every other case the behavior of the app is returned unchanged, and a refusal
 * of notify-kit falls back to the thumbnail expo-notifications draws. With the app closed or in the background the
 * system draws the push and this code does not run. The taps on the notification this draws are reported as `opened`
 * by the client like any other.
 */
export function createNotificationHandler(
  userHandler?: undefined,
  options?: ImagePushOptions,
): (notification: any) => Promise<DefaultNotificationBehavior>;
export function createNotificationHandler<B extends NotificationBehaviorLike>(
  userHandler: NotificationHandlerFn<B>,
  options?: ImagePushOptions,
): (notification: any) => Promise<B>;
export function createNotificationHandler(
  userHandler?: NotificationHandlerFn,
  options: ImagePushOptions = {},
): (notification: any) => Promise<NotificationBehaviorLike> {
  // Listen for the taps now: the app creates the handler at the top of its root file, before a tap that launches it.
  if (options.bigPicture !== false && options.installListeners !== false && isAndroid()) installImagePush();
  return async (notification: any) => {
    const behavior: NotificationBehaviorLike = userHandler ? await userHandler(notification) : { ...DEFAULT_BEHAVIOR };
    if (options.bigPicture === false || !isAndroid()) return behavior;
    const imageUrl = pickPushImage(notification);
    if (!imageUrl || behaviorHides(behavior)) return behavior;
    const drawn = await presentBigPicture(notification, imageUrl, options);
    return drawn ? { ...behavior, shouldShowBanner: false, shouldShowList: false, shouldShowAlert: false } : behavior;
  };
}

// ─── The funnel of taps: from notify-kit to the client ─────────────────────────────────────────────────────

/** A tap on a notification the SDK drew. The same shape as `OpenedInfo` of `index.ts`, which takes it as is. */
export interface ImagePushOpenedInfo {
  notificationId?: string | number;
  /** `default` for the notification itself, the id of the button otherwise. */
  actionId?: string;
  /** The push data the app sent, as it was before the SDK drew the notification. */
  data?: Record<string, unknown>;
  /** True for a tap that came before any client existed (the app was being launched). */
  coldStart?: boolean;
}

/** The events of notify-kit. */
type NotifyKitEvent = { type?: number; detail?: any };

const EVENT_PRESS = 1;
const EVENT_ACTION_PRESS = 2;

/** The same tap reaches the app by up to two paths (the background event and the launch notification); this long it is one. */
const DUPLICATE_WINDOW_MS = 10_000;
/** The most taps kept for a client that does not exist yet, and the most recent keys kept to tell duplicates. */
const MAX_PENDING_TAPS = 20;
const MAX_RECENT_KEYS = 50;

const tapListeners = new Set<(info: ImagePushOpenedInfo) => void>();
let pendingTaps: ImagePushOpenedInfo[] = [];
let recentTaps: Array<{ key: string; at: number }> = [];
let imagePushInstalled = false;

/** True when the notification of notify-kit is one the SDK drew. */
function isImagePushNotification(notification: any): boolean {
  return notification?.data?.[IMAGE_PUSH_MARKER] === '1';
}

/** The id an Espresso Notify push carries in its data. */
function notificationIdOf(data: Record<string, unknown>): string | number | undefined {
  const id = data.notificationId ?? data.notification_id;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

/** True when the tap `key` was seen less than the window ago; records it otherwise. */
function isDuplicateTap(key: string | undefined): boolean {
  if (key === undefined) return false;
  const now = Date.now();
  recentTaps = recentTaps.filter((entry) => now - entry.at < DUPLICATE_WINDOW_MS);
  if (recentTaps.some((entry) => entry.key === key)) return true;
  recentTaps.push({ key, at: now });
  if (recentTaps.length > MAX_RECENT_KEYS) recentTaps.shift();
  return false;
}

/** Hands a tap to the clients; with none, keeps it for the first one. */
function emitTap(info: ImagePushOpenedInfo): void {
  if (tapListeners.size === 0) {
    pendingTaps.push({ ...info, coldStart: true });
    if (pendingTaps.length > MAX_PENDING_TAPS) pendingTaps.shift();
    return;
  }
  for (const listener of [...tapListeners]) {
    try {
      listener(info);
    } catch { /* a client that throws does not stop the others */ }
  }
}

/** One event or launch notification of notify-kit: ignored unless it is a tap on a notification of the SDK. */
function receiveNotifyKitTap(event: NotifyKitEvent, launch: boolean): void {
  try {
    if (event?.type !== EVENT_PRESS && event?.type !== EVENT_ACTION_PRESS) return;
    const notification = event.detail?.notification;
    if (!isImagePushNotification(notification)) return;
    const actionId: string = event.detail?.pressAction?.id ?? 'default';
    if (isDuplicateTap(notification?.id === undefined ? undefined : `${String(notification.id)}|${actionId}`)) return;
    const data = objectOf(notification.data?.[IMAGE_PUSH_DATA_KEY]) ?? {};
    const info: ImagePushOpenedInfo = { notificationId: notificationIdOf(data), actionId, data };
    if (launch) info.coldStart = true;
    emitTap(info);
  } catch { /* an event the SDK cannot read is not a tap */ }
}

/**
 * Subscribes to the taps on notifications the SDK drew; `ExpoDisplayAdapter` does it for the client. A tap that came
 * before any subscriber is handed to the first one, once, with `coldStart` true. Returns the unsubscribe.
 */
export function subscribeImagePushTaps(listener: (info: ImagePushOpenedInfo) => void): () => void {
  tapListeners.add(listener);
  if (pendingTaps.length > 0) {
    const waiting = pendingTaps;
    pendingTaps = [];
    for (const info of waiting) {
      try {
        listener(info);
      } catch { /* a client that throws does not lose the others */ }
    }
  }
  return () => {
    tapListeners.delete(listener);
  };
}

/**
 * For an app that registers its own `onBackgroundEvent` in notify-kit (only one handler exists, and the last one
 * registered wins): call this with the event from inside it, so the taps on the push images are still reported.
 * Any event of notify-kit can be passed, the foreground ones too; whatever is not a tap on a notification of the SDK is ignored.
 */
export async function handleImagePushBackgroundEvent(event: NotifyKitEvent): Promise<void> {
  receiveNotifyKitTap(event, false);
}

/** The launch notification of notify-kit that is not the SDK's, kept for `getForeignInitialNotification`. */
let foreignInitial: any = null;
/** The read of the launch notification that `installImagePush` started, so a caller can wait for it. */
let initialRead: Promise<void> | null = null;

/** Handles a launch notification of notify-kit: a tap on one of the SDK's is delivered; anything else is kept for the app. */
function receiveInitialNotification(initial: any): boolean {
  if (!initial?.notification) return false;
  if (!isImagePushNotification(initial.notification)) return false;
  receiveNotifyKitTap({ type: EVENT_PRESS, detail: initial }, true);
  return true;
}

/**
 * For an app that reads `getInitialNotification()` of notify-kit itself: pass what it returned. A notification the
 * SDK drew is reported as a tap with `coldStart` and the function returns true; for any other (or null) it returns
 * false and the app handles it.
 */
export function handleImagePushInitialNotification(initial: any): boolean {
  try {
    return receiveInitialNotification(initial);
  } catch {
    return false;
  }
}

/**
 * The notification that launched the app, when it is not one the SDK drew: use it where you called notify-kit's
 * `getInitialNotification()`. notify-kit hands that notification out once and the SDK reads it first when it installed
 * its listeners, so a second reader gets null. Like notify-kit it returns the notification once, then null. A launch
 * notification of the SDK is reported as a tap and this returns null for it. Without notify-kit it returns null.
 */
export async function getForeignInitialNotification(): Promise<any> {
  try {
    if (initialRead) {
      await initialRead;
      const kept = foreignInitial;
      foreignInitial = null;
      return kept;
    }
    const loaded = loadNotifyKit();
    if (!loaded) return null;
    const initial = await loaded.kit.getInitialNotification?.();
    if (!initial?.notification || receiveInitialNotification(initial)) return null;
    return initial;
  } catch {
    return null;
  }
}

/**
 * Starts listening to notify-kit for the taps on the notifications the SDK draws: the foreground and background
 * events and the notification that launched the app. Safe to call again; does nothing without notify-kit. It
 * registers the one `onBackgroundEvent` handler of notify-kit (replacing one the app registered earlier, so an app
 * that has its own registers it after this and forwards, or passes `installListeners: false`), and reads (so
 * consumes) `getInitialNotification()` once: a launch notification that is not the SDK's is kept for `getForeignInitialNotification()`.
 */
export function installImagePush(): void {
  if (imagePushInstalled) return;
  const loaded = loadNotifyKit();
  if (!loaded) return;
  imagePushInstalled = true;
  const { kit } = loaded;
  try {
    kit.onBackgroundEvent?.(async (event: NotifyKitEvent) => receiveNotifyKitTap(event, false));
  } catch { /* best-effort */ }
  try {
    kit.onForegroundEvent?.((event: NotifyKitEvent) => receiveNotifyKitTap(event, false));
  } catch { /* best-effort */ }
  try {
    initialRead = Promise.resolve(kit.getInitialNotification?.())
      .then((initial: any) => {
        if (initial?.notification && !receiveInitialNotification(initial)) foreignInitial = initial;
      })
      .catch(() => { /* best-effort */ });
  } catch { /* best-effort */ }
}
