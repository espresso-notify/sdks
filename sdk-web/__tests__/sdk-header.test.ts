import { WebPushClient } from "../src/index";
import { fakeFetch, FakeBrowser, installFakeBrowser } from "../test-support/fakeBrowser";
import { fakeIndexedDB } from "../test-support/fakeIndexedDB";

// sdk-parity T66 (PAR-79): every call the web SDK makes to the API names the SDK and its version as
// `X-Espresso-SDK: web/<version>`, the version being the one in package.json.
// feature: platform.sdk-version

const PROJECT = "pk_live_test";
const VERSION: string = require("../package.json").version;
let browser: FakeBrowser;
let fetchMock: jest.Mock;

beforeEach(() => {
  browser = installFakeBrowser();
  (globalThis as any).indexedDB = fakeIndexedDB();
  fetchMock = fakeFetch({
    "POST /v1/web-push/subscribe": { body: {} },
    "DELETE /v1/web-push/device": { status: 204 },
    "POST /v1/notifications/track-web": { status: 204 },
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  browser.uninstall();
  delete (globalThis as any).indexedDB;
});

const headerOf = (call: unknown[]): string | undefined => {
  const headers = (call[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined;
  return headers?.["X-Espresso-SDK"];
};
const callTo = (method: string, suffix: string) =>
  fetchMock.mock.calls.find(([url, init]) => String(url).endsWith(suffix) && (init?.method ?? "GET") === method)!;

describe("X-Espresso-SDK on the web SDK (PAR-79)", () => {
  it("the subscribe, the identify and the erase carry web/<version>", async () => {
    const client = new WebPushClient({ projectId: PROJECT });
    await client.subscribe();
    await client.identify("user-1");
    await client.forgetDevice();

    const subscribes = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith("/v1/web-push/subscribe") && init?.method === "POST");
    expect(subscribes.length).toBeGreaterThanOrEqual(2); // the subscribe and the identify go to the same route
    for (const call of subscribes) expect(headerOf(call)).toBe(`web/${VERSION}`);
    expect(headerOf(callTo("DELETE", "/v1/web-push/device"))).toBe(`web/${VERSION}`);
  });

  it("the conversion report carries it too", async () => {
    const client = new WebPushClient({ projectId: PROJECT });
    await client.subscribe();
    await client.trackConversion(7);
    expect(headerOf(callTo("POST", "/v1/notifications/track-web"))).toBe(`web/${VERSION}`);
  });
});
