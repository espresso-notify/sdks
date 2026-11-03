import { EspressoNotifyHttpError, WebPushClient } from "../src/index";
import { ENDPOINT, FakeBrowser, fakeFetch, installFakeBrowser } from "../test-support/fakeBrowser";
import { fakeIndexedDB } from "../test-support/fakeIndexedDB";
import { FakeStorage, fakeStorage, installStorage } from "../test-support/fakeStorage";

// identity-jwt T22 (JWT-23 to JWT-26, JWT-28, JWT-29): the identity token of the web client calls, its provider and the
// one renewal. The tests read the requests the client sends to a fake API, never the code that builds them.

const PROJECT = "pk_live_test";
const SUBSCRIBE = "POST /v1/web-push/subscribe";
const ERASE = "DELETE /v1/web-push/device";
const PREFS_QUERY = "POST /v1/web-push/preferences/query";
const PREFS_SAVE = "POST /v1/web-push/preferences";

let browser: FakeBrowser;
let idb: ReturnType<typeof fakeIndexedDB>;
let local: FakeStorage;
let session: FakeStorage;
let restores: Array<() => void>;
let fetchMock: jest.Mock;

const EXPIRED = { status: 401, body: { error: "identity_token_expired", code: "identity_token_expired" } };
type Init = { method?: string; body?: string };
const tokenOf = (init: Init) => JSON.parse(init.body ?? "{}").identity_token as string | undefined;

/** A route that answers 401 expired to any token but `valid`, and 200 (204 for a DELETE) to `valid`. */
function acceptOnly(valid: string, ok: unknown = {}) {
  return (init: Init) => (tokenOf(init) === valid ? { status: init.method === "DELETE" ? 204 : 200, body: ok } : EXPIRED);
}

/** The subscribe route also takes the plain subscription, which has no user and no token: only an identify is checked. */
function acceptOnlyIdentify(valid: string) {
  return (init: Init) => (JSON.parse(init.body ?? "{}").external_id === undefined || tokenOf(init) === valid ? { body: {} } : EXPIRED);
}

