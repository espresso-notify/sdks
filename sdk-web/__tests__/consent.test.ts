import { SubscribeError, WebPushClient } from "../src/index";
import { validateConsent } from "../src/privacy";
import { FakeBrowser, fakeFetch, installFakeBrowser, makeSubscription } from "../test-support/fakeBrowser";

// web-sdk-completion T11 (WSC-06): trySubscribe({ consent }) and subscribe({ consent }) send the record of the
// accept in POST /v1/web-push/subscribe, only when the site passes it, and check the sizes before the network.

let browser: FakeBrowser;
const PROJECT = "pk_live_test";
const SUBSCRIBE = "POST /v1/web-push/subscribe";

function useFetch(routes: Parameters<typeof fakeFetch>[0] = {}): jest.Mock {
  const mock = fakeFetch({ [SUBSCRIBE]: { body: {} }, ...routes });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

const posted = (mock: jest.Mock) =>
  mock.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/v1/web-push/subscribe")).map(([, init]) => JSON.parse(init.body));

beforeEach(() => {
  browser = installFakeBrowser();
});

afterEach(() => browser.uninstall());

describe("consent in trySubscribe", () => {
  it("sends the consent object in the subscribe body when the site passes it", async () => {
    const mock = useFetch();

    const result = await new WebPushClient({ projectId: PROJECT }).trySubscribe({ consent: { version: "terms-2026-10", source: "banner" } });

    expect(result).toEqual({ ok: true });
    expect(posted(mock)).toHaveLength(1);
    expect(posted(mock)[0].consent).toEqual({ version: "terms-2026-10", source: "banner" });
  });

  it("sends only the fields the site gave, and an empty object when it gave none", async () => {
    const mock = useFetch();
    await new WebPushClient({ projectId: PROJECT }).trySubscribe({ consent: { source: "settings-page" } });
    await new WebPushClient({ projectId: PROJECT }).trySubscribe({ consent: {} });

    expect(posted(mock)[0].consent).toEqual({ source: "settings-page" });
    expect(posted(mock)[1].consent).toEqual({});
  });

  it("sends nothing but version and source of what the site passes", async () => {
    const mock = useFetch();

    await new WebPushClient({ projectId: PROJECT }).trySubscribe({ consent: { version: "v1", source: "banner", email: "a@b.c" } as never });

    expect(posted(mock)[0].consent).toEqual({ version: "v1", source: "banner" });
  });

  it("sends a body with no consent key when the site passes none", async () => {
    const mock = useFetch();

    await new WebPushClient({ projectId: PROJECT }).trySubscribe();
    await new WebPushClient({ projectId: PROJECT }).trySubscribe({});

    for (const body of posted(mock)) expect(body).not.toHaveProperty("consent");
  });

  it("does not resend the consent on a later call that passes none, so the API keeps the stored one", async () => {
    const mock = useFetch();
    const client = new WebPushClient({ projectId: PROJECT });
    await client.trySubscribe({ consent: { version: "v1" } });
    await client.trySubscribe();

    expect(posted(mock)[1]).not.toHaveProperty("consent");
  });

  it("fails with invalid_consent before the network and before the permission prompt when the version has 65 characters", async () => {
    const mock = useFetch();
    const asked = jest.fn();
    (globalThis as any).Notification = { permission: "default", requestPermission: asked };

    const result = await new WebPushClient({ projectId: PROJECT }).trySubscribe({ consent: { version: "v".repeat(65) } });

    expect(result).toMatchObject({ ok: false, reason: "invalid_consent" });
    expect(mock).not.toHaveBeenCalled();
    expect(asked).not.toHaveBeenCalled();
    expect(browser.current).toBeNull();
  });

  it("fails with invalid_consent before the network when the source has 33 characters", async () => {
    const mock = useFetch();

    const result = await new WebPushClient({ projectId: PROJECT }).trySubscribe({ consent: { source: "s".repeat(33) } });

    expect(result).toMatchObject({ ok: false, reason: "invalid_consent" });
    expect(mock).not.toHaveBeenCalled();
  });

  it("accepts a version of 64 characters and a source of 32", async () => {
    const mock = useFetch();

    const result = await new WebPushClient({ projectId: PROJECT }).trySubscribe({ consent: { version: "v".repeat(64), source: "s".repeat(32) } });

    expect(result).toEqual({ ok: true });
    expect(posted(mock)).toHaveLength(1);
  });

  it("delivers a 400 invalid_consent of the API as server_error with the message of the API", async () => {
    useFetch({ [SUBSCRIBE]: { status: 400, body: { error: "invalid_consent" } } });

    const result = await new WebPushClient({ projectId: PROJECT }).trySubscribe({ consent: { version: "v1" } });

    expect(result).toEqual({ ok: false, reason: "server_error", message: "invalid_consent" });
  });
});

describe("consent in subscribe", () => {
  it("sends the consent object and resolves true", async () => {
    const mock = useFetch();

    await expect(new WebPushClient({ projectId: PROJECT }).subscribe({ consent: { version: "v2", source: "onboarding" } })).resolves.toBe(true);

    expect(posted(mock)[0].consent).toEqual({ version: "v2", source: "onboarding" });
  });

  it("throws a SubscribeError invalid_consent before the network when a size is over", async () => {
    const mock = useFetch();

    const err = await new WebPushClient({ projectId: PROJECT }).subscribe({ consent: { version: "v".repeat(65) } }).catch((e) => e);

    expect(err).toBeInstanceOf(SubscribeError);
    expect(err.reason).toBe("invalid_consent");
    expect(mock).not.toHaveBeenCalled();
  });

  it("sends a body with no consent key when the site passes none", async () => {
    const mock = useFetch();

    await new WebPushClient({ projectId: PROJECT }).subscribe();

    expect(posted(mock)[0]).not.toHaveProperty("consent");
  });

  it("sends the consent when it moves a subscription to a new VAPID key, and names the one it replaces", async () => {
    const KEY_OLD = "BAAAAAAA";
    const bufferOf = (b64url: string) => Uint8Array.from(atob(b64url.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)).buffer;
    const old = makeSubscription(browser, "https://push.example/old");
    (old as any).options = { applicationServerKey: bufferOf(KEY_OLD) };
    browser.current = old;
    const mock = useFetch({ "GET /v1/web-push/vapid-key": { body: { vapid_public_key: "BBBBBBBB" } } });

    await new WebPushClient({ projectId: PROJECT }).subscribe({ consent: { version: "v3" } });

    expect(posted(mock)[0]).toMatchObject({ consent: { version: "v3" }, replaces_endpoint: "https://push.example/old" });
  });
});

describe("validateConsent", () => {
  it("counts characters, as the API does: 64 emoji fit in a version and 65 do not", () => {
    expect(validateConsent({ version: "😀".repeat(64) })).toBeNull();
    expect(validateConsent({ version: "😀".repeat(65) })).not.toBeNull();
  });

  it("refuses a field that is not a string and a consent that is not an object", () => {
    expect(validateConsent({ version: 3 as never })).not.toBeNull();
    expect(validateConsent({ source: null as never })).not.toBeNull();
    expect(validateConsent("banner" as never)).not.toBeNull();
  });

  it("accepts no consent", () => {
    expect(validateConsent(undefined)).toBeNull();
  });
});
