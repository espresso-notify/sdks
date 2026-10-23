/**
 * The helpers that both transports of the SDK share, so a request built through `fetch` and one sent through the
 * native module end in the same results and the same errors (sdk-private-transport, SPT-11 to SPT-14, SPT-51).
 *
 * This file imports nothing from `index.ts`: the transports sit above it, the helpers below.
 */
import { EspressoNotifyHttpError } from './errors';
import type { Transport } from './index';

/**
 * The request path up to the first `?` or `#`: an identifier that a caller or a proxy put in a query string
 * never reaches an error message or the `path` of an error.
 * @internal
 */
export function redactPath(path: string): string {
  const end = path.search(/[?#]/);
  return end === -1 ? path : path.slice(0, end);
}

/**
 * The seconds a `Retry-After` header asks to wait, as whole seconds: a number of seconds, or an HTTP date turned into
 * the seconds until it. Undefined when the answer has no header or a value that is neither. Never throws.
 * @internal
 */
export function parseRetryAfter(raw: string | null | undefined): number | undefined {
  try {
    if (typeof raw !== 'string') return undefined;
    const value = raw.trim();
    if (/^\d{1,9}$/.test(value)) return Number(value);
    if (/[A-Za-z]/.test(value)) {
      const when = Date.parse(value);
      if (Number.isFinite(when)) return Math.max(0, Math.ceil((when - Date.now()) / 1000));
    }
  } catch { /* an unusable header is no header */ }
  return undefined;
}

/**
 * The `code` (else the `error`) of a JSON error body, or undefined when the body is empty, is not JSON or has neither.
 * Never throws.
 */
function readErrorCode(bodyText: string): string | undefined {
  try {
    const body = JSON.parse(bodyText);
    const code = body?.code ?? body?.error;
    return typeof code === 'string' && code ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The error of an answer with a status outside 2xx: the message names the status and the path without its query
 * string, `code` is the `code` (else the `error`) of the JSON body, `retryAfter` the seconds of the `Retry-After`
 * header. The message never carries the body.
 * @internal
 */
export function buildHttpError(
  status: number,
  statusText: string,
  path: string,
  bodyText: string,
  retryAfterHeader: string | null | undefined,
): EspressoNotifyHttpError {
  const shown = redactPath(path);
  return new EspressoNotifyHttpError(
    `[espresso-notify] HTTP ${status}: ${statusText || 'request failed'} — ${shown}`,
    status,
    readErrorCode(bodyText),
    shown,
    parseRetryAfter(retryAfterHeader),
  );
}

/**
 * The parsed body of a 2xx answer: `{}` when it is empty. A body that is not JSON throws an `Error` that says so and
 * does not repeat the body.
 * @internal
 */
export function parseJsonBody(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('[espresso-notify] invalid JSON in the response');
  }
}

// ─── The native transport ─────────────────────────────────────────────────────

/** The closed list of failures the native module may report. Anything else is reported as `unknown`. */
const NATIVE_ERROR_CODES = [
  'timeout', 'no_connection', 'dns', 'tls', 'pin_mismatch', 'cancelled', 'response_too_large', 'invalid_request', 'unknown',
] as const;
export type NativeErrorCode = typeof NATIVE_ERROR_CODES[number];

/** The versions of the JavaScript to native contract this SDK speaks. A module of another version counts as absent. */
export const SUPPORTED_CONTRACTS: number[] = [1];

/** The time the native module gives one request, from the start of the call to the last byte of the answer. */
export const NATIVE_TIMEOUT_MS = 30000;

/** The name the native module registers under. */
const NATIVE_MODULE_NAME = 'EspressoNotifyTransport';

/** One host of the pin set the native module holds. */
export interface NativePinEntry {
  host: string;
  includeSubdomains: boolean;
  pins: string[];
}

/** The module as the SDK uses it; it matches the codegen spec in `native/NativeEspressoNotifyTransport.ts`. */
export interface NativeTransportModule {
  getConstants(): { contractVersion: number };
  request(
    method: string,
    url: string,
    headers: string[],
    body: string | null,
    timeoutMs: number,
  ): Promise<{ status: number; statusText: string; retryAfter: string; body: string }>;
  setPins(entries: NativePinEntry[]): Promise<boolean>;
  clearPins(): Promise<void>;
}

/** Why the native module is not usable: it is not linked (or broken), or it speaks a contract version this SDK does not list. */
export type NativeUnusable = 'not_linked' | 'version';

/**
 * Looks for the native module and says why it cannot be used when it cannot. `react-native` is loaded here and nowhere
 * at import time. Never throws.
 * @internal
 */
export function inspectNativeModule(): { module: NativeTransportModule | null; reason: NativeUnusable | null } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rn = require('react-native');
    // On the New Architecture the registry finds it; on the old one it falls back to NativeModules.
    const found = rn?.TurboModuleRegistry?.get?.(NATIVE_MODULE_NAME) ?? rn?.NativeModules?.[NATIVE_MODULE_NAME] ?? null;
    if (!found || typeof found.getConstants !== 'function' || typeof found.request !== 'function') {
      return { module: null, reason: 'not_linked' };
    }
    const version = found.getConstants()?.contractVersion;
    return typeof version === 'number' && SUPPORTED_CONTRACTS.includes(version)
      ? { module: found as NativeTransportModule, reason: null }
      : { module: null, reason: 'version' };
  } catch {
    return { module: null, reason: 'not_linked' };
  }
}

/**
 * The native module, or null when it is not linked, is of a contract version this SDK does not list, or `react-native`
 * cannot be loaded (Expo Go, the web, tests). Never throws.
 * @internal
 */
export function resolveNativeModule(): NativeTransportModule | null {
  return inspectNativeModule().module;
}

/** The code a rejection of the module carries, if it is one of the nine; `unknown` for anything else. */
function nativeErrorCode(rejection: unknown): NativeErrorCode {
  let code: unknown;
  try {
    code = rejection !== null && typeof rejection === 'object' && Object.prototype.hasOwnProperty.call(rejection, 'code')
      ? (rejection as { code?: unknown }).code
      : undefined;
  } catch {
    code = undefined;
  }
  return typeof code === 'string' && (NATIVE_ERROR_CODES as readonly string[]).includes(code) ? (code as NativeErrorCode) : 'unknown';
}

/**
 * The flat list `name, value, name, value` the module takes: `Authorization` and `Content-Type` first, then the headers
 * of the caller (a plain object only; a `Headers` instance or an array counts as none). A name that repeats, in any case,
 * is sent once, with the value of the last one.
 */
function flattenHeaders(projectId: string, extra: unknown): string[] {
  const merged = new Map<string, [string, string]>();
  const add = (name: string, value: string) => merged.set(name.toLowerCase(), [name, value]);
  add('Authorization', `Bearer ${projectId}`);
  add('Content-Type', 'application/json');
  const plain =
    extra !== null && typeof extra === 'object' && !Array.isArray(extra) && Object.getPrototypeOf(extra) === Object.prototype;
  if (plain) {
    for (const [name, value] of Object.entries(extra as Record<string, unknown>)) {
      if (value === undefined || value === null) continue;
      add(name, String(value));
    }
  }
  const out: string[] = [];
  for (const [name, value] of merged.values()) out.push(name, value);
  return out;
}

/**
 * NativeTransport: sends the request through the native module and gives back what `FetchTransport` gives, so the
 * offline queue, the retry of the hooks and the signer see no difference. Retry, signing and batching stay above it.
 * A failure with no HTTP answer is a plain `Error` that carries only one of the nine codes of the module.
 * @internal
 */
export class NativeTransport implements Transport {
  constructor(
    private readonly baseURL: string,
    private readonly projectId: string,
    private readonly native: NativeTransportModule,
  ) {}

  async request(path: string, options: RequestInit = {}): Promise<unknown> {
    const url = `${this.baseURL}${path}`;
    if (!/^https?:\/\//i.test(url)) throw new TypeError('[espresso-notify] unsupported URL scheme');
    const body = options.body;
    if (body !== undefined && typeof body !== 'string') throw new TypeError('[espresso-notify] request body must be a string');
    const method = (options.method ?? 'GET').toUpperCase();
    const headers = flattenHeaders(this.projectId, options.headers);

    let answer: unknown;
    try {
      answer = await this.native.request(method, url, headers, body ?? null, NATIVE_TIMEOUT_MS);
    } catch (rejection) {
      throw new Error(`[espresso-notify] network request failed (${nativeErrorCode(rejection)})`);
    }

    const response = answer as { status?: unknown; statusText?: unknown; retryAfter?: unknown; body?: unknown } | null;
    if (response === null || typeof response !== 'object' || typeof response.status !== 'number') {
      throw new Error('[espresso-notify] network request failed (unknown)');
    }
    const text = typeof response.body === 'string' ? response.body : '';
    if (response.status < 200 || response.status >= 300) {
      throw buildHttpError(
        response.status,
        typeof response.statusText === 'string' ? response.statusText : '',
        path,
        text,
        typeof response.retryAfter === 'string' ? response.retryAfter : undefined,
      );
    }
    return parseJsonBody(text);
  }
}
