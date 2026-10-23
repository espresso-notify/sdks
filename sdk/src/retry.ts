import { EspressoNotifyHttpError } from './errors'

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
export const RETRY_ATTEMPTS = 6
/** The back-off before the second try, in ms; it doubles with each failure up to {@link RETRY_CAP_MS}. */
export const RETRY_BASE_MS = 1000
/** The longest back-off, in ms (5 minutes). */
export const RETRY_CAP_MS = 5 * 60 * 1000
/** The most a `Retry-After` is stretched: 25% on top of what the server asked. */
export const RETRY_AFTER_JITTER = 0.25
/** The longest a `Retry-After` is obeyed, in ms (1 hour). */
export const RETRY_AFTER_CAP_MS = 60 * 60 * 1000

/**
 * The wait, in ms, before the try that follows failed attempt number `attempt` (1 for the first failure): a random
 * number from 0 up to 1 s doubling with each failure, capped at 5 minutes (full jitter).
 */
export function fullJitterBackoff(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1)
  const window = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** exponent)
  return Math.floor(random() * window)
}

/**
 * The wait, in ms, that a `Retry-After` of `seconds` asks for: the seconds times 1 plus a random 0 to 0.25, cut at one
 * hour.
 */
export function jitterRetryAfter(seconds: number, random: () => number = Math.random): number {
  const asked = Math.max(0, seconds) * 1000
  return Math.min(RETRY_AFTER_CAP_MS, Math.round(asked * (1 + RETRY_AFTER_JITTER * random())))
}

/**
 * Whether trying again can help: the transport failed (the error `register` and `identify` raise for a request that
 * never got an answer carries `network: true`), or the server said 408, 429 or 5xx. Any other 4xx, a validation error
 * and an error of the SDK itself (pinning, a project id that is missing) are final.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof EspressoNotifyHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500
  }
  return typeof error === 'object' && error !== null && (error as { network?: unknown }).network === true
}

export interface RetryOptions {
  /** Tries in all, the first included. Default {@link RETRY_ATTEMPTS}. */
  attempts?: number
  /** Return true to stop trying (the component unmounted): the last error is thrown without another wait. */
  isCancelled?: () => boolean
}

/**
 * Runs `fn`; when it fails with a retryable error, waits and runs it again, up to `attempts` tries. The wait is the
 * `Retry-After` of the server stretched by {@link jitterRetryAfter} when the error carries one, else
 * {@link fullJitterBackoff}. Throws the last error.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? RETRY_ATTEMPTS
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= attempts || !isRetryable(error) || options.isCancelled?.()) throw error
      const asked = error instanceof EspressoNotifyHttpError ? error.retryAfter : undefined
      const wait = typeof asked === 'number' && asked >= 0 ? jitterRetryAfter(asked) : fullJitterBackoff(attempt)
      await sleep(wait)
      if (options.isCancelled?.()) throw error
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer: any = setTimeout(resolve, ms)
    // A pending retry never keeps a test or a Node process alive.
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
}
