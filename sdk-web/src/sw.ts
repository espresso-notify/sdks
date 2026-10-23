// @ts-nocheck
// Compiled to dist/sw.js and copied to the customer's site by `npx @espresso-notify/web`
// (or by hand when the service worker lives at a custom path).

declare var self: ServiceWorkerGlobalScope;

interface PushPayload {
  title?: unknown;
  body?: unknown;
  icon?: unknown;
  image?: unknown;
  url?: unknown;
  notificationId?: unknown;
  actions?: unknown;
  tag?: unknown;
  badge?: unknown;
  badgeCount?: unknown;
}

// What a push may ask the worker to show, beyond title, body, icon, image and link. A push is data
// from outside: the worker keeps only what has the expected shape and drops the rest.
const ACTION_ID = /^[A-Za-z0-9_-]{1,32}$/;
const TAG = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_ACTIONS = 3; // what the sender allows; the browser may allow fewer (Notification.maxActions)
const MAX_ACTION_TITLE = 60;
const MAX_BADGE_COUNT = 999999;

const FALLBACK_ICON = "/favicon.ico";

// The API this worker reports clicks to. It is compiled in at build time (inject-url.mjs),
// exactly like the page-side client, and never read from a push payload or from the data of
// a notification: whoever could forge a payload would otherwise get the push endpoint of the
// user sent to a server of their choosing. A copy that was not built (the placeholder is
// still in place) reports nothing.
const API_URL = "__ESPRESSO_API_URL__";

// The data the sender put in the push, or null when the push carried none, carried
// something that is not a JSON object, or could not be read.
function readPayload(event: PushEvent): PushPayload | null {
  try {
    const parsed = event.data ? event.data.json() : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as PushPayload;
  } catch {}
  return null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// The buttons, the tag and the badge icon of a push. Each URL goes through safeTarget, as the link of
// the notification does; the target of every button is kept in the data of the notification, keyed by
// the id of the button, because the click event only says which button was pressed.
function addPresentation(options: Record<string, unknown>, payload: PushPayload | null): void {
  const tag = payload?.tag;
  if (typeof tag === "string" && TAG.test(tag)) {
    options.tag = tag;
    options.renotify = true; // a tag without renotify replaces the earlier notification silently
  }

  const badge = safeTarget(payload?.badge, self.location.origin);
  if (badge && typeof payload?.badge === "string") options.badge = badge;

  const raw = payload?.actions;
  if (!Array.isArray(raw)) return;
  const supported = self.Notification?.maxActions;
  const room = Number.isInteger(supported) && supported >= 0 ? Math.min(supported, MAX_ACTIONS) : MAX_ACTIONS;
  const buttons: Array<{ action: string; title: string }> = [];
  const targets: Record<string, string> = {};
  const seen = new Set<string>();
  for (const entry of raw) {
    if (buttons.length >= room) break;
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as Record<string, unknown>).action;
    const title = (entry as Record<string, unknown>).title;
    if (typeof id !== "string" || !ACTION_ID.test(id) || seen.has(id)) continue;
    if (typeof title !== "string" || !title.trim()) continue;
    seen.add(id);
    buttons.push({ action: id, title: title.trim().slice(0, MAX_ACTION_TITLE) });
    const target = safeTarget((entry as Record<string, unknown>).url, self.location.origin);
    if (target) targets[id] = target;
  }
  if (buttons.length === 0) return;
  options.actions = buttons;
  if (Object.keys(targets).length > 0) (options.data as Record<string, unknown>).actions = targets;
}

// The count on the icon of an installed app (Badging API), where the browser has it. Never rejects:
// a browser without the API, or an app that is not installed, only loses the number.
async function setAppBadge(count: unknown): Promise<void> {
  try {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_BADGE_COUNT) return;
    if (typeof self.navigator?.setAppBadge === "function") await self.navigator.setAppBadge(count);
  } catch {}
}

async function clearAppBadge(): Promise<void> {
  try {
    if (typeof self.navigator?.clearAppBadge === "function") await self.navigator.clearAppBadge();
  } catch {}
}

// Every push has to end in a visible notification (`userVisibleOnly: true`): Chrome shows
// its own "this site was updated in the background" notice when a push does not, and Safari
// revokes the subscription. So this shows the notification whether or not a tab of the site
// is visible, and shows a generic one when the push has nothing readable in it. The page
// still gets the payload through `onPush` so it can draw its own UI next to the system one.
async function handlePush(payload: PushPayload | null): Promise<void> {
  try {
    const title = text(payload?.title) || self.location?.hostname || "Notification";
    const options: Record<string, unknown> = {
      body: text(payload?.body),
      icon: text(payload?.icon) || FALLBACK_ICON,
      data: {
        url: text(payload?.url) || undefined,
        notificationId: typeof payload?.notificationId === "number" ? payload.notificationId : undefined,
      },
    };
    const image = text(payload?.image);
    if (image) options.image = image;
    addPresentation(options, payload);
    await self.registration.showNotification(title, options as NotificationOptions);
  } catch {}
  await setAppBadge(payload?.badgeCount);

  if (!payload) return;
  try {
    const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    windowClients.forEach((c) => {
      try {
        c.postMessage({ type: "espresso:push", data: payload });
      } catch {}
    });
  } catch {}
}

