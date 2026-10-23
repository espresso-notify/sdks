// The service worker runs outside the page, so these tests give src/sw.ts a fake
// ServiceWorkerGlobalScope: it records the listeners the worker registers and the
// calls it makes on `registration`, `clients` and `fetch`.

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { fakeIndexedDB } from "../test-support/fakeIndexedDB";

type Listener = (event: any) => void;

interface FakeTab {
  url: string;
  visibilityState: "visible" | "hidden";
  postMessage: jest.Mock;
  focus: jest.Mock;
}

const ORIGIN = "https://shop.example";
const ENDPOINT = "https://push.example/endpoint-1";
const API_URL = "https://api.espressonotify.com";

function tab(url: string, visibilityState: "visible" | "hidden" = "hidden"): FakeTab {
  return { url, visibilityState, postMessage: jest.fn(), focus: jest.fn().mockResolvedValue(undefined) };
}

// src/sw.ts keeps the API URL as a build-time placeholder (inject-url.mjs). The tests give
// the worker the same URL a build would, by compiling the source with the placeholder
// replaced, or leave the placeholder in place to play a copy that was never built.
function compileWorker(apiUrl: string | null): string {
  const raw = fs.readFileSync(path.join(__dirname, "..", "src", "sw.ts"), "utf8");
  const source = apiUrl === null ? raw : raw.replace("__ESPRESSO_API_URL__", apiUrl);
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 },
  }).outputText;
}

function loadWorker(tabs: FakeTab[] = [], apiUrl: string | null = API_URL, extra: Record<string, unknown> = {}) {
  const listeners: Record<string, Listener> = {};
  const fakeSelf: Record<string, any> = {
    ...extra,
    location: { origin: ORIGIN, hostname: "shop.example" },
    addEventListener: (type: string, listener: Listener) => {
      listeners[type] = listener;
    },
    registration: {
      showNotification: jest.fn().mockResolvedValue(undefined),
      pushManager: { getSubscription: jest.fn().mockResolvedValue({ endpoint: ENDPOINT }) },
    },
    clients: {
      matchAll: jest.fn().mockResolvedValue(tabs),
      openWindow: jest.fn().mockResolvedValue(null),
    },
  };
  new Function("self", compileWorker(apiUrl))(fakeSelf);
  return { self: fakeSelf, listeners };
}

/** Fires a push event and returns the promise the worker handed to waitUntil. */
function firePush(listeners: Record<string, Listener>, data: unknown) {
  const event = {
    data:
      data === undefined
        ? null
        : {
            json: () => {
              if (data instanceof Error) throw data;
              return data;
            },
          },
    waitUntil: jest.fn(),
  };
  listeners.push(event);
  expect(event.waitUntil).toHaveBeenCalledTimes(1);
  return event.waitUntil.mock.calls[0][0] as Promise<unknown>;
}

function fireClick(listeners: Record<string, Listener>, data: Record<string, unknown> | undefined, action?: unknown) {
  const notification = { close: jest.fn(), data };
  const event = { notification, action, waitUntil: jest.fn() };
  listeners.notificationclick(event);
  expect(event.waitUntil).toHaveBeenCalledTimes(1);
  return { notification, done: event.waitUntil.mock.calls[0][0] as Promise<unknown> };
}

const payload = {
  title: "Flash sale",
  body: "50% off today",
  icon: "https://shop.example/icon.png",
  image: "https://shop.example/banner.png",
  url: `${ORIGIN}/sale`,
  notificationId: 77,
  apiUrl: API_URL,
};

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn().mockResolvedValue({ ok: true });
  (globalThis as any).fetch = fetchMock;
});

afterEach(() => {
  delete (globalThis as any).self;
});

