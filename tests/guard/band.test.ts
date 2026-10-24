import { describe, expect, it } from 'vitest'
import { bandText } from '../../plugins/veilio-guard/lib/ui.ts'
import type { Guard } from '../../plugins/veilio-guard/lib/guard.ts'

// Spec 050 contracts/masking.md: the band says while the project is being
// indexed, and when the index is off, so a withheld result has a visible cause.
const guard = (index: unknown) =>
  ({
    state: 'on',
    map: { __FN__1: 'a' },
    counts: { withheld: 0, denied: 0 },
    index,
  }) as unknown as Guard

describe('the band and the project index', () => {
  it('shows progress while indexing', () => {
    const text = bandText(guard({ state: 'indexing', total: 690, indexed: new Set(['a', 'b']) }))
    expect(text).toBe(
      'Veilio guard on · 1 name in the map · indexing 2/690 files · 0 withheld · 0 refused'
    )
  })

  it('says nothing about the index once it is complete', () => {
    expect(bandText(guard({ state: 'complete', total: 2, indexed: new Set(['a', 'b']) }))).toBe(
      'Veilio guard on · 1 name in the map · 0 withheld · 0 refused'
    )
  })

  it('says when the index is off, and why', () => {
    const text = bandText(
      guard({ state: 'unavailable', reason: 'the project could not be listed', indexed: new Set() })
    )
    expect(text).toContain('index off (the project could not be listed)')
  })
})
