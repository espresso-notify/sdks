/**
 * `hex` as bytes, or null unless it is exactly `byteLen` bytes of lowercase hex.
 * @internal
 */
export declare function hexToBytes(hex: unknown, byteLen: number): Uint8Array | null;
/**
 * `byteLen` bytes from a secure source, or null when there is none. Never throws.
 * @internal
 */
export declare function secureRandomBytes(byteLen: number): Promise<Uint8Array | null>;
/**
 * A random hex string of `byteLen` bytes, from a secure source when the app has one, else from `Math.random` with one
 * warning per app run (none under test).
 * @internal
 */
export declare function randomHex(byteLen: number): Promise<string>;
