import { readFileSync } from "fs";
import { join } from "path";
import { WebPushClient } from "../src/index";
import { SW_PATH, SW_SCOPE } from "../src/swDefaults";
import { fakeIndexedDB } from "../test-support/fakeIndexedDB";

// Mock fetch globally
global.fetch = jest.fn();

// Mock navigator.serviceWorker
Object.defineProperty(global.navigator, "serviceWorker", {
  value: {
    register: jest.fn().mockResolvedValue({
      pushManager: {
        getSubscription: jest.fn().mockResolvedValue(null),
        subscribe: jest.fn().mockResolvedValue({
          endpoint: "https://fcm.googleapis.com/test",
          toJSON: () => ({
            endpoint: "https://fcm.googleapis.com/test",
            keys: { p256dh: "key123", auth: "auth456" },
          }),
        }),
      },
    }),
  },
  writable: true,
});

// Mock pushManager.subscribe to return a valid-looking subscription
const mockSubscription = {
  endpoint: "https://fcm.googleapis.com/test",
  toJSON: () => ({
    endpoint: "https://fcm.googleapis.com/test",
    keys: { p256dh: "key123", auth: "auth456" },
  }),
  unsubscribe: jest.fn().mockResolvedValue(true),
};

// The zone the browser reports. Fixed so the bodies below do not depend on the machine of the run.
const BROWSER_ZONE = "America/Sao_Paulo";

// A failure that can pass (no answer, 408, 429, 5xx) is tried again up to 6 times with a random wait (send-scale T82).
// A test that makes the server fail for good says the dice give 0, so the waits are 0 ms and it ends at once.
let dice: jest.SpyInstance | undefined;
function noWait() {
  dice = jest.spyOn(Math, "random").mockReturnValue(0);
}
afterEach(() => {
  dice?.mockRestore();
  dice = undefined;
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Intl, "DateTimeFormat").mockImplementation(
    () => ({ resolvedOptions: () => ({ timeZone: BROWSER_ZONE }) }) as unknown as Intl.DateTimeFormat,
  );
  // Default: fetch returns ok for subscribe/identify calls
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes("/v1/web-push/vapid-key")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ vapid_public_key: "BNabc123" }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
  // Reset subscription state: getSubscription returns null so subscribe() goes through full flow
  (navigator.serviceWorker.register as jest.Mock).mockResolvedValue({
    pushManager: {
      getSubscription: jest.fn().mockResolvedValue(null),
      subscribe: jest.fn().mockResolvedValue(mockSubscription),
    },
  });
});

