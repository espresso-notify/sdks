import {
  SubscribeError,
  WebPushClient,
  getPermissionState,
  getSupport,
  isSupported,
  requestPermission,
} from "../src/index";

// WEB-69..77 (web-push-v1, batch 2): what the SDK tells the host about the browser and the
// permission, and why a subscription failed. The browser is a fake that each test builds.

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1";

interface FakeOptions {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
  displayModeStandalone?: boolean;
  serviceWorker?: boolean;
  pushManager?: boolean;
  notification?: boolean;
  permission?: "default" | "granted" | "denied";
  /** What the visitor answers to the prompt; "dismiss" leaves the permission at default. */
  answer?: "granted" | "denied" | "dismiss";
  callbackStyle?: boolean;
}

const g = globalThis as unknown as Record<string, unknown>;
const KEYS = ["navigator", "Notification", "PushManager", "matchMedia", "fetch"];
const saved: Record<string, PropertyDescriptor | undefined> = {};

function define(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
function remove(name: string) {
  delete g[name];
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k]) Object.defineProperty(globalThis, k, saved[k]!);
    else remove(k);
  }
  dice?.mockRestore();
  dice = undefined;
});

// A failure that can pass (no answer, 408, 429, 5xx) is tried again up to 6 times with a random wait (send-scale T82).
// A test that makes the server fail for good says the dice give 0, so the waits are 0 ms and it ends at once.
let dice: jest.SpyInstance | undefined;
function noWait() {
  dice = jest.spyOn(Math, "random").mockReturnValue(0);
}

const mockSubscription = {
  endpoint: "https://fcm.googleapis.com/test",
  toJSON: () => ({ endpoint: "https://fcm.googleapis.com/test", keys: { p256dh: "key123", auth: "auth456" } }),
  unsubscribe: jest.fn().mockResolvedValue(true),
};

/** Installs a fake browser and returns the spies the tests look at. */
function fakeBrowser(o: FakeOptions = {}) {
  const calls: string[] = [];
  const pushManager = {
    getSubscription: jest.fn().mockResolvedValue(null),
    subscribe: jest.fn().mockImplementation(async () => {
      calls.push("pushManager.subscribe");
      return mockSubscription;
    }),
  };
  const registration = { pushManager };
  const nav: Record<string, unknown> = {
    userAgent: o.userAgent ?? CHROME,
    platform: o.platform ?? "Win32",
    maxTouchPoints: o.maxTouchPoints ?? 0,
  };
  if (o.standalone !== undefined) nav.standalone = o.standalone;
  if (o.serviceWorker !== false) {
    nav.serviceWorker = {
      register: jest.fn().mockImplementation(async () => {
        calls.push("register");
        return registration;
      }),
      getRegistration: jest.fn().mockResolvedValue(registration),
    };
  }
  define("navigator", nav);
  if (o.displayModeStandalone !== undefined) {
    define("matchMedia", () => ({ matches: o.displayModeStandalone === true }));
  } else {
    remove("matchMedia");
  }
  if (o.pushManager !== false) define("PushManager", function PushManager() {});
  else remove("PushManager");

  const requestSpy = jest.fn();
  if (o.notification !== false) {
    const Notification: { permission: string; requestPermission: jest.Mock } = {
      permission: o.permission ?? "default",
      requestPermission: requestSpy,
    };
    const settle = () => {
      calls.push("requestPermission");
      if (o.answer === "granted") Notification.permission = "granted";
      else if (o.answer === "denied") Notification.permission = "denied";
      return Notification.permission;
    };
    requestSpy.mockImplementation((cb?: (p: string) => void) => {
      const result = settle();
      if (o.callbackStyle) {
        cb?.(result);
        return undefined;
      }
      return Promise.resolve(result);
    });
    define("Notification", Notification);
  } else {
    remove("Notification");
  }
  const fetchMock = jest.fn().mockImplementation(async (url: string) => {
    if (url.includes("/v1/web-push/vapid-key")) return { ok: true, json: async () => ({ vapid_public_key: "BNabc123" }) };
    return { ok: true, json: async () => ({}) };
  });
  define("fetch", fetchMock);
  return { calls, pushManager, registration, requestSpy, fetchMock, navigator: nav };
}

