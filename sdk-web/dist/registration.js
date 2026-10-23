"use strict";
/**
 * Subscribe and identify only on change or on a new session (send-scale SCALE-39; owner decision D-196). The twin of
 * sdk/src/registration.ts.
 *
 * Why: every page load used to post the subscription and, for a signed-in visitor, post it again with `identify`.
 * With thousands of visitors that is most of the traffic of a project, and almost all of it tells the server what it
 * already knows. The rule: after a call works, the SDK remembers WHAT it sent (a hash of the subscription, the user and
 * the versions) and in WHICH session. It sends again only when the hash differs, or when the call that is remembered
 * belongs to an earlier session.
 *
 * A web session is one tab: its id lives in `sessionStorage`, so a reload or another page of the site keeps it, and a
 * new tab or a new window starts another. It also ends when the page is opened, or shown again, 30 minutes or more after
 * the last time it was seen (a tab that was left open overnight). Where the browser has no `sessionStorage` every page
 * load is a session, which is what the SDK did before this rule.
 *
 * A call that fails is never remembered, so the next page load tries it again.
 *
 * What is stored is a hash and session ids, never the endpoint, the keys, the user id, the name or the proof of
 * identity: `localStorage` can be read by any script of the site. A value left by an older SDK, or a damaged one, reads
 * as "nothing was sent yet": the call runs once, never an error. A storage that cannot be read or written (a private
 * window, a full disk) only means the call runs every time.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegistrationTracker = exports.REMEMBERED_SESSIONS = exports.SESSION_GAP_MS = exports.SDK_VERSION = void 0;
/** The version of this package; `package.json` says the same (a test keeps the two equal). */
exports.SDK_VERSION = "0.1.0";
/** How long the page must be out of sight, or the tab untouched, for the next sight of it to start a new session (30 minutes). */
exports.SESSION_GAP_MS = 30 * 60 * 1000;
/** How many sessions of one unchanged state are remembered (tabs that took turns); the oldest is forgotten first. */
exports.REMEMBERED_SESSIONS = 8;
const SESSION_KEY = "espresso-notify:session";
/** A storage of the browser, or null where there is none or the browser refuses it (reading the property can throw). */
function browserStorage(name) {
    try {
        const found = globalThis[name];
        return found && typeof found.getItem === "function" ? found : null;
    }
    catch (_a) {
        return null;
    }
}
function hex(bytes) {
    let out = "";
    for (const byte of bytes)
        out += byte.toString(16).padStart(2, "0");
    return out;
}
/** A 53-bit hash of a text (cyrb53) as 14 hex characters: the fallback where SubtleCrypto is missing. Not a secret. */
function plainHash(text) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ code, 2654435761);
        h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}