function useFetch(routes: Parameters<typeof fakeFetch>[0]): jest.Mock {
  fetchMock = fakeFetch({ [SUBSCRIBE]: { body: {} }, ...routes });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const calls = (route: string) =>
  fetchMock.mock.calls.filter(([url, init]) => `${init?.method ?? "GET"} ${String(url).replace(/^.*?(?=\/v1\/)/, "")}` === route);
const bodies = (route: string) => calls(route).map(([, init]) => JSON.parse(init.body));
const identifies = () => bodies(SUBSCRIBE).filter((b) => b.external_id);

async function failure(call: Promise<unknown>): Promise<any> {
  try {
    await call;
  } catch (e) {
    return e;
  }
  throw new Error("the call did not reject");
}

async function subscribed(options: ConstructorParameters<typeof WebPushClient>[0] = { projectId: PROJECT }) {
  const client = new WebPushClient(options);
  await client.subscribe();
  return client;
}

beforeEach(() => {
  browser = installFakeBrowser();
  idb = fakeIndexedDB();
  (globalThis as any).indexedDB = idb;
  local = fakeStorage();
  session = fakeStorage();
  restores = [installStorage("localStorage", local), installStorage("sessionStorage", session)];
});

afterEach(() => {
  restores.forEach((undo) => undo());
  browser.uninstall();
  delete (globalThis as any).indexedDB;
  jest.restoreAllMocks();
});

/** The four calls that carry the token, each with the route it goes to, the answer that means "done", and how to call it. */
const CALLS: [string, string, unknown, (c: WebPushClient, identityToken?: string) => Promise<unknown>][] = [
  ["identify", SUBSCRIBE, {}, (c, t) => c.identify("u1", { name: "Ana", identityToken: t })],
  ["forgetDevice", ERASE, undefined, (c, t) => c.forgetDevice({ identityToken: t, externalId: "u1" })],
  ["getPreferences", PREFS_QUERY, [], (c, t) => c.getPreferences({ identityToken: t, externalId: "u1" })],
  ["setPreferences", PREFS_SAVE, { updated: 1 }, (c, t) => c.setPreferences([{ categoryIdentifier: "promotions", optedOut: true }], { identityToken: t, externalId: "u1" })],
];

describe("identity_token on the wire (JWT-23)", () => {
  it("identify sends external_id, name and identity_token in the subscribe body, and never identity_hash", async () => {
    useFetch({});
    const client = await subscribed();

    await client.identify("u1", { name: "Ana", identityToken: "eyJ.header.sig" });

    const [body] = identifies();
    expect(body).toMatchObject({ endpoint: ENDPOINT, external_id: "u1", name: "Ana", identity_token: "eyJ.header.sig" });
    expect(JSON.stringify(body)).not.toContain("identity_hash");
  });

  it("forgetDevice, getPreferences and setPreferences send identity_token with the endpoint", async () => {
    useFetch({ [ERASE]: { status: 204 }, [PREFS_QUERY]: { body: [] }, [PREFS_SAVE]: { body: { updated: 1 } } });
    const client = await subscribed();

    await client.getPreferences({ identityToken: "tkn" });
    await client.setPreferences([{ categoryIdentifier: "promotions", optedOut: true }], { identityToken: "tkn" });
    await client.forgetDevice({ identityToken: "tkn" });

    expect(bodies(PREFS_QUERY)[0]).toEqual({ endpoint: ENDPOINT, identity_token: "tkn" });
    expect(bodies(PREFS_SAVE)[0]).toMatchObject({ endpoint: ENDPOINT, identity_token: "tkn" });
    expect(bodies(ERASE)[0]).toEqual({ endpoint: ENDPOINT, identity_token: "tkn" });
  });

  it.each(CALLS)("%s without a token, or with an empty one, has no identity_token key", async (_name, route, answer, call) => {
    useFetch({ [route]: { status: route === ERASE ? 204 : 200, body: answer } });
    const client = await subscribed();
    await call(client, undefined);
    await client.subscribe(); // forgetDevice dropped the subscription
    await call(client, "");

    const sent = calls(route).filter(([, init]) => !route.startsWith("POST /v1/web-push/subscribe") || JSON.parse(init.body).external_id);
    expect(sent.length).toBeGreaterThan(0);
    for (const [, init] of sent) expect(init.body).not.toContain("identity_token");
  });

  it("the old option is gone: identityHash is not read and not sent", async () => {
    useFetch({});
    const client = await subscribed();
    await client.identify("u1", { identityHash: "abc" } as any);
    expect(JSON.stringify(identifies()[0])).not.toMatch(/identity_(hash|token)/);
  });

  it("a refused token rejects with the code of the API in the message", async () => {
    useFetch({ [SUBSCRIBE]: { status: 403, body: { error: "identity_verification_failed" } } });
    const client = new WebPushClient({ projectId: PROJECT });
    await client.subscribe().catch(() => {});
    fetchMock.mockImplementation(fakeFetch({ [SUBSCRIBE]: { status: 403, body: { error: "identity_verification_failed" } } }));
    const err = await failure(client.identify("u1", { identityToken: "bad" }));
    expect(err.message).toContain("identity_verification_failed");
  });
});

describe("one renewal on identity_token_expired (JWT-24, JWT-25)", () => {
  it.each(CALLS)("%s: one provider call and one repeated request with the new token", async (_name, route, answer, call) => {
    const provider = jest.fn().mockResolvedValue("new-token");
    useFetch({ [route]: route === SUBSCRIBE ? acceptOnlyIdentify("new-token") : acceptOnly("new-token", answer) });
    const client = await subscribed({ projectId: PROJECT, identityTokenProvider: provider });
    const before = calls(route).length;

    await call(client, "old-token");

    const sent = calls(route).slice(before);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith("u1");
    expect(sent).toHaveLength(2);
    expect(tokenOf(sent[0][1])).toBe("old-token");
    expect(tokenOf(sent[1][1])).toBe("new-token");
    expect(String(sent[1][0])).toBe(String(sent[0][0]));
  });

  it("the repeated request is the same call but for the token", async () => {
    useFetch({ [SUBSCRIBE]: acceptOnlyIdentify("new-token") });
    const client = await subscribed({ projectId: PROJECT, identityTokenProvider: async () => "new-token" });

    await client.identify("u1", { name: "Ana", identityToken: "old-token" });

    const [first, second] = identifies();
    expect({ ...second, identity_token: "old-token" }).toEqual(first);
  });

  it("a renewed identify resolves, so the registration rule remembers it", async () => {
    useFetch({ [SUBSCRIBE]: acceptOnlyIdentify("new-token") });
    const client = await subscribed({ projectId: PROJECT, identityTokenProvider: async () => "new-token" });

    await expect(client.identify("u1", { identityToken: "old-token" })).resolves.toBeUndefined();
    await client.identify("u1", { identityToken: "old-token" }); // same state in the same session: nothing is sent
    expect(identifies()).toHaveLength(2);
  });
});

describe("no loop (JWT-26)", () => {
  it.each(CALLS)("%s without a provider: the error reaches the page and nothing is repeated", async (_name, route, _answer, call) => {
    useFetch({ [route]: route === SUBSCRIBE ? acceptOnlyIdentify("never") : EXPIRED });
    const client = await subscribed();
    const before = calls(route).length;

    const err = await failure(call(client, "old-token"));

    expect(err.message).toContain("identity_token_expired");
    expect(calls(route).length - before).toBe(1);
  });

  it("forgetDevice, getPreferences and setPreferences reject with an EspressoNotifyHttpError of 401 identity_token_expired", async () => {
    useFetch({ [ERASE]: EXPIRED, [PREFS_QUERY]: EXPIRED, [PREFS_SAVE]: EXPIRED });
    const client = await subscribed();

    for (const call of [
      client.forgetDevice({ identityToken: "old", externalId: "u1" }),
      client.getPreferences({ identityToken: "old", externalId: "u1" }),
      client.setPreferences([{ categoryIdentifier: "promotions", optedOut: true }], { identityToken: "old", externalId: "u1" }),
    ]) {
      const err = await failure(call);
      expect(err).toBeInstanceOf(EspressoNotifyHttpError);
      expect(err.status).toBe(401);
      expect(err.code).toBe("identity_token_expired");
    }
  });

  it("a provider that throws: the error of the call reaches the page, one provider call, no repeat", async () => {
    const provider = jest.fn().mockRejectedValue(new Error("my backend is down"));
    useFetch({ [PREFS_QUERY]: EXPIRED });
    const client = await subscribed({ projectId: PROJECT, identityTokenProvider: provider });

    const err = await failure(client.getPreferences({ identityToken: "old", externalId: "u1" }));

    expect(err.code).toBe("identity_token_expired");
    expect(err.message).not.toContain("my backend is down");
    expect(provider).toHaveBeenCalledTimes(1);
    expect(calls(PREFS_QUERY)).toHaveLength(1);
  });

  it("a provider that throws before it returns a promise is handled the same way", async () => {
    const provider = jest.fn(() => {
      throw new Error("sync failure");
    });
    useFetch({ [PREFS_QUERY]: EXPIRED });
    const client = await subscribed({ projectId: PROJECT, identityTokenProvider: provider as any });

    const err = await failure(client.getPreferences({ identityToken: "old", externalId: "u1" }));

    expect(err.code).toBe("identity_token_expired");
    expect(calls(PREFS_QUERY)).toHaveLength(1);
  });

  it.each([[""], [undefined], [null], [42]])("a provider that returns %p is no token: no repeat", async (value) => {
    const provider = jest.fn().mockResolvedValue(value);
    useFetch({ [PREFS_QUERY]: EXPIRED });
    const client = await subscribed({ projectId: PROJECT, identityTokenProvider: provider });

    const err = await failure(client.getPreferences({ identityToken: "old", externalId: "u1" }));

    expect(err.code).toBe("identity_token_expired");
    expect(provider).toHaveBeenCalledTimes(1);
    expect(calls(PREFS_QUERY)).toHaveLength(1);
  });

  it("a second 401 after the renewal reaches the page: one provider call, two requests, no third", async () => {
    const provider = jest.fn().mockResolvedValue("new-token");
    useFetch({ [PREFS_QUERY]: EXPIRED });
    const client = await subscribed({ projectId: PROJECT, identityTokenProvider: provider });

    const err = await failure(client.getPreferences({ identityToken: "old", externalId: "u1" }));

    expect(err.code).toBe("identity_token_expired");
    expect(provider).toHaveBeenCalledTimes(1);
    expect(calls(PREFS_QUERY)).toHaveLength(2);
  });

  it("a second failure of another kind reaches the page as it is", async () => {
    useFetch({
      [PREFS_QUERY]: (init: Init) => (tokenOf(init) === "new-token" ? { status: 403, body: { error: "identity_verification_failed", code: "identity_verification_failed" } } : EXPIRED),
    });
    const client = await subscribed({ projectId: PROJECT, identityTokenProvider: async () => "new-token" });

    const err = await failure(client.getPreferences({ identityToken: "old", externalId: "u1" }));

    expect(err.status).toBe(403);
    expect(err.code).toBe("identity_verification_failed");
    expect(calls(PREFS_QUERY)).toHaveLength(2);
  });

  it.each([
    [401, "unauthorized"],
    [401, "invalid_api_key"],
    [403, "identity_verification_failed"],
    [400, "identity_hash_unsupported"],
    [503, "identity_verification_unavailable"],
  ])("%i %s never calls the provider", async (status, code) => {
    const provider = jest.fn().mockResolvedValue("new-token");
    useFetch({ [PREFS_QUERY]: { status, body: { error: code, code } } });
    const client = await subscribed({ projectId: PROJECT, identityTokenProvider: provider });

    const err = await failure(client.getPreferences({ identityToken: "old", externalId: "u1" }));

    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    expect(provider).not.toHaveBeenCalled();
    expect(calls(PREFS_QUERY)).toHaveLength(1);
  });

  it("a call with no user to name (preferences before any identify) cannot ask the provider", async () => {
    const provider = jest.fn().mockResolvedValue("new-token");
    useFetch({ [PREFS_QUERY]: EXPIRED });
    const client = await subscribed({ projectId: PROJECT, identityTokenProvider: provider });

    const err = await failure(client.getPreferences({ identityToken: "old" }));

    expect(err.code).toBe("identity_token_expired");
    expect(provider).not.toHaveBeenCalled();
    expect(calls(PREFS_QUERY)).toHaveLength(1);
  });
});

describe("single flight (JWT-25)", () => {
  it("two calls of one user that expire together call the provider once and both repeat with the new token", async () => {
    let release!: (token: string) => void;
    const provider = jest.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    useFetch({ [PREFS_QUERY]: acceptOnly("new-token", []), [PREFS_SAVE]: acceptOnly("new-token", { updated: 1 }) });
    const client = await subscribed({ projectId: PROJECT, identityTokenProvider: provider });

    const first = client.getPreferences({ identityToken: "old", externalId: "u1" });
    const second = client.setPreferences([{ categoryIdentifier: "promotions", optedOut: true }], { identityToken: "old", externalId: "u1" });
    await new Promise((resolve) => setTimeout(resolve, 10)); // both got their 401 and wait for the provider
    expect(provider).toHaveBeenCalledTimes(1);
    release("new-token");
    await Promise.all([first, second]);

    expect(provider).toHaveBeenCalledTimes(1);
    const tokens = [...calls(PREFS_QUERY), ...calls(PREFS_SAVE)].map(([, init]) => tokenOf(init));
    expect(tokens.filter((t) => t === "old")).toHaveLength(2);
    expect(tokens.filter((t) => t === "new-token")).toHaveLength(2);
  });

  it("a call whose 401 arrives after the renewal is over repeats with the renewed token and does not ask again", async () => {
    const provider = jest.fn().mockResolvedValue("new-token");
    let releaseLate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseLate = resolve; });
    useFetch({ [PREFS_SAVE]: acceptOnly("new-token", { updated: 1 }), [SUBSCRIBE]: acceptOnlyIdentify("new-token") });
    const base = fetchMock.getMockImplementation() as (url: string, init: Init) => Promise<unknown>;
    fetchMock.mockImplementation(async (url: string, init: Init) => {
      if (String(url).endsWith("/v1/web-push/preferences") && tokenOf(init) === "old") await gate; // its 401 comes after the renewal
      return base(url, init);
    });
    const client = await subscribed({ projectId: PROJECT, identityTokenProvider: provider });

    const late = client.setPreferences([{ categoryIdentifier: "promotions", optedOut: true }], { identityToken: "old", externalId: "u1" });
    await client.identify("u1", { identityToken: "old" }); // renews
    expect(provider).toHaveBeenCalledTimes(1);
    releaseLate();
    await late;

    expect(provider).toHaveBeenCalledTimes(1);
    expect(tokenOf(calls(PREFS_SAVE)[calls(PREFS_SAVE).length - 1][1])).toBe("new-token");
  });
});

