/**
 * @jest-environment node
 *
 * send-scale T40 (SCALE-26, SCALE-29): the batcher of the delivery events. `opened` and `clicked` go at once (well
 * inside 2 s), `received` and `dismissed` wait a random 0 to 30 s, at most 20 events go in a request and at most one
 * flush every 5 s; a batch route that answers 404 means single requests for the session, and nothing is lost.
 */
import { TrackBatcher, BATCH_PATH, SINGLE_PATH, SPREAD_WINDOW_MS, spreadDelayMs, type BatchHost, type BatchOutcome } from '../src/track-batch'
import { EspressoNotifyHttpError } from '../src/errors'

const T0 = 1_700_000_000_000
const TOKEN = 'ExponentPushToken[batch]'

type Call = { path: string; body: any; at: number }

/** A host with a scripted transport; `queue` records what the offline queue was handed. */
function makeHost(overrides: Partial<BatchHost> = {}) {
  const calls: Call[] = []
  const kept: Array<{ path: string; body: any; outcome: BatchOutcome }> = []
  const refused: Array<{ status: number; code?: string }> = []
  const state = { pausedUntil: 0, delivered: 0, respond: (_c: Call): unknown => ({}) as unknown }
  const host: BatchHost = {
    async request(path, init) {
      const call = { path, body: JSON.parse(init.body), at: Date.now() }
      calls.push(call)
      return state.respond(call)
    },
    classify: (error): BatchOutcome => {
      if (error instanceof EspressoNotifyHttpError) {
        if (error.status === 408 || error.status === 429 || error.status >= 500) {
          return { kind: 'retry', network: false, retryAfterMs: typeof error.retryAfter === 'number' ? error.retryAfter * 1000 : undefined }
        }
        return { kind: 'refused', status: error.status, code: error.code }
      }
      return { kind: 'retry', network: true }
    },
    pausedUntil: () => state.pausedUntil,
    sendSingle: async (path, body) => {
      // what EventQueue.send does: the request, and the queue keeps it on a failure that can pass
      const call = { path, body, at: Date.now() }
      calls.push(call)
      try { await state.respond(call) } catch (error) {
        const outcome = host.classify(error)
        if (outcome.kind === 'retry') kept.push({ path, body, outcome })
        else if (outcome.kind === 'refused') refused.push({ status: outcome.status, code: outcome.code })
      }
    },
    keep: async (path, body, outcome) => { kept.push({ path, body, outcome }) },
    refused: (status, code) => { refused.push({ status, code }) },
    delivered: () => { state.delivered++ },
    ...overrides,
  }
  return { host, calls, kept, refused, state }
}

const ev = (event: string, id: number, token = TOKEN) => ({ notification_id: id, event, push_token: token })
const http = (status: number, code?: string, retryAfter?: number) =>
  new EspressoNotifyHttpError(`HTTP ${status}`, status, code, BATCH_PATH, retryAfter)
const ok = (n: number) => ({ recorded: n, rejected: 0, results: Array.from({ length: n }, (_, index) => ({ index, status: 'recorded' })) })

beforeEach(() => { jest.useFakeTimers({ now: T0 }) })
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks() })

