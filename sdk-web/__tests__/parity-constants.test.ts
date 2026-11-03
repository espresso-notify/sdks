// sdk-parity T46 (PAR-46): the web SDK behaves as the shared constants say. The numbers come from the copy of
// `sdk-parity/constants.json` (Retry-After cap of 60 s for a page, the dismissal gesture `null` under B10), never from a
// literal here.
//
// feature: queue.retry
// feature: metadata.size-limit
// feature: tracking.tap-semantics

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { RETRY_AFTER_MAX_WAIT_S, RETRY_ATTEMPTS } from "../src/retry";
import { SubscribeError, WebPushClient } from "../src/index";
import { FakeBrowser, fakeFetch, installFakeBrowser } from "../test-support/fakeBrowser";
import { fakeIndexedDB } from "../test-support/fakeIndexedDB";
import { effective, keysFor } from "./helpers/parityConstants";

const PROJECT = "pk_live_test";
const SUBSCRIBE = "POST /v1/web-push/subscribe";

describe("the constants of web", () => {
  it("lists the keys this SDK is tested against", () => {
    expect(keysFor("web")).toEqual([
      "retry.attempts",
      "retry_after.cap_seconds_web",
      "metadata.max_bytes",
      "action_id.max_length",
      "gesture_events",
    ]);
  });
});

