// A browser for the tests of the page client: a service worker registration whose push manager keeps one
// subscription at a time (subscribing makes it, unsubscribing drops it), the globals that make `isSupported()`
// true, and a `fetch` that answers from a table of routes. It covers only the calls the SDK makes.

export const ENDPOINT = "https://push.example/endpoint-1";

export interface FakeSubscription {
  endpoint: string;
  toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } };
  unsubscribe: jest.Mock;
}

export interface FakeBrowser {
  /** The subscription the push manager holds now, or null. */
  current: FakeSubscription | null;
  registration: { pushManager: { getSubscription: jest.Mock; subscribe: jest.Mock } };
  uninstall: () => void;
}

export function makeSubscription(browser: { current: FakeSubscription | null }, endpoint = ENDPOINT): FakeSubscription {
  const sub: FakeSubscription = {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: "key123", auth: "auth456" } }),
    unsubscribe: jest.fn(async () => {
      if (browser.current === sub) browser.current = null;
      return true;
    }),
  };
  return sub;
}

/** Installs the fake on `navigator` and `globalThis`. `subscribed` starts the browser with a subscription. */
export function installFakeBrowser(options: { subscribed?: boolean } = {}): FakeBrowser {
  const browser = { current: null as FakeSubscription | null } as FakeBrowser;
  if (options.subscribed) browser.current = makeSubscription(browser);
  browser.registration = {
    pushManager: {
      getSubscription: jest.fn(async () => browser.current),
      subscribe: jest.fn(async () => (browser.current = makeSubscription(browser))),
    },
  };
  const g = globalThis as Record<string, unknown>;
  const before = {
    serviceWorker: Object.getOwnPropertyDescriptor(global.navigator, "serviceWorker"),
    PushManager: g.PushManager,
    Notification: g.Notification,
  };
  Object.defineProperty(global.navigator, "serviceWorker", {
    value: {
      register: jest.fn(async () => browser.registration),
      getRegistration: jest.fn(async () => browser.registration),
    },
    writable: true,
    configurable: true,
  });
  g.PushManager = class {};
  g.Notification = { permission: "granted" };
  browser.uninstall = () => {
    if (before.serviceWorker) Object.defineProperty(global.navigator, "serviceWorker", before.serviceWorker);
    else delete (global.navigator as unknown as Record<string, unknown>).serviceWorker;
    if (before.PushManager === undefined) delete g.PushManager;
    else g.PushManager = before.PushManager;
    if (before.Notification === undefined) delete g.Notification;
    else g.Notification = before.Notification;
  };
  return browser;
}

export interface Answer {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A `fetch` answering by "METHOD path"; the VAPID key route answers by default. A function answers per call, from the request. */
type Route = Answer | ((init: { method?: string; body?: string }) => Answer);
export function fakeFetch(routes: Record<string, Route>): jest.Mock {
  const all: Record<string, Route> = { "GET /v1/web-push/vapid-key": { body: { vapid_public_key: "BNabc123" } }, ...routes };
  return jest.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
    const path = String(url).replace(/^.*?(?=\/v1\/)/, "");
    const route = all[`${init.method ?? "GET"} ${path}`];
    if (!route) return { ok: false, status: 404, json: async () => ({ error: "not_found", code: "not_found" }), headers: { get: () => null } };
    const answer = typeof route === "function" ? route(init) : route;
    const status = answer.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (answer.body === undefined ? {} : answer.body),
      headers: { get: (name: string) => answer.headers?.[name] ?? null },
    };
  });
}
