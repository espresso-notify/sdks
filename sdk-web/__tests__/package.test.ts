/**
 * @jest-environment node
 *
 * web-push-v1 batch 3, item 10: the package is ready to be published, and stays that way.
 *
 * What is guarded: the manifest metadata, what `npm pack` would put in the tarball (the compiled
 * output, the README and the licence, and nothing else), that Node resolves the package through
 * its `exports`, that the committed `dist` carries the production API URL, and that the README
 * documents every public name. Nothing here publishes: `npm pack --dry-run` writes no file.
 */
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

jest.setTimeout(60_000);

const ROOT = resolve(__dirname, "..");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const manifest = require("../package.json");
const readme = readFileSync(join(ROOT, "README.md"), "utf-8");

/** The files `npm pack` would put in the tarball, by path. */
function packedFiles(): string[] {
  const run = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  if (run.status !== 0) throw new Error(`npm pack failed: ${run.stderr}`);
  const [report] = JSON.parse(run.stdout);
  return report.files.map((f: { path: string }) => f.path).sort();
}

describe("manifest", () => {
  it("names the package and says what it is", () => {
    expect(manifest.name).toBe("@espresso-notify/web");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.description).toMatch(/Web Push/);
    expect(manifest.license).toBe("MIT");
    // The repository, bugs and homepage name the public mirror (D-137); scripts/test_publish_sdk_workflow.py pins the exact name.
    expect(manifest.homepage).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/tree\/main\/sdk-web#readme$/);
    expect(manifest.repository).toEqual(
      expect.objectContaining({ type: "git", url: expect.stringMatching(/^git\+https:\/\/github\.com\/[^/]+\/[^/]+\.git$/), directory: "sdk-web" }),
    );
    expect(manifest.keywords).toEqual(expect.arrayContaining(["web-push", "service-worker", "vapid"]));
  });

  it("publishes a scoped package as public", () => {
    expect(manifest.publishConfig).toEqual({ access: "public" });
  });

  it("points main, types and exports at the compiled output", () => {
    expect(manifest.main).toBe("dist/index.js");
    expect(manifest.types).toBe("dist/index.d.ts");
    expect(manifest.exports["."]).toEqual({ types: "./dist/index.d.ts", default: "./dist/index.js" });
    expect(manifest.exports["./sw.js"]).toBe("./dist/sw.js");
    expect(manifest.exports["./package.json"]).toBe("./package.json");
    for (const target of [manifest.main, manifest.types, "dist/sw.js", "dist/cli.js", manifest.bin["espresso-notify-web"]]) {
      expect(existsSync(join(ROOT, target))).toBe(true);
    }
  });

  it("declares what only the files of the service worker and the installer do on load", () => {
    expect(manifest.sideEffects).toEqual(["./dist/sw.js", "./dist/cli.js"]);
  });

  it("asks for a Node that has the recursive mkdir the installer uses", () => {
    expect(manifest.engines.node).toBe(">=18");
  });

  it("has no runtime dependencies", () => {
    expect(manifest.dependencies).toBeUndefined();
  });
});

describe("files of the manifest", () => {
  it("lists the compiled output and the four documents of the package", () => {
    expect(manifest.files).toEqual(["dist", "README.md", "LICENSE", "SECURITY.md", "CHANGELOG.md"]);
  });
});

