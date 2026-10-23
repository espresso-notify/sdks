import { EspressoNotifyHttpError, SubscribeError, WebPushClient } from "../src/index";
import { FakeBrowser, fakeFetch, installFakeBrowser } from "../test-support/fakeBrowser";
import { fakeIndexedDB } from "../test-support/fakeIndexedDB";

// send-scale T82 (SCALE-27, SCALE-28; owner decision D-196): subscribe and identify are tried again when the failure
// can pass (no answer, 408, 429, 5xx), up to 6 tries, with a full-jitter wait or the Retry-After of the server plus a
// random 0 to 25%. Any other 4xx is final.

let browser: FakeBrowser;
const PROJECT = "pk_live_test";
const VAPID = "GET /v1/web-push/vapid-key";
const SUBSCRIBE = "POST /v1/web-push/subscribe";

beforeEach(() => {
  jest.useFakeTimers();
  browser = installFakeBrowser();
  (globalThis as any).indexedDB = fakeIndexedDB();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  browser.uninstall();
  delete (globalThis as any).indexedDB;
});

/** The answers of one route in turn; the last one repeats. */
function inTurn(...answers: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
  let n = 0;
  return () => answers[Math.min(n++, answers.length - 1)];
}

function useFetch(routes: Parameters<typeof fakeFetch>[0]): jest.Mock {
  const mock = fakeFetch(routes);
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

const calls = (mock: jest.Mock, route: string) =>
  mock.mock.calls.filter(([url, init]) => `${init?.method ?? "GET"} ${String(url).replace(/^.*?(?=\/v1\/)/, "")}` === route);

const settle = (ms: number) => jest.advanceTimersByTimeAsync(ms);

describe("subscribe", () => {
  it("tries a 429 with Retry-After: 2 again after 2 to 2.5 s, then works", async () => {
    const mock = useFetch({ [SUBSCRIBE]: inTurn({ status: 429, headers: { "Retry-After": "2" } }, { status: 200 }) });
    const done = new WebPushClient({ projectId: PROJECT }).subscribe();

    await settle(1999);
    expect(calls(mock, SUBSCRIBE)).toHaveLength(1);
    await settle(501);
    await expect(done).resolves.toBe(true);
    expect(calls(mock, SUBSCRIBE)).toHaveLength(2);
  });

  it("stretches the Retry-After by the dice: 2 s times 1.25 at the top", async () => {
    jest.spyOn(Math, "random").mockReturnValue(1);
    const mock = useFetch({ [SUBSCRIBE]: inTurn({ status: 429, headers: { "Retry-After": "2" } }, { status: 200 }) });
    const done = new WebPushClient({ projectId: PROJECT }).subscribe();

    await settle(2499);
    expect(calls(mock, SUBSCRIBE)).toHaveLength(1);
    await settle(51); // the second try at 2,500 ms, then the local write of the state
    await expect(done).resolves.toBe(true);
    expect(calls(mock, SUBSCRIBE)).toHaveLength(2);
  });

  it("does not wait for a Retry-After over 60 s: trySubscribe answers server_error at once and posts once", async () => {
    const mock = useFetch({ [SUBSCRIBE]: { status: 429, body: { error: "new_device_limit" }, headers: { "Retry-After": "61" } } });
    const result = new WebPushClient({ projectId: PROJECT }).trySubscribe();

    await settle(100); // a wait of 61 s or more would not be over
    expect(await result).toEqual({ ok: false, reason: "server_error", message: "new_device_limit" });
    expect(calls(mock, SUBSCRIBE)).toHaveLength(1);
  });

  it("still waits for a Retry-After of exactly 60 s, then works", async () => {
    const mock = useFetch({ [SUBSCRIBE]: inTurn({ status: 429, headers: { "Retry-After": "60" } }, { status: 200 }) });
    const done = new WebPushClient({ projectId: PROJECT }).subscribe();

    await settle(59_000);
    expect(calls(mock, SUBSCRIBE)).toHaveLength(1);
    await settle(16_000);
    await expect(done).resolves.toBe(true);
    expect(calls(mock, SUBSCRIBE)).toHaveLength(2);
  });

  it("does not wait for a Retry-After over 60 s when it reads the key of the project: vapid_key_missing at once", async () => {
    const mock = useFetch({ [VAPID]: { status: 429, headers: { "Retry-After": "61" } }, [SUBSCRIBE]: { status: 200 } });
    const result = new WebPushClient({ projectId: PROJECT }).trySubscribe();

    await settle(100);
    expect(await result).toMatchObject({ ok: false, reason: "vapid_key_missing" });
    expect(calls(mock, VAPID)).toHaveLength(1);
    expect(calls(mock, SUBSCRIBE)).toHaveLength(0);
  });

  it.each([[408], [500], [503]])("tries an HTTP %i again with the full-jitter wait and works", async (status) => {
    const mock = useFetch({ [SUBSCRIBE]: inTurn({ status, body: { error: "try later" } }, { status: 200 }) });
    const done = new WebPushClient({ projectId: PROJECT }).subscribe();

    await settle(1000); // the first back-off is at most 1 s
    await expect(done).resolves.toBe(true);
    expect(calls(mock, SUBSCRIBE)).toHaveLength(2);
  });

  it("does not try a 400 again: trySubscribe answers server_error with the message of the API", async () => {
    const mock = useFetch({ [SUBSCRIBE]: { status: 400, body: { error: "invalid endpoint" } } });
    const result = new WebPushClient({ projectId: PROJECT }).trySubscribe();

    await settle(60_000);
    expect(await result).toEqual({ ok: false, reason: "server_error", message: "invalid endpoint" });
    expect(calls(mock, SUBSCRIBE)).toHaveLength(1);
  });

  it("gives up after 6 tries of a server that stays down, with the same error as before", async () => {
    const mock = useFetch({ [SUBSCRIBE]: { status: 503, body: {} } });
    const failed = new WebPushClient({ projectId: PROJECT }).subscribe().then(() => null, (e: any) => e);

    await settle(60_000);
    const error = await failed;
    expect(error).toBeInstanceOf(SubscribeError);
    expect(error).toMatchObject({ reason: "server_error", message: "Subscribe failed with status 503" });
    expect(calls(mock, SUBSCRIBE)).toHaveLength(6);
  });

  it("tries a request that got no answer again, and works when the network is back", async () => {
    const answers = fakeFetch({ [SUBSCRIBE]: { status: 200 } });
    let offline = 2;
    const mock = jest.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === "POST" && offline-- > 0) throw new TypeError("Failed to fetch");
      return answers(url, init as never);
    });
    global.fetch = mock as unknown as typeof fetch;
    const done = new WebPushClient({ projectId: PROJECT }).subscribe();

    await settle(10_000);
    await expect(done).resolves.toBe(true);
    expect(calls(mock, SUBSCRIBE)).toHaveLength(3);
  });

  it("throws what the browser raised when the network never comes back (as before)", async () => {
    const offline = new TypeError("Failed to fetch");
    const answers = fakeFetch({});
    const mock = jest.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === "POST") throw offline;
      return answers(url, init as never);
    });
    global.fetch = mock as unknown as typeof fetch;
    const failed = new WebPushClient({ projectId: PROJECT }).subscribe().then(() => null, (e: any) => e);

    await settle(60_000);
    expect(await failed).toBe(offline);
    expect(calls(mock, SUBSCRIBE)).toHaveLength(6);
  });

  it("tries the key of the project again when the browser has no subscription yet", async () => {
    const mock = useFetch({
      [VAPID]: inTurn({ status: 503 }, { body: { vapid_public_key: "BNabc123" } }),
      [SUBSCRIBE]: { status: 200 },
    });
    const done = new WebPushClient({ projectId: PROJECT }).subscribe();

    await settle(1000);
    await expect(done).resolves.toBe(true);
    expect(calls(mock, VAPID)).toHaveLength(2);
    expect(calls(mock, SUBSCRIBE)).toHaveLength(1);
  });

  it("does not try the key again for a 404 (the project has no key): vapid_key_missing at once", async () => {
    const mock = useFetch({ [VAPID]: { status: 404, body: { error: "web_push_not_configured" } }, [SUBSCRIBE]: { status: 200 } });
    const result = new WebPushClient({ projectId: PROJECT }).trySubscribe();

    await settle(60_000);
    expect(await result).toMatchObject({ ok: false, reason: "vapid_key_missing" });
    expect(calls(mock, VAPID)).toHaveLength(1);
  });

  it("does not wait for the key of a browser that already has a subscription", async () => {
    browser.uninstall();
    browser = installFakeBrowser({ subscribed: true });
    const mock = useFetch({ [VAPID]: { status: 503 }, [SUBSCRIBE]: { status: 200 } });
    const done = new WebPushClient({ projectId: PROJECT }).subscribe();

    await settle(50);
    await expect(done).resolves.toBe(true);
    expect(calls(mock, VAPID)).toHaveLength(1);
  });
});

