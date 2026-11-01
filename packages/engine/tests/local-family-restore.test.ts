import { describe, it, expect } from 'vitest'
import {
  analyzeTeamNamespace,
  localFamilyNote,
  restore,
  restoreLayers,
  type TeamLayer,
  type TeamMapEntry,
} from '../src/index.js'

// Spec 066 R5: a local placeholder means something only on the checkout that
// numbered it. No team map may give it a meaning, and a teammate's restore
// leaves it as written.

const A = '__LOCAL_AAAAAA_VAR__1'
const B = '__LOCAL_BBBBBB_VAR__1'

describe('analyzeTeamNamespace drops local keys from every team map', () => {
  const entries: TeamMapEntry[] = [
    {
      createdAt: '2026-10-01T00:00:00Z',
      map: {
        [A]: 'sharedName', // earlier than the team key with the same name
        __LOCAL_AAAAAA_VAR__: 'digitless',
        __LOCAL_X__: 'odd prefix',
        __VAR__3: 'teamOne',
      },
    },
    {
      createdAt: '2026-10-02T00:00:00Z',
      map: { [A]: 'otherName', __VAR__9: 'sharedName', __LOCAL_AAAAAA_VAR__9000: 'high' },
    },
    { createdAt: '2026-10-03T00:00:00Z', map: null },
  ]
  const r = analyzeTeamNamespace(entries)
  const all = [
    ...Object.keys(r.namespace),
    ...Object.keys(r.aliases),
    ...Object.keys(r.conflicts),
    ...Object.keys(r.highest),
  ]

  it('in none of namespace, aliases, conflicts or highest', () => {
    expect(all.filter((k) => k.startsWith('__LOCAL_'))).toEqual([])
    expect(r).toMatchObject({
      namespace: { __VAR__3: 'teamOne', __VAR__9: 'sharedName' },
      aliases: {},
      conflicts: {},
      highest: { __VAR__: 9 },
    })
  })

  it('so a local key never claims an identifier a team key holds', () => {
    expect(r.namespace.__VAR__9).toBe('sharedName')
  })

  it('and counts every one it dropped', () => {
    expect(r.localDropped).toBe(5)
  })

  it('a team without local keys reports none', () => {
    expect(analyzeTeamNamespace([{ createdAt: 'x', map: { __VAR__1: 'a' } }]).localDropped).toBe(0)
  })
})

const team = (over: Partial<TeamLayer> = {}): TeamLayer => ({
  namespace: {},
  aliases: {},
  conflicts: {},
  ...over,
})

describe('restoreLayers', () => {
  it('never restores a local key from the team layer - namespace, aliases or conflicts', () => {
    const layers = restoreLayers({
      own: {},
      team: team({
        namespace: { [A]: 'teammatesName', __VAR__1: 'teamName' },
        aliases: { [B]: 'aliasName' },
        conflicts: { __LOCAL_CCCCCC_VAR__1: 2 },
      }),
    })
    expect(layers.map).toEqual({ __VAR__1: 'teamName' })
    const text = `${A} ${B} __LOCAL_CCCCCC_VAR__1 __VAR__1`
    expect(restore(text, layers.map).restored).toBe(`${A} ${B} __LOCAL_CCCCCC_VAR__1 teamName`)
    expect(layers.disputedIn(text)).toEqual([])
    expect(layers.otherLocalIn(text)).toEqual([A, B, '__LOCAL_CCCCCC_VAR__1'])
  })

  it('restores the own map’s local key, whatever the team layer says about it', () => {
    const layers = restoreLayers({
      own: { [A]: 'myName' },
      team: team({ namespace: { [A]: 'teammatesName' } }),
    })
    expect(layers.map[A]).toBe('myName')
    expect(layers.locallyNumberedIn(A)).toEqual([])
    expect(layers.otherLocalIn(A)).toEqual([])
  })

  it('restores the own map’s local key with no team at all', () => {
    const layers = restoreLayers({ own: { [A]: 'myName' }, team: null })
    expect(restore(`${A} ${B}`, layers.map).restored).toBe(`myName ${B}`)
    expect(layers.otherLocalIn(`${A} ${B}`)).toEqual([B])
  })
})

describe('otherLocalIn(text)', () => {
  const layers = restoreLayers({ own: { [A]: 'myName' }, team: team() })

  it('lists local tokens the own layer lacks, once each, in order', () => {
    expect(layers.otherLocalIn(`${B} x ${A} __LOCAL_CCCCCC_FN__2 ${B}`)).toEqual([
      B,
      '__LOCAL_CCCCCC_FN__2',
    ])
  })

  it('whole tokens only', () => {
    expect(
      layers.otherLocalIn(`x${B} ${B}x ${B}_ ${B}$ __LOCAL_BBBBBB_VAR__ __LOCAL_BBBBB_VAR__1`)
    ).toEqual([])
  })

  it('not team placeholders', () => {
    expect(layers.otherLocalIn('__VAR__1 __CLS__2')).toEqual([])
  })
})

describe('localFamilyNote', () => {
  it('one', () => {
    expect(localFamilyNote([A])).toBe(
      `left as is: ${A}. Numbered on another checkout while it held no team numbers; ` +
        'only that checkout restores it, until its next publish gives it a team number.'
    )
  })

  it('several', () => {
    expect(localFamilyNote([A, B])).toBe(
      `left as is: ${A}, ${B}. Numbered on other checkouts while they held no team numbers; ` +
        'only the checkout that numbered each restores it, until its next publish gives it a team number.'
    )
  })
})
