import { WebPushClient } from "../src/index";
import { SDK_VERSION } from "../src/registration";
import { ENDPOINT, FakeBrowser, fakeFetch, installFakeBrowser, makeSubscription } from "../test-support/fakeBrowser";
import { fakeIndexedDB } from "../test-support/fakeIndexedDB";
import { FakeStorage, fakeStorage, installStorage } from "../test-support/fakeStorage";

// send-scale T84 (SCALE-39; owner decision D-196): the page client subscribes and identifies only when something
// changed (the subscription, the user, the versions) or in a new session (a new tab, or a page load 30 minutes after
// the last time the page was seen), and keeps only hashes. Each `loadPage()` is one page load of the same browser.

let browser: FakeBrowser;
let local: FakeStorage;
let session: FakeStorage;
let restores: Array<() => void>;
let clock: number;
let fetchMock: jest.Mock;
const PROJECT = "pk_live_test";
const VAPID = "GET /v1/web-push/vapid-key";
const SUBSCRIBE = "POST /v1/web-push/subscribe";
const MIN = 60_000;

beforeEach(() => {
  clock = 1_800_000_000_000;
  jest.spyOn(Date, "now").mockImplementation(() => clock);
  browser = installFakeBrowser();
  (globalThis as any).indexedDB = fakeIndexedDB();
  local = fakeStorage();
  session = fakeStorage();
  restores = [installStorage("localStorage", local), installStorage("sessionStorage", session)];
  fetchMock = fakeFetch({ [SUBSCRIBE]: { status: 200 } });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
  restores.forEach((undo) => undo());
  browser.uninstall();
  delete (globalThis as any).indexedDB;
});

const calls = (route: string) =>
  fetchMock.mock.calls.filter(([url, init]) => `${init?.method ?? "GET"} ${String(url).replace(/^.*?(?=\/v1\/)/, "")}` === route);
const posts = () => calls(SUBSCRIBE).map(([, init]) => JSON.parse(init.body));
const loadPage = (options: { appVersion?: string } = {}) => new WebPushClient({ projectId: PROJECT, ...options });
const newTab = () => {
  session = fakeStorage();
  restores.push(installStorage("sessionStorage", session));
};

