/**
 * @jest-environment node
 *
 * send-scale T39 (SCALE-39, D-159): the tracker that decides whether `register` and `identify` have to run. A call is
 * remembered after it WORKED, as a fingerprint (token, app version, user) and the session; it runs again when the
 * fingerprint differs or the remembered call belongs to an earlier session (a cold start, or a return to the foreground
 * after at least 30 seconds out of it).
 */
import { RegistrationTracker, SESSION_GAP_MS, type RegistrationParts } from '../src/registration'

class FakeStore {
  readonly map = new Map<string, string>()
  failRead = false
  failWrite = false
  async getItem(key: string) {
    if (this.failRead) throw new Error('store down')
    return this.map.get(key) ?? null
  }
  async setItem(key: string, value: string) {
    if (this.failWrite) throw new Error('store down')
    this.map.set(key, value)
  }
  text() { return [...this.map.values()].join('\n') }
}

const KEY = 'espresso.registration.pk_live_test'
const base: RegistrationParts = { token: 'ExponentPushToken[abc-secret]', appVersion: '1.0.0', userId: 'user-secret-7' }
let now = 1_700_000_000_000
const clock = () => now

function make(store = new FakeStore(), extra: { sessionId?: string; getAppVersion?: () => string | undefined } = {}) {
  return { store, tracker: new RegistrationTracker(store, KEY, { now: clock, ...extra }) }
}

/** Runs the call the way the hook does: plan, then commit when it worked. Returns whether it ran. */
async function run(tracker: RegistrationTracker, kind: 'register' | 'identify', parts: RegistrationParts = base): Promise<boolean> {
  const ticket = await tracker.plan(kind, parts)
  if (!ticket) return false
  await tracker.commit(ticket)
  return true
}

beforeEach(() => { now = 1_700_000_000_000 })

describe('the first call and the same call again', () => {
  it('runs when nothing was sent yet, and not again in the same session', async () => {
    const { tracker } = make()
    expect(await run(tracker, 'register')).toBe(true)
    expect(await run(tracker, 'register')).toBe(false)
    expect(await run(tracker, 'identify')).toBe(true)
    expect(await run(tracker, 'identify')).toBe(false)
  })

  it('keeps register and identify apart', async () => {
    const { tracker } = make()
    await run(tracker, 'register')
    expect(await tracker.plan('identify', base)).not.toBeNull()
  })
})

describe('a change of what is sent', () => {
  it.each([
    ['the token', { token: 'ExponentPushToken[other]' }],
    ['the app version', { appVersion: '1.0.1' }],
    ['the user', { userId: 'user-8' }],
    ['the user becoming anonymous', { userId: null }],
  ])('runs at once when %s changes', async (_name, change) => {
    const { tracker } = make()
    await run(tracker, 'register')
    await run(tracker, 'identify')
    expect(await tracker.plan('register', { ...base, ...change })).not.toBeNull()
    expect(await tracker.plan('identify', { ...base, ...change })).not.toBeNull()
  })

  it('identify also notices a new name or a new proof of identity', async () => {
    const { tracker } = make()
    await run(tracker, 'identify', { ...base, userName: 'Ana', identityHash: 'a'.repeat(64) })
    expect(await tracker.plan('identify', { ...base, userName: 'Ana', identityHash: 'a'.repeat(64) })).toBeNull()
    expect(await tracker.plan('identify', { ...base, userName: 'Ana B', identityHash: 'a'.repeat(64) })).not.toBeNull()
    expect(await tracker.plan('identify', { ...base, userName: 'Ana', identityHash: 'b'.repeat(64) })).not.toBeNull()
  })

  it('takes the app version from the getter when the parts do not carry one', async () => {
    let version: string | undefined = '2.0.0'
    const { tracker } = make(new FakeStore(), { getAppVersion: () => version })
    const parts = { token: base.token, userId: base.userId }
    await run(tracker, 'register', parts)
    expect(await tracker.plan('register', parts)).toBeNull()
    version = '2.0.1'
    expect(await tracker.plan('register', parts)).not.toBeNull()
  })

  it('does not mix two fields that would read the same side by side', async () => {
    const { tracker } = make()
    await run(tracker, 'register', { token: 'ab', appVersion: 'c', userId: 'd' })
    expect(await tracker.plan('register', { token: 'a', appVersion: 'bc', userId: 'd' })).not.toBeNull()
  })
})

