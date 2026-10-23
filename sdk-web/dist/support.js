"use strict";
/**
 * What the browser can do with Web Push, and where the permission stands.
 *
 * Every function here reads the browser and nothing else: none of them asks for a permission,
 * registers a worker or calls the network. The one that asks, `requestPermission()`, has to be
 * called from a user gesture (a click or a tap) and is never called by this package on its own:
 * browsers refuse a prompt that was not asked for by the user, and Safari and Firefox show nothing
 * at all for it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubscribeError = void 0;
exports.getSupport = getSupport;
exports.isSupported = isSupported;
exports.getPermissionState = getPermissionState;
exports.requestPermission = requestPermission;
/** Thrown by `subscribe()` (which keeps its throwing contract); `trySubscribe()` returns the same reason instead. */
class SubscribeError extends Error {
    constructor(reason, message, original) {
        super(message);
        this.name = "SubscribeError";
        this.reason = reason;
        this.original = original;
    }
}
exports.SubscribeError = SubscribeError;
function browser() {
    return globalThis;
}
/** iPhone, iPod and iPad, including the iPad that presents itself as a Mac. */
function isIos(b) {
    var _a, _b;
    const nav = b.navigator;
    if (!nav)
        return false;
    if (/iPad|iPhone|iPod/.test((_a = nav.userAgent) !== null && _a !== void 0 ? _a : ""))
        return true;
    return nav.platform === "MacIntel" && ((_b = nav.maxTouchPoints) !== null && _b !== void 0 ? _b : 0) > 1;
}
/** True when the page runs as an app installed on the home screen. */
function isInstalledApp(b) {
    var _a, _b;
    if (((_a = b.navigator) === null || _a === void 0 ? void 0 : _a.standalone) === true)
        return true;
    try {
        return ((_b = b.matchMedia) === null || _b === void 0 ? void 0 : _b.call(b, "(display-mode: standalone)").matches) === true;
    }
    catch (_c) {
        return false;
    }
}
/**
 * Whether this browser can do Web Push, and if it cannot, why. On iOS and iPadOS (16.4 and later)
 * Web Push works only for a site added to the home screen: in a Safari tab the answer is
 * `ios_requires_installed_app`, and the page should tell the visitor to install it.
 */
function getSupport() {
    const b = browser();
    if (isIos(b) && !isInstalledApp(b))
        return { supported: false, reason: "ios_requires_installed_app" };
    if (!b.navigator || !("serviceWorker" in b.navigator))
        return { supported: false, reason: "no_service_worker" };
    if (typeof b.PushManager === "undefined")
        return { supported: false, reason: "no_push_manager" };
    if (typeof b.Notification === "undefined")
        return { supported: false, reason: "no_notification" };
    return { supported: true };
}
/** True when `getSupport()` finds nothing missing. */
function isSupported() {
    return getSupport().supported;
}
/** The permission of the site, without asking for it. */
function getPermissionState() {
    var _a;
    if (!isSupported())
        return "unsupported";
    const permission = (_a = browser().Notification) === null || _a === void 0 ? void 0 : _a.permission;
    return permission === "granted" || permission === "denied" ? permission : "default";
}
/**
 * Asks the visitor for the permission and returns where it stands afterwards. Call it from a user
 * gesture, for example the click handler of an "Enable notifications" button; a call made on page
 * load is ignored or penalized by browsers. Resolves `unsupported` without prompting when the
 * browser cannot do Web Push.
 */
async function requestPermission() {
    if (!isSupported())
        return "unsupported";
    const notification = browser().Notification;
    if (!(notification === null || notification === void 0 ? void 0 : notification.requestPermission))
        return getPermissionState();
    // Old Safari answers through a callback, current browsers through a promise: take whichever comes.
    await new Promise((resolve) => {
        const returned = notification.requestPermission(() => resolve());
        if (returned && typeof returned.then === "function") {
            returned.then(() => resolve(), () => resolve());
        }
    });
    return getPermissionState();
}