describe('how many go in a request', () => {
  it('45 events queued go out as 3 requests of 20, 20 and 5, in order', async () => {
    const { host, calls, state } = makeHost()
    state.respond = (c) => (c.path === BATCH_PATH ? ok(c.body.events.length) : {})
    const batcher = new TrackBatcher(host, { random: () => 0 })
    for (let i = 1; i <= 45; i++) await batcher.add(ev('received', i))

    await jest.advanceTimersByTimeAsync(0)

    expect(calls.map((c) => c.path)).toEqual([BATCH_PATH, BATCH_PATH, BATCH_PATH])
    expect(calls.map((c) => c.body.events.length)).toEqual([20, 20, 5])
    expect(calls.flatMap((c) => c.body.events.map((e: any) => e.notification_id))).toEqual(Array.from({ length: 45 }, (_, i) => i + 1))
    expect(calls[0].body).toEqual({ push_token: TOKEN, events: expect.any(Array) })
    expect(calls[0].body.events[0]).toEqual({ notification_id: 1, event: 'received' })
  })

  it('exactly 20 is one request and 21 is two', async () => {
    const { host, calls, state } = makeHost()
    state.respond = (c) => (c.path === BATCH_PATH ? ok(c.body.events.length) : {})
    const batcher = new TrackBatcher(host, { random: () => 0 })
    for (let i = 1; i <= 20; i++) await batcher.add(ev('dismissed', i))
    await jest.advanceTimersByTimeAsync(0)
    expect(calls.map((c) => c.body.events.length)).toEqual([20])

    for (let i = 21; i <= 41; i++) await batcher.add(ev('dismissed', i))
    await jest.advanceTimersByTimeAsync(5000)
    expect(calls.slice(1).map((c) => [c.path, c.path === BATCH_PATH ? c.body.events.length : 1])).toEqual([[BATCH_PATH, 20], [SINGLE_PATH, 1]])
  })

  it('a lone event goes to the single route with the body the previous SDK sent', async () => {
    const { host, calls } = makeHost()
    const batcher = new TrackBatcher(host, { random: () => 0 })
    await batcher.add(ev('received', 7))
    await jest.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    expect(calls[0].path).toBe(SINGLE_PATH)
    expect(calls[0].body).toEqual({ notification_id: 7, event: 'received', push_token: TOKEN })
  })

  it('never puts two tokens in one request', async () => {
    const { host, calls, state } = makeHost()
    state.respond = (c) => (c.path === BATCH_PATH ? ok(c.body.events.length) : {})
    const batcher = new TrackBatcher(host, { random: () => 0 })
    await batcher.add(ev('received', 1, 'tok-a'))
    await batcher.add(ev('received', 2, 'tok-a'))
    await batcher.add(ev('received', 3, 'tok-b'))
    await batcher.add(ev('received', 4, 'tok-b'))
    await jest.advanceTimersByTimeAsync(0)
    expect(calls.map((c) => [c.body.push_token, c.body.events.map((e: any) => e.notification_id)])).toEqual([
      ['tok-a', [1, 2]],
      ['tok-b', [3, 4]],
    ])
  })
})