describe("subscribe", () => {
  it("sends one post and reads the VAPID key once for two page loads in the same tab", async () => {
    await loadPage().subscribe();
    await loadPage().subscribe();

    expect(calls(SUBSCRIBE)).toHaveLength(1);
    expect(calls(VAPID)).toHaveLength(1);
  });

  it("still answers true and ok, and leaves the subscription for identify, when the post is skipped", async () => {
    await loadPage().subscribe();
    const client = loadPage();

    await expect(client.trySubscribe()).resolves.toEqual({ ok: true });
    expect(await client.getSubscription()).not.toBeNull();
    await client.identify("user-1");
    expect(posts()).toHaveLength(2); // the first subscription and this identify
    expect(posts()[1]).toMatchObject({ endpoint: ENDPOINT, external_id: "user-1" });
  });

  it("sends once more for a second tab, and not again for the third page load of that tab", async () => {
    await loadPage().subscribe();
    newTab();
    await loadPage().subscribe();
    await loadPage().subscribe();

    expect(calls(SUBSCRIBE)).toHaveLength(2);
    expect(calls(VAPID)).toHaveLength(2);
  });

  it("sends once more for a page load 30 minutes after the last time the page was seen, not 29", async () => {
    await loadPage().subscribe();
    clock += 29 * MIN;
    await loadPage().subscribe();
    expect(calls(SUBSCRIBE)).toHaveLength(1);

    clock += 30 * MIN;
    await loadPage().subscribe();
    expect(calls(SUBSCRIBE)).toHaveLength(2);
    expect(calls(VAPID)).toHaveLength(2); // a rotation of the key is noticed in the new session
  });

  it("sends at once when the endpoint of the browser changed", async () => {
    await loadPage().subscribe();
    browser.current = makeSubscription(browser, "https://push.example/endpoint-2");
    await loadPage().subscribe();

    expect(posts().map((p) => p.endpoint)).toEqual([ENDPOINT, "https://push.example/endpoint-2"]);
  });

  it("sends at once when the time zone of the browser changed", async () => {
    const zone = jest.spyOn(Intl, "DateTimeFormat");
    zone.mockImplementation(() => ({ resolvedOptions: () => ({ timeZone: "America/Sao_Paulo" }) }) as unknown as Intl.DateTimeFormat);
    await loadPage().subscribe();
    zone.mockImplementation(() => ({ resolvedOptions: () => ({ timeZone: "Europe/Lisbon" }) }) as unknown as Intl.DateTimeFormat);
    await loadPage().subscribe();

    expect(posts().map((p) => p.timezone)).toEqual(["America/Sao_Paulo", "Europe/Lisbon"]);
  });

  it("sends at once when the version of the app the site declares changed", async () => {
    await loadPage({ appVersion: "1.0.0" }).subscribe();
    await loadPage({ appVersion: "1.0.0" }).subscribe();
    expect(calls(SUBSCRIBE)).toHaveLength(1);
    await loadPage({ appVersion: "1.1.0" }).subscribe();
    expect(calls(SUBSCRIBE)).toHaveLength(2);
  });

  it("always sends a call that carries a consent record", async () => {
    const consent = { version: "terms-2026-10", source: "banner" };
    await loadPage().subscribe({ consent });
    await loadPage().subscribe({ consent });

    expect(posts().map((p) => p.consent)).toEqual([consent, consent]);
  });

  it("sends the endpoint a failed run of the worker left to replace, even in a known session", async () => {
    await loadPage().subscribe();
    const pending = "https://push.example/pending-endpoint";
    (globalThis as any).indexedDB = fakeIndexedDB({ "web-push": { projectKey: PROJECT, endpoint: pending, pendingReplace: pending } });
    await loadPage().subscribe();

    expect(posts()).toHaveLength(2);
    expect(posts()[1]).toMatchObject({ endpoint: ENDPOINT, replaces_endpoint: pending });
  });

  it("does not remember a post that failed: the next page load sends it again", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0); // the six tries wait 0 ms
    fetchMock = fakeFetch({ [SUBSCRIBE]: { status: 400, body: { error: "invalid endpoint" } } });
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(loadPage().subscribe()).rejects.toThrow("invalid endpoint");
    expect(local.data.size).toBe(0);

    fetchMock = fakeFetch({ [SUBSCRIBE]: { status: 200 } });
    global.fetch = fetchMock as unknown as typeof fetch;
    await loadPage().subscribe();
    expect(calls(SUBSCRIBE)).toHaveLength(1);
    await loadPage().subscribe();
    expect(calls(SUBSCRIBE)).toHaveLength(1);
  });

  it("sends again after forgetDevice and after unsubscribe, which forget what was sent", async () => {
    const first = loadPage();
    await first.subscribe();
    fetchMock.mockImplementation(fakeFetch({ [SUBSCRIBE]: { status: 200 }, "DELETE /v1/web-push/device": { status: 204 }, "DELETE /v1/web-push/subscribe": { status: 200 } }));
    await first.forgetDevice();
    await loadPage().subscribe();
    expect(calls(SUBSCRIBE)).toHaveLength(2);

    const second = loadPage();
    await second.subscribe(); // known again, nothing is sent
    expect(calls(SUBSCRIBE)).toHaveLength(2);
    await second.unsubscribe();
    await loadPage().subscribe();
    expect(calls(SUBSCRIBE)).toHaveLength(3);
  });
});

