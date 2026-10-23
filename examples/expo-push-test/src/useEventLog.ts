import { useCallback, useState } from 'react'

export interface LogEntry {
  id: number
  label: string
  ok: boolean
  detail?: string
  at: string
}

let _seq = 0

/**
 * In-memory event log for the test screen. `run` wraps an async SDK call and
 * records success (with a truncated result) or the error message.
 */
export function useEventLog() {
  const [entries, setEntries] = useState<LogEntry[]>([])

  const append = useCallback((label: string, ok: boolean, detail?: string) => {
    setEntries((prev) =>
      [{ id: ++_seq, label, ok, detail, at: new Date().toLocaleTimeString() }, ...prev].slice(0, 50),
    )
  }, [])

  const push = useCallback((label: string, detail?: string) => append(label, true, detail), [append])

  const run = useCallback(
    async <T,>(label: string, fn: () => Promise<T>): Promise<void> => {
      try {
        const result = await fn()
        append(label, true, result === undefined ? 'ok' : JSON.stringify(result).slice(0, 200))
      } catch (e) {
        append(label, false, e instanceof Error ? e.message : String(e))
      }
    },
    [append],
  )

  return { entries, run, push }
}
