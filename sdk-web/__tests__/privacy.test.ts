import { readFileSync } from "fs";
import { join } from "path";
import * as pkg from "../src/index";
import { EspressoNotifyHttpError, isValidEventName, validatePreferences } from "../src/index";

// web-sdk-completion T8 (WSC-04, WSC-07, WSC-11): the error class and the validators of the web client.
// The rules are the ones of the React Native SDK (sdk/src/index.ts), and one test below compares the two.

const pref = (categoryIdentifier: string, ...rest: unknown[]) => ({ categoryIdentifier, optedOut: rest.length ? rest[0] : true }) as never;

describe("validatePreferences", () => {
  it("accepts 1 and 50 items and rejects 0 and 51", () => {
    expect(() => validatePreferences([pref("promotions")])).not.toThrow();
    expect(() => validatePreferences(Array.from({ length: 50 }, (_, i) => pref(`c${i}`)))).not.toThrow();
    expect(() => validatePreferences([])).toThrow(/1 to 50 items/);
    expect(() => validatePreferences(Array.from({ length: 51 }, (_, i) => pref(`c${i}`)))).toThrow(/1 to 50 items/);
  });

  it("rejects what is not a list", () => {
    expect(() => validatePreferences(undefined as never)).toThrow(/1 to 50 items/);
    expect(() => validatePreferences({ categoryIdentifier: "a", optedOut: true } as never)).toThrow(/1 to 50 items/);
  });

  it("rejects an empty identifier, one of only spaces, and one of 65 bytes", () => {
    expect(() => validatePreferences([pref("")])).toThrow(/1 to 64 bytes/);
    expect(() => validatePreferences([pref("   ")])).toThrow(/1 to 64 bytes/);
    expect(() => validatePreferences([pref("a".repeat(65))])).toThrow(/1 to 64 bytes/);
  });

  it("counts bytes, not characters: 32 accented letters fit and 33 do not", () => {
    expect(() => validatePreferences([pref("é".repeat(32))])).not.toThrow();
    expect(() => validatePreferences([pref("é".repeat(33))])).toThrow(/1 to 64 bytes/);
    expect(() => validatePreferences([pref("a".repeat(64))])).not.toThrow();
  });

  it("rejects an identifier that is not a string", () => {
    expect(() => validatePreferences([{ categoryIdentifier: 7, optedOut: true } as never])).toThrow(/1 to 64 bytes/);
    expect(() => validatePreferences([null as never])).toThrow(/1 to 64 bytes/);
  });

  it("rejects an optedOut that is not a boolean", () => {
    for (const bad of ["true", 1, 0, undefined, null]) {
      expect(() => validatePreferences([pref("promotions", bad)])).toThrow(/boolean 'optedOut'/);
    }
    expect(() => validatePreferences([pref("promotions", false)])).not.toThrow();
  });
});

describe("isValidEventName", () => {
  it("accepts 1 and 64 characters and rejects 0 and 65", () => {
    expect(isValidEventName("a")).toBe(true);
    expect(isValidEventName("a".repeat(64))).toBe(true);
    expect(isValidEventName("")).toBe(false);
    expect(isValidEventName("a".repeat(65))).toBe(false);
  });

  it("accepts letters, digits, underscore, dot, colon and hyphen after a letter or digit", () => {
    expect(isValidEventName("order.completed")).toBe(true);
    expect(isValidEventName("checkout:step-2_done")).toBe(true);
    expect(isValidEventName("9lives")).toBe(true);
  });

  it("rejects a name that starts with a symbol or holds a space or another symbol", () => {
    for (const bad of ["_x", ".x", ":x", "-x", "a b", "a/b", "a@b", "ção"]) expect(isValidEventName(bad)).toBe(false);
  });

  it("rejects the six names of the delivery lifecycle", () => {
    for (const reserved of ["opened", "clicked", "received", "dismissed", "converted", "app_opened"]) {
      expect(isValidEventName(reserved)).toBe(false);
    }
    expect(isValidEventName("opened_twice")).toBe(true);
  });

  it("rejects a value that is not a string", () => {
    for (const bad of [undefined, null, 5, {}, ["a"]]) expect(isValidEventName(bad as never)).toBe(false);
  });
});

