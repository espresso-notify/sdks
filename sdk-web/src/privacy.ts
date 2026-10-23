/**
 * The checks a call makes before it reaches the network: category preferences and the names of business events.
 * They are the rules of the React Native SDK, written again here because this package does not depend on that one;
 * `__tests__/privacy.test.ts` reads the constants of that SDK and fails when the two drift apart.
 */

/** One category a person chose to receive (`optedOut: false`) or to leave (`optedOut: true`). */
export interface NotificationPreference {
  categoryIdentifier: string;
  optedOut: boolean;
}

/** What the site records about the accept of the visitor: the version of the text they saw and where they accepted it. */
export interface ConsentInfo {
  /** Up to 64 characters, for example `terms-2026-10`. */
  version?: string;
  /** Up to 32 characters, for example `banner` or `settings-page`. */
  source?: string;
}

/** The limits of POST /v1/web-push/preferences: items per call and bytes of a category identifier. */
const MAX_PREFERENCE_ITEMS = 50;
const MAX_CATEGORY_IDENTIFIER_BYTES = 64;
/** The shape of a business event name the API accepts. */
const CUSTOM_EVENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
/** The names of the delivery lifecycle: they need a notification and are not business events. */
const RESERVED_EVENT_NAMES = new Set(["opened", "clicked", "received", "dismissed", "converted", "app_opened"]);

function utf8Length(text: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  return unescape(encodeURIComponent(text)).length;
}

/**
 * Throws, before any call, when a list of preferences would be refused: it must have 1 to 50 items, each with a
 * `categoryIdentifier` of 1 to 64 bytes (not only spaces) and a boolean `optedOut`.
 */
export function validatePreferences(preferences: NotificationPreference[]): void {
  if (!Array.isArray(preferences) || preferences.length === 0 || preferences.length > MAX_PREFERENCE_ITEMS) {
    throw new Error(`Validation error: 'preferences' must have 1 to ${MAX_PREFERENCE_ITEMS} items.`);
  }
  for (const p of preferences) {
    const identifier = typeof p?.categoryIdentifier === "string" ? p.categoryIdentifier : "";
    if (identifier.trim() === "" || utf8Length(identifier) > MAX_CATEGORY_IDENTIFIER_BYTES || typeof p.optedOut !== "boolean") {
      throw new Error(
        `Validation error: each preference needs a 'categoryIdentifier' of 1 to ${MAX_CATEGORY_IDENTIFIER_BYTES} bytes and a boolean 'optedOut'.`,
      );
    }
  }
}

/**
 * Whether the name is one the API takes as a business event: 1 to 64 letters, digits, `_`, `.`, `:` or `-`,
 * starting with a letter or a digit, and not one of the six names of the delivery lifecycle (opened, clicked,
 * received, dismissed, converted, app_opened).
 */
export function isValidEventName(name: string): boolean {
  return typeof name === "string" && CUSTOM_EVENT_NAME.test(name) && !RESERVED_EVENT_NAMES.has(name);
}

const MAX_CONSENT_VERSION_CHARS = 64;
const MAX_CONSENT_SOURCE_CHARS = 32;

/** Characters the way the API counts them (code points), so an emoji is one. */
const charCount = (text: string): number => Array.from(text).length;

/**
 * Why a consent record would be refused (`invalid_consent`), or null when it is fine or absent. `version` is up to
 * 64 characters and `source` up to 32, both strings.
 */
export function validateConsent(consent: ConsentInfo | undefined): string | null {
  if (consent === undefined) return null;
  if (consent === null || typeof consent !== "object") return "'consent' must be an object with an optional 'version' and 'source'.";
  const { version, source } = consent;
  if (version !== undefined && (typeof version !== "string" || charCount(version) > MAX_CONSENT_VERSION_CHARS)) {
    return `'consent.version' must be a string of up to ${MAX_CONSENT_VERSION_CHARS} characters.`;
  }
  if (source !== undefined && (typeof source !== "string" || charCount(source) > MAX_CONSENT_SOURCE_CHARS)) {
    return `'consent.source' must be a string of up to ${MAX_CONSENT_SOURCE_CHARS} characters.`;
  }
  return null;
}
