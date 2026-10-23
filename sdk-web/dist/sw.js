"use strict";
const ACTION_ID = /^[A-Za-z0-9_-]{1,32}$/;
const TAG = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_ACTIONS = 3;
const MAX_ACTION_TITLE = 60;
const MAX_BADGE_COUNT = 999999;
const FALLBACK_ICON = "/favicon.ico";
const API_URL = "https://api.espressonotify.com";
function readPayload(event) {
    try {
        const parsed = event.data ? event.data.json() : null;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            return parsed;
    }
    catch (_a) { }
    return null;
}
function text(value) {
    return typeof value === "string" ? value : "";
}
function addPresentation(options, payload) {
    var _a;
    const tag = payload === null || payload === void 0 ? void 0 : payload.tag;
    if (typeof tag === "string" && TAG.test(tag)) {
        options.tag = tag;
        options.renotify = true;
    }
    const badge = safeTarget(payload === null || payload === void 0 ? void 0 : payload.badge, self.location.origin);
    if (badge && typeof (payload === null || payload === void 0 ? void 0 : payload.badge) === "string")
        options.badge = badge;
    const raw = payload === null || payload === void 0 ? void 0 : payload.actions;
    if (!Array.isArray(raw))
        return;
    const supported = (_a = self.Notification) === null || _a === void 0 ? void 0 : _a.maxActions;
    const room = Number.isInteger(supported) && supported >= 0 ? Math.min(supported, MAX_ACTIONS) : MAX_ACTIONS;
    const buttons = [];
    const targets = {};
    const seen = new Set();
    for (const entry of raw) {
        if (buttons.length >= room)
            break;
        if (!entry || typeof entry !== "object")
            continue;
        const id = entry.action;
        const title = entry.title;
        if (typeof id !== "string" || !ACTION_ID.test(id) || seen.has(id))
            continue;
        if (typeof title !== "string" || !title.trim())
            continue;
        seen.add(id);
        buttons.push({ action: id, title: title.trim().slice(0, MAX_ACTION_TITLE) });
        const target = safeTarget(entry.url, self.location.origin);
        if (target)
            targets[id] = target;
    }
    if (buttons.length === 0)
        return;
    options.actions = buttons;
    if (Object.keys(targets).length > 0)
        options.data.actions = targets;
}
async function setAppBadge(count) {
    var _a;
    try {
        if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_BADGE_COUNT)
            return;
        if (typeof ((_a = self.navigator) === null || _a === void 0 ? void 0 : _a.setAppBadge) === "function")
            await self.navigator.setAppBadge(count);
    }
    catch (_b) { }
}
async function clearAppBadge() {
    var _a;
    try {
        if (typeof ((_a = self.navigator) === null || _a === void 0 ? void 0 : _a.clearAppBadge) === "function")
            await self.navigator.clearAppBadge();
    }
    catch (_b) { }
}
async function handlePush(payload) {
    var _a;
    try {
        const title = text(payload === null || payload === void 0 ? void 0 : payload.title) || ((_a = self.location) === null || _a === void 0 ? void 0 : _a.hostname) || "Notification";
        const options = {
            body: text(payload === null || payload === void 0 ? void 0 : payload.body),
            icon: text(payload === null || payload === void 0 ? void 0 : payload.icon) || FALLBACK_ICON,
            data: {
                url: text(payload === null || payload === void 0 ? void 0 : payload.url) || undefined,
                notificationId: typeof (payload === null || payload === void 0 ? void 0 : payload.notificationId) === "number" ? payload.notificationId : undefined,
            },
        };
        const image = text(payload === null || payload === void 0 ? void 0 : payload.image);
        if (image)
            options.image = image;
        addPresentation(options, payload);
        await self.registration.showNotification(title, options);
    }
    catch (_b) { }
    await setAppBadge(payload === null || payload === void 0 ? void 0 : payload.badgeCount);
    if (!payload)
        return;
    try {
        const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        windowClients.forEach((c) => {
            try {
                c.postMessage({ type: "espresso:push", data: payload });
            }
            catch (_a) { }
        });
    }
    catch (_c) { }
}
self.addEventListener("push", (event) => {
    const pushEvent = event;
    pushEvent.waitUntil(handlePush(readPayload(pushEvent)));
});
async function track(notificationId) {
    if (typeof notificationId !== "number" || !API_URL || API_URL.startsWith("__"))
        return;
    try {
        const sub = await self.registration.pushManager.getSubscription();
        if (!sub)
            return;
        await Promise.all(["opened", "clicked"].map((eventType) => fetch(`${API_URL}/v1/notifications/track-web`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ notification_id: notificationId, event_type: eventType, endpoint: sub.endpoint }),
            keepalive: true,
        }).catch(() => { })));
    }
    catch (_a) { }
}
function withoutHash(href) {
    const u = new URL(href);
    u.hash = "";
    return u.href;
}
function safeTarget(url, origin) {
    try {
        if (typeof url !== "string" || !url)
            return "";
        const parsed = new URL(url, origin);
        const sameOrigin = parsed.origin === origin;
        if (parsed.protocol === "https:" || (parsed.protocol === "http:" && sameOrigin))
            return parsed.href;
    }
    catch (_a) { }
    return "";
}
async function openTarget(url) {
    var _a;
    const origin = self.location.origin;
    let target = safeTarget(url, origin);
    const toRoot = target === "";
    if (toRoot)
        target = `${origin}/`;
    try {
        const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        const sameUrl = (c) => {
            try {
                return withoutHash(c.url) === withoutHash(target);
            }
            catch (_a) {
                return false;
            }
        };
        const sameOrigin = (c) => {
            try {
                return new URL(c.url).origin === origin;
            }
            catch (_a) {
                return false;
            }
        };
        const existing = (_a = windowClients.find(sameUrl)) !== null && _a !== void 0 ? _a : (toRoot ? windowClients.find(sameOrigin) : undefined);
        if (existing) {
            await existing.focus();
            return;
        }
    }
    catch (_b) { }
    try {
        await self.clients.openWindow(target);
    }
    catch (_c) { }
}
function buttonTarget(action, targets) {
    if (typeof action !== "string" || !action || !targets || typeof targets !== "object")
        return undefined;
    return Object.prototype.hasOwnProperty.call(targets, action) ? targets[action] : undefined;
}
self.addEventListener("notificationclick", (event) => {
    var _a, _b;
    const notifEvent = event;
    try {
        notifEvent.notification.close();
    }
    catch (_c) { }
    const { url, notificationId, actions } = (_b = (_a = notifEvent.notification) === null || _a === void 0 ? void 0 : _a.data) !== null && _b !== void 0 ? _b : {};
    const pressed = buttonTarget(notifEvent.action, actions);
    const target = safeTarget(pressed, self.location.origin) ? pressed : url;
    notifEvent.waitUntil(Promise.all([track(notificationId), openTarget(target), clearAppBadge()]).then(() => undefined));
});
const STATE_DB = "espresso-notify";
const STATE_STORE = "state";
const STATE_KEY = "web-push";
const MAX_ENDPOINT = 2048;
function openStateDb() {
    return new Promise((resolve, reject) => {
        const request = self.indexedDB.open(STATE_DB, 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(STATE_STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
async function readState() {
    const db = await openStateDb();
    try {
        return await new Promise((resolve, reject) => {
            const request = db.transaction(STATE_STORE, "readonly").objectStore(STATE_STORE).get(STATE_KEY);
            request.onsuccess = () => {
                const value = request.result;
                resolve(value && typeof value === "object" ? value : {});
            };
            request.onerror = () => reject(request.error);
        });
    }
    finally {
        try {
            db.close();
        }
        catch (_a) { }
    }
}
async function writeState(patch) {
    const db = await openStateDb();
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STATE_STORE, "readwrite");
            const store = tx.objectStore(STATE_STORE);
            const current = store.get(STATE_KEY);
            current.onsuccess = () => {
                const base = current.result && typeof current.result === "object" ? current.result : {};
                const next = Object.assign(Object.assign({}, base), patch);
                for (const key of Object.keys(next))
                    if (next[key] === undefined)
                        delete next[key];
                store.put(next, STATE_KEY);
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }
    finally {
        try {
            db.close();
        }
        catch (_a) { }
    }
}
function apiBase() {
    try {
        if (!API_URL || API_URL.startsWith("__"))
            return "";
        if (new URL(API_URL).protocol === "https:")
            return API_URL.replace(/\/+$/, "");
    }
    catch (_a) { }
    return "";
}
function bytesToBase64Url(raw) {
    try {
        if (!raw)
            return "";
        const bytes = new Uint8Array(raw);
        let binary = "";
        for (let i = 0; i < bytes.length; i++)
            binary += String.fromCharCode(bytes[i]);
        return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    catch (_a) {
        return "";
    }
}
function base64UrlToBuffer(value) {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const raw = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0)).buffer;
}
function usableEndpoint(value) {
    return typeof value === "string" && value.startsWith("https://") && value.length <= MAX_ENDPOINT ? value : "";
}
async function fetchVapidKey(api, projectKey) {
    try {
        const res = await fetch(`${api}/v1/web-push/vapid-key`, {
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${projectKey}` },
        });
        if (!res.ok)
            return "";
        const data = await res.json();
        return typeof (data === null || data === void 0 ? void 0 : data.vapid_public_key) === "string" ? data.vapid_public_key : "";
    }
    catch (_a) {
        return "";
    }
}
async function resubscribe(event) {
    var _a, _b, _c, _d, _e, _f, _g;
    let state = {};
    try {
        state = await readState();
    }
    catch (_h) { }
    const projectKey = typeof state.projectKey === "string" ? state.projectKey : "";
    const api = apiBase();
    if (!api || !projectKey.startsWith("pk_"))
        return;
    const toReplace = usableEndpoint(state.pendingReplace) || usableEndpoint((_a = event === null || event === void 0 ? void 0 : event.oldSubscription) === null || _a === void 0 ? void 0 : _a.endpoint) || usableEndpoint(state.endpoint);
    try {
        let subscription = (_b = event === null || event === void 0 ? void 0 : event.newSubscription) !== null && _b !== void 0 ? _b : null;
        let key = bytesToBase64Url((_c = subscription === null || subscription === void 0 ? void 0 : subscription.options) === null || _c === void 0 ? void 0 : _c.applicationServerKey);
        if (!subscription) {
            const oldKey = (_e = (_d = event === null || event === void 0 ? void 0 : event.oldSubscription) === null || _d === void 0 ? void 0 : _d.options) === null || _e === void 0 ? void 0 : _e.applicationServerKey;
            let applicationServerKey = oldKey ? oldKey : null;
            key = bytesToBase64Url(applicationServerKey);
            if (!applicationServerKey || !key) {
                key = await fetchVapidKey(api, projectKey);
                if (!key)
                    throw new Error("no VAPID key");
                applicationServerKey = base64UrlToBuffer(key);
            }
            subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
        }
        const json = subscription.toJSON();
        let timezone;
        try {
            timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
        }
        catch (_j) { }
        const res = await fetch(`${api}/v1/web-push/subscribe`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${projectKey}` },
            body: JSON.stringify({
                endpoint: json.endpoint,
                p256dh: (_f = json.keys) === null || _f === void 0 ? void 0 : _f.p256dh,
                auth: (_g = json.keys) === null || _g === void 0 ? void 0 : _g.auth,
                timezone,
                vapid_public_key: key || undefined,
                replaces_endpoint: toReplace && toReplace !== json.endpoint ? toReplace : undefined,
            }),
        });
        if (!res.ok)
            throw new Error(`subscribe failed with status ${res.status}`);
        await writeState({ endpoint: json.endpoint, pendingReplace: undefined });
    }
    catch (_k) {
        try {
            if (toReplace)
                await writeState({ pendingReplace: toReplace });
        }
        catch (_l) { }
    }
}
let resubscribing = null;
function handleSubscriptionChange(event) {
    if (!resubscribing) {
        resubscribing = resubscribe(event)
            .catch(() => { })
            .then(() => {
            resubscribing = null;
        });
    }
    return resubscribing;
}
self.addEventListener("pushsubscriptionchange", (event) => {
    event.waitUntil(handleSubscriptionChange(event));
});
