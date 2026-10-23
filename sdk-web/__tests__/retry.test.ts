/**
 * @jest-environment node
 *
 * send-scale T82 (SCALE-27, SCALE-28; owner decision D-196): the retry helper of the Web SDK. A full-jitter back-off
 * for the subscribe and identify calls, a `Retry-After` stretched by a random 0 to 25%, and the rule for which
 * failures are tried again. The twin of sdk/__tests__/retry.test.ts.
 */
import { EspressoNotifyError, EspressoNotifyHttpError } from "../src/errors";
import {
  RETRY_ATTEMPTS,
  RETRY_CAP_MS,
  fullJitterBackoff,
  isRetryable,
  jitterRetryAfter,
  readRetryAfter,
  withRetry,
} from "../src/retry";

const http = (status: number, retryAfter?: number) =>
  new EspressoNotifyHttpError(`HTTP ${status}`, status, undefined, "/v1/web-push/subscribe", retryAfter);
const network = () => Object.assign(new TypeError("Failed to fetch"), { network: true });

describe("fullJitterBackoff", () => {
  it("stays between 0 and 1 s, 2 s, 4 s ... doubling, over 1,000 samples per failure", () => {
    for (const [attempt, window] of [[1, 1000], [2, 2000], [3, 4000], [4, 8000], [5, 16000]] as const) {
      const samples = Array.from({ length: 1000 }, () => fullJitterBackoff(attempt));
      expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...samples)).toBeLessThan(window);
      expect(new Set(samples).size).toBeGreaterThan(50); // not a constant: the whole window is used
      expect(Math.max(...samples)).toBeGreaterThan(window * 0.9);
    }
  });

  it("stops doubling at 5 minutes", () => {
    expect(fullJitterBackoff(40, () => 0.999999)).toBeLessThan(RETRY_CAP_MS);
    expect(fullJitterBackoff(40, () => 0.999999)).toBeGreaterThan(RETRY_CAP_MS - 10);
    expect(fullJitterBackoff(12, () => 0.999999)).toBeGreaterThan(RETRY_CAP_MS - 10); // 1 s doubled 11 times is past the cap
  });

  it("answers 0 when the dice say 0, and treats a nonsense attempt as the first", () => {
    expect(fullJitterBackoff(3, () => 0)).toBe(0);
    expect(fullJitterBackoff(0, () => 0.5)).toBe(500);
    expect(fullJitterBackoff(-4, () => 0.5)).toBe(500);
  });
});

describe("jitterRetryAfter", () => {
  it("is the header times 1 plus a random 0 to 0.25, over 1,000 samples", () => {
    const samples = Array.from({ length: 1000 }, () => jitterRetryAfter(2));
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(2000);
    expect(Math.max(...samples)).toBeLessThanOrEqual(2500);
    expect(new Set(samples).size).toBeGreaterThan(50);
  });

  it("has the exact bounds at the extremes of the dice", () => {
    expect(jitterRetryAfter(30, () => 0)).toBe(30_000);
    expect(jitterRetryAfter(30, () => 1)).toBe(37_500);
  });

  it("is cut at one hour", () => {
    expect(jitterRetryAfter(86_400, () => 1)).toBe(3_600_000);
    expect(jitterRetryAfter(3600, () => 1)).toBe(3_600_000);
  });

  it("never waits a negative time", () => {
    expect(jitterRetryAfter(-5, () => 1)).toBe(0);
  });
});

describe("isRetryable", () => {
  it.each([[408], [429], [500], [502], [503], [504]])("retries an HTTP %i", (status) => {
    expect(isRetryable(http(status))).toBe(true);
  });

  it.each([[400], [401], [403], [404], [409], [422]])("does not retry an HTTP %i", (status) => {
    expect(isRetryable(http(status))).toBe(false);
  });

  it("retries a request that got no answer, and nothing else that is not HTTP", () => {
    expect(isRetryable(network())).toBe(true);
    expect(isRetryable(new Error("Validation Error"))).toBe(false);
    expect(isRetryable(new EspressoNotifyError("no_subscription", "no subscription"))).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
    expect(isRetryable("boom")).toBe(false);
  });
});

