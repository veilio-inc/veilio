// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDeriveController } from './useDeriveController.js'

describe('useDeriveController', () => {
  it('starts idle', () => {
    const { result } = renderHook(() => useDeriveController())
    expect(result.current.status).toBe('idle')
  })

  it('reports deriving once start() is called', () => {
    const { result } = renderHook(() => useDeriveController())
    act(() => {
      result.current.start()
    })
    expect(result.current.status).toBe('deriving')
  })

  it('returns to idle once end() is called with the same controller', () => {
    const { result } = renderHook(() => useDeriveController())
    let controller!: AbortController
    act(() => {
      controller = result.current.start()
    })
    act(() => {
      result.current.end(controller)
    })
    expect(result.current.status).toBe('idle')
  })

  it('cancel-and-replace: a second start() aborts the first rather than queueing it', () => {
    // ROADMAP E11 spec Edge Cases / research.md R-006: a rapid second export
    // must not let a stale derive finish after a newer one and silently
    // overwrite state, so the first is aborted outright, not left pending.
    const { result } = renderHook(() => useDeriveController())
    let first!: AbortController
    act(() => {
      first = result.current.start()
    })
    expect(first.signal.aborted).toBe(false)

    let second!: AbortController
    act(() => {
      second = result.current.start()
    })

    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
    expect(result.current.status).toBe('deriving')
  })

  it("a stale end() from the superseded controller does not clear the newer one's status", () => {
    const { result } = renderHook(() => useDeriveController())
    let first!: AbortController
    act(() => {
      first = result.current.start()
    })
    act(() => {
      result.current.start() // supersedes `first`
    })
    act(() => {
      result.current.end(first) // late finally() from the aborted first call
    })
    expect(result.current.status).toBe('deriving')
  })

  it('cancel() moves to cancelling and aborts the in-flight controller', () => {
    const { result } = renderHook(() => useDeriveController())
    let controller!: AbortController
    act(() => {
      controller = result.current.start()
    })
    act(() => {
      result.current.cancel()
    })
    expect(result.current.status).toBe('cancelling')
    expect(controller.signal.aborted).toBe(true)
  })

  it('cancel() with nothing in flight is a harmless no-op', () => {
    const { result } = renderHook(() => useDeriveController())
    act(() => {
      result.current.cancel()
    })
    expect(result.current.status).toBe('cancelling')
  })
})
