/**
 * @jest-environment node
 *
 * web-push-v1 batch 3, item 11: the web example app takes its project key and API URL from the
 * environment and commits no real key.
 */
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

const REPO = resolve(__dirname, "..", "..");
const EXAMPLE = join(REPO, "examples", "web-push-test");
const read = (file: string) => readFileSync(join(EXAMPLE, file), "utf-8");

/** The files of the example that git tracks or would track (not ignored), relative to the example. */
function versionedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "."], {
    cwd: EXAMPLE,
    encoding: "utf-8",
  });
  return out.split("\n").filter((f) => f && existsSync(join(EXAMPLE, f)));
}

// The example app lives in the private monorepo only: the public SDK mirror (D-137) receives sdk/ and sdk-web/, so there this
// suite has nothing to read. scripts/test_publish_sdk_workflow.py fails if the example is missing from the monorepo, so the
// suite cannot go quiet where it matters.
const describeIfExample = existsSync(EXAMPLE) ? describe : describe.skip;

describeIfExample("examples/web-push-test", () => {
  it("is a Vite app that builds with npm run build", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.private).toBe(true);
    expect(pkg.scripts.build).toContain("vite build");
    expect(pkg.scripts.prebuild).toBe("npm run prepare:sdk");
    expect(pkg.devDependencies.vite).toBeDefined();
    expect(existsSync(join(EXAMPLE, "index.html"))).toBe(true);
  });

  it("uses the SDK, asks for the permission from a click and shows what it receives", () => {
    const main = read("src/main.ts");
    expect(main).toContain('from "@espresso-notify/web"');
    expect(main).toMatch(/addEventListener\("click"[\s\S]*trySubscribe\(\)/);
    expect(main).toContain(".identify(");
    expect(main).toContain(".onPush(");
    // The permission is never asked on load: requestPermission and trySubscribe sit inside handlers.
    expect(main.split("\n").filter((l) => /^\s{0,2}(await\s+)?push\.(trySubscribe|requestPermission|subscribe)\(/.test(l))).toEqual([]);
  });

  it("takes the project key and the API URL from the environment", () => {
    expect(read("src/main.ts")).toContain("import.meta.env.VITE_ESPRESSO_PROJECT_ID");
    expect(read("scripts/prepare-sdk.mjs")).toContain("VITE_ESPRESSO_API_URL");
    const example = read(".env.example");
    expect(example).toMatch(/^VITE_ESPRESSO_PROJECT_ID=pk_live_x+$/m);
    expect(example).toMatch(/^VITE_ESPRESSO_API_URL=https:\/\/api\.espressonotify\.com$/m);
  });

  it("commits no real key, no secret key and no development URL", () => {
    const files = versionedFiles();
    expect(files).toEqual(expect.arrayContaining(["package.json", ".env.example", "src/main.ts", "README.md"]));
    for (const file of files) {
      const text = readFileSync(join(EXAMPLE, file), "utf-8");
      expect({ file, secret: /sk_(live|test)_/.test(text) }).toEqual({ file, secret: false });
      expect({ file, realKey: /pk_(live|test)_(?!x+\b)[A-Za-z0-9]{16,}/.test(text) }).toEqual({ file, realKey: false });
    }
  });

  it("keeps .env, the built SDK and the installed worker out of git", () => {
    const files = versionedFiles();
    expect(files).not.toContain(".env");
    expect(files.filter((f) => f.startsWith(".sdk-build") || f.startsWith("public/push") || f.startsWith("dist/") || f.startsWith("node_modules/"))).toEqual([]);
    const ignore = read(".gitignore");
    for (const entry of [".env", ".sdk-build", "public/push", "node_modules", "dist"]) expect(ignore).toContain(entry);
  });
});
