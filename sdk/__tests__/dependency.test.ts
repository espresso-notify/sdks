/**
 * Tests for SDK behavior when expo-notifications is absent (bare React Native)
 * and when it is present (Expo).
 *
 * Task #801: constructor must never throw because expo-notifications is missing.
 */

// Mock global fetch for transport-method tests
const mockFetch = jest.fn();
globalThis.fetch = mockFetch;

describe("SDK Dependencies — bare React Native (expo-notifications absent)", () => {
  beforeEach(() => {
    jest.resetModules();
    mockFetch.mockClear();
  });

  it("constructs PushClient successfully when expo-notifications is missing", () => {
    jest.doMock(
      "expo-notifications",
      () => {
        throw new Error("Cannot find module expo-notifications");
      },
      { virtual: true },
    );

    const { PushClient } = require("../src/index");

    expect(() => {
      new PushClient({ projectId: "pk_test_bare_rn" });
    }).not.toThrow();
  });

  it("devices.register works (pure fetch) when expo-notifications is absent", async () => {
    jest.doMock(
      "expo-notifications",
      () => {
        throw new Error("Cannot find module expo-notifications");
      },
      { virtual: true },
    );

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ success: true })),
    });

    const { PushClient } = require("../src/index");
    const client = new PushClient({
      projectId: "pk_test_bare_rn",
      pushToken: "ExponentPushToken[bare_rn]",
      platform: "android",
    });

    const result = await client.devices.register({
      pushToken: "ExponentPushToken[bare_rn]",
      platform: "android",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/devices/register"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).toEqual({ success: true });
  });

  it("does NOT warn with npx-expo hint when ALL expo-* packages are absent", () => {
    // Simulate a fully bare-RN environment: none of the expo-* packages exist
    jest.doMock("expo-notifications", () => { throw new Error("not found"); }, { virtual: true });
    jest.doMock("expo-localization",  () => { throw new Error("not found"); }, { virtual: true });
    jest.doMock("expo-application",   () => { throw new Error("not found"); }, { virtual: true });
    jest.doMock("expo-device",        () => { throw new Error("not found"); }, { virtual: true });

    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    try {
      const { PushClient } = require("../src/index");
      new PushClient({ projectId: "pk_test_bare_rn" });
      // No misleading Expo-CLI warning should appear in a bare-RN context
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("npx expo install"));
    } finally {
      process.env.NODE_ENV = origEnv;
      warnSpy.mockRestore();
    }
  });
});

describe("SDK Dependencies — Expo environment (expo-notifications present)", () => {
  beforeEach(() => {
    jest.resetModules();
    mockFetch.mockClear();
  });

  it("constructs PushClient successfully when expo-notifications is present", () => {
    jest.doMock("expo-notifications", () => ({}), { virtual: true });

    const { PushClient } = require("../src/index");

    expect(() => {
      new PushClient({ projectId: "pk_test_expo" });
    }).not.toThrow();
  });

  it("warns about missing optional expo-* deps when expo-notifications IS present", () => {
    jest.doMock("expo-notifications", () => ({}), { virtual: true });
    // Leave expo-localization / expo-application / expo-device absent
    jest.doMock("expo-localization", () => { throw new Error("not found"); }, { virtual: true });
    jest.doMock("expo-application",  () => { throw new Error("not found"); }, { virtual: true });
    jest.doMock("expo-device",       () => { throw new Error("not found"); }, { virtual: true });

    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    (globalThis as any).__DEV__ = true; // the warning is for development builds only (expo-setup-simpler ES-02)
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    try {
      const { PushClient } = require("../src/index");
      new PushClient({ projectId: "pk_test_expo" });

      // Should warn about the missing optional metadata packages
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[espresso-notify]"));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("expo-localization"));
    } finally {
      process.env.NODE_ENV = origEnv;
      delete (globalThis as any).__DEV__;
      warnSpy.mockRestore();
    }
  });
});

// Torna o arquivo um módulo: sem isso o ts-jest o trata como script global e
// nomes de topo repetidos entre testes colidem (TS2451) em cache frio.
export {}
