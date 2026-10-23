#!/usr/bin/env node
export declare function findPublicDir(): string;
/**
 * Where the worker has to land inside the directory the site serves.
 *
 * The scope is a URL path, so it is split on `/` and rejoined with the
 * platform separator rather than concatenated.
 */
export declare function destinationFor(servedDir: string): string;
/** The URL a copied file answers to, once `servedDir` is served at the root. */
export declare function servedUrlFor(servedDir: string, destination: string): string;
export declare function install(servedDir: string): string;
