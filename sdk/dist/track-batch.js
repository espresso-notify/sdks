"use strict";
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
exports.TrackBatcher = exports.SINGLE_PATH = exports.BATCH_PATH = exports.SPREAD_WINDOW_MS = exports.BATCH_MIN_GAP_MS = exports.BATCH_MAX_EVENTS = void 0;
exports.spreadDelayMs = spreadDelayMs;
const retry_1 = require("./retry");
/**
 * The batcher of the delivery events (send-scale SCALE-26, SCALE-29).
 *
 * Why: when a campaign reaches a million devices, each of them reports `received` (and later `dismissed`) within
 * seconds of the push, one request each. The server then takes a million requests at the moment the campaign goes out.
 * Two rules flatten that:
 *
 *  - SPREAD: `received` and `dismissed` wait a random 0 to 30 s before they go, so the reports of a crowd arrive over
 *    half a minute instead of in one second. `opened` and `clicked` are what a person just did and what a journey may
 *    wait for: they go at once (the rule is "within 2 seconds"), together with any event whose time has come.
 *  - BATCH: what is due goes in as few requests as possible, at most 20 events each, to `POST /v1/notifications/track/batch`
 *    (one device lookup for up to 20 events), and the flushes of the delayed events are at least 5 s apart.
 *
 * A lone event is sent to the single route with the body the SDK always sent. If the server has no batch route (404
 * without a code; a 404 `unknown_device` is the answer of a route that exists) the batcher uses single requests for the
 * rest of the session and loses no event. An event the server could not take for a reason that can pass goes to the
 * offline queue, which keeps it, persists it under its own rules and sends it again; an event it refused for good is
 * dropped and counted, exactly as a single event is.
 *
 * Throughput: a device sends at most one flush every 5 s, so a project of N devices that all get the same push sends
 * about N/30 events a second (N/(30*20) requests a second when they batch), against N in the first second before.
 */