describe('the session', () => {
  it('a foreground 10 s after leaving is the same session: nothing runs', async () => {
    const { tracker } = make()
    await run(tracker, 'register')
    tracker.noteAppState('background')
    now += 10_000
    tracker.noteAppState('active')
    expect(await tracker.plan('register', base)).toBeNull()
  })

  it('a return after 31 s in the background is a new session: it runs again', async () => {
    const { tracker } = make()
    await run(tracker, 'register')
    const before = tracker.sessionId
    tracker.noteAppState('background')
    now += 31_000
    tracker.noteAppState('active')
    expect(tracker.sessionId).not.toBe(before)
    expect(await run(tracker, 'register')).toBe(true)
    expect(await run(tracker, 'register')).toBe(false)
  })

  it('the gap is "at least 30 seconds": 29.999 s is not enough, 30 s is', async () => {
    const { tracker } = make()
    const first = tracker.sessionId
    tracker.noteAppState('background')
    now += SESSION_GAP_MS - 1
    tracker.noteAppState('active')
    expect(tracker.sessionId).toBe(first)
    tracker.noteAppState('background')
    now += SESSION_GAP_MS
    tracker.noteAppState('active')
    expect(tracker.sessionId).not.toBe(first)
  })

  it('the time counts from the first state outside the foreground (inactive, then background)', async () => {
    const { tracker } = make()
    const first = tracker.sessionId
    tracker.noteAppState('inactive')
    now += 20_000
    tracker.noteAppState('background')
    now += 20_000
    tracker.noteAppState('active')
    expect(tracker.sessionId).not.toBe(first) // 40 s since it left, not 20
  })

  it('a short return restarts the count: 20 s out, 5 s in, 20 s out is two short absences', async () => {
    const { tracker } = make()
    const first = tracker.sessionId
    tracker.noteAppState('background')
    now += 20_000
    tracker.noteAppState('active')
    now += 5_000
    tracker.noteAppState('background')
    now += 20_000
    tracker.noteAppState('active')
    expect(tracker.sessionId).toBe(first)
  })

  it('"active" with no earlier absence changes nothing', () => {
    const { tracker } = make()
    const first = tracker.sessionId
    tracker.noteAppState('active')
    expect(tracker.sessionId).toBe(first)
  })

  it('a cold start is a new session even when the fingerprint is the same', async () => {
    const store = new FakeStore()
    const run1 = make(store)
    await run(run1.tracker, 'register')
    await run(run1.tracker, 'identify')

    const run2 = make(store) // the app was killed and started again: same store, new tracker, new session id
    expect(run2.tracker.sessionId).not.toBe(run1.tracker.sessionId)
    expect(await run(run2.tracker, 'register')).toBe(true)
    expect(await run(run2.tracker, 'identify')).toBe(true)
    expect(await run(run2.tracker, 'register')).toBe(false)
  })

  it('the same app process creating the tracker twice with the same session id remembers the call', async () => {
    const store = new FakeStore()
    await run(make(store, { sessionId: 's-1' }).tracker, 'register')
    expect(await make(store, { sessionId: 's-1' }).tracker.plan('register', base)).toBeNull()
  })
})

describe('a call that fails', () => {
  it('stores nothing when it is not committed, and runs again at the next try', async () => {
    const { tracker, store } = make()
    const ticket = await tracker.plan('register', base)
    expect(ticket).not.toBeNull() // the call is made and fails: no commit
    expect(store.map.size).toBe(0)
    expect(await tracker.plan('register', base)).not.toBeNull()
  })

  it('a call that worked in one session is not hidden by a failed one of another fingerprint', async () => {
    const { tracker } = make()
    await run(tracker, 'register')
    await tracker.plan('register', { ...base, token: 'ExponentPushToken[new]' }) // fails: not committed
    expect(await tracker.plan('register', base)).toBeNull() // the old state still stands
    expect(await tracker.plan('register', { ...base, token: 'ExponentPushToken[new]' })).not.toBeNull()
  })
})

