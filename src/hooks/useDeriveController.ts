import { useCallback, useRef, useState } from 'react'

/**
 * Tracks the single in-flight, cancellable key derivation a page allows at
 * once (ROADMAP E11). 'cancelling' is its own state rather than folded into
 * 'idle', so a Cancel button can disable itself the instant it's clicked
 * rather than appearing to do nothing for the window between the click and
 * the worker's terminate() actually rejecting the pending derive
 * (specs/007-e11-derive-off/data-model.md).
 */
export type DeriveStatus = 'idle' | 'deriving' | 'cancelling'

export interface DeriveController {
  status: DeriveStatus
  /** Call before starting a derive. Aborts any derive already in flight —
   *  cancel-and-replace, not a queue (research.md R-006) — and returns the
   *  signal the new one should pass through. */
  start(): AbortController
  /** Call in a `finally` once the derive settles, passing the same
   *  controller `start()` returned. A no-op if a newer `start()` already
   *  superseded it. */
  end(controller: AbortController): void
  /** Aborts whatever is in flight, if anything. */
  cancel(): void
}

export function useDeriveController(): DeriveController {
  const [status, setStatus] = useState<DeriveStatus>('idle')
  const controllerRef = useRef<AbortController | null>(null)

  const start = useCallback((): AbortController => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setStatus('deriving')
    return controller
  }, [])

  const end = useCallback((controller: AbortController): void => {
    if (controllerRef.current === controller) {
      controllerRef.current = null
      setStatus('idle')
    }
  }, [])

  const cancel = useCallback((): void => {
    setStatus('cancelling')
    controllerRef.current?.abort()
  }, [])

  return { status, start, end, cancel }
}