/** The most events one request carries (the server refuses more with 400 `batch_too_large`). */
exports.BATCH_MAX_EVENTS = 20;
/** Between two flushes of delayed events, at least this long (ms). */
exports.BATCH_MIN_GAP_MS = 5000;
/** `received` and `dismissed` wait a random time from 0 up to this (ms). */
exports.SPREAD_WINDOW_MS = 30000;
exports.BATCH_PATH = '/v1/notifications/track/batch';
exports.SINGLE_PATH = '/v1/notifications/track';
/** The wait, in ms, before a `received` or `dismissed` report goes: a random 0 up to {@link SPREAD_WINDOW_MS}. */
function spreadDelayMs(random = Math.random) {
    return Math.floor(random() * exports.SPREAD_WINDOW_MS);
}
class TrackBatcher {
    constructor(_host, options = {}) {
        var _a, _b;
        this._host = _host;
        this._pending = [];
        this._timer = null;
        this._lastFlushAt = 0;
        this._batchRoute = true;
        this._running = null;
        this._destroyed = false;
        this._random = (_a = options.random) !== null && _a !== void 0 ? _a : Math.random;
        this._now = (_b = options.now) !== null && _b !== void 0 ? _b : Date.now;
    }
    /**
     * Takes a delivery event. `opened` and `clicked` go now (with every event that is due); `received` and `dismissed` wait
     * their random delay. Resolves when a request it started ends; never rejects.
     */
    add(event) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._destroyed || !event.push_token)
                return;
            const priority = event.event === 'opened' || event.event === 'clicked';
            const now = this._now();
            this._pending.push({ body: event, due: priority ? now : now + spreadDelayMs(this._random) });
            if (priority) {
                yield this._flush(false);
            }
            else {
                this._schedule();
            }
        });
    }
    /** Sends everything that waits, now, due or not. Resolves when the requests end; never rejects. */
    flush() {
        return this._flush(true);
    }
    /** Gives what waits to the offline queue as single events (the client is being destroyed) and sends nothing. */
    handOff() {
        return __awaiter(this, void 0, void 0, function* () {
            this._clearTimer();
            const waiting = this._pending;
            this._pending = [];
            for (const { body } of waiting) {
                try {
                    yield this._host.keep(exports.SINGLE_PATH, Object.assign({}, body), { kind: 'retry', network: false });
                }
                catch ( /* best-effort */_a) { /* best-effort */ }
            }
        });
    }
    destroy() {
        this._destroyed = true;
        this._clearTimer();
    }
    _clearTimer() {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }
    /** One timer, for the soonest moment something can go: its time, and not before the gap after the last flush. */
    _schedule() {
        this._clearTimer();
        if (this._destroyed || this._pending.length === 0)
            return;
        const soonest = Math.min(...this._pending.map((p) => p.due));
        const at = Math.max(soonest, this._lastFlushAt + exports.BATCH_MIN_GAP_MS);
        const timer = setTimeout(() => { this._timer = null; void this._flush(false); }, Math.max(0, at - this._now()));
        if (timer && typeof timer.unref === 'function')
            timer.unref();
        this._timer = timer;
    }
    /**
     * Flushes one after the other. When nothing is running the flush starts in the same tick, so the request of an `opened`
     * leaves the app at the moment the tap is handled, as it did before the batcher existed.
     */
    _flush(all) {
        const start = () => this._flushNow(all);
        const run = this._running ? this._running.then(start, start) : start();
        const tracked = run.then(() => undefined, () => undefined);
        this._running = tracked;
        void tracked.then(() => { if (this._running === tracked)
            this._running = null; });
        return tracked;
    }
    _flushNow(all) {
        return __awaiter(this, void 0, void 0, function* () {
            this._clearTimer();
            const now = this._now();
            const due = this._pending.filter((p) => all || p.due <= now);
            this._pending = this._pending.filter((p) => !due.includes(p));
            if (due.length > 0) {
                this._lastFlushAt = now;
                for (const chunk of this._chunks(due.map((p) => p.body)))
                    yield this._send(chunk);
            }
            this._schedule();
        });
    }
    /** The events in order, cut into runs of one token of at most {@link BATCH_MAX_EVENTS}. */
    _chunks(events) {
        const out = [];
        for (const event of events) {
            const last = out[out.length - 1];
            if (last && last[0].push_token === event.push_token && last.length < exports.BATCH_MAX_EVENTS)
                last.push(event);
            else
                out.push([event]);
        }
        return out;
    }
    _sendEach(chunk) {
        return __awaiter(this, void 0, void 0, function* () {
            for (const body of chunk) {
                try {
                    yield this._host.sendSingle(exports.SINGLE_PATH, Object.assign({}, body));
                }
                catch ( /* the queue keeps what can pass */_a) { /* the queue keeps what can pass */ }
            }
        });
    }
    _send(chunk) {
        return __awaiter(this, void 0, void 0, function* () {
            // A lone event, no batch route, or a Retry-After the queue is waiting out: the single path (which keeps what cannot go).
            if (chunk.length === 1 || !this._batchRoute || this._now() < this._host.pausedUntil()) {
                yield this._sendEach(chunk);
                return;
            }
            const token = chunk[0].push_token;
            const body = JSON.stringify({ push_token: token, events: chunk.map((e) => ({ notification_id: e.notification_id, event: e.event })) });
            let answer;
            try {
                answer = yield this._host.request(exports.BATCH_PATH, { method: 'POST', body });
            }
            catch (error) {
                yield this._failed(chunk, error);
                return;
            }
            this._host.delivered();
            yield this._rejections(chunk, answer);
        });
    }
    /** The whole request failed: no batch route, a refusal for good, or a failure that can pass. */
    _failed(chunk, error) {
        return __awaiter(this, void 0, void 0, function* () {
            const outcome = this._host.classify(error);
            if (outcome.kind === 'refused') {
                if (outcome.status === 404 && outcome.code !== 'unknown_device') {
                    this._batchRoute = false; // the server has no batch route: one request per event for the rest of the session
                    yield this._sendEach(chunk);
                    return;
                }
                for (let i = 0; i < chunk.length; i++)
                    this._host.refused(outcome.status, outcome.code);
                return;
            }
            if (outcome.kind === 'retry') {
                for (const event of chunk)
                    yield this._keep(event, outcome);
                return;
            }
            for (let i = 0; i < chunk.length; i++)
                this._host.refused(0); // an error of the SDK itself: the event is gone
        });
    }
    /** The events a batch the server accepted still rejected: kept when the reason can pass, dropped when it cannot. */
    _rejections(chunk, answer) {
        return __awaiter(this, void 0, void 0, function* () {
            const results = answer === null || answer === void 0 ? void 0 : answer.results;
            if (!Array.isArray(results))
                return;
            for (const r of results) {
                if (!r || r.status !== 'rejected' || typeof r.index !== 'number')
                    continue;
                const event = chunk[r.index];
                if (!event)
                    continue;
                const code = typeof r.code === 'string' ? r.code : undefined;
                if (code === 'rate_limited' || code === 'track_unavailable') {
                    const seconds = typeof r.retry_after === 'number' && r.retry_after >= 0 ? r.retry_after : undefined;
                    yield this._keep(event, Object.assign({ kind: 'retry', network: false }, (seconds !== undefined ? { retryAfterMs: (0, retry_1.jitterRetryAfter)(seconds) } : {})));
                }
                else {
                    this._host.refused(200, code);
                }
            }
        });
    }
    _keep(event, outcome) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield this._host.keep(exports.SINGLE_PATH, Object.assign({}, event), outcome);
            }
            catch ( /* best-effort */_a) { /* best-effort */ }
        });
    }
}
exports.TrackBatcher = TrackBatcher;
