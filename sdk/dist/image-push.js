"use strict";
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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var _a, _b, _c;
Object.defineProperty(exports, "__esModule", { value: true });
exports.IMAGE_PUSH_DATA_KEY = exports.IMAGE_PUSH_MARKER = void 0;
exports.unwrapPushData = unwrapPushData;
exports.pickPushImage = pickPushImage;
exports.createNotificationHandler = createNotificationHandler;
exports.subscribeImagePushTaps = subscribeImagePushTaps;
exports.handleImagePushBackgroundEvent = handleImagePushBackgroundEvent;
exports.handleImagePushInitialNotification = handleImagePushInitialNotification;
exports.getForeignInitialNotification = getForeignInitialNotification;
exports.installImagePush = installImagePush;
/** True for a plain object (not null, not an array). */
function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
/** The object a value carries: the object itself, or the object a JSON string holds; undefined for anything else. */
function objectOf(value) {
    if (isObject(value))
        return value;
    if (typeof value !== 'string')
        return undefined;
    const text = value.trim();
    if (text.charAt(0) !== '{')
        return undefined;
    try {
        const parsed = JSON.parse(text);
        return isObject(parsed) ? parsed : undefined;
    }
    catch (_a) {
        return undefined;
    }
}
/** The most characters of an image URL the SDK passes on. */
const MAX_IMAGE_URL_LENGTH = 2048;
/** The URL when it is an https URL without spaces; undefined otherwise. */
function httpsUrl(value) {
    if (typeof value !== 'string')
        return undefined;
    const url = value.trim();
    if (url.length > MAX_IMAGE_URL_LENGTH || !/^https:\/\/[^\s/?#]+[^\s]*$/i.test(url))
        return undefined;
    return url;
}
/** The `image` key of a value that is an object or a JSON string of one. */
function imageOf(value) {
    var _a;
    return (_a = objectOf(value)) === null || _a === void 0 ? void 0 : _a.image;
}
/**
 * The push data of an expo-notifications content, as the SDK reads it everywhere else: `data`, with the keys of
 * the JSON the Expo push service wraps in `body` (and `dataString`) merged in; a key at the top level wins.
 * A copy of `_unwrapPushData` in `index.ts`, which imports this module and so cannot be imported here.
 */
function unwrapPushData(content) {
    const base = isObject(content === null || content === void 0 ? void 0 : content.data) ? content.data : {};
    const wrapped = [objectOf(base.body), objectOf(base.dataString), objectOf(content === null || content === void 0 ? void 0 : content.dataString)];
    if (wrapped.every((w) => w === undefined))
        return base;
    const out = Object.assign({}, base);
    for (const inner of wrapped) {
        if (!inner)
            continue;
        for (const key of Object.keys(inner))
            if (!(key in out))
                out[key] = inner[key];
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
function pickPushImage(notification) {
    var _a, _b, _c, _d, _e;
    try {
        const request = notification === null || notification === void 0 ? void 0 : notification.request;
        const content = request === null || request === void 0 ? void 0 : request.content;
        const raw = isObject(content === null || content === void 0 ? void 0 : content.data) ? content.data : {};
        const body = (_b = (_a = objectOf(raw.body)) !== null && _a !== void 0 ? _a : objectOf(raw.dataString)) !== null && _b !== void 0 ? _b : objectOf(content === null || content === void 0 ? void 0 : content.dataString);
        const candidates = [
            (_e = (_d = (_c = request === null || request === void 0 ? void 0 : request.trigger) === null || _c === void 0 ? void 0 : _c.remoteMessage) === null || _d === void 0 ? void 0 : _d.notification) === null || _e === void 0 ? void 0 : _e.imageUrl,
            imageOf(body === null || body === void 0 ? void 0 : body._richContent),
            imageOf(raw._richContent),
            imageOf(raw.richContent),
            raw.image,
            imageOf(raw.fcm_options),
        ];
        for (const candidate of candidates) {
            const url = httpsUrl(candidate);
            if (url)
                return url;
        }
    }
    catch ( /* an unreadable notification has no image */_f) { /* an unreadable notification has no image */ }
    return undefined;
}
/** What the handler returns for a push when the app has no handler of its own: show it, no sound, no badge. */
const DEFAULT_BEHAVIOR = {
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
};
/** The marker the SDK puts in the `data` of a notification it draws, and the key that holds the original data as JSON. */
exports.IMAGE_PUSH_MARKER = '_espressoImage';
exports.IMAGE_PUSH_DATA_KEY = '_espressoData';
/** How long the SDK waits for notify-kit to draw before it counts the notification as drawn (it may still be downloading). */
const DISPLAY_WAIT_MS = 2500;
// The optional packages are required once, here at the top level and inside a `try` (a require that runs later, from a
// function, is fatal in a Metro release build when the package is absent: see optional-peers-load.test.ts, BUG-4).
let NotifyKit = null;
let NotifyKitAndroidStyle = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nk = require('react-native-notify-kit');
    NotifyKit = (nk === null || nk === void 0 ? void 0 : nk.default) && typeof nk.default.displayNotification === 'function' ? nk.default : null;
    NotifyKitAndroidStyle = (_a = nk === null || nk === void 0 ? void 0 : nk.AndroidStyle) !== null && _a !== void 0 ? _a : null;
}
catch ( /* not installed: the push keeps the thumbnail of expo-notifications */_d) { /* not installed: the push keeps the thumbnail of expo-notifications */ }
let RNPlatform = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    RNPlatform = (_c = (_b = require('react-native')) === null || _b === void 0 ? void 0 : _b.Platform) !== null && _c !== void 0 ? _c : null;
}
catch ( /* not available: web or a test */_e) { /* not available: web or a test */ }
/** react-native-notify-kit, or null when it is not installed. */
function loadNotifyKit() {
    return NotifyKit ? { kit: NotifyKit, androidStyle: NotifyKitAndroidStyle } : null;
}
/** True on Android. */
function isAndroid() {
    return (RNPlatform === null || RNPlatform === void 0 ? void 0 : RNPlatform.OS) === 'android';
}
/** True once the warning about a missing notify-kit was logged: it shows once per app run. */
let missingNotifyKitWarned = false;
function warnMissingNotifyKitOnce() {
    try {
        if (missingNotifyKitWarned)
            return;
        if (typeof __DEV__ === 'undefined' || __DEV__ !== true)
            return;
        missingNotifyKitWarned = true;
        console.warn('[espresso-notify] A push with an image arrived with the app open, and react-native-notify-kit is not installed, ' +
            'so Android shows only a small thumbnail. Install react-native-notify-kit to show the large picture, or pass ' +
            '{ bigPicture: false } to createNotificationHandler to silence this warning.');
    }
    catch ( /* a logger that throws changes nothing */_a) { /* a logger that throws changes nothing */ }
}
/** True when the behavior the app chose shows nothing: no banner and no list (or the old alert switched off). */
function behaviorHides(behavior) {
    if (behavior.shouldShowBanner === false && behavior.shouldShowList === false)
        return true;
    return behavior.shouldShowBanner === undefined && behavior.shouldShowList === undefined && behavior.shouldShowAlert === false;
}
/** The first non-empty string of the arguments. */
function firstString(...values) {
    for (const value of values)
        if (typeof value === 'string' && value !== '')
            return value;
    return undefined;
}
/**
 * Draws the notification with notify-kit and the large picture. True when it was drawn (or is still being drawn after
 * 2.5 s); false when notify-kit is missing or refuses with every small icon.
 */
function presentBigPicture(notification, imageUrl, options) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const loaded = loadNotifyKit();
        if (!loaded) {
            warnMissingNotifyKitOnce();
            return false;
        }
        const request = (_a = notification === null || notification === void 0 ? void 0 : notification.request) !== null && _a !== void 0 ? _a : {};
        const content = (_b = request.content) !== null && _b !== void 0 ? _b : {};
        const channelId = (_f = firstString((_e = (_d = (_c = request.trigger) === null || _c === void 0 ? void 0 : _c.remoteMessage) === null || _d === void 0 ? void 0 : _d.notification) === null || _e === void 0 ? void 0 : _e.channelId)) !== null && _f !== void 0 ? _f : 'default';
        const bigPicture = (_h = (_g = loaded.androidStyle) === null || _g === void 0 ? void 0 : _g.BIGPICTURE) !== null && _h !== void 0 ? _h : 0;
        const icons = [options.smallIcon, 'notification_icon', 'ic_launcher'].filter((icon, index, all) => typeof icon === 'string' && icon !== '' && all.indexOf(icon) === index);
        for (const smallIcon of icons) {
            try {
                const drawing = Promise.resolve(loaded.kit.displayNotification(Object.assign(Object.assign(Object.assign(Object.assign({}, (firstString(request.identifier) ? { id: request.identifier } : {})), (firstString(content.title) ? { title: content.title } : {})), (firstString(content.body) ? { body: content.body } : {})), { data: {
                        [exports.IMAGE_PUSH_MARKER]: '1',
                        [exports.IMAGE_PUSH_DATA_KEY]: JSON.stringify(unwrapPushData(content)),
                    }, android: {
                        channelId,
                        smallIcon,
                        pressAction: { id: 'default', launchActivity: 'default' },
                        style: { type: bigPicture, picture: imageUrl },
                    } })));
                let timer;
                const waited = new Promise((resolve) => {
                    timer = setTimeout(resolve, DISPLAY_WAIT_MS);
                });
                try {
                    yield Promise.race([drawing, waited]);
                }
                finally {
                    if (timer !== undefined)
                        clearTimeout(timer);
                    drawing.catch(() => { });
                }
                return true;
            }
            catch ( /* this icon was refused: try the next one */_j) { /* this icon was refused: try the next one */ }
        }
        return false;
    });
}
function createNotificationHandler(userHandler, options = {}) {
    // Listen for the taps now: the app creates the handler at the top of its root file, before a tap that launches it.
    if (options.bigPicture !== false && options.installListeners !== false && isAndroid())
        installImagePush();
    return (notification) => __awaiter(this, void 0, void 0, function* () {
        const behavior = userHandler ? yield userHandler(notification) : Object.assign({}, DEFAULT_BEHAVIOR);
        if (options.bigPicture === false || !isAndroid())
            return behavior;
        const imageUrl = pickPushImage(notification);
        if (!imageUrl || behaviorHides(behavior))
            return behavior;
        const drawn = yield presentBigPicture(notification, imageUrl, options);
        return drawn ? Object.assign(Object.assign({}, behavior), { shouldShowBanner: false, shouldShowList: false, shouldShowAlert: false }) : behavior;
    });
}
const EVENT_PRESS = 1;
const EVENT_ACTION_PRESS = 2;
/** The same tap reaches the app by up to two paths (the background event and the launch notification); this long it is one. */
const DUPLICATE_WINDOW_MS = 10000;
/** The most taps kept for a client that does not exist yet, and the most recent keys kept to tell duplicates. */
const MAX_PENDING_TAPS = 20;
const MAX_RECENT_KEYS = 50;
const tapListeners = new Set();
let pendingTaps = [];
let recentTaps = [];
let imagePushInstalled = false;
/** True when the notification of notify-kit is one the SDK drew. */
function isImagePushNotification(notification) {
    var _a;
    return ((_a = notification === null || notification === void 0 ? void 0 : notification.data) === null || _a === void 0 ? void 0 : _a[exports.IMAGE_PUSH_MARKER]) === '1';
}
/** The id an Espresso Notify push carries in its data. */
function notificationIdOf(data) {
    var _a;
    const id = (_a = data.notificationId) !== null && _a !== void 0 ? _a : data.notification_id;
    return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}
