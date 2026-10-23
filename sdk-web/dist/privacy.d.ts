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
/**
 * Throws, before any call, when a list of preferences would be refused: it must have 1 to 50 items, each with a
 * `categoryIdentifier` of 1 to 64 bytes (not only spaces) and a boolean `optedOut`.
 */
export declare function validatePreferences(preferences: NotificationPreference[]): void;
/**
 * Whether the name is one the API takes as a business event: 1 to 64 letters, digits, `_`, `.`, `:` or `-`,
 * starting with a letter or a digit, and not one of the six names of the delivery lifecycle (opened, clicked,
 * received, dismissed, converted, app_opened).
 */
export declare function isValidEventName(name: string): boolean;
/**
 * Why a consent record would be refused (`invalid_consent`), or null when it is fine or absent. `version` is up to
 * 64 characters and `source` up to 32, both strings.
 */
export declare function validateConsent(consent: ConsentInfo | undefined): string | null;