describe("WebPushClient", () => {
  it("constructs without throwing", () => {
    expect(() => new WebPushClient({ projectId: "pk_live_test" })).not.toThrow();
  });

  it("registers the worker at the path the installer writes it to", async () => {
    const client = new WebPushClient({ projectId: "pk_live_test" });

    await client.subscribe();

    // Both values come from swDefaults, which the CLI also installs against.
    // Hard-coding either one here is how the client and the installer drifted
    // apart in the first place.
    expect(navigator.serviceWorker.register).toHaveBeenCalledWith(SW_PATH, { scope: SW_SCOPE });
  });

  it("lets the host override the worker location", async () => {
    const client = new WebPushClient({
      projectId: "pk_live_test",
      swPath: "/sw/custom.js",
      swScope: "/sw/",
    });

    await client.subscribe();

    expect(navigator.serviceWorker.register).toHaveBeenCalledWith("/sw/custom.js", { scope: "/sw/" });
  });

  it("subscribe fetches VAPID key then calls /v1/web-push/subscribe", async () => {
    const client = new WebPushClient({ projectId: "pk_live_test" });

    await client.subscribe();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/web-push/vapid-key"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer pk_live_test" }) })
    );
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/web-push/subscribe"),
      expect.objectContaining({ method: "POST" })
    );
  });

  // The body below is shared with the Go suite (backend/internal/api/web_push_identify_test.go),
  // which posts the same file to the real Subscribe handler. If the SDK and the route drift
  // apart, one of the two tests fails. identify() once sent user_id as a string to a field the
  // route binds as a number, so the route answered 400 and the old assertion hid it.
  describe("identify", () => {
    const golden = JSON.parse(readFileSync(join(__dirname, "fixtures", "identify-request.json"), "utf-8"));

    async function identifyBody(identify: (c: WebPushClient) => Promise<void>) {
      mockSubscription.toJSON = () => ({
        endpoint: golden.endpoint,
        keys: { p256dh: golden.p256dh, auth: golden.auth },
      });
      const client = new WebPushClient({ projectId: "pk_live_test" });
      await client.subscribe();
      (global.fetch as jest.Mock).mockClear();
      await identify(client);
      const calls = (global.fetch as jest.Mock).mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toContain("/v1/web-push/subscribe");
      expect(calls[0][1].method).toBe("POST");
      return JSON.parse(calls[0][1].body);
    }

    it("sends external_id, name and identity_hash exactly as the golden body", async () => {
      const body = await identifyBody((c) =>
        c.identify(golden.external_id, { name: golden.name, identityHash: golden.identity_hash }),
      );
      expect(body).toEqual(golden);
      expect(body).not.toHaveProperty("user_id");
    });

    it("omits name and identity_hash when the host does not pass them", async () => {
      const body = await identifyBody((c) => c.identify("user-42"));
      expect(body).toEqual({
        endpoint: golden.endpoint,
        p256dh: golden.p256dh,
        auth: golden.auth,
        timezone: BROWSER_ZONE,
        external_id: "user-42",
      });
    });

    it("surfaces the error code of a refusal", async () => {
      const client = new WebPushClient({ projectId: "pk_live_test" });
      await client.subscribe();
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ error: "identity_verification_failed" }),
      });
      await expect(client.identify("user-42")).rejects.toThrow("identity_verification_failed");
    });
  });

  it("updateMetadata sends only the metadata next to the subscription keys", async () => {
    const client = new WebPushClient({ projectId: "pk_live_test" });
    await client.subscribe();
    (global.fetch as jest.Mock).mockClear();
    await client.updateMetadata({ plan: "pro" });

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.metadata).toEqual({ plan: "pro" });
    expect(body).not.toHaveProperty("external_id");
    expect(body).not.toHaveProperty("user_id");
  });

  // WPC-04 (web-push-v1-closure): the zone of the browser travels with every post of the subscription,
  // so the quiet hours and delivery_mode of the project can use the local clock of the visitor.
  describe("time zone", () => {
    const lastBody = () => {
      const calls = (global.fetch as jest.Mock).mock.calls.filter(([url]) => String(url).includes("/v1/web-push/subscribe"));
      return JSON.parse(calls[calls.length - 1][1].body);
    };

    it("sends the zone of the browser with the subscription, the identify and the metadata", async () => {
      const client = new WebPushClient({ projectId: "pk_live_test" });
      await client.subscribe();
      expect(lastBody().timezone).toBe(BROWSER_ZONE);
      await client.identify("user-42");
      expect(lastBody().timezone).toBe(BROWSER_ZONE);
      await client.updateMetadata({ plan: "pro" });
      expect(lastBody().timezone).toBe(BROWSER_ZONE);
    });

    it("sends no zone key when the browser cannot say", async () => {
      (Intl.DateTimeFormat as unknown as jest.Mock).mockImplementation(() => {
        throw new Error("no Intl");
      });
      const client = new WebPushClient({ projectId: "pk_live_test" });
      await client.subscribe();
      expect(lastBody()).not.toHaveProperty("timezone");
    });

    it("sends no zone key when the browser answers an empty zone", async () => {
      (Intl.DateTimeFormat as unknown as jest.Mock).mockImplementation(() => ({ resolvedOptions: () => ({ timeZone: "" }) }));
      const client = new WebPushClient({ projectId: "pk_live_test" });
      await client.subscribe();
      expect(lastBody()).not.toHaveProperty("timezone");
    });
  });

  // WPC-49, WPC-51 (web-push-v1-closure): after the project rotates its VAPID keys, a browser subscription
  // made with the old key is moved to the new one, and nothing is lost when the move cannot be done.
  describe("VAPID rotation", () => {
    const KEY_OLD = "BAAAAAAA";
    const KEY_NEW = "BBBBBBBB";
    const bufferOf = (b64url: string) => Uint8Array.from(atob(b64url.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)).buffer;
    const ENDPOINT_OLD = "https://push.example/old-endpoint";
    const ENDPOINT_NEW = "https://push.example/new-endpoint";

    function browserSub(endpoint: string, key: string | null, overrides: Record<string, unknown> = {}) {
      return {
        endpoint,
        options: key ? { applicationServerKey: bufferOf(key) } : {},
        toJSON: () => ({ endpoint, keys: { p256dh: "key123", auth: "auth456" } }),
        unsubscribe: jest.fn().mockResolvedValue(true),
        ...overrides,
      };
    }

    function arrange(existing: ReturnType<typeof browserSub> | null, subscribe: jest.Mock, serverKey: string | null = KEY_NEW) {
      (navigator.serviceWorker.register as jest.Mock).mockResolvedValue({
        pushManager: { getSubscription: jest.fn().mockResolvedValue(existing), subscribe },
      });
      (global.fetch as jest.Mock).mockImplementation((url: string) => {
        if (url.includes("/v1/web-push/vapid-key")) {
          return Promise.resolve(serverKey === null ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, json: async () => ({ vapid_public_key: serverKey }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      });
    }

    const postedBody = () => {
      const calls = (global.fetch as jest.Mock).mock.calls.filter(([url]) => String(url).includes("/v1/web-push/subscribe"));
      return JSON.parse(calls[calls.length - 1][1].body);
    };
    const keyArg = (subscribe: jest.Mock, call: number) => new Uint8Array(subscribe.mock.calls[call][0].applicationServerKey);

    it("leaves a subscription made with the current key alone and tells the server which key it has", async () => {
      const existing = browserSub(ENDPOINT_OLD, KEY_NEW);
      const subscribe = jest.fn();
      arrange(existing, subscribe);

      await new WebPushClient({ projectId: "pk_live_test" }).subscribe();

      expect(existing.unsubscribe).not.toHaveBeenCalled();
      expect(subscribe).not.toHaveBeenCalled();
      expect(postedBody()).toMatchObject({ endpoint: ENDPOINT_OLD, vapid_public_key: KEY_NEW });
      expect(postedBody()).not.toHaveProperty("replaces_endpoint");
    });

    it("moves a subscription made with another key to the current one and names the one it replaces", async () => {
      const existing = browserSub(ENDPOINT_OLD, KEY_OLD);
      const subscribe = jest.fn().mockResolvedValue(browserSub(ENDPOINT_NEW, KEY_NEW));
      arrange(existing, subscribe);

      await new WebPushClient({ projectId: "pk_live_test" }).subscribe();

      expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(Array.from(keyArg(subscribe, 0))).toEqual(Array.from(new Uint8Array(bufferOf(KEY_NEW))));
      expect(postedBody()).toMatchObject({ endpoint: ENDPOINT_NEW, vapid_public_key: KEY_NEW, replaces_endpoint: ENDPOINT_OLD });
    });

    it("keeps the subscription it has when the key of the server cannot be read", async () => {
      const existing = browserSub(ENDPOINT_OLD, KEY_OLD);
      const subscribe = jest.fn();
      arrange(existing, subscribe, null);

      await expect(new WebPushClient({ projectId: "pk_live_test" }).subscribe()).resolves.toBe(true);

      expect(existing.unsubscribe).not.toHaveBeenCalled();
      expect(postedBody()).toMatchObject({ endpoint: ENDPOINT_OLD, vapid_public_key: KEY_OLD });
    });

    it("subscribes again with the old key when the new one cannot be used, so the browser keeps a subscription", async () => {
      const existing = browserSub(ENDPOINT_OLD, KEY_OLD);
      const restored = browserSub(ENDPOINT_NEW, KEY_OLD);
      const subscribe = jest.fn().mockRejectedValueOnce(new Error("push service says no")).mockResolvedValueOnce(restored);
      arrange(existing, subscribe);

      await new WebPushClient({ projectId: "pk_live_test" }).subscribe();

      expect(subscribe).toHaveBeenCalledTimes(2);
      expect(Array.from(keyArg(subscribe, 1))).toEqual(Array.from(new Uint8Array(bufferOf(KEY_OLD))));
      expect(postedBody()).toMatchObject({ endpoint: ENDPOINT_NEW, vapid_public_key: KEY_OLD, replaces_endpoint: ENDPOINT_OLD });
    });

    it("fails with the reason when the browser cannot subscribe with either key", async () => {
      const existing = browserSub(ENDPOINT_OLD, KEY_OLD);
      arrange(existing, jest.fn().mockRejectedValue(new Error("offline")));

      await expect(new WebPushClient({ projectId: "pk_live_test" }).subscribe()).rejects.toThrow("offline");
    });

    it("keeps the subscription when the browser will not drop it", async () => {
      const existing = browserSub(ENDPOINT_OLD, KEY_OLD, { unsubscribe: jest.fn().mockRejectedValue(new Error("busy")) });
      const subscribe = jest.fn();
      arrange(existing, subscribe);

      await new WebPushClient({ projectId: "pk_live_test" }).subscribe();

      expect(subscribe).not.toHaveBeenCalled();
      expect(postedBody()).toMatchObject({ endpoint: ENDPOINT_OLD, vapid_public_key: KEY_OLD });
      expect(postedBody()).not.toHaveProperty("replaces_endpoint");
    });

    it("does not guess when the browser does not say which key a subscription was made with", async () => {
      const existing = browserSub(ENDPOINT_OLD, null);
      const subscribe = jest.fn();
      arrange(existing, subscribe);

      await new WebPushClient({ projectId: "pk_live_test" }).subscribe();

      expect(existing.unsubscribe).not.toHaveBeenCalled();
      expect(postedBody()).not.toHaveProperty("vapid_public_key");
    });

    it("treats two spellings of one key as the same key", async () => {
      const existing = browserSub(ENDPOINT_OLD, KEY_NEW);
      const subscribe = jest.fn();
      arrange(existing, subscribe, KEY_NEW + "==");

      await new WebPushClient({ projectId: "pk_live_test" }).subscribe();

      expect(existing.unsubscribe).not.toHaveBeenCalled();
    });

    it("still fails with vapid_key_missing when a browser with no subscription cannot read the key", async () => {
      noWait();
      arrange(null, jest.fn(), null);

      await expect(new WebPushClient({ projectId: "pk_live_test" }).subscribe()).rejects.toThrow("Failed to fetch VAPID key");
    });
  });
});

// web-sw-subscription-change (WEBSW-07 to WEBSW-10): the page leaves the service worker what it needs to
// subscribe again when the browser changes the subscription (the PUBLIC key of the project and the endpoint
// the API knows), and finishes the job of a run that failed.
describe("state kept for the service worker", () => {
  const ENDPOINT = "https://fcm.googleapis.com/test";
  const PENDING = "https://push.example/pending-endpoint";
  const posted = () => {
    const calls = (global.fetch as jest.Mock).mock.calls.filter(([url]) => String(url).includes("/v1/web-push/subscribe"));
    return calls.map(([, init]) => JSON.parse(init.body));
  };

  // A browser subscription whose endpoint is the same in the object and in its JSON, as in a real browser.
  const own = {
    endpoint: ENDPOINT,
    toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: "key123", auth: "auth456" } }),
    unsubscribe: jest.fn().mockResolvedValue(true),
  };

  beforeEach(() => {
    (navigator.serviceWorker.register as jest.Mock).mockResolvedValue({
      pushManager: { getSubscription: jest.fn().mockResolvedValue(null), subscribe: jest.fn().mockResolvedValue(own) },
    });
  });

  afterEach(() => {
    delete (globalThis as any).indexedDB;
  });

  function useDb(initial: Record<string, unknown> = {}, options: { failOpen?: boolean } = {}) {
    const idb = fakeIndexedDB(initial, options);
    (globalThis as any).indexedDB = idb;
    return idb;
  }

  it("stores the public key of the project and the endpoint after a successful subscription, and nothing else", async () => {
    const idb = useDb();

    await new WebPushClient({ projectId: "pk_live_test" }).subscribe();

    expect(idb.data.get("web-push")).toEqual({ projectKey: "pk_live_test", endpoint: ENDPOINT });
    expect(idb.opened?.name).toBe("espresso-notify");
  });

  it("stores nothing for a key that is not a public project key", async () => {
    const idb = useDb();

    await new WebPushClient({ projectId: "some-project-id" }).subscribe();

    expect(idb.data.has("web-push")).toBe(false);
  });

  it("stores nothing when the server refuses the subscription", async () => {
    noWait();
    const idb = useDb();
    (global.fetch as jest.Mock).mockImplementation((url: string) =>
      Promise.resolve(url.includes("/vapid-key") ? { ok: true, json: async () => ({ vapid_public_key: "BNabc123" }) } : { ok: false, status: 500, json: async () => ({}) }),
    );

    await expect(new WebPushClient({ projectId: "pk_live_test" }).subscribe()).rejects.toThrow();

    expect(idb.data.has("web-push")).toBe(false);
  });

  it("subscribes normally when the browser has no IndexedDB or it fails", async () => {
    await expect(new WebPushClient({ projectId: "pk_live_test" }).subscribe()).resolves.toBe(true);

    useDb({}, { failOpen: true });
    await expect(new WebPushClient({ projectId: "pk_live_test" }).subscribe()).resolves.toBe(true);
  });

  it("sends the endpoint a failed worker left as replaces_endpoint and clears it once the server accepts", async () => {
    const idb = useDb({ "web-push": { projectKey: "pk_live_test", endpoint: PENDING, pendingReplace: PENDING } });

    await new WebPushClient({ projectId: "pk_live_test" }).subscribe();

    expect(posted().pop()).toMatchObject({ endpoint: ENDPOINT, replaces_endpoint: PENDING });
    expect(idb.data.get("web-push")).toEqual({ projectKey: "pk_live_test", endpoint: ENDPOINT });
  });

  it("names the pending endpoint for a subscription the worker made without telling the API", async () => {
    const idb = useDb({ "web-push": { projectKey: "pk_live_test", endpoint: PENDING, pendingReplace: PENDING } });
    const made = { ...own, endpoint: "https://push.example/made-by-worker", toJSON: () => ({ endpoint: "https://push.example/made-by-worker", keys: { p256dh: "k", auth: "a" } }) };
    (navigator.serviceWorker.register as jest.Mock).mockResolvedValue({
      pushManager: { getSubscription: jest.fn().mockResolvedValue(made), subscribe: jest.fn() },
    });

    await new WebPushClient({ projectId: "pk_live_test" }).subscribe();

    expect(posted().pop()).toMatchObject({ endpoint: "https://push.example/made-by-worker", replaces_endpoint: PENDING });
    expect(idb.data.get("web-push")).toEqual({ projectKey: "pk_live_test", endpoint: "https://push.example/made-by-worker" });
  });

  it("does not name the pending endpoint when it is the subscription the browser has", async () => {
    useDb({ "web-push": { projectKey: "pk_live_test", endpoint: ENDPOINT, pendingReplace: ENDPOINT } });

    await new WebPushClient({ projectId: "pk_live_test" }).subscribe();

    expect(posted().pop()).not.toHaveProperty("replaces_endpoint");
  });

  it("keeps the pending endpoint when the server refuses the subscription", async () => {
    noWait();
    const idb = useDb({ "web-push": { projectKey: "pk_live_test", endpoint: PENDING, pendingReplace: PENDING } });
    (global.fetch as jest.Mock).mockImplementation((url: string) =>
      Promise.resolve(url.includes("/vapid-key") ? { ok: true, json: async () => ({ vapid_public_key: "BNabc123" }) } : { ok: false, status: 500, json: async () => ({}) }),
    );

    await expect(new WebPushClient({ projectId: "pk_live_test" }).subscribe()).rejects.toThrow();

    expect((idb.data.get("web-push") as any).pendingReplace).toBe(PENDING);
  });

  it("prefers the pending endpoint to the one of its own move to a new key", async () => {
    useDb({ "web-push": { projectKey: "pk_live_test", endpoint: PENDING, pendingReplace: PENDING } });
    const bufferOf = (b64url: string) => Uint8Array.from(atob(b64url.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)).buffer;
    const existing = {
      endpoint: "https://push.example/made-by-worker",
      options: { applicationServerKey: bufferOf("BAAAAAAA") },
      toJSON: () => ({ endpoint: "https://push.example/made-by-worker", keys: { p256dh: "k", auth: "a" } }),
      unsubscribe: jest.fn().mockResolvedValue(true),
    };
    (navigator.serviceWorker.register as jest.Mock).mockResolvedValue({
      pushManager: { getSubscription: jest.fn().mockResolvedValue(existing), subscribe: jest.fn().mockResolvedValue(own) },
    });
    (global.fetch as jest.Mock).mockImplementation((url: string) =>
      Promise.resolve(url.includes("/vapid-key") ? { ok: true, json: async () => ({ vapid_public_key: "BBBBBBBB" }) } : { ok: true, json: async () => ({}) }),
    );

    await new WebPushClient({ projectId: "pk_live_test" }).subscribe();

    expect(posted().pop()).toMatchObject({ endpoint: ENDPOINT, replaces_endpoint: PENDING });
  });

  it("erases the record on unsubscribe, so the worker does not subscribe someone who left", async () => {
    const idb = useDb();
    const client = new WebPushClient({ projectId: "pk_live_test" });
    await client.subscribe();
    expect(idb.data.has("web-push")).toBe(true);

    await client.unsubscribe();

    expect(idb.data.has("web-push")).toBe(false);
  });

  it("still unsubscribes when the record cannot be erased", async () => {
    const client = new WebPushClient({ projectId: "pk_live_test" });
    await client.subscribe();
    useDb({}, { failOpen: true });

    await expect(client.unsubscribe()).resolves.toBeUndefined();
  });
});
