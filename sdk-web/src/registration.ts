/**
 * Subscribe and identify only on change or on a new session (send-scale SCALE-39; owner decision D-196). The twin of
 * sdk/src/registration.ts.
 *
 * Why: every page load used to post the subscription and, for a signed-in visitor, post it again with `identify`.
 * With thousands of visitors that is most of the traffic of a project, and almost all of it tells the server what it
 * already knows. The rule: after a call works, the SDK remembers WHAT it sent (a hash of the subscription, the user and
 * the versions) and in WHICH session. It sends again only when the hash differs, or when the call that is remembered
 * belongs to an earlier session.
 *
 * A web session is one tab: its id lives in `sessionStorage`, so a reload or another page of the site keeps it, and a
 * new tab or a new window starts another. It also ends when the page is opened, or shown again, 30 minutes or more after
 * the last time it was seen (a tab that was left open overnight). Where the browser has no `sessionStorage` every page
 * load is a session, which is what the SDK did before this rule.
 *
 * A call that fails is never remembered, so the next page load tries it again.
 *
 * What is stored is a hash and session ids, never the endpoint, the keys, the user id, the name or the proof of
 * identity: `localStorage` can be read by any script of the site. A value left by an older SDK, or a damaged one, reads
 * as "nothing was sent yet": the call runs once, never an error. A storage that cannot be read or written (a private
 * window, a full disk) only means the call runs every time.
 */

/** The version of this package; `package.json` says the same (a test keeps the two equal). */
export const SDK_VERSION = "0.0.2";

/** The two calls that are remembered. */
export type RegistrationKind = "register" | "identify";

/** How long the page must be out of sight, or the tab untouched, for the next sight of it to start a new session (30 minutes). */
export const SESSION_GAP_MS = 30 * 60 * 1000;

/** How many sessions of one unchanged state are remembered (tabs that took turns); the oldest is forgotten first. */
export const REMEMBERED_SESSIONS = 8;

/** The part of a web storage this module needs. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The part of `document` this module needs to know when the page is hidden and shown. */
export interface PageLike {
  visibilityState?: string;
  addEventListener(type: string, listener: () => void): void;
}

/** What a call sends about the browser and the user; the fingerprint is made of it. */
export interface RegistrationParts {
  endpoint: string;
  p256dh?: string;
  auth?: string;
  /** The VAPID key the subscription was made with. */
  vapidKey?: string;
  timezone?: string;
  /** `identify` only: the external id of the user, the display name and the proof of identity; a change of any is a change. */
  userId?: string | null;
  userName?: string | null;
  identityHash?: string | null;
}

/** The permission to run a call, given by {@link RegistrationTracker.plan} and handed back to `commit` when the call worked. */
export interface RegistrationTicket {
  readonly kind: RegistrationKind;
  readonly fingerprint: string;
  readonly session: string;
}

export interface RegistrationOptions {
  /** The key of the record in the storage. */
  key: string;
  /** The public key of the project; part of every fingerprint. */
  projectKey: string;
  /** The version of the app the site declares, part of every fingerprint. */
  appVersion?: string;
  /** Default {@link SDK_VERSION}. */
  sdkVersion?: string;
  /** Where the record lives. Default `localStorage` when it can be used; `null` for none (every plan runs). */
  storage?: StorageLike | null;
  /** Where the session lives. Default `sessionStorage` when it can be used; `null` for none (every page load is a session). */
  sessionStorage?: StorageLike | null;
  /** The clock, in ms. Default `Date.now`. */
  now?: () => number;
  /** The page whose visibility is watched. Default `document` when there is one; `null` for none. */
  page?: PageLike | null;
}

interface Remembered { f: string; s: string[] }
interface Stored { v: 1; register?: Remembered; identify?: Remembered }
interface SessionRecord { id: string; seen: number }

const SESSION_KEY = "espresso-notify:session";

/** A storage of the browser, or null where there is none or the browser refuses it (reading the property can throw). */
function browserStorage(name: "localStorage" | "sessionStorage"): StorageLike | null {
  try {
    const found = (globalThis as Record<string, unknown>)[name] as StorageLike | undefined;
    return found && typeof found.getItem === "function" ? found : null;
  } catch {
    return null;
  }
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** A 53-bit hash of a text (cyrb53) as 14 hex characters: the fallback where SubtleCrypto is missing. Not a secret. */
function plainHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** The hash of a text: `s` and 32 hex characters of its SHA-256, or `c` and a plain hash where SubtleCrypto is missing. */
async function hashText(text: string): Promise<string> {
  try {
    const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
    if (subtle) return "s" + hex(new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(text)))).slice(0, 32);
  } catch {
    // fall back below
  }
  return "c" + plainHash(text);
}