describe("CHANGELOG", () => {
  const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf-8");

  it("follows Keep a Changelog and has an Unreleased section that names the version of the manifest", () => {
    expect(changelog).toMatch(/^# Changelog$/m);
    expect(changelog).toContain("https://keepachangelog.com");
    expect(changelog).toMatch(/^## Unreleased$/m);
    const unreleased = changelog.slice(changelog.search(/^## Unreleased$/m));
    expect(unreleased.split("\n").slice(0, 6).join("\n")).toContain(`\`${manifest.version}\``);
    expect(unreleased).toMatch(/^### Added$/m);
  });

  it("keeps the package at the version the changelog and the README of the SDK agree on", () => {
    expect(manifest.version).toBe("0.1.0");
  });

  it("has a line for every public method of the client and for the other public names", () => {
    const source = readFileSync(join(ROOT, "src", "index.ts"), "utf-8");
    const klass = source.slice(source.indexOf("export class WebPushClient"));
    const methods = [...klass.matchAll(/^  (?:async )?([a-z][A-Za-z]+)\(/gm)].map((m) => m[1]).filter((n) => n !== "constructor");
    expect(methods.length).toBeGreaterThanOrEqual(10);
    for (const name of methods) expect(changelog).toContain(`\`${name}(`);
    for (const name of ["EspressoNotifyHttpError", "EspressoNotifyError", "validatePreferences", "isValidEventName", "SubscribeError", "appVersion"]) {
      expect(changelog).toContain(`\`${name}`);
    }
  });

  it("lists what the web SDK does about retries, the session and the consent, and no secret key", () => {
    expect(changelog).toMatch(/Retry-After/);
    expect(changelog).toMatch(/new session/i);
    expect(changelog).toMatch(/consent/);
    expect(changelog).not.toMatch(/sk_(live|test)_/);
  });
});

describe("tarball (npm pack --dry-run)", () => {
  it("holds the compiled output, the README, the licence, the security note and the changelog, and nothing else", () => {
    expect(packedFiles()).toEqual([
      "CHANGELOG.md",
      "LICENSE",
      "README.md",
      "SECURITY.md",
      "dist/cli.d.ts",
      "dist/cli.js",
      "dist/errors.d.ts",
      "dist/errors.js",
      "dist/index.d.ts",
      "dist/index.js",
      "dist/privacy.d.ts",
      "dist/privacy.js",
      "dist/registration.d.ts",
      "dist/registration.js",
      "dist/retry.d.ts",
      "dist/retry.js",
      "dist/support.d.ts",
      "dist/support.js",
      "dist/sw.js",
      "dist/swDefaults.d.ts",
      "dist/swDefaults.js",
      "package.json",
    ]);
  });

  it("leaves out sources, tests, build scripts, lock file and any tarball", () => {
    const files = packedFiles();
    const leaked = files.filter((f) => /^(src|__tests__|node_modules)\//.test(f) || /(^|\/)(tsconfig.*|inject-url\.mjs|package-lock\.json|\.npmrc|\.env.*)$/.test(f) || f.endsWith(".tgz") || f.endsWith(".map"));
    expect(leaked).toEqual([]);
  });

  it("ships a CLI that starts with its shebang", () => {
    expect(readFileSync(join(ROOT, "dist", "cli.js"), "utf-8").startsWith("#!/usr/bin/env node")).toBe(true);
  });
});

describe("committed dist", () => {
  it("carries the production API URL and no placeholder or development address", () => {
    for (const file of ["index.js", "sw.js"]) {
      const text = readFileSync(join(ROOT, "dist", file), "utf-8");
      expect(text).toContain('"https://api.espressonotify.com"');
      expect(text).not.toMatch(/__ESPRESSO_API_URL__"\s*;|localhost|127\.0\.0\.1|10\.0\.2\.2/);
    }
  });
});

describe("resolution from an app", () => {
  let app: string;

  beforeAll(() => {
    app = mkdtempSync(join(tmpdir(), "espresso-web-exports-"));
    mkdirSync(join(app, "node_modules", "@espresso-notify"), { recursive: true });
    symlinkSync(ROOT, join(app, "node_modules", "@espresso-notify", "web"), "dir");
  });

  afterAll(() => rmSync(app, { recursive: true, force: true }));

  const resolveFromApp = (spec: string) => realpathSync(require.resolve(spec, { paths: [app] }));

  it("resolves the root entry, the worker and package.json through exports", () => {
    expect(resolveFromApp("@espresso-notify/web")).toBe(join(ROOT, "dist", "index.js"));
    expect(resolveFromApp("@espresso-notify/web/sw.js")).toBe(join(ROOT, "dist", "sw.js"));
    expect(resolveFromApp("@espresso-notify/web/package.json")).toBe(join(ROOT, "package.json"));
  });

  it("refuses a path the package does not export", () => {
    expect(() => resolveFromApp("@espresso-notify/web/dist/cli.js")).toThrow();
  });
});

describe("README", () => {
  const headings = [
    "Install",
    "Quick start",
    "Service worker",
    "Permission UX",
    "Identify the user",
    "Privacy: consent, preferences and erasure",
    "API reference",
    "Browser support",
    "Safari and iOS",
    "Limitations",
    "Troubleshooting",
  ];

  it.each(headings)("has the %s section", (heading) => {
    expect(readme).toMatch(new RegExp(`^## ${heading}$`, "m"));
  });

  it("installs the published name", () => {
    expect(readme).toContain("npm install @espresso-notify/web");
    expect(readme).toContain("npx @espresso-notify/web");
  });

  it("names the Home Screen requirement of Safari on iOS", () => {
    expect(readme).toMatch(/Add to Home Screen/);
    expect(readme).toContain("ios_requires_installed_app");
  });

  it("documents every public method of the client and every exported function", () => {
    const source = readFileSync(join(ROOT, "src", "index.ts"), "utf-8");
    const klass = source.slice(source.indexOf("export class WebPushClient"));
    const methods = [...klass.matchAll(/^  (?:async )?([a-z][A-Za-z]+)\(/gm)].map((m) => m[1]).filter((n) => n !== "constructor");
    expect(methods.length).toBeGreaterThanOrEqual(10);
    for (const name of methods) expect(readme).toContain(`\`${name}(`);
    for (const name of ["isSupported", "getSupport", "getPermissionState", "requestPermission", "SubscribeError"]) {
      expect(readme).toContain(name);
    }
  });

  it("documents every name the package exports besides the client", () => {
    const source = readFileSync(join(ROOT, "src", "index.ts"), "utf-8");
    const exported = [...source.matchAll(/^export (?:type )?\{([^}]+)\}/gm)].flatMap((m) => m[1].split(",").map((n) => n.trim()).filter(Boolean));
    expect(exported).toEqual(expect.arrayContaining(["EspressoNotifyHttpError", "EspressoNotifyError", "validatePreferences", "isValidEventName", "ConsentInfo", "NotificationPreference"]));
    for (const name of exported) expect(readme).toContain(name);
  });

  it("tells what erasure, preferences and consent do in a section of their own, and no longer lists them as missing", () => {
    const section = readme.slice(readme.search(/^## Privacy: consent, preferences and erasure$/m), readme.search(/^## API reference$/m));
    expect(section.length).toBeGreaterThan(500);
    for (const word of ["forgetDevice(", "getPreferences(", "setPreferences(", "consent", "identityHash", "no_subscription", "user_not_found", "cannot be undone"]) {
      expect(section).toContain(word);
    }
    const limitations = readme.slice(readme.search(/^## Limitations$/m), readme.search(/^## Troubleshooting$/m));
    expect(limitations).not.toMatch(/no consent record|no erasure|no call to erase|cannot erase/i);
  });

  it("does not promise a journey to a person who has only a browser", () => {
    const events = readme.slice(readme.indexOf("`trackEvent(name)`"));
    expect(events.split("\n")[0]).toMatch(/mobile device/);
    expect(readme).toMatch(/only a browser[^.]*(coming soon|not yet|does not)/i);
    expect(readme).not.toMatch(/journeys? (start|run|react)s? for (every|any) (visitor|browser)/i);
  });

  it("documents every unsupported reason and every subscribe failure reason", () => {
    const support = readFileSync(join(ROOT, "src", "support.ts"), "utf-8");
    const reasons = [...support.matchAll(/\| "([a-z_]+)"/g)].map((m) => m[1]);
    expect(reasons).toEqual(expect.arrayContaining(["no_service_worker", "ios_requires_installed_app", "permission_denied", "vapid_key_missing"]));
    for (const reason of new Set(reasons)) expect(readme).toContain(reason);
  });

  it("documents the default service worker location the code uses", () => {
    const defaults = readFileSync(join(ROOT, "src", "swDefaults.ts"), "utf-8");
    const scope = /SW_SCOPE = "([^"]+)"/.exec(defaults)![1];
    const file = /SW_FILENAME = "([^"]+)"/.exec(defaults)![1];
    expect(readme).toContain(`${scope}${file}`);
  });

  it("puts no secret key and no real project key in an example", () => {
    expect(readme).not.toMatch(/sk_(live|test)_/);
    expect(readme).not.toMatch(/pk_(live|test)_(?!x+\b)[A-Za-z0-9]{16,}/);
  });
});

describe("SECURITY.md", () => {
  const security = readFileSync(join(ROOT, "SECURITY.md"), "utf-8");

  it("names the routes a browser calls with the public key and the endpoint as the proof of the browser", () => {
    for (const route of ["/v1/web-push/subscribe", "/v1/web-push/device", "/v1/web-push/preferences", "/v1/web-push/preferences/query", "/v1/web-push/event", "/v1/notifications/track-web"]) {
      expect(security).toContain(route);
    }
    expect(security).toMatch(/endpoint[^.]*(secret|capabilit)/i);
    expect(security).toMatch(/never in a URL|not in a URL|in the body/i);
  });

  it("says the erasure needs the proof of the identity when the project requires it, and that nothing is signed", () => {
    expect(security).toContain("identityHash");
    expect(security).toMatch(/`required`/);
    expect(security).toMatch(/403/);
    expect(security).toMatch(/does not sign/i);
  });
});