/** True when the tap `key` was seen less than the window ago; records it otherwise. */
function isDuplicateTap(key) {
    if (key === undefined)
        return false;
    const now = Date.now();
    recentTaps = recentTaps.filter((entry) => now - entry.at < DUPLICATE_WINDOW_MS);
    if (recentTaps.some((entry) => entry.key === key))
        return true;
    recentTaps.push({ key, at: now });
    if (recentTaps.length > MAX_RECENT_KEYS)
        recentTaps.shift();
    return false;
}
/** Hands a tap to the clients; with none, keeps it for the first one. */
function emitTap(info) {
    if (tapListeners.size === 0) {
        pendingTaps.push(Object.assign(Object.assign({}, info), { coldStart: true }));
        if (pendingTaps.length > MAX_PENDING_TAPS)
            pendingTaps.shift();
        return;
    }
    for (const listener of [...tapListeners]) {
        try {
            listener(info);
        }
        catch ( /* a client that throws does not stop the others */_a) { /* a client that throws does not stop the others */ }
    }
}
/** One event or launch notification of notify-kit: ignored unless it is a tap on a notification of the SDK. */
function receiveNotifyKitTap(event, launch) {
    var _a, _b, _c, _d, _e, _f;
    try {
        if ((event === null || event === void 0 ? void 0 : event.type) !== EVENT_PRESS && (event === null || event === void 0 ? void 0 : event.type) !== EVENT_ACTION_PRESS)
            return;
        const notification = (_a = event.detail) === null || _a === void 0 ? void 0 : _a.notification;
        if (!isImagePushNotification(notification))
            return;
        const actionId = (_d = (_c = (_b = event.detail) === null || _b === void 0 ? void 0 : _b.pressAction) === null || _c === void 0 ? void 0 : _c.id) !== null && _d !== void 0 ? _d : 'default';
        if (isDuplicateTap((notification === null || notification === void 0 ? void 0 : notification.id) === undefined ? undefined : `${String(notification.id)}|${actionId}`))
            return;
        const data = (_f = objectOf((_e = notification.data) === null || _e === void 0 ? void 0 : _e[exports.IMAGE_PUSH_DATA_KEY])) !== null && _f !== void 0 ? _f : {};
        const info = { notificationId: notificationIdOf(data), actionId, data };
        if (launch)
            info.coldStart = true;
        emitTap(info);
    }
    catch ( /* an event the SDK cannot read is not a tap */_g) { /* an event the SDK cannot read is not a tap */ }
}
/**
 * Subscribes to the taps on notifications the SDK drew; `ExpoDisplayAdapter` does it for the client. A tap that came
 * before any subscriber is handed to the first one, once, with `coldStart` true. Returns the unsubscribe.
 */
