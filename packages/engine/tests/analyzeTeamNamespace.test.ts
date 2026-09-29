import { describe, it, expect } from 'vitest'
import {
  analyzeTeamNamespace,
  mergeTeamNamespace,
  type TeamMapEntry,
} from '../src/teamNamespace.js'

// Spec 017. The staging collision (j-concurrent, 2026-09-26): two members both
// saved __FN__6 for different identifiers; the merge kept the first and a
// restore of the second member's text silently named the wrong function.

const A: TeamMapEntry = {
  createdAt: '2026-09-26T10:00:00Z',
  map: { __FN__6: 'settleLedger', __VAR__1: 'customerId' },
}
const B: TeamMapEntry = {
  createdAt: '2026-09-26T10:00:05Z',
  map: { __FN__6: 'voidLedger', __VAR__1: 'customerId' },
}

describe('analyzeTeamNamespace', () => {
  it('keeps the first-write-wins namespace exactly as mergeTeamNamespace', () => {
    expect(analyzeTeamNamespace([B, A]).namespace).toEqual({
      __FN__6: 'settleLedger',
      __VAR__1: 'customerId',
    })
    expect(mergeTeamNamespace([B, A])).toEqual(analyzeTeamNamespace([B, A]).namespace)
  })

  it('reports a placeholder two maps give different identifiers as a conflict', () => {
    const r = analyzeTeamNamespace([A, B])
    expect(r.conflicts).toEqual({ __FN__6: 2 })
    // A shared placeholder with the same meaning everywhere is not one.
    expect(r.conflicts.__VAR__1).toBeUndefined()
  })

  it('keeps a second number for the same identifier as an alias, not a conflict', () => {
    const later: TeamMapEntry = {
      createdAt: '2026-09-26T11:00:00Z',
      map: { __FN__7: 'settleLedger' },
    }
    const r = analyzeTeamNamespace([A, later])
    expect(r.aliases).toEqual({ __FN__7: 'settleLedger' })
    expect(r.namespace.__FN__7).toBeUndefined()
    expect(r.conflicts).toEqual({})
  })

  it('a conflicting placeholder is never an alias', () => {
    const r = analyzeTeamNamespace([A, B])
    expect(r.aliases.__FN__6).toBeUndefined()
  })

  it('highest counts every readable map, dropped entries included', () => {
    const dropped: TeamMapEntry = {
      createdAt: '2026-09-26T12:00:00Z',
      map: { __FN__9: 'settleLedger', __CLS__3: 'Gateway' },
    }
    expect(analyzeTeamNamespace([A, dropped]).highest).toEqual({
      __FN__: 9,
      __VAR__: 1,
      __CLS__: 3,
    })
    // Order of maps does not lower it: a later map with a smaller number.
    const small: TeamMapEntry = { createdAt: '2026-09-26T13:00:00Z', map: { __FN__2: 'other' } }
    expect(analyzeTeamNamespace([A, dropped, small]).highest.__FN__).toBe(9)
  })

  it('reads custom-rule and manual bases, ignores non-numbered keys', () => {
    const r = analyzeTeamNamespace([
      { createdAt: 'x', map: { __RECON__12: 'reconcile', __MANUAL__2: 'acct', weird: 'x' } },
    ])
    expect(r.highest).toEqual({ __RECON__: 12, __MANUAL__: 2 })
  })

  it('skips unreadable maps', () => {
    // Sorted FIRST, so an unreadable map must not end the walk.
    const r = analyzeTeamNamespace([{ createdAt: '2000-01-01T00:00:00Z', map: null }, A])
    expect(r.namespace).toEqual(A.map)
    expect(r.conflicts).toEqual({})
  })
})