describe("identify", () => {
  async function subscribedPage(options: { appVersion?: string } = {}) {
    const client = loadPage(options);
    await client.subscribe();
    return client;
  }

  it("sends one identify for two page loads of the same user in the same tab", async () => {
    await (await subscribedPage()).identify("user-1", { name: "Maria" });
    await (await subscribedPage()).identify("user-1", { name: "Maria" });

    expect(posts().filter((p) => p.external_id)).toHaveLength(1);
  });

  it("sends at once when the user, the name or the proof of identity changed", async () => {
    const client = await subscribedPage();
    await client.identify("user-1", { name: "Maria", identityHash: "aa" });
    await client.identify("user-1", { name: "Maria", identityHash: "aa" });
    await client.identify("user-2", { name: "Maria", identityHash: "aa" });
    await client.identify("user-2", { name: "Maria B", identityHash: "aa" });
    await client.identify("user-2", { name: "Maria B", identityHash: "bb" });

    expect(posts().filter((p) => p.external_id).map((p) => [p.external_id, p.name, p.identity_hash])).toEqual([
      ["user-1", "Maria", "aa"],
      ["user-2", "Maria", "aa"],
      ["user-2", "Maria B", "aa"],
      ["user-2", "Maria B", "bb"],
    ]);
  });

  it("sends again for a second tab and for a page load after 30 minutes", async () => {
    await (await subscribedPage()).identify("user-1");
    newTab();
    await (await subscribedPage()).identify("user-1");
    clock += 31 * MIN;
    await (await subscribedPage()).identify("user-1");

    expect(posts().filter((p) => p.external_id)).toHaveLength(3);
  });

  it("sends again when the subscription it belongs to changed", async () => {
    await (await subscribedPage()).identify("user-1");
    browser.current = makeSubscription(browser, "https://push.example/endpoint-2");
    await (await subscribedPage()).identify("user-1");

    expect(posts().filter((p) => p.external_id).map((p) => p.endpoint)).toEqual([ENDPOINT, "https://push.example/endpoint-2"]);
  });

  it("does not remember an identify that failed: the next page load sends it again", async () => {
    const client = await subscribedPage();
    fetchMock.mockImplementation(fakeFetch({ [SUBSCRIBE]: { status: 403, body: { error: "identity_verification_failed" } } }));
    await expect(client.identify("user-1")).rejects.toThrow("identity_verification_failed");

    fetchMock.mockImplementation(fakeFetch({ [SUBSCRIBE]: { status: 200 } }));
    const next = await subscribedPage();
    await next.identify("user-1");
    await (await subscribedPage()).identify("user-1");
    const identifies = fetchMock.mock.calls.filter(([, init]) => init?.body && JSON.parse(init.body).external_id);
    expect(identifies).toHaveLength(2); // the refused one and the one that worked; the third load sent nothing
  });

  it("does nothing, as before, while the browser has no subscription", async () => {
    await loadPage().identify("user-1");
    expect(calls(SUBSCRIBE)).toHaveLength(0);
  });

  it("is not skipped for the proof of identity that a new login hands over (the hash is part of the state)", async () => {
    const client = await subscribedPage();
    await client.identify("user-1", { identityHash: "first" });
    await client.identify("user-1", { identityHash: "second" });
    expect(posts().filter((p) => p.external_id)).toHaveLength(2);
  });
});

describe("what the browser keeps", () => {
  it("is a hash and a session id: no endpoint, key, user id, name or proof in either storage", async () => {
    const client = loadPage({ appVersion: "3.1.4" });
    await client.subscribe({ consent: { version: "terms-1", source: "banner" } });
    await client.identify("user-secret-42", { name: "Maria Silva", identityHash: "ab".repeat(32) });

    const everything = [...local.written, ...session.written, ...local.data.values(), ...session.data.values()].join("\n");
    expect(local.data.size).toBe(1);
    expect(session.data.size).toBe(1);
    for (const secret of [ENDPOINT, "push.example", "key123", "auth456", "user-secret-42", "Maria", "ab".repeat(32), "3.1.4", "terms-1"]) {
      expect(everything).not.toContain(secret);
    }
    expect(JSON.parse([...local.data.values()][0]).register.f).toMatch(/^s[0-9a-f]{32}$/);
  });

  it("keys the record by the project, so two projects on one site do not undo each other", async () => {
    await new WebPushClient({ projectId: "pk_live_one" }).subscribe();
    await new WebPushClient({ projectId: "pk_live_two" }).subscribe();
    await new WebPushClient({ projectId: "pk_live_one" }).subscribe();

    expect(calls(SUBSCRIBE)).toHaveLength(2);
    expect([...local.data.keys()].sort()).toEqual(["espresso-notify:registration:pk_live_one", "espresso-notify:registration:pk_live_two"]);
  });

  it("sends on every page load, as before, where the browser has no storage", async () => {
    restores.forEach((undo) => undo());
    restores = [installStorage("localStorage", undefined), installStorage("sessionStorage", undefined)];
    await loadPage().subscribe();
    await loadPage().subscribe();

    expect(calls(SUBSCRIBE)).toHaveLength(2);
  });

  it("sends on every page load, as before, where the storage cannot be read or written", async () => {
    local.failReads = true;
    local.failWrites = true;
    session.failReads = true;
    session.failWrites = true;
    await expect(loadPage().subscribe()).resolves.toBe(true);
    await expect(loadPage().subscribe()).resolves.toBe(true);

    expect(calls(SUBSCRIBE)).toHaveLength(2);
  });

  it("treats a record left by an older SDK or a damaged one as 'changed' once", async () => {
    local.data.set(`espresso-notify:registration:${PROJECT}`, "{damaged");
    await loadPage().subscribe();
    await loadPage().subscribe();

    expect(calls(SUBSCRIBE)).toHaveLength(1);
  });

  it("declares the SDK version of the package", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(SDK_VERSION).toBe(require("../package.json").version);
  });
});
