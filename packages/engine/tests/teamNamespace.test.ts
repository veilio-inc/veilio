import { describe, it, expect } from 'vitest'
import { mergeTeamNamespace, type TeamMapEntry } from '../src/teamNamespace.js'

// The shared-placeholder namespace for a team.
//
// This is the function that lets team maps stop being server-readable: a server
// that merges them has to decrypt every one, which is the only reason it would
// hold a key that can read them. Moving the merge to the clients is what makes
// that removal possible - so every client has to reproduce the rule EXACTLY,
// including the parts that look arbitrary.
//
// The rule: sort by createdAt ascending, then first-write-wins on the
// placeholder AND on the identifier. An identifier already claimed by an
// earlier map cannot be re-bound, even to a placeholder nobody has used.
//
// Ported with the function from veilio-cloud's @veilio-inc/shared. These cases
// are the executable form of the contract; leaving them behind would have left
// the rule stated in one repository and asserted in another.

const at = (iso: string, map: Record<string, string>): TeamMapEntry => ({
  createdAt: iso,
  map,
})

describe('mergeTeamNamespace', () => {
  it('returns an empty namespace for no maps', () => {
    expect(mergeTeamNamespace([])).toEqual({})
  })

  it('passes a single map through unchanged', () => {
    expect(mergeTeamNamespace([at('2026-01-01', { __CLS__1: 'Invoice' })])).toEqual({
      __CLS__1: 'Invoice',
    })
  })

  it('merges disjoint maps', () => {
    const merged = mergeTeamNamespace([
      at('2026-01-01', { __CLS__1: 'Invoice' }),
      at('2026-01-02', { __FN__1: 'charge' }),
    ])
    expect(merged).toEqual({ __CLS__1: 'Invoice', __FN__1: 'charge' })
  })

  it('the OLDER map wins a placeholder collision', () => {
    const merged = mergeTeamNamespace([
      at('2026-01-02', { __CLS__1: 'Newer' }),
      at('2026-01-01', { __CLS__1: 'Older' }),
    ])
    expect(merged.__CLS__1).toBe('Older')
  })

  it('an identifier claimed by an older map cannot be re-bound to a new placeholder', () => {
    // The non-obvious half of the rule. Without it, two placeholders would map
    // to one identifier and a restore would be ambiguous.
    const merged = mergeTeamNamespace([
      at('2026-01-01', { __CLS__1: 'Invoice' }),
      at('2026-01-02', { __CLS__9: 'Invoice' }),
    ])
    expect(merged).toEqual({ __CLS__1: 'Invoice' })
  })

  it('input order does not matter - createdAt decides', () => {
    const a = at('2026-01-01', { __CLS__1: 'Older' })
    const b = at('2026-01-02', { __CLS__1: 'Newer' })
    expect(mergeTeamNamespace([a, b])).toEqual(mergeTeamNamespace([b, a]))
  })

  it('skips a map that failed to decrypt rather than aborting the merge', () => {
    // One unreadable row must never cost a whole team its namespace. A null map
    // is how the caller reports that failure, and the MCP server will hit this
    // for any map written under a team key version it was never granted.
    const merged = mergeTeamNamespace([
      at('2026-01-01', { __CLS__1: 'Invoice' }),
      { createdAt: '2026-01-02', map: null },
      at('2026-01-03', { __FN__1: 'charge' }),
    ])
    expect(merged).toEqual({ __CLS__1: 'Invoice', __FN__1: 'charge' })
  })

  it('is stable when two maps share a createdAt', () => {
    // Equal timestamps are possible; the result must at least be deterministic
    // rather than depending on sort implementation details.
    const maps = [at('2026-01-01', { __CLS__1: 'A' }), at('2026-01-01', { __CLS__1: 'B' })]
    expect(mergeTeamNamespace(maps)).toEqual(mergeTeamNamespace([...maps]))
  })

  it('does not mutate its input', () => {
    const maps = [at('2026-01-02', { __CLS__1: 'B' }), at('2026-01-01', { __CLS__1: 'A' })]
    const snapshot = JSON.stringify(maps)
    mergeTeamNamespace(maps)
    expect(JSON.stringify(maps)).toBe(snapshot)
  })
})
