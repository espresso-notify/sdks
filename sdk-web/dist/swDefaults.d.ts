/**
 * One spelling of the service worker location, shared by the client and the
 * installer CLI.
 *
 * They used to disagree. The CLI copied the worker to the root of `public/`
 * and told the developer to serve it from the domain root, while the client
 * registered `/push/espressonotify/espresso-notify-sw.js`. Following both
 * documented defaults produced a 404, so web push never armed.
 *
 * The nested directory is the deliberate half of that pair, and it is the one
 * that stays: registering under a dedicated prefix keeps Espresso Notify from
 * colliding with a service worker the customer already serves at `/`, which is
 * the same reason Firebase registers under `/firebase-cloud-messaging-push-scope`.
 * The narrow scope costs nothing — `clients.openWindow()` opens any URL
 * regardless of scope, `matchAll({ includeUncontrolled: true })` is bounded by
 * origin rather than by path, and push delivery never consults the scope.
 *
 * A worker may only claim a scope at or below the directory it is served from,
 * so the file has to live inside the scope directory. Deriving the path from
 * the scope is what keeps that true no matter which value changes.
 *
 * The database default (`projects.sw_path`, `sw_scope`) and the dashboard's
 * Web Push tab carry these same two strings. Changing them here means changing
 * them there, and migrating the rows that already exist.
 */
export declare const SW_FILENAME = "espresso-notify-sw.js";
/** Trailing slash matters: the scope is a directory, not a file. */
export declare const SW_SCOPE = "/push/espressonotify/";
export declare const SW_PATH: string;