describe("push", () => {
  it("shows the notification even when a tab of the site is visible", async () => {
    const { self, listeners } = loadWorker([tab(`${ORIGIN}/home`, "visible")]);

    await firePush(listeners, payload);

    expect(self.registration.showNotification).toHaveBeenCalledTimes(1);
    expect(self.registration.showNotification).toHaveBeenCalledWith(
      "Flash sale",
      expect.objectContaining({
        body: "50% off today",
        icon: "https://shop.example/icon.png",
        image: "https://shop.example/banner.png",
        data: { url: `${ORIGIN}/sale`, notificationId: 77 },
      }),
    );
  });

  it("falls back to the site icon when the payload has none", async () => {
    const { self, listeners } = loadWorker();

    await firePush(listeners, { title: "Hi", body: "there" });

    expect(self.registration.showNotification).toHaveBeenCalledWith("Hi", expect.objectContaining({ icon: "/favicon.ico" }));
  });

  it("still hands the payload to every open tab for onPush", async () => {
    const visible = tab(`${ORIGIN}/home`, "visible");
    const hidden = tab(`${ORIGIN}/other`, "hidden");
    const { listeners } = loadWorker([visible, hidden]);

    await firePush(listeners, payload);

    for (const t of [visible, hidden]) {
      expect(t.postMessage).toHaveBeenCalledWith({ type: "espresso:push", data: payload });
    }
  });

  it("reports nothing to the backend when the notification is shown", async () => {
    const { listeners } = loadWorker();

    await firePush(listeners, payload);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["no data", undefined],
    ["invalid JSON", new SyntaxError("Unexpected token")],
    ["a JSON value that is not an object", "just text"],
    ["an array", [1, 2]],
    ["an object without a title", { body: "orphan" }],
    ["a title that is not text", { title: 7, body: "x" }],
  ])("shows a notification titled with the site name for a push with %s", async (_name, data) => {
    const { self, listeners } = loadWorker([tab(`${ORIGIN}/home`, "visible")]);

    await expect(firePush(listeners, data)).resolves.toBeUndefined();

    expect(self.registration.showNotification).toHaveBeenCalledTimes(1);
    expect(self.registration.showNotification.mock.calls[0][0]).toBe("shop.example");
  });

  it("keeps the body of a payload that has no title", async () => {
    const { self, listeners } = loadWorker();

    await firePush(listeners, { body: "orphan" });

    expect(self.registration.showNotification).toHaveBeenCalledWith(
      "shop.example",
      expect.objectContaining({ body: "orphan" }),
    );
  });

  it("does not reject when showNotification or matchAll fail", async () => {
    const { self, listeners } = loadWorker();
    self.registration.showNotification.mockRejectedValue(new Error("denied"));
    self.clients.matchAll.mockRejectedValue(new Error("no clients"));

    await expect(firePush(listeners, payload)).resolves.toBeUndefined();
  });
});

