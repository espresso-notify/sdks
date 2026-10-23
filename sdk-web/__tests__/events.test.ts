import { WebPushClient } from "../src/index";
import { ENDPOINT, FakeBrowser, fakeFetch, installFakeBrowser } from "../test-support/fakeBrowser";

// web-sdk-completion T12 (WSC-07, WSC-09): client.trackEvent() and client.trackConversion(). Neither ever throws:
// like the track methods of the React Native SDK they are fire-and-forget, with no queue and no retry.

let browser: FakeBrowser;
const PROJECT = "pk_live_test";
const EVENT = "POST /v1/web-push/event";
const TRACK_WEB = "POST /v1/notifications/track-web";
let warn: jest.SpyInstance;
let debug: jest.SpyInstance;

function useFetch(routes: Parameters<typeof fakeFetch>[0] = {}): jest.Mock {
  const mock = fakeFetch({ "POST /v1/web-push/subscribe": { body: {} }, [EVENT]: { status: 204 }, [TRACK_WEB]: { status: 204 }, ...routes });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

const callsTo = (mock: jest.Mock, suffix: string) => mock.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).endsWith(suffix));

async function subscribed(): Promise<WebPushClient> {
  const client = new WebPushClient({ projectId: PROJECT });
  await client.subscribe();
  return client;
}

beforeEach(() => {
  browser = installFakeBrowser();
  warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  debug = jest.spyOn(console, "debug").mockImplementation(() => undefined);
});

afterEach(() => {
  browser.uninstall();
  jest.restoreAllMocks();
});

describe("trackEvent", () => {
  it("sends the endpoint, the name and an event_id to POST /v1/web-push/event with the public key", async () => {
    const mock = useFetch();
    const client = await subscribed();

    await expect(client.trackEvent("order.completed")).resolves.toBeUndefined();

    const [call] = callsTo(mock, "/v1/web-push/event");
    expect(call[0]).toMatch(/^[^?#]*\/v1\/web-push\/event$/);
    expect(call[1].headers).toEqual(expect.objectContaining({ Authorization: `Bearer ${PROJECT}` }));
    const body = JSON.parse(call[1].body);
    expect(Object.keys(body).sort()).toEqual(["endpoint", "event", "event_id"]);
    expect(body.endpoint).toBe(ENDPOINT);
    expect(body.event).toBe("order.completed");
    expect(body.event_id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it("gives each call its own event_id", async () => {
    const mock = useFetch();
    const client = await subscribed();

    await client.trackEvent("order.completed");
    await client.trackEvent("order.completed");

    const ids = callsTo(mock, "/v1/web-push/event").map(([, init]) => JSON.parse(init.body).event_id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("still makes a valid event_id where the browser has no crypto.randomUUID", async () => {
    const mock = useFetch();
    const client = await subscribed();
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
    try {
      await client.trackEvent("order.completed");
    } finally {
      if (original) Object.defineProperty(globalThis, "crypto", original);
    }

    expect(JSON.parse(callsTo(mock, "/v1/web-push/event")[0][1].body).event_id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it("never puts the endpoint in the URL", async () => {
    const mock = useFetch();
    const client = await subscribed();

    await client.trackEvent("order.completed");

    const [url] = callsTo(mock, "/v1/web-push/event")[0];
    expect(url).not.toContain(ENDPOINT);
    expect(url).not.toContain(encodeURIComponent(ENDPOINT));
  });

  it.each(["", "a".repeat(65), "_x", "has space", "opened", "clicked", "received", "dismissed", "converted", "app_opened"])(
    "sends nothing and warns for the name %j, without throwing",
    async (name) => {
      const mock = useFetch();
      const client = await subscribed();
      mock.mockClear();

      await expect(client.trackEvent(name)).resolves.toBeUndefined();

      expect(mock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("trackEvent");
    },
  );

  it("sends nothing when the name is not a string", async () => {
    const mock = useFetch();
    const client = await subscribed();
    mock.mockClear();

    await client.trackEvent(undefined as never);

    expect(mock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not throw on 429 and 404, and leaves the code in the debug console", async () => {
    useFetch({ [EVENT]: { status: 429, body: { error: "rate_limited", code: "rate_limited" }, headers: { "Retry-After": "7" } } });
    const client = await subscribed();
    await expect(client.trackEvent("order.completed")).resolves.toBeUndefined();
    expect(debug.mock.calls.flat().join(" ")).toContain("rate_limited");

    debug.mockClear();
    useFetch({ [EVENT]: { status: 404, body: { error: "unknown_device", code: "unknown_device" } } });
    await expect(client.trackEvent("order.completed")).resolves.toBeUndefined();
    expect(debug.mock.calls.flat().join(" ")).toContain("unknown_device");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not throw when the network fails", async () => {
    const mock = useFetch();
    const client = await subscribed();
    mock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(client.trackEvent("order.completed")).resolves.toBeUndefined();
  });

  it("calls nothing when the browser has no subscription", async () => {
    const mock = useFetch();

    await new WebPushClient({ projectId: PROJECT }).trackEvent("order.completed");

    expect(mock).not.toHaveBeenCalled();
  });
});

describe("trackConversion", () => {
  const bodyOf = (mock: jest.Mock) => JSON.parse(callsTo(mock, "/v1/notifications/track-web")[0][1].body);

  it.each([[42], ["42"]])("sends the converted event of the notification %j to POST /v1/notifications/track-web", async (id) => {
    const mock = useFetch();
    const client = await subscribed();

    await expect(client.trackConversion(id)).resolves.toBeUndefined();

    expect(bodyOf(mock)).toEqual({ notification_id: 42, event_type: "converted", endpoint: ENDPOINT });
    expect(callsTo(mock, "/v1/notifications/track-web")[0][0]).not.toContain(ENDPOINT);
  });

  it.each([["abc"], [""], ["4.2"], [0], [-1], [1.5], [Number.NaN], [undefined], [null], [{}]])("sends nothing and warns for the id %j", async (id) => {
    const mock = useFetch();
    const client = await subscribed();
    mock.mockClear();

    await expect(client.trackConversion(id as never)).resolves.toBeUndefined();

    expect(mock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("trackConversion");
  });

  it("does not throw when the API refuses or the network fails", async () => {
    const mock = useFetch({ [TRACK_WEB]: { status: 429, body: { error: "rate_limited" } } });
    const client = await subscribed();
    await expect(client.trackConversion(42)).resolves.toBeUndefined();

    mock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(client.trackConversion(42)).resolves.toBeUndefined();
  });

  it("calls nothing when the browser has no subscription", async () => {
    const mock = useFetch();

    await new WebPushClient({ projectId: PROJECT }).trackConversion(42);

    expect(mock).not.toHaveBeenCalled();
  });
});
