import { EspressoNotifyError, EspressoNotifyHttpError, WebPushClient } from "../src/index";
import { ENDPOINT, FakeBrowser, fakeFetch, installFakeBrowser } from "../test-support/fakeBrowser";
import { fakeIndexedDB } from "../test-support/fakeIndexedDB";

// web-sdk-completion T9 (WSC-01): client.forgetDevice() erases the browser and its data with the public key.

let browser: FakeBrowser;
let idb: ReturnType<typeof fakeIndexedDB>;
const PROJECT = "pk_live_test";
const ERASE = "DELETE /v1/web-push/device";

function useFetch(routes: Parameters<typeof fakeFetch>[0]): jest.Mock {
  const mock = fakeFetch({ "POST /v1/web-push/subscribe": { body: {} }, ...routes });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

const eraseCalls = (mock: jest.Mock) => mock.mock.calls.filter(([url, init]) => init?.method === "DELETE" && String(url).endsWith("/v1/web-push/device"));

async function failure(call: Promise<unknown>): Promise<any> {
  try {
    await call;
  } catch (e) {
    return e;
  }
  throw new Error("the call did not reject");
}

beforeEach(() => {
  browser = installFakeBrowser();
  idb = fakeIndexedDB();
  (globalThis as any).indexedDB = idb;
});

afterEach(() => {
  browser.uninstall();
  delete (globalThis as any).indexedDB;
});

describe("forgetDevice", () => {
  it("sends DELETE /v1/web-push/device with the endpoint in the body and the public key in the header, and nothing in the URL", async () => {
    const mock = useFetch({ [ERASE]: { status: 204 } });
    const client = new WebPushClient({ projectId: PROJECT });
    await client.subscribe();

    await client.forgetDevice();

    const [call] = eraseCalls(mock);
    expect(call[0]).toMatch(/^[^?#]*\/v1\/web-push\/device$/);
    expect(call[0]).not.toContain(ENDPOINT);
    expect(call[1].headers).toEqual(expect.objectContaining({ Authorization: `Bearer ${PROJECT}` }));
    expect(JSON.parse(call[1].body)).toEqual({ endpoint: ENDPOINT });
  });

  it("sends identity_hash only when the site passes identityHash", async () => {
    const mock = useFetch({ [ERASE]: { status: 204 } });
    const client = new WebPushClient({ projectId: PROJECT });
    await client.subscribe();

    await client.forgetDevice({ identityHash: "abc123" });

    expect(JSON.parse(eraseCalls(mock)[0][1].body)).toEqual({ endpoint: ENDPOINT, identity_hash: "abc123" });
  });

  it("after the API erased, drops the local record and the browser subscription and resolves with no value", async () => {
    useFetch({ [ERASE]: { status: 204 } });
    const client = new WebPushClient({ projectId: PROJECT });
    await client.subscribe();
    const sub = browser.current!;
    expect(idb.data.has("web-push")).toBe(true);

    await expect(client.forgetDevice()).resolves.toBeUndefined();

    expect(idb.data.has("web-push")).toBe(false);
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(browser.current).toBeNull();
    expect(await client.getSubscription()).toBeNull();
  });

  it("works on a page that did not subscribe in this load, when the browser already has a subscription", async () => {
    browser.uninstall();
    browser = installFakeBrowser({ subscribed: true });
    const mock = useFetch({ [ERASE]: { status: 204 } });

    await new WebPushClient({ projectId: PROJECT }).forgetDevice();

    expect(JSON.parse(eraseCalls(mock)[0][1].body)).toEqual({ endpoint: ENDPOINT });
    expect(browser.current).toBeNull();
  });

  it("rejects no_subscription without calling the API when the browser has no subscription", async () => {
    const mock = useFetch({ [ERASE]: { status: 204 } });

    const err = await failure(new WebPushClient({ projectId: PROJECT }).forgetDevice());

    expect(err).toBeInstanceOf(EspressoNotifyError);
    expect(err.code).toBe("no_subscription");
    expect(mock).not.toHaveBeenCalled();
  });

  it("rejects with the status and code of a 404, and keeps the subscription and the local record", async () => {
    const mock = useFetch({ [ERASE]: { status: 404, body: { error: "not_found", code: "not_found" } } });
    const client = new WebPushClient({ projectId: PROJECT });
    await client.subscribe();
    const sub = browser.current!;

    const err = await failure(client.forgetDevice());

    expect(err).toBeInstanceOf(EspressoNotifyHttpError);
    expect([err.status, err.code, err.path]).toEqual([404, "not_found", "/v1/web-push/device"]);
    expect(sub.unsubscribe).not.toHaveBeenCalled();
    expect(browser.current).toBe(sub);
    expect(idb.data.get("web-push")).toEqual({ projectKey: PROJECT, endpoint: ENDPOINT });
    expect(eraseCalls(mock)).toHaveLength(1);
  });

  it("rejects with the status and code of a 403 identity_verification_failed, and keeps everything", async () => {
    useFetch({ [ERASE]: { status: 403, body: { error: "identity_verification_failed" } } });
    const client = new WebPushClient({ projectId: PROJECT });
    await client.subscribe();
    const sub = browser.current!;

    const err = await failure(client.forgetDevice());

    expect(err).toBeInstanceOf(EspressoNotifyHttpError);
    expect([err.status, err.code]).toEqual([403, "identity_verification_failed"]);
    expect(sub.unsubscribe).not.toHaveBeenCalled();
    expect(idb.data.has("web-push")).toBe(true);
  });

  it("rejects when the network fails, and keeps the subscription and the local record so the site can try again", async () => {
    const mock = useFetch({});
    const client = new WebPushClient({ projectId: PROJECT });
    await client.subscribe();
    const sub = browser.current!;
    mock.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (init?.method === "DELETE") throw new TypeError("Failed to fetch");
      return { ok: true, status: 200, json: async () => ({}) };
    });

    await expect(client.forgetDevice()).rejects.toThrow("Failed to fetch");

    expect(sub.unsubscribe).not.toHaveBeenCalled();
    expect(browser.current).toBe(sub);
    expect(idb.data.has("web-push")).toBe(true);
  });

  it("can be called again after a failure and then erases", async () => {
    let answer = { status: 503, body: { error: "unavailable" } } as { status: number; body?: unknown };
    const mock = useFetch({ [ERASE]: () => answer });
    const client = new WebPushClient({ projectId: PROJECT });
    await client.subscribe();
    await expect(client.forgetDevice()).rejects.toMatchObject({ status: 503 });

    answer = { status: 204 };
    await expect(client.forgetDevice()).resolves.toBeUndefined();

    expect(eraseCalls(mock)).toHaveLength(2);
    expect(browser.current).toBeNull();
  });

  it("falls back to the error field when the answer has no code", async () => {
    useFetch({ [ERASE]: { status: 400, body: { error: "invalid endpoint" } } });
    const client = new WebPushClient({ projectId: PROJECT });
    await client.subscribe();

    expect((await failure(client.forgetDevice())).code).toBe("invalid endpoint");
  });

  it("still resolves when the browser refuses to drop its subscription after the API erased", async () => {
    useFetch({ [ERASE]: { status: 204 } });
    const client = new WebPushClient({ projectId: PROJECT });
    await client.subscribe();
    browser.current!.unsubscribe.mockRejectedValue(new Error("busy"));

    await expect(client.forgetDevice()).resolves.toBeUndefined();

    expect(idb.data.has("web-push")).toBe(false);
  });
});

describe("unsubscribe stays what it was", () => {
  it("still removes the subscription with DELETE /v1/web-push/subscribe", async () => {
    const mock = useFetch({ "DELETE /v1/web-push/subscribe": { status: 204 } });
    const client = new WebPushClient({ projectId: PROJECT });
    await client.subscribe();

    await client.unsubscribe();

    const calls = mock.mock.calls.filter(([url, init]) => init?.method === "DELETE" && String(url).endsWith("/v1/web-push/subscribe"));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0][1].body)).toEqual({ endpoint: ENDPOINT });
    expect(eraseCalls(mock)).toHaveLength(0);
  });
});
