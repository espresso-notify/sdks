"use strict";
/**
 * Register and identify only on change or on a new session (send-scale SCALE-39, owner decision D-159).
 *
 * Why: every app open used to send a `register` and an `identify`. With thousands of devices that is most of the
 * traffic of a project, and almost all of it tells the server what it already knows. The rule (the one OneSignal
 * uses): after a call works, the SDK remembers WHAT it sent (a fingerprint of the token, the app version and the user)
 * and in WHICH session. It sends again only when the fingerprint differs, or when the call that is remembered belongs
 * to an earlier session. A session is one run of the app: a new one starts at a cold start, and when the app comes back
 * to the foreground after at least 30 seconds out of it.
 *
 * A call that fails is never remembered, so the next start or foreground tries it again.
 *
 * What is stored is a hash and a session id, never the token or the user id: the store (AsyncStorage) is not
 * encrypted, the same rule as the offline queue. A value left by an older SDK, or a damaged one, reads as "nothing was
 * sent yet": the call runs once, never an error.
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegistrationTracker = exports.SESSION_GAP_MS = void 0;
/** How long the app must be out of the foreground for its return to start a new session (30 seconds). */
exports.SESSION_GAP_MS = 30000;
/** A 53-bit hash of a text (cyrb53) as 14 hex characters: enough to tell two fingerprints apart, not a secret. */
function hashText(text) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ code, 2654435761);
        h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}
function randomSessionId() {
    let out = '';
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
            for (const byte of crypto.getRandomValues(new Uint8Array(8)))
                out += byte.toString(16).padStart(2, '0');
        }
    }
    catch ( /* fall back below */_a) { /* fall back below */ }
    while (out.length < 16)
        out += Math.floor(Math.random() * 16).toString(16);
    return out;
}
class RegistrationTracker {
    constructor(_store, _key, _options = {}) {
        var _a, _b;
        this._store = _store;
        this._key = _key;
        this._options = _options;
        this._record = null;
        this._loading = null;
        this._chain = Promise.resolve();
        /** When the app left the foreground, or null while it is in it. */
        this._leftAt = null;
        this._session = (_a = _options.sessionId) !== null && _a !== void 0 ? _a : randomSessionId();
        this._now = (_b = _options.now) !== null && _b !== void 0 ? _b : Date.now;
    }
    /** The session the calls are being made in. */
    get sessionId() {
        return this._session;
    }
    /**
     * Tells the tracker that the app changed state (`active`, `inactive`, `background`). Coming back to `active` after at
     * least {@link SESSION_GAP_MS} out of it starts a new session.
     */
    noteAppState(state) {
        if (state === 'active') {
            if (this._leftAt !== null && this._now() - this._leftAt >= exports.SESSION_GAP_MS)
                this._session = randomSessionId();
            this._leftAt = null;
        }
        else if (this._leftAt === null) {
            this._leftAt = this._now();
        }
    }
    /**
     * Whether the call has to run: a ticket when the server may not know this state, null when it is known (the same
     * fingerprint, remembered in this session). Never throws; a store that cannot be read means "run".
     */
    plan(kind, parts) {
        return __awaiter(this, void 0, void 0, function* () {
            const fingerprint = this._fingerprint(parts);
            const session = this._session;
            let record;
            try {
                record = yield this._read();
            }
            catch (_a) {
                return { kind, fingerprint, session };
            }
            const known = record[kind];
            if (known && known.f === fingerprint && known.s === session)
                return null;
            return { kind, fingerprint, session };
        });
    }
    /** Remembers a call that worked. Never throws; a store that cannot be written only means the call may run again. */
    commit(ticket) {
        return this._update((record) => { record[ticket.kind] = { f: ticket.fingerprint, s: ticket.session }; });
    }
    /** Forgets a call, so the next `plan` of it runs (the user logged out: the next login must identify again). */
    forget(kind) {
        return this._update((record) => { delete record[kind]; });
    }
    _fingerprint(parts) {
        var _a, _b, _c, _d, _e, _f, _g;
        const appVersion = (_d = (_a = parts.appVersion) !== null && _a !== void 0 ? _a : (_c = (_b = this._options).getAppVersion) === null || _c === void 0 ? void 0 : _c.call(_b)) !== null && _d !== void 0 ? _d : '';
        // JSON keeps the fields apart (a user id that ends like a token cannot be confused with it).
        return hashText(JSON.stringify([parts.token, appVersion, (_e = parts.userId) !== null && _e !== void 0 ? _e : '', (_f = parts.userName) !== null && _f !== void 0 ? _f : '', (_g = parts.identityHash) !== null && _g !== void 0 ? _g : '']));
    }
    _read() {
        if (this._record)
            return Promise.resolve(this._record);
        if (!this._loading) {
            this._loading = (() => __awaiter(this, void 0, void 0, function* () {
                let record = { v: 1 };
                try {
                    const text = yield this._store.getItem(this._key);
                    record = this._parse(text);
                }
                catch (error) {
                    this._loading = null; // a store that failed to answer is asked again next time
                    throw error;
                }
                this._record = record;
                return record;
            }))();
        }
        return this._loading;
    }
    /** The record of a stored text; anything that is not the expected shape (no value, an older SDK, damage) is empty. */
    _parse(text) {
        const empty = { v: 1 };
        if (!text)
            return empty;
        try {
            const value = JSON.parse(text);
            if (!value || value.v !== 1)
                return empty;
            const pick = (r) => r && typeof r.f === 'string' && typeof r.s === 'string' ? { f: r.f, s: r.s } : undefined;
            const out = { v: 1 };
            const register = pick(value.register);
            const identify = pick(value.identify);
            if (register)
                out.register = register;
            if (identify)
                out.identify = identify;
            return out;
        }
        catch (_a) {
            return empty;
        }
    }
    _update(change) {
        const run = this._chain.then(() => __awaiter(this, void 0, void 0, function* () {
            var _a;
            let record;
            try {
                record = yield this._read();
            }
            catch (_b) {
                record = (_a = this._record) !== null && _a !== void 0 ? _a : { v: 1 };
            }
            change(record);
            this._record = record;
            yield this._store.setItem(this._key, JSON.stringify(record)); // a write that fails is swallowed below: the call may run again at worst
        }));
        this._chain = run.then(() => undefined, () => undefined);
        return run.catch(() => undefined);
    }
}
exports.RegistrationTracker = RegistrationTracker;
