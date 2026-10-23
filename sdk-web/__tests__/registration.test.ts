/**
 * @jest-environment node
 *
 * send-scale T84 (SCALE-39; owner decision D-196): the registration tracker of the Web SDK. After a subscription post
 * or an identify WORKED it remembers a hash of what was sent and the session; the call runs again only when the hash
 * differs or the remembered call belongs to an earlier session. A web session is one tab, and ends after 30 minutes
 * away. The twin of sdk/__tests__/registration.test.ts.
 */
import { RegistrationParts, RegistrationTracker, SDK_VERSION, SESSION_GAP_MS } from "../src/registration";
import { FakeStorage, fakeStorage } from "../test-support/fakeStorage";

const KEY = "espresso-notify:registration:pk_live_test";
const SESSION_KEY = "espresso-notify:session";
const MIN = 60_000;

const PARTS: RegistrationParts = {
  endpoint: "https://push.example/endpoint-secret-1",
  p256dh: "p256dh-secret-key",
  auth: "auth-secret-key",
  vapidKey: "BNvapid",
  timezone: "America/Sao_Paulo",
};
const WHO: RegistrationParts = { ...PARTS, userId: "user-secret-42", userName: "Maria Silva", identityHash: "ab".repeat(32) };

let clock = 1_800_000_000_000;
let local: FakeStorage;
let session: FakeStorage;

function tracker(options: Partial<ConstructorParameters<typeof RegistrationTracker>[0]> = {}) {
  return new RegistrationTracker({
    key: KEY,
    projectKey: "pk_live_test",
    storage: local,
    sessionStorage: session,
    now: () => clock,
    page: null,
    ...options,
  });
}

beforeEach(() => {
  clock = 1_800_000_000_000;
  local = fakeStorage();
  session = fakeStorage();
});

