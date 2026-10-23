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
export declare const BATCH_MAX_EVENTS = 20;
/** Between two flushes of delayed events, at least this long (ms). */
export declare const BATCH_MIN_GAP_MS = 5000;
/** `received` and `dismissed` wait a random time from 0 up to this (ms). */
export declare const SPREAD_WINDOW_MS = 30000;
export declare const BATCH_PATH = "/v1/notifications/track/batch";
export declare const SINGLE_PATH = "/v1/notifications/track";
/** How the queue judges one failure; the same shape as the queue's own outcome. */
export type BatchOutcome = {
    kind: 'ok';
} | {
    kind: 'retry';
    network: boolean;
    retryAfterMs?: number;
    race?: true;
} | {
    kind: 'refused';
    status: number;
    code?: string;
} | {
    kind: 'sdk';
};
/** An event as the Devices methods report it: the body of the single route. */
export interface TrackedEvent {
    notification_id: number;
    event: string;
    push_token: string;
}
/** What the batcher needs from the client; the offline queue provides most of it. */
export interface BatchHost {
    request(path: string, init: {
        method: 'POST';
        body: string;
    }): Promise<unknown>;
    /** How a thrown error is judged (the queue's own rule). */
    classify(error: unknown): BatchOutcome;
    /** The time (ms) until which a `Retry-After` holds every request, or 0. */
    pausedUntil(): number;
    /** Sends one event to a single route as the queue does: the request now, kept by the queue when it can pass. */
    sendSingle(path: string, body: Record<string, unknown>): Promise<void>;
    /** Keeps an event for later with the outcome of the failure that held it. */
    keep(path: string, body: Record<string, unknown>, outcome: Extract<BatchOutcome, {
        kind: 'retry';
    }>): Promise<void>;
    /** An event the server refused for good (200 when it was rejected inside a batch the server accepted). */
    refused(status: number, code?: string): void;
    /** A batch worked: the network is back, so what the queue holds may go. */
    delivered(): void;
}
export interface BatcherOptions {
    /** The dice. Default `Math.random`. */
    random?: () => number;
    /** The clock, in ms. Default `Date.now`. */
    now?: () => number;
}
/** The wait, in ms, before a `received` or `dismissed` report goes: a random 0 up to {@link SPREAD_WINDOW_MS}. */
export declare function spreadDelayMs(random?: () => number): number;
export declare class TrackBatcher {
    private readonly _host;
    private _pending;
    private _timer;
    private _lastFlushAt;
    private _batchRoute;
    private _running;
    private _destroyed;
    private readonly _random;
    private readonly _now;
    constructor(_host: BatchHost, options?: BatcherOptions);
    /**
     * Takes a delivery event. `opened` and `clicked` go now (with every event that is due); `received` and `dismissed` wait
     * their random delay. Resolves when a request it started ends; never rejects.
     */
    add(event: TrackedEvent): Promise<void>;
    /** Sends everything that waits, now, due or not. Resolves when the requests end; never rejects. */
    flush(): Promise<void>;
    /** Gives what waits to the offline queue as single events (the client is being destroyed) and sends nothing. */
    handOff(): Promise<void>;
    destroy(): void;
    private _clearTimer;
    /** One timer, for the soonest moment something can go: its time, and not before the gap after the last flush. */
    private _schedule;
    /**
     * Flushes one after the other. When nothing is running the flush starts in the same tick, so the request of an `opened`
     * leaves the app at the moment the tap is handled, as it did before the batcher existed.
     */
    private _flush;
    private _flushNow;
    /** The events in order, cut into runs of one token of at most {@link BATCH_MAX_EVENTS}. */
    private _chunks;
    private _sendEach;
    private _send;
    /** The whole request failed: no batch route, a refusal for good, or a failure that can pass. */
    private _failed;
    /** The events a batch the server accepted still rejected: kept when the reason can pass, dropped when it cannot. */
    private _rejections;
    private _keep;
}