/** The hash of a text: `s` and 32 hex characters of its SHA-256, or `c` and a plain hash where SubtleCrypto is missing. */
async function hashText(text) {
    var _a;
    try {
        const subtle = (_a = globalThis.crypto) === null || _a === void 0 ? void 0 : _a.subtle;
        if (subtle)
            return "s" + hex(new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(text)))).slice(0, 32);
    }
    catch (_b) {
        // fall back below
    }
    return "c" + plainHash(text);
}
function randomSessionId() {
    let out = "";
    try {
        const random = globalThis.crypto;
        if (typeof (random === null || random === void 0 ? void 0 : random.getRandomValues) === "function")
            out = hex(random.getRandomValues(new Uint8Array(8)));
    }
    catch (_a) {
        // fall back below
    }
    while (out.length < 16)
        out += Math.floor(Math.random() * 16).toString(16);
    return out;
}
class RegistrationTracker {
    constructor(options) {
        var _a, _b;
        this.options = options;
        /** When the page left the screen, or null while it is on it. */
        this.leftAt = null;
        this.store = options.storage === undefined ? browserStorage("localStorage") : options.storage;
        this.sessionStore = options.sessionStorage === undefined ? browserStorage("sessionStorage") : options.sessionStorage;
        this.now = (_a = options.now) !== null && _a !== void 0 ? _a : Date.now;
        this.session = this.openSession();
        this.watchPage(options.page === undefined ? (_b = globalThis.document) !== null && _b !== void 0 ? _b : null : options.page);
    }
    /** The session the calls are being made in. */
    get sessionId() {
        return this.session;
    }
    /**
     * Whether the call has to run: a ticket when the server may not know this state, null when it is known (the same
     * fingerprint, remembered in this session). `force` always gives a ticket (a call that carries a consent record, or
     * an endpoint to replace). Never throws; a store that cannot be read means "run".
     */
    async plan(kind, parts, options = {}) {
        const session = this.session;
        // With no storage nothing is remembered, so there is nothing to compare and nothing to hash.
        if (!this.store)
            return { kind, fingerprint: "", session };
        const fingerprint = await this.fingerprint(kind, parts);
        if (!options.force) {
            const known = this.read()[kind];
            if (known && known.f === fingerprint && known.s.includes(session))
                return null;
        }
        return { kind, fingerprint, session };
    }
    /** Remembers a call that worked. Never throws; a store that cannot be written only means the call may run again. */
    async commit(ticket) {
        const record = this.read();
        const known = record[ticket.kind];
        const sessions = known && known.f === ticket.fingerprint ? known.s.filter((s) => s !== ticket.session) : [];
        sessions.push(ticket.session);
        record[ticket.kind] = { f: ticket.fingerprint, s: sessions.slice(-exports.REMEMBERED_SESSIONS) };
        this.write(record);
    }
    /** Forgets one call, or both, so the next `plan` runs (the browser was unsubscribed or erased). */
    async forget(kind) {
        var _a;
        if (!kind) {
            try {
                (_a = this.store) === null || _a === void 0 ? void 0 : _a.removeItem(this.options.key);
            }
            catch ( /* the record stays; the call may be skipped once too often at worst */_b) { /* the record stays; the call may be skipped once too often at worst */ }
            return;
        }
        const record = this.read();
        delete record[kind];
        this.write(record);
    }
    fingerprint(kind, p) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        // JSON keeps the fields apart (a user id that ends like a key cannot be confused with it).
        return hashText(JSON.stringify([
            kind,
            this.options.projectKey,
            (_a = this.options.sdkVersion) !== null && _a !== void 0 ? _a : exports.SDK_VERSION,
            (_b = this.options.appVersion) !== null && _b !== void 0 ? _b : "",
            p.endpoint,
            (_c = p.p256dh) !== null && _c !== void 0 ? _c : "",
            (_d = p.auth) !== null && _d !== void 0 ? _d : "",
            (_e = p.vapidKey) !== null && _e !== void 0 ? _e : "",
            (_f = p.timezone) !== null && _f !== void 0 ? _f : "",
            (_g = p.userId) !== null && _g !== void 0 ? _g : "",
            (_h = p.userName) !== null && _h !== void 0 ? _h : "",
            (_j = p.identityHash) !== null && _j !== void 0 ? _j : "",
        ]));
    }
    /** The record of the storage; anything that is not the expected shape (no value, an older SDK, damage) is empty. */
    read() {
        var _a;
        const empty = { v: 1 };
        try {
            const text = (_a = this.store) === null || _a === void 0 ? void 0 : _a.getItem(this.options.key);
            if (!text)
                return empty;
            const value = JSON.parse(text);
            if (!value || value.v !== 1)
                return empty;
            const pick = (r) => r && typeof r.f === "string" && Array.isArray(r.s) && r.s.every((s) => typeof s === "string") ? { f: r.f, s: r.s } : undefined;
            const out = { v: 1 };
            const register = pick(value.register);
            const identify = pick(value.identify);
            if (register)
                out.register = register;
            if (identify)
                out.identify = identify;
            return out;
        }
        catch (_b) {
            return empty;
        }
    }
    write(record) {
        var _a;
        try {
            (_a = this.store) === null || _a === void 0 ? void 0 : _a.setItem(this.options.key, JSON.stringify(record));
        }
        catch (_b) {
            // a write that fails only means the call may run again
        }
    }
    /** The session this page load belongs to: the one of the tab when it was seen less than 30 minutes ago, else a new one. */
    openSession() {
        var _a;
        const now = this.now();
        let id = null;
        try {
            const text = (_a = this.sessionStore) === null || _a === void 0 ? void 0 : _a.getItem(SESSION_KEY);
            const value = text ? JSON.parse(text) : null;
            if (value && typeof value.id === "string" && typeof value.seen === "number" && now - value.seen < exports.SESSION_GAP_MS)
                id = value.id;
        }
        catch (_b) {
            // an unreadable session is a new one
        }
        id = id !== null && id !== void 0 ? id : randomSessionId();
        this.touch(id);
        return id;
    }
    /** Writes the time the page was last seen with the session. */
    touch(id) {
        var _a;
        try {
            (_a = this.sessionStore) === null || _a === void 0 ? void 0 : _a.setItem(SESSION_KEY, JSON.stringify({ id, seen: this.now() }));
        }
        catch (_b) {
            // without it the next page load is a new session
        }
    }
    watchPage(page) {
        if (!page || typeof page.addEventListener !== "function")
            return;
        const onChange = () => {
            if (page.visibilityState === "hidden") {
                if (this.leftAt === null)
                    this.leftAt = this.now();
            }
            else {
                if (this.leftAt !== null && this.now() - this.leftAt >= exports.SESSION_GAP_MS)
                    this.session = randomSessionId();
                this.leftAt = null;
            }
            this.touch(this.session);
        };
        page.addEventListener("visibilitychange", onChange);
        page.addEventListener("pagehide", () => this.touch(this.session));
    }
}
exports.RegistrationTracker = RegistrationTracker;
