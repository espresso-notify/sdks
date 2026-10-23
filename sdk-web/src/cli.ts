#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { SW_FILENAME, SW_PATH, SW_SCOPE } from "./swDefaults";

const TARGETS = ["public", "static", "www", "."];

export function findPublicDir(): string {
  for (const dir of TARGETS) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      return dir;
    }
  }
  return "public";
}

/**
 * Where the worker has to land inside the directory the site serves.
 *
 * The scope is a URL path, so it is split on `/` and rejoined with the
 * platform separator rather than concatenated.
 */
export function destinationFor(servedDir: string): string {
  const scopeSegments = SW_SCOPE.split("/").filter(Boolean);
  return path.join(servedDir, ...scopeSegments, SW_FILENAME);
}

/** The URL a copied file answers to, once `servedDir` is served at the root. */
export function servedUrlFor(servedDir: string, destination: string): string {
  return "/" + path.relative(servedDir, destination).split(path.sep).join("/");
}

export function install(servedDir: string): string {
  const destination = destinationFor(servedDir);

  const built = path.join(__dirname, "sw.js");
  const source = fs.existsSync(built) ? built : path.join(__dirname, "..", "src", "sw.ts");

  // The nested directory does not exist in a fresh project; without this the
  // copy fails with ENOENT and nothing is installed.
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return destination;
}

if (require.main === module) {
  const servedDir = process.argv[2] ?? findPublicDir();
  const destination = install(servedDir);
  console.log(`espresso-notify-sw.js copied to ${destination}`);
  console.log(`Serve ${servedDir} at the root of your domain so the worker answers at ${SW_PATH}.`);
}