describe("identify", () => {
  // Subscribes with the API answering 200, then gives the answers of `afterwards` to the calls that follow.
  async function subscribed(afterwards: () => { status?: number; body?: unknown; headers?: Record<string, string> }) {
    let subscribing = true;
    const mock = useFetch({ [SUBSCRIBE]: () => (subscribing ? { status: 200 } : afterwards()) });
    const client = new WebPushClient({ projectId: PROJECT });
    const first = client.subscribe();
    await settle(50);
    await first;
    subscribing = false;
    mock.mockClear();
    return { client, mock };
  }

  it("tries a 503 again with the full-jitter wait, then works", async () => {
    const { client, mock } = await subscribed(inTurn({ status: 503 }, { status: 200 }));
    const done = client.identify("user-1");

    await settle(1000);
    await expect(done).resolves.toBeUndefined();
    expect(calls(mock, SUBSCRIBE)).toHaveLength(2);
  });

  it("tries a 429 with Retry-After: 2 again after 2 to 2.5 s", async () => {
    const { client, mock } = await subscribed(inTurn({ status: 429, headers: { "Retry-After": "2" } }, { status: 200 }));
    const done = client.identify("user-1");

    await settle(1999);
    expect(calls(mock, SUBSCRIBE)).toHaveLength(1);
    await settle(501);
    await expect(done).resolves.toBeUndefined();
    expect(calls(mock, SUBSCRIBE)).toHaveLength(2);
  });

  it("does not wait for a Retry-After over 60 s: it throws at once and sends once", async () => {
    const { client, mock } = await subscribed(() => ({ status: 429, body: { error: "rate_limited" }, headers: { "Retry-After": "61" } }));
    const failed = client.identify("user-1").then(() => null, (e: any) => e);

    await settle(100);
    expect(await failed).toMatchObject({ message: "rate_limited" });
    expect(calls(mock, SUBSCRIBE)).toHaveLength(1);
  });

  it("does not try a 403 again: it throws the message of the API at once", async () => {
    const { client, mock } = await subscribed(() => ({ status: 403, body: { error: "identity_verification_failed" } }));
    const failed = client.identify("user-1").then(() => null, (e: any) => e);

    await settle(60_000);
    expect(await failed).toMatchObject({ message: "identity_verification_failed" });
    expect(calls(mock, SUBSCRIBE)).toHaveLength(1);
  });

  it("gives up after 6 tries and throws the same error as before", async () => {
    const { client, mock } = await subscribed(() => ({ status: 502, body: {} }));
    const failed = client.identify("user-1").then(() => null, (e: any) => e);

    await settle(60_000);
    expect(await failed).toMatchObject({ message: "Identify failed with status 502" });
    expect(calls(mock, SUBSCRIBE)).toHaveLength(6);
  });
});

describe("the error of the API", () => {
  it("carries the Retry-After of the answer as seconds", () => {
    const error = new EspressoNotifyHttpError("Too many", 429, "rate_limited", "/v1/web-push/subscribe", 7);
    expect(error.retryAfter).toBe(7);
    expect(new EspressoNotifyHttpError("x", 500).retryAfter).toBeUndefined();
  });
});