describe("notificationclick", () => {
  const data = { url: `${ORIGIN}/sale`, notificationId: 77, apiUrl: API_URL };

  it("closes the notification and focuses the tab that already shows the target", async () => {
    const other = tab(`${ORIGIN}/home`);
    const same = tab(`${ORIGIN}/sale#reviews`);
    const { self, listeners } = loadWorker([other, same]);

    const { notification, done } = fireClick(listeners, data);
    await done;

    expect(notification.close).toHaveBeenCalledTimes(1);
    expect(same.focus).toHaveBeenCalledTimes(1);
    expect(other.focus).not.toHaveBeenCalled();
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });

  it("opens a new tab when no open tab shows the target", async () => {
    const { self, listeners } = loadWorker([tab(`${ORIGIN}/home`)]);

    await fireClick(listeners, data).done;

    expect(self.clients.openWindow).toHaveBeenCalledTimes(1);
    expect(self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/sale`);
  });

  it("opens a target on another origin in a new tab", async () => {
    const { self, listeners } = loadWorker([tab(`${ORIGIN}/home`)]);

    await fireClick(listeners, { ...data, url: "https://partner.example/offer" }).done;

    expect(self.clients.openWindow).toHaveBeenCalledWith("https://partner.example/offer");
  });

  it("goes to the root of the site when the payload has no web_url, focusing any tab of the site", async () => {
    const open = tab(`${ORIGIN}/cart`);
    const { self, listeners } = loadWorker([tab("https://elsewhere.example/x"), open]);

    await fireClick(listeners, { notificationId: 77, apiUrl: API_URL }).done;

    expect(open.focus).toHaveBeenCalledTimes(1);
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });

  it.each([
    "javascript:alert(document.cookie)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "blob:https://shop.example/1234",
    "chrome://settings",
    "ftp://files.example/x",
    "http://evil.example/offer",
  ])("opens the root of the site instead of %s", async (url) => {
    const { self, listeners } = loadWorker([]);

    await fireClick(listeners, { url, notificationId: 77 }).done;

    expect(self.clients.openWindow).toHaveBeenCalledTimes(1);
    expect(self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });

  it("opens the root of the site when the url is not a string", async () => {
    const { self, listeners } = loadWorker([]);

    await fireClick(listeners, { url: { href: "javascript:alert(1)" }, notificationId: 77 }).done;

    expect(self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });

  it("opens the root of the site when there is no web_url and no tab of the site", async () => {
    const { self, listeners } = loadWorker([]);

    await fireClick(listeners, undefined).done;

    expect(self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });

  it("reports the open and the click once each, with the notification id and the endpoint", async () => {
    const { listeners } = loadWorker();

    await fireClick(listeners, data).done;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sent = fetchMock.mock.calls.map(([url, init]) => ({ url, method: init.method, body: JSON.parse(init.body) }));
    expect(sent).toEqual(
      expect.arrayContaining([
        { url: `${API_URL}/v1/notifications/track-web`, method: "POST", body: { notification_id: 77, event_type: "opened", endpoint: ENDPOINT } },
        { url: `${API_URL}/v1/notifications/track-web`, method: "POST", body: { notification_id: 77, event_type: "clicked", endpoint: ENDPOINT } },
      ]),
    );
  });

  it("reports nothing when the notification has no id", async () => {
    const { listeners } = loadWorker();

    await fireClick(listeners, { url: `${ORIGIN}/sale` }).done;

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // SFF-08 (FE-09): the API the clicks go to is the one compiled into the worker.
  it("never keeps an apiUrl from the push payload in the notification", async () => {
    const { self, listeners } = loadWorker();

    await firePush(listeners, { ...payload, apiUrl: "https://attacker.example" });

    const options = self.registration.showNotification.mock.calls[0][1];
    expect(options.data).toEqual({ url: `${ORIGIN}/sale`, notificationId: 77 });
  });

  it("reports to the compiled-in API even when the notification data names another one", async () => {
    const { listeners } = loadWorker();

    await fireClick(listeners, { url: `${ORIGIN}/sale`, notificationId: 77, apiUrl: "https://attacker.example" }).done;

    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).toEqual([`${API_URL}/v1/notifications/track-web`, `${API_URL}/v1/notifications/track-web`]);
  });

  it("reports nothing when the worker was never built (placeholder still in place)", async () => {
    const { listeners } = loadWorker([], null);

    await fireClick(listeners, { notificationId: 77, apiUrl: "https://attacker.example" }).done;

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports nothing when the browser has no subscription", async () => {
    const { self, listeners } = loadWorker();
    self.registration.pushManager.getSubscription.mockResolvedValue(null);

    await fireClick(listeners, data).done;

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens the page even when the tracking fails", async () => {
    const { self, listeners } = loadWorker();
    self.registration.pushManager.getSubscription.mockRejectedValue(new Error("no subscription"));

    await expect(fireClick(listeners, data).done).resolves.toBeUndefined();
    expect(self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/sale`);

    self.registration.pushManager.getSubscription.mockResolvedValue({ endpoint: ENDPOINT });
    fetchMock.mockRejectedValue(new Error("offline"));
    self.clients.openWindow.mockClear();

    await expect(fireClick(listeners, data).done).resolves.toBeUndefined();
    expect(self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/sale`);
  });

  it("does not reject when focus, openWindow or matchAll fail, and opens a tab when focus fails", async () => {
    const same = tab(`${ORIGIN}/sale`);
    same.focus.mockRejectedValue(new Error("not allowed"));
    const { self, listeners } = loadWorker([same]);

    await expect(fireClick(listeners, data).done).resolves.toBeUndefined();
    expect(self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/sale`);

    self.clients.openWindow.mockRejectedValue(new Error("blocked"));
    self.clients.matchAll.mockRejectedValue(new Error("gone"));
    await expect(fireClick(listeners, data).done).resolves.toBeUndefined();
  });
});