describe('when they go', () => {
  it('opened and clicked go at once, well inside 2 s, and the add resolves after the request', async () => {
    const { host, calls } = makeHost()
    const batcher = new TrackBatcher(host)
    await batcher.add(ev('opened', 1))
    expect(calls).toHaveLength(1)
    expect(calls[0].at - T0).toBeLessThan(2000)
    await batcher.add(ev('clicked', 2))
    expect(calls).toHaveLength(2)
    expect(calls[1].body.event).toBe('clicked')
  })

  it('received waits the random delay of 0 to 30 s: half the dice is 15 s', async () => {
    const { host, calls } = makeHost()
    const batcher = new TrackBatcher(host, { random: () => 0.5 })
    await batcher.add(ev('received', 1))
    await jest.advanceTimersByTimeAsync(14_999)
    expect(calls).toHaveLength(0)
    await jest.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(1)
    expect(calls[0].at - T0).toBe(15_000)
  })

  it('dismissed waits like received, and the delay never reaches 30 s', async () => {
    const { host, calls } = makeHost()
    const batcher = new TrackBatcher(host, { random: () => 0.999999 })
    await batcher.add(ev('dismissed', 1))
    await jest.advanceTimersByTimeAsync(29_999)
    expect(calls).toHaveLength(1)
    expect(calls[0].at - T0).toBeLessThan(30_000)
  })

  it('goes at most once every 5 s: the second event waits for the gap after the first request', async () => {
    const { host, calls } = makeHost()
    const dice = [1 / 30, 2 / 30] // due at 1 s and at 2 s
    const batcher = new TrackBatcher(host, { random: () => dice.shift() ?? 0 })
    await batcher.add(ev('received', 1))
    await batcher.add(ev('received', 2))
    await jest.advanceTimersByTimeAsync(1000)
    expect(calls.map((c) => c.at - T0)).toEqual([1000])
    await jest.advanceTimersByTimeAsync(4999) // t = 5,999 ms: the event was due at 2 s but the last flush was at 1 s
    expect(calls).toHaveLength(1)
    await jest.advanceTimersByTimeAsync(1)
    expect(calls.map((c) => c.at - T0)).toEqual([1000, 6000])
  })

  it('a click is not held by the gap: it goes inside 2 s even right after another request', async () => {
    const { host, calls } = makeHost()
    const batcher = new TrackBatcher(host, { random: () => 0 })
    await batcher.add(ev('received', 1))
    await jest.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    await batcher.add(ev('clicked', 2))
    expect(calls).toHaveLength(2)
  })

  it('a click takes with it the events whose time came, and leaves the others', async () => {
    const { host, calls, state } = makeHost()
    state.respond = (c) => (c.path === BATCH_PATH ? ok(c.body.events.length) : {})
    const dice = [0, 0.5]
    const batcher = new TrackBatcher(host, { random: () => dice.shift() ?? 0 })
    await batcher.add(ev('received', 1)) // due now
    await batcher.add(ev('dismissed', 2)) // due at 15 s
    await batcher.add(ev('clicked', 3))
    expect(calls).toHaveLength(1)
    expect(calls[0].body.events.map((e: any) => e.notification_id)).toEqual([1, 3])
    await jest.advanceTimersByTimeAsync(15_000)
    expect(calls[1].path).toBe(SINGLE_PATH)
    expect(calls[1].body.notification_id).toBe(2)
  })

  it('1,000 simulated devices spread their received events over the window: no second holds more than 15%', async () => {
    let seed = 12345
    const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000 }
    const perSecond = new Map<number, number>()
    const hosts = Array.from({ length: 1000 }, () => {
      const { host } = makeHost({
        request: async (path) => { const s = Math.floor((Date.now() - T0) / 1000); perSecond.set(s, (perSecond.get(s) ?? 0) + 1); return path === BATCH_PATH ? ok(1) : {} },
        sendSingle: async () => { const s = Math.floor((Date.now() - T0) / 1000); perSecond.set(s, (perSecond.get(s) ?? 0) + 1) },
      })
      return host
    })
    // every device got the same push at the same moment
    for (const [i, host] of hosts.entries()) await new TrackBatcher(host, { random }).add(ev('received', 42 + 0 * i))
    await jest.advanceTimersByTimeAsync(31_000)

    const total = [...perSecond.values()].reduce((a, b) => a + b, 0)
    expect(total).toBe(1000)
    expect(perSecond.size).toBeGreaterThan(25) // spread over the window, not a few instants
    expect(Math.max(...perSecond.values()) / total).toBeLessThanOrEqual(0.15)
  })

  it('the delay is uniform over 0 to 30 s: 1,000 samples fill every 5 s of the window', () => {
    const samples = Array.from({ length: 1000 }, () => spreadDelayMs())
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...samples)).toBeLessThan(SPREAD_WINDOW_MS)
    const bins = new Array(6).fill(0)
    for (const d of samples) bins[Math.floor(d / 5000)]++
    for (const n of bins) expect(n).toBeGreaterThan(100) // 1000/6 = 167 each, give or take
    expect(spreadDelayMs(() => 0)).toBe(0)
    expect(spreadDelayMs(() => 0.999999)).toBe(29_999)
  })
})

