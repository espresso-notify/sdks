// A minimal IndexedDB for the tests of the page client and of the service worker: one database, object
// stores of key/value pairs, requests that answer on a later tick, and a transaction that completes when its
// requests are done. It covers only the calls the SDK makes (open, createObjectStore, get, put, delete).

export interface FakeIndexedDB {
  data: Map<string, unknown>;
  opened?: { name: string; version: number };
  open(name: string, version: number): any;
}

export function fakeIndexedDB(initial: Record<string, unknown> = {}, options: { failOpen?: boolean } = {}): FakeIndexedDB {
  const data = new Map<string, unknown>(Object.entries(initial));
  const api: FakeIndexedDB = {
    data,
    open: (name: string, version: number) => {
      const request: any = {};
      setTimeout(() => {
        if (options.failOpen) {
          request.error = new Error("blocked");
          request.onerror?.();
          return;
        }
        const db = {
          createObjectStore: () => undefined,
          close: () => undefined,
          transaction: () => {
            const tx: any = {};
            let pending = 0;
            const settle = () => setTimeout(() => pending === 0 && tx.oncomplete?.(), 0);
            const run = (work: () => unknown) => {
              const req: any = {};
              pending++;
              setTimeout(() => {
                req.result = work();
                req.onsuccess?.();
                pending--;
                settle();
              }, 0);
              return req;
            };
            tx.objectStore = () => ({
              get: (key: string) => run(() => (data.has(key) ? structuredClone(data.get(key)) : undefined)),
              put: (value: unknown, key: string) => run(() => void data.set(key, structuredClone(value))),
              delete: (key: string) => run(() => void data.delete(key)),
            });
            return tx;
          },
        };
        request.result = db;
        api.opened = { name, version };
        request.onupgradeneeded?.();
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
  return api;
}
