// Builds @espresso-notify/web from ../../sdk-web with the API URL of this example, places it in
// node_modules like an installed package, and installs the service worker with the package's own
// command. The committed sdk-web/dist is never touched: it carries the production URL.
//
// In your own app none of this is needed: `npm install @espresso-notify/web` and
// `npx @espresso-notify/web public`.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const sdkSource = path.join(root, "..", "..", "sdk-web");
const build = path.join(root, ".sdk-build");
const installed = path.join(root, "node_modules", "@espresso-notify", "web");
const PRODUCTION_API = "https://api.espressonotify.com";

const env = loadEnv(process.env.NODE_ENV === "production" ? "production" : "development", root, "VITE_");
const apiUrl = (env.VITE_ESPRESSO_API_URL || PRODUCTION_API).replace(/\/+$/, "");

let parsed;
try {
  parsed = new URL(apiUrl);
} catch {
  fail(`VITE_ESPRESSO_API_URL is not a URL: ${apiUrl}`);
}
const local = ["localhost", "127.0.0.1"].includes(parsed.hostname);
if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
  fail(`VITE_ESPRESSO_API_URL must be https (http only for localhost): ${apiUrl}`);
}

function fail(message) {
  console.error(`[prepare-sdk] ${message}`);
  process.exit(1);
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, { stdio: "inherit", cwd: build, ...options });
  if (result.status !== 0) fail(`${path.basename(args[0] ?? file)} failed`);
}

if (!existsSync(path.join(sdkSource, "src", "index.ts"))) fail(`the SDK source is not at ${sdkSource}`);
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
if (!existsSync(tsc)) fail("run `npm install` in this folder first");

rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });
for (const entry of ["src", "tsconfig.json", "tsconfig.sw.json", "inject-url.mjs", "package.json", "LICENSE", "README.md"]) {
  cpSync(path.join(sdkSource, entry), path.join(build, entry), { recursive: true });
}

console.info(`[prepare-sdk] building @espresso-notify/web for ${apiUrl}`);
run(process.execPath, [tsc, "-p", "tsconfig.json"]);
run(process.execPath, [tsc, "-p", "tsconfig.sw.json"]);
run(process.execPath, ["inject-url.mjs"], { env: { ...process.env, ESPRESSO_API_URL: apiUrl } });

rmSync(installed, { recursive: true, force: true });
mkdirSync(installed, { recursive: true });
cpSync(path.join(build, "dist"), path.join(installed, "dist"), { recursive: true });
cpSync(path.join(build, "package.json"), path.join(installed, "package.json"));

// Same command as the quick start: it writes public/push/espressonotify/espresso-notify-sw.js.
run(process.execPath, [path.join(installed, "dist", "cli.js"), "public"], { cwd: root });