describe("getSupport / isSupported", () => {
  it("is supported when the service worker, PushManager and Notification exist (AC 1)", () => {
    fakeBrowser();
    expect(isSupported()).toBe(true);
    expect(getSupport()).toEqual({ supported: true });
    expect(new WebPushClient({ projectId: "pk" }).isSupported()).toBe(true);
  });

  it.each([
    ["serviceWorker", { serviceWorker: false }, "no_service_worker"],
    ["PushManager", { pushManager: false }, "no_push_manager"],
    ["Notification", { notification: false }, "no_notification"],
  ] as const)("names the missing %s (AC 1)", (_name, options, reason) => {
    fakeBrowser(options);
    expect(isSupported()).toBe(false);
    expect(getSupport()).toEqual({ supported: false, reason });
    expect(new WebPushClient({ projectId: "pk" }).getSupport()).toEqual({ supported: false, reason });
  });

  it("asks an iPhone in a Safari tab to install the app first (AC 2)", () => {
    fakeBrowser({ userAgent: IPHONE, platform: "iPhone", maxTouchPoints: 5, standalone: false });
    expect(getSupport()).toEqual({ supported: false, reason: "ios_requires_installed_app" });
    expect(isSupported()).toBe(false);
  });

  it("asks an iPad that presents itself as a Mac to install the app too (AC 2)", () => {
    fakeBrowser({ userAgent: CHROME.replace("Windows NT 10.0; Win64; x64", "Macintosh; Intel Mac OS X 10_15_7"), platform: "MacIntel", maxTouchPoints: 5 });
    expect(getSupport().reason).toBe("ios_requires_installed_app");
  });

  it("supports an iPhone app installed on the home screen, by navigator.standalone or display-mode (AC 2)", () => {
    fakeBrowser({ userAgent: IPHONE, platform: "iPhone", maxTouchPoints: 5, standalone: true });
    expect(getSupport()).toEqual({ supported: true });
    fakeBrowser({ userAgent: IPHONE, platform: "iPhone", maxTouchPoints: 5, displayModeStandalone: true });
    expect(getSupport()).toEqual({ supported: true });
  });

  it("does not take a Mac without a touch screen for an iPad (AC 2)", () => {
    fakeBrowser({ platform: "MacIntel", maxTouchPoints: 0 });
    expect(getSupport()).toEqual({ supported: true });
  });
});

describe("getPermissionState", () => {
  it.each(["default", "granted", "denied"] as const)("reports %s (AC 3)", (permission) => {
    fakeBrowser({ permission });
    expect(getPermissionState()).toBe(permission);
    expect(new WebPushClient({ projectId: "pk" }).getPermissionState()).toBe(permission);
  });

  it("reports unsupported when the browser has no Web Push (AC 3)", () => {
    fakeBrowser({ pushManager: false, permission: "granted" });
    expect(getPermissionState()).toBe("unsupported");
  });

  it("does not prompt (AC 3)", () => {
    const b = fakeBrowser({ permission: "default" });
    getPermissionState();
    expect(b.requestSpy).not.toHaveBeenCalled();
  });
});

