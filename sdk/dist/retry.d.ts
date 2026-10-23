/**
 * Retry rules of the SDK (send-scale SCALE-27, SCALE-28).
 *
 * Why: when thousands of devices fail together (the server restarts, a limit trips) and every one of them retries on
 * the same schedule, the retries arrive together and trip the limit again. Two rules break that:
 *
 *  - a back-off with FULL jitter: the wait before the next try is a random number between 0 and the back-off, not the
 *    back-off itself, so the retries of a crowd spread over the whole window;
 *  - a `Retry-After` is obeyed and then stretched by a random 0 to 25%, so the devices told "wait 30 s" do not all
 *    come back in the same second.
 */
/** How many times in all `register` and `identify` are tried (the first call and five retries). */
export declare const RETRY_ATTEMPTS = 6;
/** The back-off before the second try, in ms; it doubles with each failure up to {@link RETRY_CAP_MS}. */
export declare const RETRY_BASE_MS = 1000;
/** The longest back-off, in ms (5 minutes). */
export declare const RETRY_CAP_MS: number;
/** The most a `Retry-After` is stretched: 25% on top of what the server asked. */
export declare const RETRY_AFTER_JITTER = 0.25;
/** The longest a `Retry-After` is obeyed, in ms (1 hour). */
export declare const RETRY_AFTER_CAP_MS: number;
/**
 * The wait, in ms, before the try that follows failed attempt number `attempt` (1 for the first failure): a random
 * number from 0 up to 1 s doubling with each failure, capped at 5 minutes (full jitter).
 */
export declare function fullJitterBackoff(attempt: number, random?: () => number): number;
/**
 * The wait, in ms, that a `Retry-After` of `seconds` asks for: the seconds times 1 plus a random 0 to 0.25, cut at one
 * hour.
 */
export declare function jitterRetryAfter(seconds: number, random?: () => number): number;
/**
 * Whether trying again can help: the transport failed (the error `register` and `identify` raise for a request that
 * never got an answer carries `network: true`), or the server said 408, 429 or 5xx. Any other 4xx, a validation error
 * and an error of the SDK itself (pinning, a project id that is missing) are final.
 */
export declare function isRetryable(error: unknown): boolean;
export interface RetryOptions {
    /** Tries in all, the first included. Default {@link RETRY_ATTEMPTS}. */
    attempts?: number;
    /** Return true to stop trying (the component unmounted): the last error is thrown without another wait. */
    isCancelled?: () => boolean;
}
/**
 * Runs `fn`; when it fails with a retryable error, waits and runs it again, up to `attempts` tries. The wait is the
 * `Retry-After` of the server stretched by {@link jitterRetryAfter} when the error carries one, else
 * {@link fullJitterBackoff}. Throws the last error.
 */
export declare function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T>;
