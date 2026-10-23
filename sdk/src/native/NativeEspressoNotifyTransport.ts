/**
 * The codegen spec of the native transport (sdk-private-transport, design "JS to native contract").
 *
 * React Native's codegen reads this file (`codegenConfig.jsSrcsDir` of `package.json`) and generates the native
 * interface that the Android and iOS modules implement. Keep to what the codegen parses: object types declared in this
 * file, `ReadonlyArray` of an object type, `string | null`, `Promise` of an object, a boolean or void, and no `any`.
 *
 * The module has four methods and no logic of its own: it sends one request and answers with the status, the status
 * text, the first `Retry-After` value and the body, or it rejects with one of nine closed codes (`timeout`,
 * `no_connection`, `dns`, `tls`, `pin_mismatch`, `cancelled`, `response_too_large`, `invalid_request`, `unknown`).
 * It also holds the certificate pins of the native path. Signing, queue, retry and batching stay in JavaScript.
 *
 * The SDK imports this file only inside the `try` of its module resolver, never at load time, so an app without the
 * native module (Expo Go, the web, tests) is not affected.
 */
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type PinEntry = {
  /** Host name the pins apply to. */
  host: string;
  /** True to apply the pins to every subdomain of the host as well. */
  includeSubdomains: boolean;
  /** Base64 SHA-256 of the SubjectPublicKeyInfo; a leading `sha256/` is tolerated. */
  pins: string[];
};

export type NativeResponse = {
  status: number;
  statusText: string;
  /** The raw first `Retry-After` header value, or an empty string. */
  retryAfter: string;
  /** The body as UTF-8 text, at most 4,194,304 bytes. */
  body: string;
};

export type NativeConstants = {
  /** The version of this contract. The SDK uses the module only for a version it lists as supported. */
  contractVersion: number;
};

export interface Spec extends TurboModule {
  getConstants(): NativeConstants;
  /**
   * Sends one request. `headers` is a flat list: name, value, name, value, and so on; `body` is null when there is none;
   * the call ends with `timeout` after `timeoutMs`.
   */
  request(
    method: string,
    url: string,
    headers: string[],
    body: string | null,
    timeoutMs: number,
  ): Promise<NativeResponse>;
  /** Replaces the whole pin set. Resolves false and applies nothing when any entry is invalid. */
  setPins(entries: ReadonlyArray<PinEntry>): Promise<boolean>;
  /** Removes every pin. */
  clearPins(): Promise<void>;
  /**
   * `count` bytes (1 to 256) from the platform generator (`SecureRandom`, `SecRandomCopyBytes`) as `2 x count` lowercase hex
   * characters, or a rejection with `invalid_request`. Hermes has no `crypto.getRandomValues`, so the SDK takes the bytes of
   * the device id and of the nonce of a signed request from here. A module of an older build may not have it.
   */
  randomBytes(count: number): Promise<string>;
}

export default TurboModuleRegistry.get<Spec>('EspressoNotifyTransport');