describe("page requests (retry.attempts, retry_after.cap_seconds_web, metadata.max_bytes)", () => {
  let browser: FakeBrowser;
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

  const useFetch = (routes: Parameters<typeof fakeFetch>[0]) => {
    const mock = fakeFetch(routes);
    global.fetch = mock as unknown as typeof fetch;
    return mock;
  };
  const posts = (mock: jest.Mock) => mock.mock.calls.filter(([url, init]) => `${init?.method ?? "GET"} ${String(url).replace(/^.*?(?=\/v1\/)/, "")}` === SUBSCRIBE);

  it("tries a server that stays down retry.attempts times in all", async () => {
    const mock = useFetch({ [SUBSCRIBE]: { status: 503, body: {} } });
    const failed = new WebPushClient({ projectId: PROJECT }).subscribe().then(() => null, (e: any) => e);

    await jest.advanceTimersByTimeAsync(600_000);
    expect(await failed).toBeInstanceOf(SubscribeError);
    expect(posts(mock)).toHaveLength(effective("retry.attempts", "web"));
    expect(RETRY_ATTEMPTS).toBe(effective("retry.attempts", "web"));
  });

  it("waits for a Retry-After of exactly retry_after.cap_seconds_web and fails at once on one second more", async () => {
    const cap = effective<number>("retry_after.cap_seconds_web", "web");
    expect(RETRY_AFTER_MAX_WAIT_S).toBe(cap);

    let n = 0;
    const waits = useFetch({ [SUBSCRIBE]: () => (n++ === 0 ? { status: 429, headers: { "Retry-After": String(cap) } } : { status: 200 }) });
    const done = new WebPushClient({ projectId: PROJECT }).subscribe();
    await jest.advanceTimersByTimeAsync((cap - 1) * 1000);
    expect(posts(waits)).toHaveLength(1);
    await jest.advanceTimersByTimeAsync((cap * 0.25 + 2) * 1000);
    await expect(done).resolves.toBe(true);
    expect(posts(waits)).toHaveLength(2);

    const refused = useFetch({ [SUBSCRIBE]: { status: 429, body: { error: "new_device_limit" }, headers: { "Retry-After": String(cap + 1) } } });
    const result = new WebPushClient({ projectId: PROJECT }).trySubscribe();
    await jest.advanceTimersByTimeAsync(100);
    expect(await result).toEqual({ ok: false, reason: "server_error", message: "new_device_limit" });
    expect(posts(refused)).toHaveLength(1);
  });

  it("posts metadata of exactly metadata.max_bytes whole and surfaces the refusal of one byte more, once", async () => {
    jest.useRealTimers();
    const max = effective<number>("metadata.max_bytes", "web");
    const padded = (size: number) => ({ k: "a".repeat(size - '{"k":""}'.length) });
    // The server takes at most `max` bytes of metadata and answers 400 above it; the page SDK does not cut or retry.
    const mock = useFetch({
      [SUBSCRIBE]: (init: { body?: string }) => {
        const metadata = JSON.parse(init.body ?? "{}").metadata;
        return metadata && JSON.stringify(metadata).length > max ? { status: 400, body: { error: "metadata_too_large" } } : { status: 200 };
      },
    });
    const client = new WebPushClient({ projectId: PROJECT });
    await client.subscribe();
    mock.mockClear();

    await client.updateMetadata(padded(max));
    expect(JSON.stringify(JSON.parse(mock.mock.calls[0][1].body).metadata)).toHaveLength(max);

    mock.mockClear();
    await expect(client.updateMetadata(padded(max + 1))).rejects.toThrow("metadata_too_large");
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe("the service worker (action_id.max_length, gesture_events)", () => {
  const ORIGIN = "https://shop.example";
  const ENDPOINT = "https://push.example/endpoint-1";
  const API_URL = "https://api.espressonotify.com";
  const TRACK = `${API_URL}/v1/notifications/track-web`;
  type Listener = (event: any) => void;

  function loadWorker() {
    const listeners: Record<string, Listener> = {};
    const fakeSelf: Record<string, any> = {
      location: { origin: ORIGIN, hostname: "shop.example" },
      addEventListener: (type: string, listener: Listener) => {
        listeners[type] = listener;
      },
      registration: {
        showNotification: jest.fn().mockResolvedValue(undefined),
        pushManager: { getSubscription: jest.fn().mockResolvedValue({ endpoint: ENDPOINT }) },
      },
      clients: { matchAll: jest.fn().mockResolvedValue([]), openWindow: jest.fn().mockResolvedValue(null) },
    };
    const raw = fs.readFileSync(path.join(__dirname, "..", "src", "sw.ts"), "utf8").replace("__ESPRESSO_API_URL__", API_URL);
    const code = ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } }).outputText;
    new Function("self", code)(fakeSelf);
    return listeners;
  }

  async function click(listeners: Record<string, Listener>, action?: unknown) {
    const event = { notification: { close: jest.fn(), data: { url: `${ORIGIN}/sale`, notificationId: 77 } }, action, waitUntil: jest.fn() };
    listeners.notificationclick(event);
    await event.waitUntil.mock.calls[0][0];
  }

  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    (globalThis as any).fetch = fetchMock;
  });
  afterEach(() => {
    delete (globalThis as any).self;
  });
  const reports = () => fetchMock.mock.calls.map(([url, init]) => ({ url, body: JSON.parse(init.body) }));

  it("keeps an action id of action_id.max_length characters and leaves out one more", async () => {
    const max = effective<number>("action_id.max_length", "web");
    await click(loadWorker(), "a".repeat(max));
    await click(loadWorker(), "a".repeat(max + 1));

    const [kept, left] = reports();
    expect(kept.body.action_id).toBe("a".repeat(max));
    expect(left.body.event_type).toBe("clicked");
    expect(left.body).not.toHaveProperty("action_id");
  });

  it("reports gesture_events.body for the body and gesture_events.button for a button", async () => {
    const gestures = effective<{ body: string; button: string; dismiss: string | null }>("gesture_events", "web");
    await click(loadWorker());
    await click(loadWorker(), "reply");

    expect(reports().map((r) => [r.url, r.body.event_type])).toEqual([
      [TRACK, gestures.body],
      [TRACK, gestures.button],
    ]);
  });

  it("reports no dismissal while gesture_events.dismiss is null (B10)", () => {
    const gestures = effective<{ dismiss: string | null }>("gesture_events", "web");
    expect(gestures.dismiss).toBeNull();
    expect(loadWorker()).not.toHaveProperty("notificationclose");
  });
});