describe("readRetryAfter", () => {
  const answer = (value: string | null) => ({ headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? value : null) } });

  it("reads a number of seconds", () => {
    expect(readRetryAfter(answer("2"))).toBe(2);
    expect(readRetryAfter(answer(" 30 "))).toBe(30);
    expect(readRetryAfter(answer("0"))).toBe(0);
  });

  it("turns an HTTP date into the seconds until it", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-18T12:00:00Z"));
    expect(readRetryAfter(answer("Sun, 18 Oct 2026 12:00:45 GMT"))).toBe(45);
    expect(readRetryAfter(answer("Sun, 18 Oct 2026 11:59:00 GMT"))).toBe(0);
    jest.useRealTimers();
  });

  it("is undefined for no header, a nonsense value, or an answer with no headers", () => {
    expect(readRetryAfter(answer(null))).toBeUndefined();
    expect(readRetryAfter(answer("soon"))).toBeUndefined();
    expect(readRetryAfter(answer("-3"))).toBeUndefined();
    expect(readRetryAfter({})).toBeUndefined();
    expect(readRetryAfter({ headers: { get: () => { throw new Error("boom"); } } })).toBeUndefined();
  });
});

describe("withRetry", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("answers at once when the call works", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    await expect(withRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("waits 2 to 2.5 s for a 429 with Retry-After: 2, then succeeds", async () => {
    const fn = jest.fn().mockRejectedValueOnce(http(429, 2)).mockResolvedValue("ok");
    const done = withRetry(fn);
    await jest.advanceTimersByTimeAsync(1999);
    expect(fn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(501);
    await expect(done).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not wait for a Retry-After over 60 s: it throws the error at once, trying once", async () => {
    const fn = jest.fn().mockRejectedValue(http(429, 61));
    await expect(withRetry(fn)).rejects.toMatchObject({ status: 429, retryAfter: 61 }); // no timer is advanced: a wait would hang here
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("still waits for a Retry-After of exactly 60 s, 60 to 75 s with the jitter", async () => {
    const fn = jest.fn().mockRejectedValueOnce(http(429, 60)).mockResolvedValue("ok");
    const done = withRetry(fn);
    await jest.advanceTimersByTimeAsync(59_999);
    expect(fn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(15_001);
    await expect(done).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 400", async () => {
    const fn = jest.fn().mockRejectedValue(http(400));
    await expect(withRetry(fn)).rejects.toMatchObject({ status: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry an error of the SDK or a validation error", async () => {
    const sdkError = new EspressoNotifyError("no_subscription", "no subscription");
    const fn = jest.fn().mockRejectedValue(sdkError);
    await expect(withRetry(fn)).rejects.toBe(sdkError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after 6 tries and throws the last error", async () => {
    const fn = jest.fn().mockRejectedValue(http(503));
    const settled = withRetry(fn).then(() => "resolved", (e: any) => e);
    await jest.advanceTimersByTimeAsync(60_000); // the five waits add up to at most 1+2+4+8+16 s
    expect(await settled).toMatchObject({ status: 503 });
    expect(fn).toHaveBeenCalledTimes(RETRY_ATTEMPTS);
    expect(RETRY_ATTEMPTS).toBe(6);
  });

  it("retries a transport failure with the full-jitter wait", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0.5);
    const fn = jest.fn().mockRejectedValueOnce(network()).mockRejectedValueOnce(network()).mockResolvedValue("ok");
    const done = withRetry(fn);
    await jest.advanceTimersByTimeAsync(499);
    expect(fn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1); // 0.5 of the 1 s window
    expect(fn).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1); // 0.5 of the 2 s window
    await expect(done).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
