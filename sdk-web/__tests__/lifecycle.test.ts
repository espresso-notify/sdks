import { SubscribeError, WebPushClient } from "../src/index";
import { ENDPOINT, FakeBrowser, fakeFetch, installFakeBrowser } from "../test-support/fakeBrowser";
import { fakeIndexedDB } from "../test-support/fakeIndexedDB";

// web-sdk-completion T13 (WSC-11): the two paths that had no test (the project with no VAPID key, and unsubscribe
// from end to end against a server that keeps state), and the refusal of a secret key.

let browser: FakeBrowser;
let idb: ReturnType<typeof fakeIndexedDB>;
const PROJECT = "pk_live_test";
const VAPID = "GET /v1/web-push/vapid-key";
const SUBSCRIBE = "POST /v1/web-push/subscribe";

beforeEach(() => {
  idb = fakeIndexedDB();
  (globalThis as any).indexedDB = idb;
});

afterEach(() => {
  browser?.uninstall();
  delete (globalThis as any).indexedDB;
});

describe("a project with no VAPID key", () => {
  const cases: Array<[string, Parameters<typeof fakeFetch>[0]]> = [
    ["the key route answers 404", { [VAPID]: { status: 404, body: { error: "web_push_not_configured" } } }],
    ["the key route answers 200 with no vapid_public_key", { [VAPID]: { body: {} } }],
  ];

  describe.each(cases)("when %s", (_name, routes) => {
    it("makes subscribe() throw SubscribeError vapid_key_missing for a browser with no subscription, and posts nothing", async () => {
      browser = installFakeBrowser();
      const mock = fakeFetch({ [SUBSCRIBE]: { body: {} }, ...routes });
      global.fetch = mock as unknown as typeof fetch;

      const err = await new WebPushClient({ projectId: PROJECT }).subscribe().catch((e) => e);

      expect(err).toBeInstanceOf(SubscribeError);
      expect(err.reason).toBe("vapid_key_missing");
      expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
      expect(browser.registration.pushManager.subscribe).not.toHaveBeenCalled();
      expect(idb.data.has("web-push")).toBe(false);
    });

    it("makes trySubscribe() answer vapid_key_missing for a browser with no subscription", async () => {
      browser = installFakeBrowser();
      global.fetch = fakeFetch({ [SUBSCRIBE]: { body: {} }, ...routes }) as unknown as typeof fetch;

      const result = await new WebPushClient({ projectId: PROJECT }).trySubscribe();

      expect(result).toMatchObject({ ok: false, reason: "vapid_key_missing" });
    });

    it("goes on without an error for a browser that already has a subscription", async () => {
      browser = installFakeBrowser({ subscribed: true });
      const mock = fakeFetch({ [SUBSCRIBE]: { body: {} }, ...routes });
      global.fetch = mock as unknown as typeof fetch;

      await expect(new WebPushClient({ projectId: PROJECT }).subscribe()).resolves.toBe(true);
      expect(await new WebPushClient({ projectId: PROJECT }).trySubscribe()).toEqual({ ok: true });

      const posts = mock.mock.calls.filter(([, init]) => init?.method === "POST");
      expect(posts).toHaveLength(2);
      expect(JSON.parse(posts[0][1].body).endpoint).toBe(ENDPOINT);
    });
  });
});

describe("subscribe, identify and unsubscribe from end to end", () => {
  // A server that keeps what the API keeps: the subscriptions by endpoint and the user each one is linked to.
  function server() {
    const subscriptions = new Map<string, { external_id?: string }>();
    const routes: Parameters<typeof fakeFetch>[0] = {
      [SUBSCRIBE]: (init) => {
        const body = JSON.parse(init.body ?? "{}");
        subscriptions.set(body.endpoint, { ...subscriptions.get(body.endpoint), ...(body.external_id ? { external_id: body.external_id } : {}) });
        return { body: {} };
      },
      "DELETE /v1/web-push/subscribe": (init) => {
        subscriptions.delete(JSON.parse(init.body ?? "{}").endpoint);
        return { status: 204 };
      },
    };
    return { subscriptions, routes };
  }

  it("leaves no state on the server, in the local record or in the browser", async () => {
    browser = installFakeBrowser();
    const { subscriptions, routes } = server();
    global.fetch = fakeFetch(routes) as unknown as typeof fetch;
    const client = new WebPushClient({ projectId: PROJECT });

    await client.subscribe();
    await client.identify("user-42", { name: "Ana" });

    expect(subscriptions.get(ENDPOINT)).toEqual({ external_id: "user-42" });
    expect(idb.data.get("web-push")).toEqual({ projectKey: PROJECT, endpoint: ENDPOINT });
    expect(browser.current).not.toBeNull();

    await client.unsubscribe();

    expect(subscriptions.size).toBe(0);
    expect(idb.data.has("web-push")).toBe(false);
    expect(browser.current).toBeNull();
    expect(await client.getSubscription()).toBeNull();
  });

  it("sends the endpoint of the subscription in the body of the DELETE, with the public key", async () => {
    browser = installFakeBrowser();
    const { routes } = server();
    const mock = fakeFetch(routes);
    global.fetch = mock as unknown as typeof fetch;
    const client = new WebPushClient({ projectId: PROJECT });
    await client.subscribe();

    await client.unsubscribe();

    const del = mock.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(del).toHaveLength(1);
    expect(JSON.parse(del[0][1].body)).toEqual({ endpoint: ENDPOINT });
    expect(del[0][1].headers).toEqual(expect.objectContaining({ Authorization: `Bearer ${PROJECT}` }));
  });

  it("can subscribe again after it, to a new endpoint", async () => {
    browser = installFakeBrowser();
    const { subscriptions, routes } = server();
    global.fetch = fakeFetch(routes) as unknown as typeof fetch;
    const client = new WebPushClient({ projectId: PROJECT });
    await client.subscribe();
    await client.unsubscribe();

    await client.subscribe();

    expect(subscriptions.size).toBe(1);
    expect(idb.data.get("web-push")).toEqual({ projectKey: PROJECT, endpoint: ENDPOINT });
  });
});

describe("a secret key", () => {
  it.each(["sk_live_abc", "sk_test_abc", "sk_"])("is refused by the constructor, so no method can reach the network with %s", (key) => {
    browser = installFakeBrowser({ subscribed: true });
    const mock = fakeFetch({});
    global.fetch = mock as unknown as typeof fetch;

    expect(() => new WebPushClient({ projectId: key })).toThrow(/secret key/i);
    expect(() => new WebPushClient({ projectId: key, swPath: "/x.js", swScope: "/x/" })).toThrow(/secret key/i);

    expect(mock).not.toHaveBeenCalled();
  });
});
