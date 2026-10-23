"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RETRY_AFTER_MAX_WAIT_S = exports.RETRY_AFTER_CAP_MS = exports.RETRY_AFTER_JITTER = exports.RETRY_CAP_MS = exports.RETRY_BASE_MS = exports.RETRY_ATTEMPTS = void 0;
exports.fullJitterBackoff = fullJitterBackoff;
exports.jitterRetryAfter = jitterRetryAfter;
exports.readRetryAfter = readRetryAfter;
exports.isRetryable = isRetryable;
exports.withRetry = withRetry;
const errors_1 = require("./errors");
/**
 * Retry rules of the Web SDK (send-scale SCALE-27, SCALE-28; owner decision D-196). The twin of sdk/src/retry.ts.
 *
 * Why: when thousands of browsers fail together (the server restarts, a limit trips) and every one of them retries
 * on the same schedule, the retries arrive together and trip the limit again. Two rules break that:
 *
 *  - a back-off with FULL jitter: the wait before the next try is a random number between 0 and the back-off, not the
 *    back-off itself, so the retries of a crowd spread over the whole window;
 *  - a `Retry-After` is obeyed and then stretched by a random 0 to 25%, so the browsers told "wait 30 s" do not all
 *    come back in the same second.
 */
/** How many times in all the subscribe and identify calls are tried (the first call and five retries). */
exports.RETRY_ATTEMPTS = 6;
/** The back-off before the second try, in ms; it doubles with each failure up to {@link RETRY_CAP_MS}. */
exports.RETRY_BASE_MS = 1000;
/** The longest back-off, in ms (5 minutes). */
exports.RETRY_CAP_MS = 5 * 60 * 1000;
/** The most a `Retry-After` is stretched: 25% on top of what the server asked. */
exports.RETRY_AFTER_JITTER = 0.25;
/** The longest a `Retry-After` is obeyed, in ms (1 hour). */
exports.RETRY_AFTER_CAP_MS = 60 * 60 * 1000;
/**
 * The longest `Retry-After`, in seconds, that a call waits for (owner decision D-196). A page that awaits `subscribe`,
 * `trySubscribe` or `identify` must not hang for an hour: an answer that asks for more is not waited for, the call
 * fails at once, nothing is remembered and the next page load tries again.
 */
exports.RETRY_AFTER_MAX_WAIT_S = 60;
/**
 * The wait, in ms, before the try that follows failed attempt number `attempt` (1 for the first failure): a random
 * number from 0 up to 1 s doubling with each failure, capped at 5 minutes (full jitter).
 */
function fullJitterBackoff(attempt, random = Math.random) {
    const exponent = Math.max(0, Math.floor(attempt) - 1);
    const window = Math.min(exports.RETRY_CAP_MS, exports.RETRY_BASE_MS * 2 ** exponent);
    return Math.floor(random() * window);
}
/**
 * The wait, in ms, that a `Retry-After` of `seconds` asks for: the seconds times 1 plus a random 0 to 0.25, cut at one
 * hour.
 */
function jitterRetryAfter(seconds, random = Math.random) {
    const asked = Math.max(0, seconds) * 1000;
    return Math.min(exports.RETRY_AFTER_CAP_MS, Math.round(asked * (1 + exports.RETRY_AFTER_JITTER * random())));
}
/**
 * The seconds a `Retry-After` header asks to wait, as whole seconds: a number of seconds, or an HTTP date turned into
 * the seconds until it. Undefined when the answer has no header or a value that is neither. Never throws.
 */
function readRetryAfter(response) {
    var _a, _b;
    try {
        const raw = (_b = (_a = response.headers) === null || _a === void 0 ? void 0 : _a.get) === null || _b === void 0 ? void 0 : _b.call(_a, "Retry-After");
        if (typeof raw !== "string")
            return undefined;
        const value = raw.trim();
        if (/^\d{1,9}$/.test(value))
            return Number(value);
        if (/[A-Za-z]/.test(value)) {
            const when = Date.parse(value);
            if (Number.isFinite(when))
                return Math.max(0, Math.ceil((when - Date.now()) / 1000));
        }
    }
    catch (_c) {
        // an unusable header is no header
    }
    return undefined;
}
/**
 * Whether trying again can help: the transport failed (the error of a request that never got an answer carries
 * `network: true`), or the server said 408, 429 or 5xx. Any other 4xx, a validation error and an error of the SDK
 * itself are final.
 */
function isRetryable(error) {
    if (error instanceof errors_1.EspressoNotifyHttpError) {
        return error.status === 408 || error.status === 429 || error.status >= 500;
    }
    return typeof error === "object" && error !== null && error.network === true;
}
/**
 * Runs `fn`; when it fails with a retryable error, waits and runs it again, up to `attempts` tries. The wait is the
 * `Retry-After` of the server stretched by {@link jitterRetryAfter} when the error carries one, else
 * {@link fullJitterBackoff}; a `Retry-After` over {@link RETRY_AFTER_MAX_WAIT_S} is not waited for: the error is
 * thrown at once. Throws the last error.
 */
async function withRetry(fn, options = {}) {
    var _a;
    const attempts = (_a = options.attempts) !== null && _a !== void 0 ? _a : exports.RETRY_ATTEMPTS;
    for (let attempt = 1;; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            if (attempt >= attempts || !isRetryable(error))
                throw error;
            const asked = error instanceof errors_1.EspressoNotifyHttpError ? error.retryAfter : undefined;
            if (typeof asked === "number" && asked > exports.RETRY_AFTER_MAX_WAIT_S)
                throw error;
            const wait = typeof asked === "number" && asked >= 0 ? jitterRetryAfter(asked) : fullJitterBackoff(attempt);
            await sleep(wait);
        }
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