describe('flush and hand-off', () => {
  it('flush() sends everything now, due or not', async () => {
    const { host, calls, state } = makeHost()
    state.respond = (c) => (c.path === BATCH_PATH ? ok(c.body.events.length) : {})
    const batcher = new TrackBatcher(host, { random: () => 0.9 })
    await batcher.add(ev('received', 1))
    await batcher.add(ev('received', 2))
    expect(calls).toHaveLength(0)
    await batcher.flush()
    expect(calls).toHaveLength(1)
    expect(calls[0].body.events).toHaveLength(2)
    await jest.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(1) // nothing is sent twice
  })

  it('flush() with nothing waiting does nothing', async () => {
    const { host, calls } = makeHost()
    await new TrackBatcher(host).flush()
    expect(calls).toHaveLength(0)
  })

  it('handOff() gives what waits to the offline queue as single events and sends nothing', async () => {
    const { host, calls, kept } = makeHost()
    const batcher = new TrackBatcher(host, { random: () => 0.9 })
    await batcher.add(ev('received', 1))
    await batcher.add(ev('dismissed', 2))
    await batcher.handOff()
    expect(calls).toHaveLength(0)
    expect(kept.map((k) => [k.path, k.body.notification_id, k.body.event])).toEqual([
      [SINGLE_PATH, 1, 'received'],
      [SINGLE_PATH, 2, 'dismissed'],
    ])
    await jest.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(0)
  })

  it('destroy() stops the timer', async () => {
    const { host, calls } = makeHost()
    const batcher = new TrackBatcher(host, { random: () => 0.5 })
    await batcher.add(ev('received', 1))
    batcher.destroy()
    await jest.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(0)
  })
})

describe('a batch route that is not there (SCALE-29)', () => {
  it('a 404 without a code means single requests, loses no event, and keeps doing so for the session', async () => {
    const { host, calls, state } = makeHost()
    state.respond = (c) => { if (c.path === BATCH_PATH) throw http(404); return {} }
    const batcher = new TrackBatcher(host, { random: () => 0 })
    for (let i = 1; i <= 3; i++) await batcher.add(ev('received', i))
    await jest.advanceTimersByTimeAsync(0)

    expect(calls.map((c) => c.path)).toEqual([BATCH_PATH, SINGLE_PATH, SINGLE_PATH, SINGLE_PATH])
    expect(calls.slice(1).map((c) => c.body.notification_id)).toEqual([1, 2, 3])
    expect(calls[1].body).toEqual({ notification_id: 1, event: 'received', push_token: TOKEN })

    for (let i = 4; i <= 6; i++) await batcher.add(ev('received', i))
    await jest.advanceTimersByTimeAsync(5000)
    expect(calls.filter((c) => c.path === BATCH_PATH)).toHaveLength(1) // never asked again
    expect(calls.slice(4).map((c) => c.path)).toEqual([SINGLE_PATH, SINGLE_PATH, SINGLE_PATH])
  })

  it('a 404 unknown_device is the answer of a route that exists: the events are dropped, the route is kept', async () => {
    const { host, calls, refused, state } = makeHost()
    state.respond = (c) => { if (c.path === BATCH_PATH) throw http(404, 'unknown_device'); return {} }
    const batcher = new TrackBatcher(host, { random: () => 0 })
    await batcher.add(ev('received', 1))
    await batcher.add(ev('received', 2))
    await jest.advanceTimersByTimeAsync(0)
    expect(calls.map((c) => c.path)).toEqual([BATCH_PATH])
    expect(refused).toEqual([{ status: 404, code: 'unknown_device' }, { status: 404, code: 'unknown_device' }])

    await batcher.add(ev('received', 3))
    await batcher.add(ev('received', 4))
    await jest.advanceTimersByTimeAsync(5000)
    expect(calls.filter((c) => c.path === BATCH_PATH)).toHaveLength(2)
  })
})