self.addEventListener("push", (event) => {
  const pushEvent = event as PushEvent;
  pushEvent.waitUntil(handlePush(readPayload(pushEvent)));
});

// A click is the moment the user opened the notification, so the open and the click are
// reported here and nowhere else: showing a notification is not an open. The backend has no
// event for a delivery, so nothing is reported when it is shown. Never rejects.
async function track(notificationId: unknown): Promise<void> {
  if (typeof notificationId !== "number" || !API_URL || API_URL.startsWith("__")) return;
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub) return;
    await Promise.all(
      ["opened", "clicked"].map((eventType) =>
        fetch(`${API_URL}/v1/notifications/track-web`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notification_id: notificationId, event_type: eventType, endpoint: sub.endpoint }),
          keepalive: true,
        }).catch(() => {}),
      ),
    );
  } catch {}
}

function withoutHash(href: string): string {
  const u = new URL(href);
  u.hash = "";
  return u.href;
}

// Only a page of the site itself or an https page is opened: a url with another scheme
// (javascript:, data:, file:, blob:, chrome:...) or an http page of another origin is
// treated as if the push had no url.
function safeTarget(url: unknown, origin: string): string {
  try {
    if (typeof url !== "string" || !url) return "";
    const parsed = new URL(url, origin);
    const sameOrigin = parsed.origin === origin;
    if (parsed.protocol === "https:" || (parsed.protocol === "http:" && sameOrigin)) return parsed.href;
  } catch {}
  return "";
}

// Brings the user to the page of the notification: the tab that already shows it when there
// is one, otherwise a new tab. A notification without a web_url goes to the root of the
// site, where any open tab of the site is as good as another. Never rejects.
async function openTarget(url: unknown): Promise<void> {
  const origin = self.location.origin;
  let target = safeTarget(url, origin);
  const toRoot = target === "";
  if (toRoot) target = `${origin}/`;

  try {
    const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const sameUrl = (c: WindowClient) => {
      try {
        return withoutHash(c.url) === withoutHash(target);
      } catch {
        return false;
      }
    };
    const sameOrigin = (c: WindowClient) => {
      try {
        return new URL(c.url).origin === origin;
      } catch {
        return false;
      }
    };
    const existing = windowClients.find(sameUrl) ?? (toRoot ? windowClients.find(sameOrigin) : undefined);
    if (existing) {
      await existing.focus();
      return;
    }
  } catch {}

  try {
    await self.clients.openWindow(target);
  } catch {}
}

// The URL kept for the button that was pressed, or undefined for a click on the body of the
// notification, a button the worker did not keep, or one without a URL of its own.
function buttonTarget(action: unknown, targets: unknown): unknown {
  if (typeof action !== "string" || !action || !targets || typeof targets !== "object") return undefined;
  return Object.prototype.hasOwnProperty.call(targets, action) ? (targets as Record<string, unknown>)[action] : undefined;
}

self.addEventListener("notificationclick", (event) => {
  const notifEvent = event as NotificationEvent;
  try {
    notifEvent.notification.close();
  } catch {}
  const { url, notificationId, actions } = notifEvent.notification?.data ?? {};
  // The target of the button goes through the same check again: what was stored with the
  // notification is not trusted just because the worker stored it.
  const pressed = buttonTarget(notifEvent.action, actions);
  const target = safeTarget(pressed, self.location.origin) ? pressed : url;
  notifEvent.waitUntil(Promise.all([track(notificationId), openTarget(target), clearAppBadge()]).then(() => undefined));
});

// ---- pushsubscriptionchange ------------------------------------------------------------------------
// A browser may rotate or expire the push subscription while the site is closed. Without this the API
// keeps the dead endpoint and the visitor stops receiving until the page calls trySubscribe() again.
// The worker subscribes again with the same key and tells the API which endpoint the new one replaces
// (`replaces_endpoint`), so the linked user, the metadata and the time zone move to it.
//
// What the worker needs from the page is kept in IndexedDB, written by the page client after every
// successful subscription (src/index.ts uses the same three names): the PUBLIC key of the project (pk_...,
// never a secret key) and the endpoint the API knows. `pendingReplace` is the flag a failed run leaves:
// the endpoint the API still holds, which the page sends as `replaces_endpoint` on its next visit.
const STATE_DB = "espresso-notify";
const STATE_STORE = "state";
const STATE_KEY = "web-push";
const MAX_ENDPOINT = 2048; // the API ignores a longer replaces_endpoint

interface WebPushState {
  projectKey?: unknown;
  endpoint?: unknown;
  pendingReplace?: unknown;
}

function openStateDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = self.indexedDB.open(STATE_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STATE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readState(): Promise<WebPushState> {
  const db = await openStateDb();
  try {
    return await new Promise<WebPushState>((resolve, reject) => {
      const request = db.transaction(STATE_STORE, "readonly").objectStore(STATE_STORE).get(STATE_KEY);
      request.onsuccess = () => {
        const value = request.result;
        resolve(value && typeof value === "object" ? (value as WebPushState) : {});
      };
      request.onerror = () => reject(request.error);
    });
  } finally {
    try {
      db.close();
    } catch {}
  }
}

// Merges `patch` into the record in one transaction; a key set to undefined is removed.
async function writeState(patch: WebPushState): Promise<void> {
  const db = await openStateDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STATE_STORE, "readwrite");
      const store = tx.objectStore(STATE_STORE);
      const current = store.get(STATE_KEY);
      current.onsuccess = () => {
        const base = current.result && typeof current.result === "object" ? current.result : {};
        const next: Record<string, unknown> = { ...base, ...patch };
        for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
        store.put(next, STATE_KEY);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    try {
      db.close();
    } catch {}
  }
}

// The API the worker may call: the one compiled in, and only over https. A copy that was not built has none.
function apiBase(): string {
  try {
    if (!API_URL || API_URL.startsWith("__")) return "";
    if (new URL(API_URL).protocol === "https:") return API_URL.replace(/\/+$/, "");
  } catch {}
  return "";
}

function bytesToBase64Url(raw: unknown): string {
  try {
    if (!raw) return "";
    const bytes = new Uint8Array(raw as ArrayBuffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch {
    return "";
  }
}

function base64UrlToBuffer(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0)).buffer as ArrayBuffer;
}

function usableEndpoint(value: unknown): string {
  return typeof value === "string" && value.startsWith("https://") && value.length <= MAX_ENDPOINT ? value : "";
}

// The current public VAPID key of the project, from the route the page uses. "" when it cannot be had.
async function fetchVapidKey(api: string, projectKey: string): Promise<string> {
  try {
    const res = await fetch(`${api}/v1/web-push/vapid-key`, {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${projectKey}` },
    });
    if (!res.ok) return "";
    const data = await res.json();
    return typeof data?.vapid_public_key === "string" ? data.vapid_public_key : "";
  } catch {
    return "";
  }
}

async function resubscribe(event: any): Promise<void> {
  let state: WebPushState = {};
  try {
    state = await readState();
  } catch {}
  const projectKey = typeof state.projectKey === "string" ? state.projectKey : "";
  const api = apiBase();
  // No page ever stored a key (an older page), a key that is not the public one of a project (sk_... and
  // anything else), or no API to call: there is nothing the worker may do.
  if (!api || !projectKey.startsWith("pk_")) return;

  // The endpoint the API still holds: the one an earlier failed run left, else the one of the event,
  // else the last one the page stored.
  const toReplace =
    usableEndpoint(state.pendingReplace) || usableEndpoint(event?.oldSubscription?.endpoint) || usableEndpoint(state.endpoint);
  try {
    let subscription = event?.newSubscription ?? null;
    let key = bytesToBase64Url(subscription?.options?.applicationServerKey);
    if (!subscription) {
      const oldKey = event?.oldSubscription?.options?.applicationServerKey;
      let applicationServerKey: ArrayBuffer | null = oldKey ? (oldKey as ArrayBuffer) : null;
      key = bytesToBase64Url(applicationServerKey);
      if (!applicationServerKey || !key) {
        key = await fetchVapidKey(api, projectKey);
        if (!key) throw new Error("no VAPID key");
        applicationServerKey = base64UrlToBuffer(key);
      }
      subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    }
    const json = subscription.toJSON();
    let timezone: string | undefined;
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    } catch {}
    const res = await fetch(`${api}/v1/web-push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${projectKey}` },
      body: JSON.stringify({
        endpoint: json.endpoint,
        p256dh: json.keys?.p256dh,
        auth: json.keys?.auth,
        timezone,
        vapid_public_key: key || undefined,
        replaces_endpoint: toReplace && toReplace !== json.endpoint ? toReplace : undefined,
      }),
    });
    if (!res.ok) throw new Error(`subscribe failed with status ${res.status}`);
    await writeState({ endpoint: json.endpoint, pendingReplace: undefined });
  } catch {
    // The page finishes it on the next visit: it sends this endpoint as replaces_endpoint.
    try {
      if (toReplace) await writeState({ pendingReplace: toReplace });
    } catch {}
  }
}

// One run at a time: a second event while one is going on gets the same run, so the API is not
// called twice for the same change.
let resubscribing: Promise<void> | null = null;

function handleSubscriptionChange(event: any): Promise<void> {
  if (!resubscribing) {
    resubscribing = resubscribe(event)
      .catch(() => {})
      .then(() => {
        resubscribing = null;
      });
  }
  return resubscribing;
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(handleSubscriptionChange(event));
});