function subscribeImagePushTaps(listener) {
    tapListeners.add(listener);
    if (pendingTaps.length > 0) {
        const waiting = pendingTaps;
        pendingTaps = [];
        for (const info of waiting) {
            try {
                listener(info);
            }
            catch ( /* a client that throws does not lose the others */_a) { /* a client that throws does not lose the others */ }
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
function handleImagePushBackgroundEvent(event) {
    return __awaiter(this, void 0, void 0, function* () {
        receiveNotifyKitTap(event, false);
    });
}
/** The launch notification of notify-kit that is not the SDK's, kept for `getForeignInitialNotification`. */
let foreignInitial = null;
/** The read of the launch notification that `installImagePush` started, so a caller can wait for it. */
let initialRead = null;
/** Handles a launch notification of notify-kit: a tap on one of the SDK's is delivered; anything else is kept for the app. */
function receiveInitialNotification(initial) {
    if (!(initial === null || initial === void 0 ? void 0 : initial.notification))
        return false;
    if (!isImagePushNotification(initial.notification))
        return false;
    receiveNotifyKitTap({ type: EVENT_PRESS, detail: initial }, true);
    return true;
}
/**
 * For an app that reads `getInitialNotification()` of notify-kit itself: pass what it returned. A notification the
 * SDK drew is reported as a tap with `coldStart` and the function returns true; for any other (or null) it returns
 * false and the app handles it.
 */
function handleImagePushInitialNotification(initial) {
    try {
        return receiveInitialNotification(initial);
    }
    catch (_a) {
        return false;
    }
}
/**
 * The notification that launched the app, when it is not one the SDK drew: use it where you called notify-kit's
 * `getInitialNotification()`. notify-kit hands that notification out once and the SDK reads it first when it installed
 * its listeners, so a second reader gets null. Like notify-kit it returns the notification once, then null. A launch
 * notification of the SDK is reported as a tap and this returns null for it. Without notify-kit it returns null.
 */
function getForeignInitialNotification() {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        try {
            if (initialRead) {
                yield initialRead;
                const kept = foreignInitial;
                foreignInitial = null;
                return kept;
            }
            const loaded = loadNotifyKit();
            if (!loaded)
                return null;
            const initial = yield ((_b = (_a = loaded.kit).getInitialNotification) === null || _b === void 0 ? void 0 : _b.call(_a));
            if (!(initial === null || initial === void 0 ? void 0 : initial.notification) || receiveInitialNotification(initial))
                return null;
            return initial;
        }
        catch (_c) {
            return null;
        }
    });
}
/**
 * Starts listening to notify-kit for the taps on the notifications the SDK draws: the foreground and background
 * events and the notification that launched the app. Safe to call again; does nothing without notify-kit. It
 * registers the one `onBackgroundEvent` handler of notify-kit (replacing one the app registered earlier, so an app
 * that has its own registers it after this and forwards, or passes `installListeners: false`), and reads (so
 * consumes) `getInitialNotification()` once: a launch notification that is not the SDK's is kept for `getForeignInitialNotification()`.
 */
function installImagePush() {
    var _a, _b, _c;
    if (imagePushInstalled)
        return;
    const loaded = loadNotifyKit();
    if (!loaded)
        return;
    imagePushInstalled = true;
    const { kit } = loaded;
    try {
        (_a = kit.onBackgroundEvent) === null || _a === void 0 ? void 0 : _a.call(kit, (event) => __awaiter(this, void 0, void 0, function* () { return receiveNotifyKitTap(event, false); }));
    }
    catch ( /* best-effort */_d) { /* best-effort */ }
    try {
        (_b = kit.onForegroundEvent) === null || _b === void 0 ? void 0 : _b.call(kit, (event) => receiveNotifyKitTap(event, false));
    }
    catch ( /* best-effort */_e) { /* best-effort */ }
    try {
        initialRead = Promise.resolve((_c = kit.getInitialNotification) === null || _c === void 0 ? void 0 : _c.call(kit))
            .then((initial) => {
            if ((initial === null || initial === void 0 ? void 0 : initial.notification) && !receiveInitialNotification(initial))
                foreignInitial = initial;
        })
            .catch(() => { });
    }
    catch ( /* best-effort */_f) { /* best-effort */ }
}
