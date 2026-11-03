// sdk-parity T28 (PAR-18, PAR-19): the service worker reports one event for one click. A click on the body of the
// notification is an `opened`; a click on an action button is a `clicked` that carries the id of the button as
// `action_id`. It never reports both.
//
// feature: tracking.tap-semantics

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

type Listener = (event: any) => void;

const ORIGIN = "https://shop.example";
const ENDPOINT = "https://push.example/endpoint-1";
const API_URL = "https://api.espressonotify.com";
const TRACK = `${API_URL}/v1/notifications/track-web`;

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

/** Clicks the notification (a button when `action` is given) and waits for what the worker does. */
async function click(listeners: Record<string, Listener>, action?: unknown, data: Record<string, unknown> = { url: `${ORIGIN}/sale`, notificationId: 77 }) {
  const event = { notification: { close: jest.fn(), data }, action, waitUntil: jest.fn() };
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

describe("one click, one event (PAR-18, PAR-19)", () => {
  it.each([undefined, ""])("a click on the body (action %p) is one opened, without action_id", async (action) => {
    await click(loadWorker(), action);

    expect(reports()).toEqual([{ url: TRACK, body: { notification_id: 77, event_type: "opened", endpoint: ENDPOINT } }]);
  });

  it("a click on a button is one clicked with the id of the button, and no opened", async () => {
    await click(loadWorker(), "reply");

    expect(reports()).toEqual([
      { url: TRACK, body: { notification_id: 77, event_type: "clicked", endpoint: ENDPOINT, action_id: "reply" } },
    ]);
  });

  it("keeps an id of 64 characters, counted as characters and not as bytes", async () => {
    const id = "\u{1F600}".repeat(64);
    await click(loadWorker(), id);

    expect(reports()[0].body).toEqual({ notification_id: 77, event_type: "clicked", endpoint: ENDPOINT, action_id: id });
  });

  it.each([
    ["over 64 characters", "x".repeat(65)],
    ["with a control character", "a\u0007b"],
    ["with a format character", "a‍b"],
  ])("a button id %s is left out and the click still counts", async (_name, id) => {
    await click(loadWorker(), id);

    expect(reports()).toEqual([{ url: TRACK, body: { notification_id: 77, event_type: "clicked", endpoint: ENDPOINT } }]);
  });

  it("reports nothing for a notification without an id, body or button", async () => {
    const listeners = loadWorker();
    await click(listeners, undefined, { url: `${ORIGIN}/sale` });
    await click(listeners, "reply", { url: `${ORIGIN}/sale` });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