describe("requestPermission", () => {
  it("asks once and returns the state afterwards (AC 4)", async () => {
    const b = fakeBrowser({ answer: "granted" });
    expect(await requestPermission()).toBe("granted");
    expect(b.requestSpy).toHaveBeenCalledTimes(1);
  });

  it("returns denied when the visitor refuses and default when the prompt is dismissed (AC 4)", async () => {
    fakeBrowser({ answer: "denied" });
    expect(await requestPermission()).toBe("denied");
    fakeBrowser({ answer: "dismiss" });
    expect(await requestPermission()).toBe("default");
  });

  it("works with the callback form of old Safari (AC 4)", async () => {
    fakeBrowser({ answer: "granted", callbackStyle: true });
    expect(await new WebPushClient({ projectId: "pk" }).requestPermission()).toBe("granted");
  });

  it("does not prompt a browser without Web Push (AC 4)", async () => {
    const b = fakeBrowser({ pushManager: false });
    expect(await requestPermission()).toBe("unsupported");
    expect(b.requestSpy).not.toHaveBeenCalled();
  });

  it("never prompts when the client is created or the module is loaded (AC 4)", () => {
    const b = fakeBrowser({ permission: "default" });
    new WebPushClient({ projectId: "pk" });
    expect(b.requestSpy).not.toHaveBeenCalled();
  });
});

describe("trySubscribe", () => {
  it("subscribes a granted browser and reports ok (AC 5)", async () => {
    const b = fakeBrowser({ permission: "granted" });
    const result = await new WebPushClient({ projectId: "pk" }).trySubscribe();
    expect(result).toEqual({ ok: true });
    expect(b.requestSpy).not.toHaveBeenCalled();
    expect(b.calls).toEqual(["register", "pushManager.subscribe"]);
  });

  it("reports unsupported with the reason of the browser (AC 5)", async () => {
    const b = fakeBrowser({ pushManager: false });
    expect(await new WebPushClient({ projectId: "pk" }).trySubscribe()).toEqual({ ok: false, reason: "unsupported", message: "no_push_manager" });
    expect(b.calls).toEqual([]);
  });

  it("does not try a denied permission again (AC 6)", async () => {
    const b = fakeBrowser({ permission: "denied" });
    expect(await new WebPushClient({ projectId: "pk" }).trySubscribe()).toEqual({ ok: false, reason: "permission_denied" });
    expect(b.requestSpy).not.toHaveBeenCalled();
    expect(b.calls).toEqual([]);
  });

  it("asks for the permission before it subscribes (AC 6)", async () => {
    const b = fakeBrowser({ permission: "default", answer: "granted" });
    expect(await new WebPushClient({ projectId: "pk" }).trySubscribe()).toEqual({ ok: true });
    expect(b.calls).toEqual(["requestPermission", "register", "pushManager.subscribe"]);
  });

  it("reports permission_denied when the prompt is refused and permission_dismissed when it is closed (AC 5, 6)", async () => {
    const refused = fakeBrowser({ permission: "default", answer: "denied" });
    expect(await new WebPushClient({ projectId: "pk" }).trySubscribe()).toEqual({ ok: false, reason: "permission_denied" });
    expect(refused.calls).toEqual(["requestPermission"]);

    const closed = fakeBrowser({ permission: "default", answer: "dismiss" });
    expect(await new WebPushClient({ projectId: "pk" }).trySubscribe()).toEqual({ ok: false, reason: "permission_dismissed" });
    expect(closed.calls).toEqual(["requestPermission"]);
  });

  it("reports no_service_worker when the worker cannot be registered (AC 5)", async () => {
    const b = fakeBrowser({ permission: "granted" });
    (b.navigator.serviceWorker as { register: jest.Mock }).register.mockRejectedValue(new TypeError("Failed to register a ServiceWorker: 404"));
    expect(await new WebPushClient({ projectId: "pk" }).trySubscribe()).toEqual({
      ok: false,
      reason: "no_service_worker",
      message: "Failed to register a ServiceWorker: 404",
    });
  });

  it("reports vapid_key_missing when the key cannot be fetched or is empty (AC 5)", async () => {
    const b = fakeBrowser({ permission: "granted" });
    b.fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    const failed = await new WebPushClient({ projectId: "pk" }).trySubscribe();
    expect(failed).toMatchObject({ ok: false, reason: "vapid_key_missing" });

    const empty = fakeBrowser({ permission: "granted" });
    empty.fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    expect(await new WebPushClient({ projectId: "pk" }).trySubscribe()).toMatchObject({ ok: false, reason: "vapid_key_missing" });
  });

  it("reports permission_denied when the browser refuses the subscription itself (AC 5)", async () => {
    const b = fakeBrowser({ permission: "granted" });
    const denied = new Error("Registration failed - permission denied");
    denied.name = "NotAllowedError";
    b.pushManager.subscribe.mockRejectedValue(denied);
    expect(await new WebPushClient({ projectId: "pk" }).trySubscribe()).toMatchObject({ ok: false, reason: "permission_denied" });
  });

  it("reports server_error for a push service failure, a refusal of the backend and a network failure (AC 5)", async () => {
    const pushFailure = fakeBrowser({ permission: "granted" });
    pushFailure.pushManager.subscribe.mockRejectedValue(new Error("Registration failed - push service error"));
    expect(await new WebPushClient({ projectId: "pk" }).trySubscribe()).toMatchObject({ ok: false, reason: "server_error", message: "Registration failed - push service error" });

    const refused = fakeBrowser({ permission: "granted" });
    refused.fetchMock.mockImplementation(async (url: string) =>
      url.includes("vapid-key")
        ? { ok: true, json: async () => ({ vapid_public_key: "BNabc123" }) }
        : { ok: false, status: 400, json: async () => ({ error: "invalid endpoint" }) },
    );
    expect(await new WebPushClient({ projectId: "pk" }).trySubscribe()).toEqual({ ok: false, reason: "server_error", message: "invalid endpoint" });

    noWait();
    const offline = fakeBrowser({ permission: "granted" });
    offline.fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await new WebPushClient({ projectId: "pk" }).trySubscribe()).toMatchObject({ ok: false, reason: "server_error", message: "Failed to fetch" });
  });
});