// WPC-26 to WPC-30 (web-push-v1-closure): action buttons, tag, badge icon and app badge. Every URL the
// worker acts on goes through the same check as the link of the notification (FE-09), and a push is
// data from outside: the worker keeps only what it can show.
describe("action buttons, tag and badge", () => {
  const rich = {
    ...payload,
    tag: "order-42",
    badge: "https://shop.example/badge.png",
    badgeCount: 3,
    actions: [
      { action: "track", title: "Track order", url: `${ORIGIN}/orders/42` },
      { action: "later", title: "Remind me later", url: "https://partner.example/later" },
    ],
  };
  const shown = (self: any) => self.registration.showNotification.mock.calls[0][1];
  const browser = (maxActions?: number) => ({
    Notification: { maxActions },
    navigator: { setAppBadge: jest.fn().mockResolvedValue(undefined), clearAppBadge: jest.fn().mockResolvedValue(undefined) },
  });

  it("shows the buttons, the tag with renotify and the badge icon", async () => {
    const { self, listeners } = loadWorker([], API_URL, browser(3));

    await firePush(listeners, rich);

    const options = shown(self);
    expect(options.actions).toEqual([
      { action: "track", title: "Track order" },
      { action: "later", title: "Remind me later" },
    ]);
    expect(options.tag).toBe("order-42");
    expect(options.renotify).toBe(true);
    expect(options.badge).toBe("https://shop.example/badge.png");
    expect(options.data).toEqual({
      url: `${ORIGIN}/sale`,
      notificationId: 77,
      actions: { track: `${ORIGIN}/orders/42`, later: "https://partner.example/later" },
    });
  });

  it("keeps the options of a push that has none exactly as before", async () => {
    const { self, listeners } = loadWorker([], API_URL, browser(3));

    await firePush(listeners, payload);

    const options = shown(self);
    for (const key of ["actions", "tag", "renotify", "badge"]) expect(options).not.toHaveProperty(key);
    expect(options.data).toEqual({ url: `${ORIGIN}/sale`, notificationId: 77 });
  });

  it("passes at most the buttons the browser can show", async () => {
    const four = Array.from({ length: 4 }, (_, i) => ({ action: `a${i}`, title: `B${i}` }));
    for (const [maxActions, expected] of [[2, 2], [1, 1], [0, 0], [10, 3], [undefined, 3]] as const) {
      const { self, listeners } = loadWorker([], API_URL, browser(maxActions));
      await firePush(listeners, { ...payload, actions: four });
      expect((shown(self).actions ?? []).length).toBe(expected);
    }
  });

  it("drops a button that is not a short id with a text title, and a repeated id", async () => {
    const { self, listeners } = loadWorker([], API_URL, browser(3));

    await firePush(listeners, {
      ...payload,
      actions: [
        { action: "ok", title: "Fine" },
        { action: "ok", title: "Same id again" },
        { action: "bad id!", title: "Space and bang" },
        { action: "x".repeat(33), title: "Too long id" },
        { action: 7, title: "Number id" },
        { action: "notitle" },
        { action: "blank", title: "   " },
        "not an object",
        null,
      ],
    });

    expect(shown(self).actions).toEqual([{ action: "ok", title: "Fine" }]);
  });

  it("ignores actions that are not an array", async () => {
    for (const actions of ["track", { action: "a", title: "b" }, 7]) {
      const { self, listeners } = loadWorker([], API_URL, browser(3));
      await firePush(listeners, { ...payload, actions });
      expect(shown(self)).not.toHaveProperty("actions");
    }
  });

  it("ignores a tag that is not a short plain text, and never sets renotify without one", async () => {
    for (const tag of ["", "has space", "x".repeat(65), 7, { a: 1 }]) {
      const { self, listeners } = loadWorker([], API_URL, browser(3));
      await firePush(listeners, { ...payload, tag });
      expect(shown(self)).not.toHaveProperty("tag");
      expect(shown(self)).not.toHaveProperty("renotify");
    }
  });

  it("keeps a button url out of the notification data when the check refuses it", async () => {
    const { self, listeners } = loadWorker([], API_URL, browser(3));

    await firePush(listeners, {
      ...payload,
      actions: [
        { action: "js", title: "JS", url: "javascript:alert(1)" },
        { action: "http", title: "Plain http", url: "http://evil.example/x" },
        { action: "good", title: "Good", url: `${ORIGIN}/ok` },
      ],
    });

    expect(shown(self).actions.map((a: any) => a.action)).toEqual(["js", "http", "good"]);
    expect(shown(self).data.actions).toEqual({ good: `${ORIGIN}/ok` });
  });

  it("drops a badge icon the check refuses", async () => {
    for (const badge of ["javascript:alert(1)", "http://evil.example/b.png", "data:image/png;base64,AAAA", 7, ""]) {
      const { self, listeners } = loadWorker([], API_URL, browser(3));
      await firePush(listeners, { ...payload, badge });
      expect(shown(self)).not.toHaveProperty("badge");
    }
  });

  it("never takes an api or tracking url from the push, whatever field carries it", async () => {
    const { self, listeners } = loadWorker([], API_URL, browser(3));

    await firePush(listeners, {
      ...rich,
      apiUrl: "https://attacker.example",
      trackUrl: "https://attacker.example/track",
      actions: [{ action: "a", title: "A", url: `${ORIGIN}/a`, apiUrl: "https://attacker.example", track: "https://attacker.example" }],
    });

    expect(JSON.stringify(shown(self))).not.toContain("attacker.example");
  });

  it("sets the app badge to the count of the push where the browser can", async () => {
    const env = browser(3);
    const { listeners } = loadWorker([], API_URL, env);

    await firePush(listeners, rich);

    expect(env.navigator.setAppBadge).toHaveBeenCalledWith(3);
  });

  it.each([[0], [-1], [1.5], ["3"], [null], [1e9]])("sets no app badge for a count of %p", async (badgeCount) => {
    const env = browser(3);
    const { self, listeners } = loadWorker([], API_URL, env);

    await firePush(listeners, { ...payload, badgeCount });

    expect(env.navigator.setAppBadge).not.toHaveBeenCalled();
    expect(self.registration.showNotification).toHaveBeenCalledTimes(1);
  });

  it("shows the notification when the browser has no app badge or it throws", async () => {
    const none = loadWorker([], API_URL, { Notification: { maxActions: 3 } });
    await expect(firePush(none.listeners, rich)).resolves.toBeUndefined();
    expect(none.self.registration.showNotification).toHaveBeenCalledTimes(1);

    const env = browser(3);
    env.navigator.setAppBadge.mockRejectedValue(new Error("not installed"));
    const failing = loadWorker([], API_URL, env);
    await expect(firePush(failing.listeners, rich)).resolves.toBeUndefined();
    expect(failing.self.registration.showNotification).toHaveBeenCalledTimes(1);
  });

  describe("click on a button", () => {
    const data = {
      url: `${ORIGIN}/sale`,
      notificationId: 77,
      actions: { track: `${ORIGIN}/orders/42`, later: "https://partner.example/later", js: "javascript:alert(1)" },
    };

    it("opens the url of the button and reports the open and the click once each", async () => {
      const { self, listeners } = loadWorker([], API_URL, browser(3));

      const { notification, done } = fireClick(listeners, data, "track");
      await done;

      expect(notification.close).toHaveBeenCalledTimes(1);
      expect(self.clients.openWindow).toHaveBeenCalledTimes(1);
      expect(self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/orders/42`);
      const types = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).event_type).sort();
      expect(types).toEqual(["clicked", "opened"]);
    });

    it("opens the url of the notification for the body, an unknown button or a button without a url", async () => {
      for (const action of [undefined, "", "unknown", "constructor", 7]) {
        const { self, listeners } = loadWorker([], API_URL, browser(3));
        await fireClick(listeners, data, action).done;
        expect(self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/sale`);
      }
    });

    it("opens the url of the notification when the url of the button is refused", async () => {
      const { self, listeners } = loadWorker([], API_URL, browser(3));

      await fireClick(listeners, data, "js").done;

      expect(self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/sale`);
    });

    it("clears the app badge on a click, and still opens the page when that throws", async () => {
      const env = browser(3);
      const { listeners } = loadWorker([], API_URL, env);
      await fireClick(listeners, data, "track").done;
      expect(env.navigator.clearAppBadge).toHaveBeenCalledTimes(1);

      const failing = browser(3);
      failing.navigator.clearAppBadge.mockRejectedValue(new Error("nope"));
      const second = loadWorker([], API_URL, failing);
      await expect(fireClick(second.listeners, data).done).resolves.toBeUndefined();
      expect(second.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/sale`);
    });
  });
});