function randomSessionId(): string {
  let out = "";
  try {
    const random = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
    if (typeof random?.getRandomValues === "function") out = hex(random.getRandomValues(new Uint8Array(8)));
  } catch {
    // fall back below
  }
  while (out.length < 16) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

export class RegistrationTracker {
  private readonly store: StorageLike | null;
  private readonly sessionStore: StorageLike | null;
  private readonly now: () => number;
  private session: string;
  /** When the page left the screen, or null while it is on it. */
  private leftAt: number | null = null;

  constructor(private readonly options: RegistrationOptions) {
    this.store = options.storage === undefined ? browserStorage("localStorage") : options.storage;
    this.sessionStore = options.sessionStorage === undefined ? browserStorage("sessionStorage") : options.sessionStorage;
    this.now = options.now ?? Date.now;
    this.session = this.openSession();
    this.watchPage(options.page === undefined ? (globalThis as { document?: PageLike }).document ?? null : options.page);
  }

  /** The session the calls are being made in. */
  get sessionId(): string {
    return this.session;
  }

  /**
   * Whether the call has to run: a ticket when the server may not know this state, null when it is known (the same
   * fingerprint, remembered in this session). `force` always gives a ticket (a call that carries a consent record, or
   * an endpoint to replace). Never throws; a store that cannot be read means "run".
   */
  async plan(kind: RegistrationKind, parts: RegistrationParts, options: { force?: boolean } = {}): Promise<RegistrationTicket | null> {
    const session = this.session;
    // With no storage nothing is remembered, so there is nothing to compare and nothing to hash.
    if (!this.store) return { kind, fingerprint: "", session };
    const fingerprint = await this.fingerprint(kind, parts);
    if (!options.force) {
      const known = this.read()[kind];
      if (known && known.f === fingerprint && known.s.includes(session)) return null;
    }
    return { kind, fingerprint, session };
  }

  /** Remembers a call that worked. Never throws; a store that cannot be written only means the call may run again. */
  async commit(ticket: RegistrationTicket): Promise<void> {
    const record = this.read();
    const known = record[ticket.kind];
    const sessions = known && known.f === ticket.fingerprint ? known.s.filter((s) => s !== ticket.session) : [];
    sessions.push(ticket.session);
    record[ticket.kind] = { f: ticket.fingerprint, s: sessions.slice(-REMEMBERED_SESSIONS) };
    this.write(record);
  }

  /** Forgets one call, or both, so the next `plan` runs (the browser was unsubscribed or erased). */
  async forget(kind?: RegistrationKind): Promise<void> {
    if (!kind) {
      try { this.store?.removeItem(this.options.key); } catch { /* the record stays; the call may be skipped once too often at worst */ }
      return;
    }
    const record = this.read();
    delete record[kind];
    this.write(record);
  }

  private fingerprint(kind: RegistrationKind, p: RegistrationParts): Promise<string> {
    // JSON keeps the fields apart (a user id that ends like a key cannot be confused with it).
    return hashText(
      JSON.stringify([
        kind,
        this.options.projectKey,
        this.options.sdkVersion ?? SDK_VERSION,
        this.options.appVersion ?? "",
        p.endpoint,
        p.p256dh ?? "",
        p.auth ?? "",
        p.vapidKey ?? "",
        p.timezone ?? "",
        p.userId ?? "",
        p.userName ?? "",
        p.identityHash ?? "",
      ]),
    );
  }

  /** The record of the storage; anything that is not the expected shape (no value, an older SDK, damage) is empty. */
  private read(): Stored {
    const empty: Stored = { v: 1 };
    try {
      const text = this.store?.getItem(this.options.key);
      if (!text) return empty;
      const value = JSON.parse(text);
      if (!value || value.v !== 1) return empty;
      const pick = (r: any): Remembered | undefined =>
        r && typeof r.f === "string" && Array.isArray(r.s) && r.s.every((s: unknown) => typeof s === "string") ? { f: r.f, s: r.s } : undefined;
      const out: Stored = { v: 1 };
      const register = pick(value.register);
      const identify = pick(value.identify);
      if (register) out.register = register;
      if (identify) out.identify = identify;
      return out;
    } catch {
      return empty;
    }
  }

  private write(record: Stored): void {
    try {
      this.store?.setItem(this.options.key, JSON.stringify(record));
    } catch {
      // a write that fails only means the call may run again
    }
  }

  /** The session this page load belongs to: the one of the tab when it was seen less than 30 minutes ago, else a new one. */
  private openSession(): string {
    const now = this.now();
    let id: string | null = null;
    try {
      const text = this.sessionStore?.getItem(SESSION_KEY);
      const value: SessionRecord | null = text ? JSON.parse(text) : null;
      if (value && typeof value.id === "string" && typeof value.seen === "number" && now - value.seen < SESSION_GAP_MS) id = value.id;
    } catch {
      // an unreadable session is a new one
    }
    id = id ?? randomSessionId();
    this.touch(id);
    return id;
  }

  /** Writes the time the page was last seen with the session. */
  private touch(id: string): void {
    try {
      this.sessionStore?.setItem(SESSION_KEY, JSON.stringify({ id, seen: this.now() } satisfies SessionRecord));
    } catch {
      // without it the next page load is a new session
    }
  }

  private watchPage(page: PageLike | null): void {
    if (!page || typeof page.addEventListener !== "function") return;
    const onChange = () => {
      if (page.visibilityState === "hidden") {
        if (this.leftAt === null) this.leftAt = this.now();
      } else {
        if (this.leftAt !== null && this.now() - this.leftAt >= SESSION_GAP_MS) this.session = randomSessionId();
        this.leftAt = null;
      }
      this.touch(this.session);
    };
    page.addEventListener("visibilitychange", onChange);
    page.addEventListener("pagehide", () => this.touch(this.session));
  }
}