describe("the token the client keeps in memory (JWT-27, JWT-29)", () => {
  it("a later call without a token sends the one identify was given", async () => {
    useFetch({ [PREFS_QUERY]: { body: [] }, [PREFS_SAVE]: { body: { updated: 1 } }, [ERASE]: { status: 204 } });
    const client = await subscribed();

    await client.identify("u1", { identityToken: "tkn" });
    await client.getPreferences();
    await client.setPreferences([{ categoryIdentifier: "promotions", optedOut: true }]);
    await client.forgetDevice();

    expect(tokenOf(calls(PREFS_QUERY)[0][1])).toBe("tkn");
    expect(tokenOf(calls(PREFS_SAVE)[0][1])).toBe("tkn");
    expect(tokenOf(calls(ERASE)[0][1])).toBe("tkn");
  });

  it("after a renewal the new token is the one kept: the next call needs no provider call", async () => {
    const provider = jest.fn().mockResolvedValue("new-token");
    useFetch({ [SUBSCRIBE]: acceptOnlyIdentify("new-token"), [PREFS_QUERY]: acceptOnly("new-token", []) });
    const client = await subscribed({ projectId: PROJECT, identityTokenProvider: provider });

    await client.identify("u1", { identityToken: "old" });
    await client.getPreferences();

    expect(provider).toHaveBeenCalledTimes(1);
    expect(calls(PREFS_QUERY)).toHaveLength(1);
    expect(tokenOf(calls(PREFS_QUERY)[0][1])).toBe("new-token");
  });

  it("a token the page passes wins over the one kept", async () => {
    useFetch({ [PREFS_QUERY]: { body: [] } });
    const client = await subscribed();
    await client.identify("u1", { identityToken: "first" });
    await client.getPreferences({ identityToken: "second" });
    await client.getPreferences();

    expect(calls(PREFS_QUERY).map(([, init]) => tokenOf(init))).toEqual(["second", "second"]);
  });

  it("another user's token is not sent for this user", async () => {
    useFetch({});
    const client = await subscribed();
    await client.identify("u1", { identityToken: "of-u1" });
    await client.identify("u2");

    expect(JSON.stringify(identifies()[1])).not.toContain("identity_token");
  });

  it("the token is never written to the storage of the page, to IndexedDB or to the console", async () => {
    const logs: string[] = [];
    for (const method of ["log", "info", "debug", "warn", "error"] as const) {
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    }
    useFetch({ [PREFS_QUERY]: acceptOnly("SECRET-RENEWED-TOKEN", []), [SUBSCRIBE]: acceptOnlyIdentify("SECRET-RENEWED-TOKEN") });
    const client = await subscribed({ projectId: PROJECT, identityTokenProvider: async () => "SECRET-RENEWED-TOKEN" });

    await client.identify("u1", { name: "Ana", identityToken: "SECRET-OLD-TOKEN" });
    await client.getPreferences();

    const everything = [
      ...local.written, ...session.written, ...local.data.values(), ...session.data.values(),
      ...[...idb.data.values()].map((v) => JSON.stringify(v)), ...logs,
    ].join("\n");
    expect(everything).not.toContain("SECRET-OLD-TOKEN");
    expect(everything).not.toContain("SECRET-RENEWED-TOKEN");
    expect(everything).not.toContain("identity_token");
  });
});

