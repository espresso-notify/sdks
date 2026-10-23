import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { destinationFor, install, servedUrlFor } from "../src/cli";
import { SW_FILENAME, SW_PATH, SW_SCOPE } from "../src/swDefaults";

/**
 * The installer and the client have to agree on one location.
 *
 * They did not: the CLI copied the worker to the root of `public/` while the
 * client registered `/push/espressonotify/espresso-notify-sw.js`. Following
 * both documented defaults produced a 404, so web push never armed and the
 * failure surfaced as a registration error with no hint of the cause.
 */
describe("service worker installer", () => {
  it("puts the worker exactly where the client will ask for it", () => {
    const dest = destinationFor("public");

    // This is the assertion that was false: the served URL of the copied file
    // has to be the path the client registers, character for character.
    expect(servedUrlFor("public", dest)).toBe(SW_PATH);
  });

  it("keeps the worker inside the scope it claims", () => {
    // A worker may only claim a scope at or below the directory it is served
    // from, so the file has to live inside the scope directory. Copying it to
    // the domain root and asking for a nested scope is rejected by the browser.
    expect(SW_PATH.startsWith(SW_SCOPE)).toBe(true);
    expect(SW_PATH).toBe(SW_SCOPE + SW_FILENAME);
  });

  it("creates the nested directory that does not exist yet", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "espresso-sw-"));
    const served = path.join(root, "public");
    fs.mkdirSync(served);

    const dest = install(served);

    // `public/push/espressonotify/` is absent in a fresh project; a copy that
    // does not create it fails with ENOENT instead of installing anything.
    expect(fs.existsSync(dest)).toBe(true);
    expect(servedUrlFor(served, dest)).toBe(SW_PATH);
    expect(fs.readFileSync(dest, "utf-8").length).toBeGreaterThan(0);
  });

  it("honours an explicitly served directory instead of guessing", () => {
    expect(servedUrlFor("static", destinationFor("static"))).toBe(SW_PATH);
    expect(servedUrlFor(".", destinationFor("."))).toBe(SW_PATH);
  });
});