describe("EspressoNotifyHttpError", () => {
  it("is an Error that carries the status and the code of the answer", () => {
    const err = new EspressoNotifyHttpError("refused", 404, "user_not_found", "/v1/web-push/preferences");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(EspressoNotifyHttpError);
    expect(err.name).toBe("EspressoNotifyHttpError");
    expect(err.message).toBe("refused");
    expect(err.status).toBe(404);
    expect(err.code).toBe("user_not_found");
    expect(err.path).toBe("/v1/web-push/preferences");
  });

  it("leaves the code empty when the answer had none", () => {
    expect(new EspressoNotifyHttpError("down", 503).code).toBeUndefined();
  });

  it("is exported by the package next to the validators", () => {
    expect(pkg.EspressoNotifyHttpError).toBe(EspressoNotifyHttpError);
    expect(typeof pkg.validatePreferences).toBe("function");
    expect(typeof pkg.isValidEventName).toBe("function");
  });
});

// The web package does not import the React Native one, so the rules exist twice. This test reads the
// constants out of the React Native source and runs one table of inputs through both, so they cannot drift.
describe("parity with the React Native SDK", () => {
  const rn = readFileSync(join(__dirname, "..", "..", "sdk", "src", "index.ts"), "utf-8");
  const constant = (pattern: RegExp): string => {
    const m = pattern.exec(rn);
    if (!m) throw new Error(`not found in the React Native source: ${pattern}`);
    return m[1];
  };
  const maxItems = Number(constant(/const MAX_PREFERENCE_ITEMS = (\d+);/));
  const maxBytes = Number(constant(/const MAX_CATEGORY_IDENTIFIER_BYTES = (\d+);/));
  const nameRegex = new RegExp(constant(/const CUSTOM_EVENT_NAME = \/(.+)\/;/));
  const reserved = new Set([...constant(/const RESERVED_EVENT_NAMES = new Set\(\[(.+?)\]\);/).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));

  const rnEventName = (n: unknown) => typeof n === "string" && nameRegex.test(n) && !reserved.has(n);
  const rnPreferences = (list: unknown): boolean => {
    if (!Array.isArray(list) || list.length === 0 || list.length > maxItems) return false;
    return list.every((p) => {
      const id = typeof p?.categoryIdentifier === "string" ? p.categoryIdentifier : "";
      return id.trim() !== "" && new TextEncoder().encode(id).length <= maxBytes && typeof p.optedOut === "boolean";
    });
  };

  it("reads the same limits", () => {
    expect([maxItems, maxBytes]).toEqual([50, 64]);
    expect([...reserved].sort()).toEqual(["app_opened", "clicked", "converted", "dismissed", "opened", "received"]);
  });

  it("agrees with React Native on every event name of the table", () => {
    const names: unknown[] = ["order.completed", "a", "a".repeat(64), "a".repeat(65), "", "_x", "a b", "opened", "converted", "app_opened", "9", "x:y-z", 5, null, undefined];
    for (const n of names) expect([n, isValidEventName(n as never)]).toEqual([n, rnEventName(n)]);
  });

  it("agrees with React Native on every preference list of the table", () => {
    const ok = pref("promotions", false);
    const lists: unknown[] = [
      [ok],
      [],
      Array.from({ length: 50 }, (_, i) => pref(`c${i}`)),
      Array.from({ length: 51 }, (_, i) => pref(`c${i}`)),
      [pref("")],
      [pref("  ")],
      [pref("é".repeat(32))],
      [pref("é".repeat(33))],
      [pref("a".repeat(64))],
      [pref("a".repeat(65))],
      [pref("x", "yes")],
      [ok, pref("y", 1)],
      undefined,
    ];
    for (const list of lists) {
      let web = true;
      try {
        validatePreferences(list as never);
      } catch {
        web = false;
      }
      expect([JSON.stringify(list)?.slice(0, 40), web]).toEqual([JSON.stringify(list)?.slice(0, 40), rnPreferences(list)]);
    }
  });
});