describe("plan and commit", () => {
  it("asks for the call when nothing was sent yet, and not again once it worked in this session", async () => {
    const t = tracker();
    const ticket = await t.plan("register", PARTS);
    expect(ticket).not.toBeNull();
    await t.commit(ticket!);
    expect(await t.plan("register", PARTS)).toBeNull();
  });

  it("keeps register and identify apart", async () => {
    const t = tracker();
    await t.commit((await t.plan("register", PARTS))!);
    expect(await t.plan("identify", WHO)).not.toBeNull();
    await t.commit((await t.plan("identify", WHO))!);
    expect(await t.plan("register", PARTS)).toBeNull();
    expect(await t.plan("identify", WHO)).toBeNull();
  });

  it("does not remember a call that was planned but did not work", async () => {
    const t = tracker();
    expect(await t.plan("register", PARTS)).not.toBeNull();
    expect(await t.plan("register", PARTS)).not.toBeNull(); // nothing was committed
    expect(local.data.size).toBe(0);
  });

  it.each<[string, Partial<RegistrationParts>]>([
    ["the endpoint", { endpoint: "https://push.example/endpoint-2" }],
    ["the p256dh key", { p256dh: "other" }],
    ["the auth key", { auth: "other" }],
    ["the VAPID key", { vapidKey: "BNother" }],
    ["the time zone", { timezone: "Europe/Lisbon" }],
  ])("asks again at once when %s changed", async (_name, change) => {
    const t = tracker();
    await t.commit((await t.plan("register", PARTS))!);
    expect(await t.plan("register", { ...PARTS, ...change })).not.toBeNull();
  });

  it.each<[string, Partial<RegistrationParts>]>([
    ["the user", { userId: "user-2" }],
    ["the name", { userName: "Other Name" }],
    ["the proof of identity", { identityHash: "cd".repeat(32) }],
  ])("asks for identify again at once when %s changed", async (_name, change) => {
    const t = tracker();
    await t.commit((await t.plan("identify", WHO))!);
    expect(await t.plan("identify", { ...WHO, ...change })).not.toBeNull();
  });

  it("asks again when the version of the app or of the SDK changed, and for another project", async () => {
    const base = tracker({ appVersion: "1.0.0" });
    await base.commit((await base.plan("register", PARTS))!);
    expect(await tracker({ appVersion: "1.0.0" }).plan("register", PARTS)).toBeNull();
    expect(await tracker({ appVersion: "1.0.1" }).plan("register", PARTS)).not.toBeNull();
    expect(await tracker({ appVersion: "1.0.0", sdkVersion: "9.9.9" }).plan("register", PARTS)).not.toBeNull();
    expect(await tracker({ appVersion: "1.0.0", projectKey: "pk_live_other" }).plan("register", PARTS)).not.toBeNull();
  });

  it("uses the version of the package as the SDK version", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("always asks when the call is forced (a consent record, an endpoint to replace)", async () => {
    const t = tracker();
    await t.commit((await t.plan("register", PARTS))!);
    expect(await t.plan("register", PARTS, { force: true })).not.toBeNull();
  });

  it("forgets one call or both, so the next plan runs", async () => {
    const t = tracker();
    await t.commit((await t.plan("register", PARTS))!);
    await t.commit((await t.plan("identify", WHO))!);
    await t.forget("identify");
    expect(await t.plan("identify", WHO)).not.toBeNull();
    expect(await t.plan("register", PARTS)).toBeNull();
    await t.forget();
    expect(await t.plan("register", PARTS)).not.toBeNull();
  });
});

describe("the session", () => {
  async function sent(t: RegistrationTracker) {
    await t.commit((await t.plan("register", PARTS))!);
  }

  it("is the same for a page load in the same tab", async () => {
    await sent(tracker());
    clock += 10 * MIN;
    expect(await tracker().plan("register", PARTS)).toBeNull();
  });

  it("is a new one for another tab (an empty sessionStorage) and sends once more", async () => {
    await sent(tracker());
    session = fakeStorage();
    const second = tracker();
    const ticket = await second.plan("register", PARTS);
    expect(ticket).not.toBeNull();
    await second.commit(ticket!);
    expect(await second.plan("register", PARTS)).toBeNull();
  });

  it("does not send again when two tabs take turns with the same state", async () => {
    const sessionA = session;
    const sessionB = fakeStorage();
    session = sessionA;
    await sent(tracker());
    session = sessionB;
    await sent(tracker());
    session = sessionA;
    expect(await tracker().plan("register", PARTS)).toBeNull();
    session = sessionB;
    expect(await tracker().plan("register", PARTS)).toBeNull();
  });

  it("is a new one for a page load 30 minutes after the last time the page was seen, and not before", async () => {
    await sent(tracker());
    clock += SESSION_GAP_MS - 1;
    expect(await tracker().plan("register", PARTS)).toBeNull(); // 29 min 59 s
    clock += SESSION_GAP_MS - 1; // 59 min 58 s after the first load, but under 30 min after the last
    expect(await tracker().plan("register", PARTS)).toBeNull();
    clock += SESSION_GAP_MS;
    expect(await tracker().plan("register", PARTS)).not.toBeNull();
    expect(SESSION_GAP_MS).toBe(30 * MIN);
  });

  it("is a new one when the page comes back to the screen after 30 minutes hidden, and not after 29", async () => {
    const listeners: Record<string, () => void> = {};
    const page = { visibilityState: "visible", addEventListener: (type: string, fn: () => void) => { listeners[type] = fn; } };
    const t = tracker({ page });
    await sent(t);

    page.visibilityState = "hidden";
    listeners.visibilitychange();
    clock += 29 * MIN;
    page.visibilityState = "visible";
    listeners.visibilitychange();
    expect(await t.plan("register", PARTS)).toBeNull();

    page.visibilityState = "hidden";
    listeners.visibilitychange();
    clock += 30 * MIN;
    page.visibilityState = "visible";
    listeners.visibilitychange();
    expect(await t.plan("register", PARTS)).not.toBeNull();
  });

  it("is a new one for every tracker when the browser has no sessionStorage (every page load)", async () => {
    await sent(tracker({ sessionStorage: null }));
    expect(await tracker({ sessionStorage: null }).plan("register", PARTS)).not.toBeNull();
  });

  it("keeps the 8 latest sessions of a state; an older one sends once more", async () => {
    const firstSession = session;
    await sent(tracker());
    for (let i = 0; i < 8; i++) {
      session = fakeStorage();
      await sent(tracker());
    }
    session = firstSession;
    expect(await tracker().plan("register", PARTS)).not.toBeNull();
  });
});

describe("what is stored", () => {
  it("holds hashes and a session id, never the endpoint, the keys, the user id, the name or the proof", async () => {
    const t = tracker({ appVersion: "2.0.0" });
    await t.commit((await t.plan("register", PARTS))!);
    await t.commit((await t.plan("identify", WHO))!);

    const everything = [...local.written, ...session.written, ...local.data.values(), ...session.data.values()].join("\n");
    for (const secret of ["endpoint-secret-1", "p256dh-secret-key", "auth-secret-key", "user-secret-42", "Maria", "Silva", "ab".repeat(32), "push.example"]) {
      expect(everything).not.toContain(secret);
    }
    const record = JSON.parse(local.data.get(KEY) as string);
    expect(record.register.f).toMatch(/^s[0-9a-f]{32}$/);
    expect(record.identify.f).toMatch(/^s[0-9a-f]{32}$/);
    expect(record.register.f).not.toBe(record.identify.f);
  });

  it("falls back to a plain hash where SubtleCrypto is missing, still hiding the values and telling states apart", async () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
    try {
      const t = tracker();
      await t.commit((await t.plan("identify", WHO))!);
      expect(local.data.get(KEY)).not.toContain("user-secret-42");
      expect(JSON.parse(local.data.get(KEY) as string).identify.f).toMatch(/^c[0-9a-f]{14}$/);
      expect(await t.plan("identify", WHO)).toBeNull();
      expect(await t.plan("identify", { ...WHO, userId: "user-2" })).not.toBeNull();
    } finally {
      if (before) Object.defineProperty(globalThis, "crypto", before);
      else delete (globalThis as Record<string, unknown>).crypto;
    }
  });

  it.each([
    ["nothing", undefined],
    ["text that is not JSON", "{not json"],
    ["a record of another version", JSON.stringify({ v: 9, register: { f: "x", s: ["y"] } })],
    ["a record of the wrong shape", JSON.stringify({ v: 1, register: { f: 7, s: "y" } })],
    ["an array", "[1,2]"],
  ])("reads %s as 'nothing was sent yet': the call runs once, never an error", async (_name, stored) => {
    if (stored !== undefined) local.data.set(KEY, stored);
    const t = tracker();
    const ticket = await t.plan("register", PARTS);
    expect(ticket).not.toBeNull();
    await t.commit(ticket!);
    expect(await t.plan("register", PARTS)).toBeNull();
  });

  it("never throws when the storage cannot be read or written; the call runs every time", async () => {
    local.failReads = true;
    session.failReads = true;
    session.failWrites = true;
    const t = tracker();
    const ticket = await t.plan("register", PARTS);
    expect(ticket).not.toBeNull();
    await expect(t.commit(ticket!)).resolves.toBeUndefined();
    local.failWrites = true;
    await expect(t.forget()).resolves.toBeUndefined();
    expect(await t.plan("register", PARTS)).not.toBeNull();
  });

  it("works with no localStorage at all: every plan runs", async () => {
    const t = tracker({ storage: null });
    const ticket = await t.plan("register", PARTS);
    await t.commit(ticket!);
    expect(await t.plan("register", PARTS)).not.toBeNull();
  });
});
