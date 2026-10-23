// A web storage (localStorage, sessionStorage) for the tests of the registration rule: a map behind the three calls
// the SDK makes, and switches that make it fail the way a private window or a full disk does.

export interface FakeStorage {
  data: Map<string, string>;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  /** Every text ever written, in order (a test looks for what must never be stored). */
  written: string[];
  failReads: boolean;
  failWrites: boolean;
}

export function fakeStorage(initial: Record<string, string> = {}): FakeStorage {
  const storage: FakeStorage = {
    data: new Map(Object.entries(initial)),
    written: [],
    failReads: false,
    failWrites: false,
    getItem: (key) => {
      if (storage.failReads) throw new Error("SecurityError: storage is blocked");
      return storage.data.has(key) ? (storage.data.get(key) as string) : null;
    },
    setItem: (key, value) => {
      if (storage.failWrites) throw new Error("QuotaExceededError");
      storage.written.push(value);
      storage.data.set(key, value);
    },
    removeItem: (key) => {
      if (storage.failWrites) throw new Error("QuotaExceededError");
      storage.data.delete(key);
    },
  };
  return storage;
}

/** Puts a storage on `globalThis` under `name` (`localStorage`, `sessionStorage`) and returns the way back. */
export function installStorage(name: "localStorage" | "sessionStorage", storage: FakeStorage | undefined): () => void {
  const before = Object.getOwnPropertyDescriptor(globalThis, name);
  if (storage) Object.defineProperty(globalThis, name, { value: storage, configurable: true, writable: true });
  else Object.defineProperty(globalThis, name, { value: undefined, configurable: true, writable: true });
  return () => {
    if (before) Object.defineProperty(globalThis, name, before);
    else delete (globalThis as Record<string, unknown>)[name];
  };
}