describe("getSubscription and the functions that already existed", () => {
  it("returns the subscription of the browser, or null (AC 7)", async () => {
    const b = fakeBrowser({ permission: "granted" });
    b.pushManager.getSubscription.mockResolvedValue(mockSubscription);
    expect(await new WebPushClient({ projectId: "pk" }).getSubscription()).toBe(mockSubscription);

    b.pushManager.getSubscription.mockResolvedValue(null);
    expect(await new WebPushClient({ projectId: "pk" }).getSubscription()).toBeNull();

    fakeBrowser({ serviceWorker: false });
    expect(await new WebPushClient({ projectId: "pk" }).getSubscription()).toBeNull();
  });

  it("unsubscribe still cancels in the browser and in the backend (AC 7)", async () => {
    const b = fakeBrowser({ permission: "granted" });
    const client = new WebPushClient({ projectId: "pk" });
    await client.trySubscribe();
    b.fetchMock.mockClear();
    await client.unsubscribe();
    expect(mockSubscription.unsubscribe).toHaveBeenCalled();
    expect(b.fetchMock).toHaveBeenCalledWith(expect.stringContaining("/v1/web-push/subscribe"), expect.objectContaining({ method: "DELETE" }));
  });

  it("subscribe() keeps resolving false without a service worker and throwing what the browser raised (AC 8)", async () => {
    fakeBrowser({ serviceWorker: false });
    expect(await new WebPushClient({ projectId: "pk" }).subscribe()).toBe(false);

    const b = fakeBrowser({ permission: "granted" });
    const raised = new TypeError("Failed to register a ServiceWorker");
    (b.navigator.serviceWorker as { register: jest.Mock }).register.mockRejectedValue(raised);
    await expect(new WebPushClient({ projectId: "pk" }).subscribe()).rejects.toBe(raised);
  });

  it("subscribe() throws a SubscribeError with the reason for a backend refusal (AC 8)", async () => {
    noWait();
    const b = fakeBrowser({ permission: "granted" });
    b.fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }); // stays down: tried 6 times
    const error = await new WebPushClient({ projectId: "pk" }).subscribe().catch((e) => e);
    expect(error).toBeInstanceOf(SubscribeError);
    expect(error.reason).toBe("vapid_key_missing");
    expect(error.message).toBe("Failed to fetch VAPID key — check that web push is configured in the dashboard");
  });
});
