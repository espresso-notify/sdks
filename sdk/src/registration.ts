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

/** The two calls that are remembered. */
export type RegistrationKind = 'register' | 'identify'

/** The part of a `KeyStore` this module needs. */
export interface RegistrationStore {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
}

/** What a call sends about the device and the user; the fingerprint is made of it. */
export interface RegistrationParts {
  token: string
  /** Defaults to the app version the tracker was given. */
  appVersion?: string
  /** The external id of the user, or null/undefined for an anonymous device. */
  userId?: string | null
  /** `identify` only: the display name and the proof of identity sent with the user; a change of either is a change. */
  userName?: string | null
  identityHash?: string | null
}

/** The permission to run a call, given by {@link RegistrationTracker.plan} and handed back to `commit` when the call worked. */
export interface RegistrationTicket {
  readonly kind: RegistrationKind
  readonly fingerprint: string
  readonly session: string
}

export interface RegistrationOptions {
  /** The clock, in ms. Default `Date.now`. */
  now?: () => number
  /** The id of the session this run starts with. Default: a random one (a cold start is a new session). */
  sessionId?: string
  /** The version of the app, added to every fingerprint. */
  getAppVersion?: () => string | undefined
}

/** How long the app must be out of the foreground for its return to start a new session (30 seconds). */
export const SESSION_GAP_MS = 30_000

interface Remembered { f: string; s: string }
interface Stored { v: 1; register?: Remembered; identify?: Remembered }

/** A 53-bit hash of a text (cyrb53) as 14 hex characters: enough to tell two fingerprints apart, not a secret. */
function hashText(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

function randomSessionId(): string {
  let out = ''
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      for (const byte of crypto.getRandomValues(new Uint8Array(8))) out += byte.toString(16).padStart(2, '0')
    }
  } catch { /* fall back below */ }
  while (out.length < 16) out += Math.floor(Math.random() * 16).toString(16)
  return out
}

export class RegistrationTracker {
  private _session: string
  private _record: Stored | null = null
  private _loading: Promise<Stored> | null = null
  private _chain: Promise<unknown> = Promise.resolve()
  /** When the app left the foreground, or null while it is in it. */
  private _leftAt: number | null = null
  private readonly _now: () => number

  constructor(
    private readonly _store: RegistrationStore,
    private readonly _key: string,
    private readonly _options: RegistrationOptions = {},
  ) {
    this._session = _options.sessionId ?? randomSessionId()
    this._now = _options.now ?? Date.now
  }

  /** The session the calls are being made in. */
  get sessionId(): string {
    return this._session
  }

  /**
   * Tells the tracker that the app changed state (`active`, `inactive`, `background`). Coming back to `active` after at
   * least {@link SESSION_GAP_MS} out of it starts a new session.
   */
  noteAppState(state: string): void {
    if (state === 'active') {
      if (this._leftAt !== null && this._now() - this._leftAt >= SESSION_GAP_MS) this._session = randomSessionId()
      this._leftAt = null
    } else if (this._leftAt === null) {
      this._leftAt = this._now()
    }
  }

  /**
   * Whether the call has to run: a ticket when the server may not know this state, null when it is known (the same
   * fingerprint, remembered in this session). Never throws; a store that cannot be read means "run".
   */
  async plan(kind: RegistrationKind, parts: RegistrationParts): Promise<RegistrationTicket | null> {
    const fingerprint = this._fingerprint(parts)
    const session = this._session
    let record: Stored
    try { record = await this._read() } catch { return { kind, fingerprint, session } }
    const known = record[kind]
    if (known && known.f === fingerprint && known.s === session) return null
    return { kind, fingerprint, session }
  }

  /** Remembers a call that worked. Never throws; a store that cannot be written only means the call may run again. */
  commit(ticket: RegistrationTicket): Promise<void> {
    return this._update((record) => { record[ticket.kind] = { f: ticket.fingerprint, s: ticket.session } })
  }

  /** Forgets a call, so the next `plan` of it runs (the user logged out: the next login must identify again). */
  forget(kind: RegistrationKind): Promise<void> {
    return this._update((record) => { delete record[kind] })
  }

  private _fingerprint(parts: RegistrationParts): string {
    const appVersion = parts.appVersion ?? this._options.getAppVersion?.() ?? ''
    // JSON keeps the fields apart (a user id that ends like a token cannot be confused with it).
    return hashText(JSON.stringify([parts.token, appVersion, parts.userId ?? '', parts.userName ?? '', parts.identityHash ?? '']))
  }

  private _read(): Promise<Stored> {
    if (this._record) return Promise.resolve(this._record)
    if (!this._loading) {
      this._loading = (async () => {
        let record: Stored = { v: 1 }
        try {
          const text = await this._store.getItem(this._key)
          record = this._parse(text)
        } catch (error) {
          this._loading = null // a store that failed to answer is asked again next time
          throw error
        }
        this._record = record
        return record
      })()
    }
    return this._loading
  }

  /** The record of a stored text; anything that is not the expected shape (no value, an older SDK, damage) is empty. */
  private _parse(text: string | null): Stored {
    const empty: Stored = { v: 1 }
    if (!text) return empty
    try {
      const value = JSON.parse(text)
      if (!value || value.v !== 1) return empty
      const pick = (r: any): Remembered | undefined =>
        r && typeof r.f === 'string' && typeof r.s === 'string' ? { f: r.f, s: r.s } : undefined
      const out: Stored = { v: 1 }
      const register = pick(value.register)
      const identify = pick(value.identify)
      if (register) out.register = register
      if (identify) out.identify = identify
      return out
    } catch {
      return empty
    }
  }

  private _update(change: (record: Stored) => void): Promise<void> {
    const run = this._chain.then(async () => {
      let record: Stored
      try { record = await this._read() } catch { record = this._record ?? { v: 1 } }
      change(record)
      this._record = record
      await this._store.setItem(this._key, JSON.stringify(record)) // a write that fails is swallowed below: the call may run again at worst
    })
    this._chain = run.then(() => undefined, () => undefined)
    return run.catch(() => undefined)
  }
}
