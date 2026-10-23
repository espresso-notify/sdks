/**
 * The random bytes behind the device id and the nonce of a signed request (sdk-secure-device-id).
 *
 * Hermes has no `crypto.getRandomValues`, so the SDK takes the bytes from the first source the app has, in this order:
 *   1. `crypto.getRandomValues`, when the app (or a polyfill such as `react-native-get-random-values`) defines it;
 *   2. the `randomBytes` of the SDK's own native module (`SecureRandom` on Android, `SecRandomCopyBytes` on iOS);
 *   3. `expo-crypto`;
 *   4. `Math.random`, with one warning per app run (reduced entropy), only when none of the above exists.
 *
 * A source that throws, rejects or answers the wrong size hands over to the next one, so a wrong answer never becomes an
 * id. Nothing here logs a value: the one warning has a fixed text.
 *
 * This file imports nothing from `index.ts`; `index.ts` imports it.
 */
import { resolveNativeModule } from './transport';
import type { NativeTransportModule } from './transport';

/**
 * `expo-crypto`, looked up once when the package loads, inside a `try` and at the top level: Metro gives a `require` of
 * an uninstalled optional peer a module id with no module behind it, and only a `require` that runs while the bundle
 * loads (inside a `try`) lets the SDK see the error. `optional-peers-load.test.ts` holds that rule.
 */
let OptExpoCrypto: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  OptExpoCrypto = require('expo-crypto');
} catch { /* not installed */ }

/** The native module as this file uses it: `randomBytes` is missing from a build made before it was added. */
type ModuleWithRandomBytes = NativeTransportModule & { randomBytes?: (count: number) => Promise<string> };

/** Lowercase hex digits, two per byte. */
const bytesToHex = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
};

/**
 * `hex` as bytes, or null unless it is exactly `byteLen` bytes of lowercase hex.
 * @internal
 */
export function hexToBytes(hex: unknown, byteLen: number): Uint8Array | null {
  if (typeof hex !== 'string' || hex.length !== byteLen * 2 || !/^[0-9a-f]+$/.test(hex)) return null;
  const bytes = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * `byteLen` bytes from a secure source, or null when there is none. Never throws.
 * @internal
 */
export async function secureRandomBytes(byteLen: number): Promise<Uint8Array | null> {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(byteLen);
      crypto.getRandomValues(bytes);
      return bytes;
    }
  } catch { /* the next source */ }
  try {
    const native = resolveNativeModule() as ModuleWithRandomBytes | null;
    if (native && typeof native.randomBytes === 'function') {
      const bytes = hexToBytes(await native.randomBytes(byteLen), byteLen);
      if (bytes) return bytes;
    }
  } catch { /* the next source */ }
  try {
    const expoCrypto = OptExpoCrypto;
    const raw =
      typeof expoCrypto?.getRandomBytesAsync === 'function' ? await expoCrypto.getRandomBytesAsync(byteLen)
      : typeof expoCrypto?.getRandomBytes === 'function' ? expoCrypto.getRandomBytes(byteLen)
      : null;
    if (raw && raw.length === byteLen) {
      const bytes = Uint8Array.from(raw as ArrayLike<number>);
      if (bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return bytes;
    }
  } catch { /* no secure source */ }
  return null;
}

/** True once the `Math.random` warning has shown in this app run. */
let weakRandomWarned = false;

/**
 * A random hex string of `byteLen` bytes, from a secure source when the app has one, else from `Math.random` with one
 * warning per app run (none under test).
 * @internal
 */
export async function randomHex(byteLen: number): Promise<string> {
  const secure = await secureRandomBytes(byteLen);
  if (secure) return bytesToHex(secure);
  if (!weakRandomWarned && process.env.NODE_ENV !== 'test') {
    weakRandomWarned = true;
    console.warn(
      '[espresso-notify] crypto.getRandomValues is not available and no secure random source was found ' +
      '(the native module, expo-crypto); device ID generated with Math.random (reduced entropy).',
    );
  }
  const bytes = new Uint8Array(byteLen);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytesToHex(bytes);
}
