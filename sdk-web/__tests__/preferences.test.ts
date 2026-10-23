import { EspressoNotifyError, EspressoNotifyHttpError, WebPushClient } from "../src/index";
import { ENDPOINT, FakeBrowser, fakeFetch, installFakeBrowser } from "../test-support/fakeBrowser";

// web-sdk-completion T10 (WSC-04): client.setPreferences() and client.getPreferences() against the routes
// POST /v1/web-push/preferences and POST /v1/web-push/preferences/query. The person is the user the API linked
// to the subscription by identify(); the call never names a user.

let browser: FakeBrowser;
const PROJECT = "pk_live_test";
const SET = "POST /v1/web-push/preferences";
const QUERY = "POST /v1/web-push/preferences/query";

function useFetch(routes: Parameters<typeof fakeFetch>[0]): jest.Mock {
  const mock = fakeFetch({ "POST /v1/web-push/subscribe": { body: {} }, ...routes });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

const callsTo = (mock: jest.Mock, suffix: string) =>
  mock.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).endsWith(suffix));

async function failure(call: Promise<unknown>): Promise<any> {
  try {
    await call;
  } catch (e) {
    return e;
  }
  throw new Error("the call did not reject");
}

async function subscribed(): Promise<WebPushClient> {
  const client = new WebPushClient({ projectId: PROJECT });
  await client.subscribe();
  return client;
}

beforeEach(() => {
  browser = installFakeBrowser();
});

afterEach(() => browser.uninstall());

describe("setPreferences", () => {
  it("sends the endpoint and the preferences in snake case, with the public key, and returns { updated }", async () => {
    const mock = useFetch({ [SET]: { body: { updated: 2 } } });
    const client = await subscribed();

    const result = await client.setPreferences([
      { categoryIdentifier: "promotions", optedOut: true },
      { categoryIdentifier: "news", optedOut: false },
    ]);

    expect(result).toEqual({ updated: 2 });
    const [call] = callsTo(mock, "/v1/web-push/preferences");
    expect(call[1].headers).toEqual(expect.objectContaining({ Authorization: `Bearer ${PROJECT}` }));
    expect(JSON.parse(call[1].body)).toEqual({
      endpoint: ENDPOINT,
      preferences: [
        { category_identifier: "promotions", opted_out: true },
        { category_identifier: "news", opted_out: false },
      ],
    });
  });

  it("never puts the endpoint in the URL", async () => {
    const mock = useFetch({ [SET]: { body: { updated: 1 } } });
    const client = await subscribed();

    await client.setPreferences([{ categoryIdentifier: "promotions", optedOut: true }]);

    const [url] = callsTo(mock, "/v1/web-push/preferences")[0];
    expect(url).toMatch(/^[^?#]*\/v1\/web-push\/preferences$/);
    expect(url).not.toContain(ENDPOINT);
    expect(url).not.toContain(encodeURIComponent(ENDPOINT));
  });

  it("falls back to the number of items sent when the answer has no count", async () => {
    useFetch({ [SET]: { body: {} } });
    const client = await subscribed();

    expect(await client.setPreferences([{ categoryIdentifier: "a", optedOut: true }, { categoryIdentifier: "b", optedOut: true }])).toEqual({ updated: 2 });
  });

  it.each([
    ["an empty list", []],
    ["51 items", Array.from({ length: 51 }, (_, i) => ({ categoryIdentifier: `c${i}`, optedOut: true }))],
    ["an empty identifier", [{ categoryIdentifier: "", optedOut: true }]],
    ["an identifier of 65 bytes", [{ categoryIdentifier: "a".repeat(65), optedOut: true }]],
    ["an optedOut that is not a boolean", [{ categoryIdentifier: "a", optedOut: "yes" }]],
  ])("throws before the network for %s", async (_name, list) => {
    const mock = useFetch({ [SET]: { body: { updated: 1 } } });
    const client = await subscribed();
    mock.mockClear();

    await expect(client.setPreferences(list as never)).rejects.toThrow(/Validation error/);

    expect(mock).not.toHaveBeenCalled();
  });

  it("rejects no_subscription without calling the API when the browser has no subscription", async () => {
    const mock = useFetch({ [SET]: { body: { updated: 1 } } });

    const err = await failure(new WebPushClient({ projectId: PROJECT }).setPreferences([{ categoryIdentifier: "a", optedOut: true }]));

    expect(err).toBeInstanceOf(EspressoNotifyError);
    expect(err.code).toBe("no_subscription");
    expect(mock).not.toHaveBeenCalled();
  });

  it("turns 404 user_not_found into an EspressoNotifyHttpError that tells the site to call identify first", async () => {
    useFetch({ [SET]: { status: 404, body: { error: "user_not_found", code: "user_not_found" } } });
    const client = await subscribed();

    const err = await failure(client.setPreferences([{ categoryIdentifier: "a", optedOut: true }]));

    expect(err).toBeInstanceOf(EspressoNotifyHttpError);
    expect([err.status, err.code, err.path]).toEqual([404, "user_not_found", "/v1/web-push/preferences"]);
    expect(err.message).toMatch(/identify/);
  });

  it("keeps the code of a refused category", async () => {
    useFetch({ [SET]: { status: 400, body: { error: "unknown_category", code: "unknown_category" } } });
    const client = await subscribed();

    const err = await failure(client.setPreferences([{ categoryIdentifier: "nope", optedOut: true }]));

    expect([err.status, err.code]).toEqual([400, "unknown_category"]);
  });
});

describe("getPreferences", () => {
  it("sends only the endpoint and returns the list in camel case", async () => {
    const mock = useFetch({
      [QUERY]: { body: [{ category_identifier: "promotions", opted_out: true }, { category_identifier: "news", opted_out: false }] },
    });
    const client = await subscribed();

    const result = await client.getPreferences();

    expect(result).toEqual([
      { categoryIdentifier: "promotions", optedOut: true },
      { categoryIdentifier: "news", optedOut: false },
    ]);
    const [call] = callsTo(mock, "/v1/web-push/preferences/query");
    expect(JSON.parse(call[1].body)).toEqual({ endpoint: ENDPOINT });
    expect(call[0]).toMatch(/^[^?#]*\/v1\/web-push\/preferences\/query$/);
    expect(call[1].headers).toEqual(expect.objectContaining({ Authorization: `Bearer ${PROJECT}` }));
  });

  it("returns an empty list when the person set nothing", async () => {
    useFetch({ [QUERY]: { body: [] } });
    expect(await (await subscribed()).getPreferences()).toEqual([]);
  });

  it("returns an empty list when the answer is not a list", async () => {
    useFetch({ [QUERY]: { body: { preferences: "x" } } });
    expect(await (await subscribed()).getPreferences()).toEqual([]);
  });

  it("turns 404 user_not_found into an EspressoNotifyHttpError that tells the site to call identify first", async () => {
    useFetch({ [QUERY]: { status: 404, body: { error: "user_not_found", code: "user_not_found" } } });
    const client = await subscribed();

    const err = await failure(client.getPreferences());

    expect(err).toBeInstanceOf(EspressoNotifyHttpError);
    expect([err.status, err.code, err.path]).toEqual([404, "user_not_found", "/v1/web-push/preferences/query"]);
    expect(err.message).toMatch(/identify/);
  });

  it("rejects no_subscription without calling the API when the browser has no subscription", async () => {
    const mock = useFetch({ [QUERY]: { body: [] } });

    const err = await failure(new WebPushClient({ projectId: PROJECT }).getPreferences());

    expect(err.code).toBe("no_subscription");
    expect(mock).not.toHaveBeenCalled();
  });
});