describe('a batch that fails', () => {
  it.each([
    ['a 503', () => http(503)],
    ['a 429 with Retry-After', () => http(429, 'rate_limited', 30)],
    ['a network error', () => new TypeError('Network request failed')],
  ])('%s: every event is kept in the offline queue as a single event, none is lost', async (_name, makeError) => {
    const { host, kept, state } = makeHost()
    state.respond = (c) => { if (c.path === BATCH_PATH) throw makeError(); return {} }
    const batcher = new TrackBatcher(host, { random: () => 0 })
    for (let i = 1; i <= 3; i++) await batcher.add(ev('received', i))
    await jest.advanceTimersByTimeAsync(0)

    expect(kept.map((k) => [k.path, k.body.notification_id, k.outcome.kind])).toEqual([
      [SINGLE_PATH, 1, 'retry'], [SINGLE_PATH, 2, 'retry'], [SINGLE_PATH, 3, 'retry'],
    ])
    expect(kept[0].body).toEqual({ notification_id: 1, event: 'received', push_token: TOKEN })
  })

  it('a 400 refuses the whole batch: the events are dropped and counted', async () => {
    const { host, kept, refused, state } = makeHost()
    state.respond = (c) => { if (c.path === BATCH_PATH) throw http(400, 'invalid_push_token'); return {} }
    const batcher = new TrackBatcher(host, { random: () => 0 })
    await batcher.add(ev('received', 1))
    await batcher.add(ev('received', 2))
    await jest.advanceTimersByTimeAsync(0)
    expect(kept).toEqual([])
    expect(refused).toEqual([{ status: 400, code: 'invalid_push_token' }, { status: 400, code: 'invalid_push_token' }])
  })

  it('what the queue is waiting out (a Retry-After) is not sent: the single path keeps each event', async () => {
    const { host, calls, state } = makeHost()
    state.pausedUntil = T0 + 60_000
    const batcher = new TrackBatcher(host, { random: () => 0 })
    await batcher.add(ev('received', 1))
    await batcher.add(ev('received', 2))
    await jest.advanceTimersByTimeAsync(0)
    expect(calls.every((c) => c.path === SINGLE_PATH)).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('a click with a Retry-After pending goes to the single path too', async () => {
    const { host, calls, state } = makeHost()
    state.pausedUntil = T0 + 60_000
    await new TrackBatcher(host).add(ev('opened', 1))
    expect(calls.map((c) => c.path)).toEqual([SINGLE_PATH])
  })
})

describe('the answer of the batch route', () => {
  it('tells the host the network is back after a batch that worked', async () => {
    const { host, state } = makeHost()
    state.respond = (c) => (c.path === BATCH_PATH ? ok(2) : {})
    const batcher = new TrackBatcher(host, { random: () => 0 })
    await batcher.add(ev('received', 1))
    await batcher.add(ev('received', 2))
    await jest.advanceTimersByTimeAsync(0)
    expect(state.delivered).toBe(1)
  })

  it('keeps the events the server rate-limited, with the wait it gave, and drops the ones it refused for good', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0) // no jitter on the Retry-After here (T38 covers it)
    const { host, kept, refused, state } = makeHost()
    state.respond = (c) => c.path === BATCH_PATH
      ? { recorded: 1, rejected: 3, results: [
          { index: 0, status: 'recorded' },
          { index: 1, status: 'rejected', code: 'rate_limited', retry_after: 12 },
          { index: 2, status: 'rejected', code: 'unknown_notification' },
          { index: 3, status: 'rejected', code: 'track_unavailable' },
        ] }
      : {}
    const batcher = new TrackBatcher(host, { random: () => 0 })
    for (let i = 1; i <= 4; i++) await batcher.add(ev('received', i))
    await jest.advanceTimersByTimeAsync(0)

    expect(kept.map((k) => [k.body.notification_id, k.outcome])).toEqual([
      [2, { kind: 'retry', network: false, retryAfterMs: 12_000 }],
      [4, { kind: 'retry', network: false }],
    ])
    expect(refused).toEqual([{ status: 200, code: 'unknown_notification' }]) // 200: rejected inside a batch the server accepted
  })

  it('an answer it cannot read counts the batch as delivered', async () => {
    const { host, kept, refused, state } = makeHost()
    state.respond = (c) => (c.path === BATCH_PATH ? 'not an object' : {})
    const batcher = new TrackBatcher(host, { random: () => 0 })
    await batcher.add(ev('received', 1))
    await batcher.add(ev('received', 2))
    await jest.advanceTimersByTimeAsync(0)
    expect(kept).toEqual([])
    expect(refused).toEqual([])
  })
})

describe('what is not batched', () => {
  it('ignores an event with no push token: nothing to send it with', async () => {
    const { host, calls } = makeHost()
    const batcher = new TrackBatcher(host)
    await batcher.add({ notification_id: 1, event: 'opened', push_token: '' })
    expect(calls).toHaveLength(0)
  })
})