// web-sw-subscription-change (WEBSW-01 to WEBSW-14): when the browser rotates or expires the push
// subscription while the site is closed, the worker subscribes again with the same key and tells the API
// which endpoint the new one replaces.
describe("pushsubscriptionchange", () => {
  const PROJECT_KEY = "pk_live_abc";
  const OLD = "https://push.example/old-endpoint";
  const STORED = "https://push.example/stored-endpoint";
  const FRESH = "https://push.example/new-endpoint";
  // 65 bytes like a real P-256 key; the base64 of these bytes has "-" and "_" in the url-safe form and padding in the plain one.
  const KEY_BYTES = Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : (i * 53 + 126) % 256));
  const KEY_B64URL = Buffer.from(KEY_BYTES).toString("base64url");
  it("uses a key that exercises both url-safe characters and the padding", () => {
    expect(KEY_B64URL).toMatch(/-/);
    expect(KEY_B64URL).toMatch(/_/);
    expect(Buffer.from(KEY_BYTES).toString("base64")).toMatch(/=$/);
  });

  const keyBuffer = () => KEY_BYTES.buffer.slice(0) as ArrayBuffer;

  const stateOf = (idb: ReturnType<typeof fakeIndexedDB>) => idb.data.get("web-push") as Record<string, unknown> | undefined;

  function subscription(endpoint: string, key: ArrayBuffer | null = keyBuffer()) {
    return {
      endpoint,
      options: { applicationServerKey: key },
      toJSON: () => ({ endpoint, keys: { p256dh: `p256dh-of-${endpoint}`, auth: `auth-of-${endpoint}` } }),
    };
  }

  function setup(state: Record<string, unknown> | null = { projectKey: PROJECT_KEY, endpoint: STORED }, apiUrl: string | null = API_URL) {
    const idb = fakeIndexedDB(state ? { "web-push": state } : {});
    const worker = loadWorker([], apiUrl, { indexedDB: idb });
    worker.self.registration.pushManager.subscribe = jest.fn().mockResolvedValue(subscription(FRESH));
    return { ...worker, idb };
  }

  function fireChange(listeners: Record<string, Listener>, init: Record<string, unknown> = {}) {
    const event = { waitUntil: jest.fn(), ...init };
    listeners.pushsubscriptionchange(event);
    expect(event.waitUntil).toHaveBeenCalledTimes(1);
    return event.waitUntil.mock.calls[0][0] as Promise<unknown>;
  }

  const posts = () => fetchMock.mock.calls.filter(([url, init]) => url === `${API_URL}/v1/web-push/subscribe` && init?.method === "POST");
  const bodyOf = (call: any[]) => JSON.parse(call[1].body);

  beforeEach(() => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
  });

  it("listens for the event", () => {
    const { listeners } = setup();
    expect(typeof listeners.pushsubscriptionchange).toBe("function");
  });

  // WEBSW-01
  it("subscribes again with the key of the old subscription and posts it with replaces_endpoint", async () => {
    const { self, listeners } = setup();

    await fireChange(listeners, { oldSubscription: subscription(OLD) });

    expect(self.registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
    const options = self.registration.pushManager.subscribe.mock.calls[0][0];
    expect(options.userVisibleOnly).toBe(true);
    expect(Array.from(new Uint8Array(options.applicationServerKey))).toEqual(Array.from(KEY_BYTES));

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${API_URL}/v1/web-push/subscribe`]);
    const [url, init] = posts()[0];
    expect(init.headers).toEqual({ "Content-Type": "application/json", Authorization: `Bearer ${PROJECT_KEY}` });
    expect(JSON.parse(init.body)).toEqual({
      endpoint: FRESH,
      p256dh: `p256dh-of-${FRESH}`,
      auth: `auth-of-${FRESH}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      vapid_public_key: KEY_B64URL,
      replaces_endpoint: OLD,
    });
    expect(url).toBe(`${API_URL}/v1/web-push/subscribe`);
  });

  // WSC-06: the worker does not send a consent; the API carries the stored one over with replaces_endpoint.
  it("posts the new subscription with no consent key", async () => {
    const { listeners } = setup();

    await fireChange(listeners, { oldSubscription: subscription(OLD) });

    expect(bodyOf(posts()[0])).not.toHaveProperty("consent");
  });

  // WEBSW-02
  it("fetches the public key of the project when the event has no old subscription, and replaces the stored endpoint", async () => {
    const { self, listeners } = setup();
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/vapid-key") ? { ok: true, json: async () => ({ vapid_public_key: KEY_B64URL }) } : { ok: true, json: async () => ({}) },
    );

    await fireChange(listeners, {});

    const [keyUrl, keyInit] = fetchMock.mock.calls[0];
    expect(keyUrl).toBe(`${API_URL}/v1/web-push/vapid-key`);
    expect(keyInit.headers.Authorization).toBe(`Bearer ${PROJECT_KEY}`);
    const options = self.registration.pushManager.subscribe.mock.calls[0][0];
    expect(options.userVisibleOnly).toBe(true);
    expect(Array.from(new Uint8Array(options.applicationServerKey))).toEqual(Array.from(KEY_BYTES));
    expect(posts()).toHaveLength(1);
    expect(bodyOf(posts()[0])).toMatchObject({ endpoint: FRESH, replaces_endpoint: STORED, vapid_public_key: KEY_B64URL });
  });

  it("does not fetch the key when the old subscription carries it", async () => {
    const { listeners } = setup();

    await fireChange(listeners, { oldSubscription: subscription(OLD) });

    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/vapid-key"))).toBe(false);
  });

  it("fetches the key when the old subscription does not say its key", async () => {
    const { self, listeners } = setup();
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/vapid-key") ? { ok: true, json: async () => ({ vapid_public_key: KEY_B64URL }) } : { ok: true, json: async () => ({}) },
    );

    await fireChange(listeners, { oldSubscription: subscription(OLD, null) });

    expect(fetchMock.mock.calls[0][0]).toBe(`${API_URL}/v1/web-push/vapid-key`);
    expect(self.registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(bodyOf(posts()[0]).replaces_endpoint).toBe(OLD);
  });

  it("does not post when the key cannot be had", async () => {
    for (const answer of [{ ok: false, json: async () => ({}) }, { ok: true, json: async () => ({}) }, { ok: true, json: async () => { throw new Error("bad json"); } }]) {
      const { self, listeners, idb } = setup();
      fetchMock.mockReset().mockResolvedValue(answer);

      await expect(fireChange(listeners, { oldSubscription: subscription(OLD, null) })).resolves.toBeUndefined();

      expect(self.registration.pushManager.subscribe).not.toHaveBeenCalled();
      expect(stateOf(idb)?.pendingReplace).toBe(OLD);
    }
  });

  it("does not trust the body of a key answer the API marked as an error", async () => {
    const { self, listeners, idb } = setup();
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({ vapid_public_key: KEY_B64URL }) });

    await expect(fireChange(listeners, {})).resolves.toBeUndefined();

    expect(self.registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(stateOf(idb)?.pendingReplace).toBe(STORED);
  });

  it("builds the routes from an API url that ends with a slash", async () => {
    const { listeners } = setup(undefined, `${API_URL}/`);

    await fireChange(listeners, { oldSubscription: subscription(OLD) });

    expect(fetchMock.mock.calls[0][0]).toBe(`${API_URL}/v1/web-push/subscribe`);
  });

  // WEBSW-03
  it("posts the subscription the browser already made (newSubscription) without subscribing again", async () => {
    const { self, listeners } = setup();

    await fireChange(listeners, { oldSubscription: subscription(OLD), newSubscription: subscription("https://push.example/made-by-browser") });

    expect(self.registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(bodyOf(posts()[0])).toMatchObject({ endpoint: "https://push.example/made-by-browser", replaces_endpoint: OLD, vapid_public_key: KEY_B64URL });
  });

  // WEBSW-04
  it("keeps the new endpoint and clears the pending replace once the API accepts", async () => {
    const { listeners, idb } = setup({ projectKey: PROJECT_KEY, endpoint: STORED, pendingReplace: "https://push.example/older" });

    await fireChange(listeners, { oldSubscription: subscription(OLD) });

    expect(stateOf(idb)).toEqual({ projectKey: PROJECT_KEY, endpoint: FRESH });
  });

  it("replaces the endpoint the API still knows (the pending one) before the one of the event", async () => {
    const { listeners } = setup({ projectKey: PROJECT_KEY, endpoint: STORED, pendingReplace: "https://push.example/older" });

    await fireChange(listeners, { oldSubscription: subscription(OLD) });

    expect(bodyOf(posts()[0]).replaces_endpoint).toBe("https://push.example/older");
  });

  it("prefers the endpoint of the event over the stored one", async () => {
    const { listeners } = setup();

    await fireChange(listeners, { oldSubscription: subscription(OLD) });

    expect(bodyOf(posts()[0]).replaces_endpoint).toBe(OLD);
  });

  // WEBSW-05
  it("answers a second event while one is running with the same run, without a second post", async () => {
    const { self, listeners } = setup();
    let release: () => void = () => {};
    self.registration.pushManager.subscribe.mockImplementation(() => new Promise((resolve) => (release = () => resolve(subscription(FRESH)))));

    const first = fireChange(listeners, { oldSubscription: subscription(OLD) });
    const second = fireChange(listeners, { oldSubscription: subscription(OLD) });
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all([first, second]);

    expect(self.registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(1);
  });

  it("runs again for an event that comes after the earlier run ended", async () => {
    const { self, listeners } = setup();

    await fireChange(listeners, { oldSubscription: subscription(OLD) });
    await fireChange(listeners, { oldSubscription: subscription(FRESH) });

    expect(self.registration.pushManager.subscribe).toHaveBeenCalledTimes(2);
    expect(posts()).toHaveLength(2);
  });

  it("runs again after a run that failed", async () => {
    const { self, listeners } = setup();
    self.registration.pushManager.subscribe.mockRejectedValueOnce(new Error("push service down"));

    await fireChange(listeners, { oldSubscription: subscription(OLD) });
    await fireChange(listeners, { oldSubscription: subscription(OLD) });

    expect(posts()).toHaveLength(1);
  });

  // WEBSW-06 and WEBSW-07
  it.each([
    ["the push service refuses to subscribe", (s: any) => s.registration.pushManager.subscribe.mockRejectedValue(new Error("denied"))],
    ["the network is down", () => fetchMock.mockRejectedValue(new Error("offline"))],
    ["the API answers an error", () => fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "vapid_key_unknown" }) })],
    ["the API answers 500", () => fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })],
  ])("never throws and keeps the endpoint to replace when %s", async (_name, fail) => {
    const { self, listeners, idb } = setup();
    fail(self);

    await expect(fireChange(listeners, { oldSubscription: subscription(OLD) })).resolves.toBeUndefined();

    expect(stateOf(idb)).toEqual({ projectKey: PROJECT_KEY, endpoint: STORED, pendingReplace: OLD });
  });

  it("keeps the stored endpoint to replace when the event has no old subscription and the post fails", async () => {
    const { listeners, idb } = setup();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/vapid-key")) return { ok: true, json: async () => ({ vapid_public_key: KEY_B64URL }) };
      throw new Error("offline");
    });

    await fireChange(listeners, {});

    expect(stateOf(idb)?.pendingReplace).toBe(STORED);
  });

  it("does not reject when the database cannot be opened or is missing", async () => {
    const broken = loadWorker([], API_URL, { indexedDB: fakeIndexedDB({}, { failOpen: true }) });
    await expect(fireChange(broken.listeners, { oldSubscription: subscription(OLD) })).resolves.toBeUndefined();

    const missing = loadWorker([], API_URL);
    await expect(fireChange(missing.listeners, { oldSubscription: subscription(OLD) })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not throw out of the handler when the event is odd", async () => {
    const { listeners } = setup();
    for (const init of [{ oldSubscription: null }, { oldSubscription: {} }, { oldSubscription: { endpoint: 7, options: 3 } }, { newSubscription: {} }]) {
      await expect(fireChange(listeners, init)).resolves.toBeUndefined();
    }
  });

  // WEBSW-11: the key the page keeps for the worker is a public one, and anything else is refused.
  it.each([["sk_live_secret"], ["SK_live_secret"], ["token"], [""], [7], [null]])("makes no call and does not subscribe with the key %p", async (key) => {
    const { self, listeners } = setup({ projectKey: key, endpoint: STORED });

    await expect(fireChange(listeners, { oldSubscription: subscription(OLD) })).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(self.registration.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("makes no call when the page never stored a project key (an older page)", async () => {
    for (const state of [null, {}, { endpoint: STORED }, "text"] as const) {
      const { self, listeners } = setup(state as any);
      await fireChange(listeners, { oldSubscription: subscription(OLD) });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(self.registration.pushManager.subscribe).not.toHaveBeenCalled();
    }
  });

  // WEBSW-12
  it.each([
    ["the placeholder (never built)", null],
    ["a plain http API on the internet", "http://api.example"],
    ["a plain http API on this machine", "http://localhost:8080"],
    ["a javascript url", "javascript:alert(1)"],
    ["a file url", "file:///etc/passwd"],
    ["an empty url", ""],
  ])("makes no call when the compiled API is %s", async (_name, apiUrl) => {
    const { self, listeners } = setup(undefined, apiUrl);

    await expect(fireChange(listeners, { oldSubscription: subscription(OLD) })).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(self.registration.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("never takes the API or the key from the event", async () => {
    const { listeners } = setup();

    await fireChange(listeners, { oldSubscription: subscription(OLD), apiUrl: "https://attacker.example", projectKey: "pk_live_other", data: { apiUrl: "https://attacker.example" } });

    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith(API_URL))).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${PROJECT_KEY}`);
  });

  it("does not name the new endpoint as the one it replaces", async () => {
    const { self, listeners } = setup();
    self.registration.pushManager.subscribe.mockResolvedValue(subscription(OLD));

    await fireChange(listeners, { oldSubscription: subscription(OLD) });

    expect(posts()).toHaveLength(1);
    expect(bodyOf(posts()[0])).not.toHaveProperty("replaces_endpoint");
  });

  // WEBSW-13
  it.each([
    ["an http endpoint", "http://push.example/old"],
    ["an endpoint over 2048 characters", `https://push.example/${"a".repeat(2030)}`],
    ["an endpoint that is not text", 7],
  ])("posts without replaces_endpoint when the old endpoint is %s", async (_name, endpoint) => {
    const { listeners } = setup({ projectKey: PROJECT_KEY });

    await fireChange(listeners, { oldSubscription: subscription(endpoint as any) });

    expect(posts()).toHaveLength(1);
    expect(bodyOf(posts()[0])).not.toHaveProperty("replaces_endpoint");
  });

  it("accepts an old endpoint of exactly 2048 characters", async () => {
    const edge = `https://push.example/${"a".repeat(2048 - "https://push.example/".length)}`;
    expect(edge).toHaveLength(2048);
    const { listeners } = setup({ projectKey: PROJECT_KEY });

    await fireChange(listeners, { oldSubscription: subscription(edge) });

    expect(bodyOf(posts()[0]).replaces_endpoint).toBe(edge);
  });

  it("uses the same database and record as the page client", () => {
    const sw = fs.readFileSync(path.join(__dirname, "..", "src", "sw.ts"), "utf8");
    const page = fs.readFileSync(path.join(__dirname, "..", "src", "index.ts"), "utf8");
    for (const name of ["STATE_DB", "STATE_STORE", "STATE_KEY"]) {
      const pick = (source: string) => source.match(new RegExp(`const ${name} = ("[^"]+");`))?.[1];
      expect(pick(sw)).toBeDefined();
      expect(pick(sw)).toBe(pick(page));
    }
    expect(pickConst(sw, "STATE_DB")).toBe('"espresso-notify"');
    expect(pickConst(sw, "STATE_STORE")).toBe('"state"');
    expect(pickConst(sw, "STATE_KEY")).toBe('"web-push"');
  });

  it("opens the database espresso-notify", async () => {
    const { listeners, idb } = setup();

    await fireChange(listeners, { oldSubscription: subscription(OLD) });

    expect(idb.opened?.name).toBe("espresso-notify");
  });
});

function pickConst(source: string, name: string): string | undefined {
  return source.match(new RegExp(`const ${name} = ("[^"]+");`))?.[1];
}