describe('what is on disk', () => {
  it('holds hashes and a session id, never the token or the user id', async () => {
    const { tracker, store } = make()
    await run(tracker, 'register', { ...base, userName: 'Ana Secret', identityHash: 'f'.repeat(64) })
    await run(tracker, 'identify', { ...base, userName: 'Ana Secret', identityHash: 'f'.repeat(64) })
    const text = store.text()
    expect(text).not.toContain('abc-secret')
    expect(text).not.toContain('user-secret-7')
    expect(text).not.toContain('Ana Secret')
    expect(text).not.toContain('f'.repeat(64))
    expect(JSON.parse(store.map.get(KEY)!)).toEqual({
      v: 1,
      register: { f: expect.stringMatching(/^[0-9a-f]{14}$/), s: tracker.sessionId },
      identify: { f: expect.stringMatching(/^[0-9a-f]{14}$/), s: tracker.sessionId },
    })
  })

  it.each([
    ['nothing', null],
    ['text that is not JSON', 'not json {'],
    ['a value of the previous SDK (no such key; here a bare string)', '"registered"'],
    ['a record with the wrong types', '{"v":1,"register":{"f":1,"s":null},"identify":"x"}'],
    ['an array', '[1,2]'],
  ])('reads %s as "nothing was sent": it runs once and never errors', async (_name, stored) => {
    const store = new FakeStore()
    if (stored !== null) store.map.set(KEY, stored)
    const { tracker } = make(store)
    await expect(tracker.plan('register', base)).resolves.not.toBeNull()
    expect(await run(tracker, 'register')).toBe(true)
    expect(await run(tracker, 'register')).toBe(false)
  })

  it('does not trust a record of another version, even one that would match', async () => {
    const store = new FakeStore()
    const first = make(store, { sessionId: 's-1' })
    await run(first.tracker, 'register')
    store.map.set(KEY, store.map.get(KEY)!.replace('"v":1', '"v":2'))
    expect(await make(store, { sessionId: 's-1' }).tracker.plan('register', base)).not.toBeNull()
  })

  it('keeps the other call when one of the two is damaged', async () => {
    const store = new FakeStore()
    const first = make(store, { sessionId: 's-1' })
    await run(first.tracker, 'identify')
    const stored = JSON.parse(store.map.get(KEY)!)
    store.map.set(KEY, JSON.stringify({ ...stored, register: { f: 5 } }))
    const second = make(store, { sessionId: 's-1' })
    expect(await second.tracker.plan('register', base)).not.toBeNull()
    expect(await second.tracker.plan('identify', base)).toBeNull()
  })
})

describe('a store that fails', () => {
  it('a store that cannot be read means "run", and does not throw', async () => {
    const store = new FakeStore()
    store.failRead = true
    const { tracker } = make(store)
    await expect(tracker.plan('register', base)).resolves.not.toBeNull()
  })

  it('a store that cannot be written does not throw, and the call is still remembered for the run', async () => {
    const store = new FakeStore()
    store.failWrite = true
    const { tracker } = make(store)
    const ticket = await tracker.plan('register', base)
    await expect(tracker.commit(ticket!)).resolves.toBeUndefined()
    expect(await tracker.plan('register', base)).toBeNull() // in memory
    expect(store.map.size).toBe(0)
  })

  it('reads the store again after a read that failed', async () => {
    const store = new FakeStore()
    const warm = make(store, { sessionId: 's-1' })
    await run(warm.tracker, 'register')
    const cold = make(store, { sessionId: 's-1' })
    store.failRead = true
    expect(await cold.tracker.plan('register', base)).not.toBeNull()
    store.failRead = false
    expect(await cold.tracker.plan('register', base)).toBeNull()
  })
})

describe('forget', () => {
  it('makes the next plan of that call run, and leaves the other', async () => {
    const { tracker } = make()
    await run(tracker, 'register')
    await run(tracker, 'identify')
    await tracker.forget('identify')
    expect(await tracker.plan('identify', base)).not.toBeNull()
    expect(await tracker.plan('register', base)).toBeNull()
  })

  it('is written to the store', async () => {
    const { tracker, store } = make()
    await run(tracker, 'identify')
    await tracker.forget('identify')
    expect(JSON.parse(store.map.get(KEY)!).identify).toBeUndefined()
  })
})

describe('two calls at once', () => {
  it('commits of the two kinds in the same tick are both kept', async () => {
    const { tracker, store } = make()
    const [a, b] = await Promise.all([tracker.plan('register', base), tracker.plan('identify', base)])
    await Promise.all([tracker.commit(a!), tracker.commit(b!)])
    const stored = JSON.parse(store.map.get(KEY)!)
    expect(Object.keys(stored).sort()).toEqual(['identify', 'register', 'v'])
  })
})