describe("logout clears the token (JWT-28)", () => {
  it("unsubscribe: after the visitor subscribes again, the next call of the same user sends no token", async () => {
    useFetch({ "DELETE /v1/web-push/subscribe": { status: 204 }, [PREFS_QUERY]: { body: [] } });
    const client = await subscribed();
    await client.identify("u1", { identityToken: "tkn" });

    await client.unsubscribe();
    await client.subscribe();
    await client.getPreferences({ externalId: "u1" });

    expect(calls(PREFS_QUERY)[0][1].body).not.toContain("identity_token");
  });

  it("unsubscribe clears the token even when the call to the API failed", async () => {
    useFetch({ "DELETE /v1/web-push/subscribe": { status: 500 }, [PREFS_QUERY]: { body: [] } });
    const client = await subscribed();
    await client.identify("u1", { identityToken: "tkn" });

    await client.unsubscribe();
    await client.subscribe();
    await client.getPreferences({ externalId: "u1" });

    expect(calls(PREFS_QUERY)[0][1].body).not.toContain("identity_token");
  });

  it("forgetDevice: once it succeeded, a call of the same user sends no token", async () => {
    useFetch({ [ERASE]: { status: 204 }, [PREFS_QUERY]: { body: [] } });
    const client = await subscribed();
    await client.identify("u1", { identityToken: "tkn" });
    await client.forgetDevice();
    expect(tokenOf(calls(ERASE)[0][1])).toBe("tkn"); // it used the kept token
    await client.subscribe();
    await client.getPreferences({ externalId: "u1" });

    expect(calls(PREFS_QUERY)[0][1].body).not.toContain("identity_token");
  });

  it("forgetDevice that failed keeps the token, so the call can be repeated", async () => {
    let n = 0;
    useFetch({ [ERASE]: () => (++n === 1 ? { status: 500, body: { error: "erasure_failed" } } : { status: 204 }) });
    const client = await subscribed();
    await client.identify("u1", { identityToken: "tkn" });

    await failure(client.forgetDevice());
    await client.forgetDevice();

    expect(tokenOf(calls(ERASE)[1][1])).toBe("tkn");
  });

  it("a token that comes back from the provider after the logout is not kept", async () => {
    let release!: (token: string) => void;
    const provider = jest.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    useFetch({ [PREFS_QUERY]: EXPIRED, "DELETE /v1/web-push/subscribe": { status: 204 } });
    const client = await subscribed({ projectId: PROJECT, identityTokenProvider: provider });

    const pending = failure(client.getPreferences({ identityToken: "old", externalId: "u1" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await client.unsubscribe(); // the visitor leaves while the page builds the token
    release("late-token");
    const err = await pending;

    expect(err.code).toBe("identity_token_expired"); // no repeat with a token of a user who left
    expect(calls(PREFS_QUERY)).toHaveLength(1);
  });
});

describe("an identify the registration rule skips still keeps the user and the token", () => {
  // A reload in the same tab: the new page identifies the same user with the same token, nothing is sent (the server
  // has them), and the calls that follow carry the token and can renew it.
  async function reloadedAfterIdentify(options: ConstructorParameters<typeof WebPushClient>[0] = { projectId: PROJECT }) {
    const first = await subscribed();
    await first.identify("u1", { name: "Ana", identityToken: "tok-1" });
    const page = new WebPushClient(options);
    await page.subscribe();
    await page.identify("u1", { name: "Ana", identityToken: "tok-1" });
    return page;
  }

  it("the skipped identify sends nothing", async () => {
    useFetch({});
    await reloadedAfterIdentify();

    expect(identifies()).toHaveLength(1);
  });

  it.each([
    ["getPreferences", PREFS_QUERY, [], (c: WebPushClient) => c.getPreferences()],
    ["setPreferences", PREFS_SAVE, { updated: 1 }, (c: WebPushClient) => c.setPreferences([{ categoryIdentifier: "promotions", optedOut: true }])],
    ["forgetDevice", ERASE, undefined, (c: WebPushClient) => c.forgetDevice()],
  ] as [string, string, unknown, (c: WebPushClient) => Promise<unknown>][])(
    "%s with no options carries the token the skipped identify was given",
    async (_name, route, answer, call) => {
      useFetch({ [route]: { status: route === ERASE ? 204 : 200, body: answer } });
      const page = await reloadedAfterIdentify();

      await call(page);

      expect(bodies(route).pop()).toMatchObject({ endpoint: ENDPOINT, identity_token: "tok-1" });
    },
  );

  it("an expired token is renewed for the user of the skipped identify", async () => {
    const provider = jest.fn().mockResolvedValue("tok-2");
    useFetch({ [PREFS_QUERY]: acceptOnly("tok-2", []) });
    const page = await reloadedAfterIdentify({ projectId: PROJECT, identityTokenProvider: provider });

    await page.getPreferences();

    expect(provider).toHaveBeenCalledWith("u1");
    expect(bodies(PREFS_QUERY).map((b) => b.identity_token)).toEqual(["tok-1", "tok-2"]);
  });
});

// feature: identity.identify
// feature: identity.token
// feature: identity.token-renewal
// feature: identity.optional-name
