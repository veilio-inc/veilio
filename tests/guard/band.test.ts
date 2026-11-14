import { describe, expect, it } from 'vitest'
import { bandText } from '../../plugins/veilio-guard/lib/ui.ts'
import type { Guard } from '../../plugins/veilio-guard/lib/guard.ts'
import { NO_RULES, readGuardRules } from '../../plugins/veilio-guard/lib/rules.ts'

// Spec 050 contracts/masking.md: the band says while the project is being
// indexed, and when the index is off, so a withheld result has a visible cause.
const guard = (index: unknown) =>
  ({
    state: 'on',
    map: { __FN__1: 'a' },
    counts: { withheld: 0, denied: 0 },
    rules: NO_RULES,
    mcpRestore: [],
    index,
  }) as unknown as Guard

describe('the band and the project index', () => {
  it('shows progress while indexing', () => {
    const text = bandText(guard({ state: 'indexing', total: 690, indexed: new Set(['a', 'b']) }))
    expect(text).toBe(
      'Veilio guard on · 1 name in the map · indexing 2/690 files · custom rules: none pulled - run `veilio rules pull` · 0 withheld · 0 refused'
    )
  })

  it('says nothing about the index once it is complete', () => {
    expect(bandText(guard({ state: 'complete', total: 2, indexed: new Set(['a', 'b']) }))).toBe(
      'Veilio guard on · 1 name in the map · custom rules: none pulled - run `veilio rules pull` · 0 withheld · 0 refused'
    )
  })

  // Spec 093, review round 1: a damaged cache is not "none pulled".
  it('says when the saved rules cannot be read', () => {
    const g = guard({ state: 'complete', total: 0, indexed: new Set() })
    expect(bandText({ ...g, rules: { ...NO_RULES, state: 'unreadable' } } as Guard)).toBe(
      'Veilio guard on · 1 name in the map · custom rules: cannot be read - run veilio rules pull · 0 withheld · 0 refused'
    )
  })

  it('says when the index is off, and why', () => {
    const text = bandText(
      guard({ state: 'unavailable', reason: 'the project could not be listed', indexed: new Set() })
    )
    expect(text).toContain('index off (the project could not be listed)')
  })
})

// Spec 093, review round 1: the reader tells a damaged cache from no cache.
describe('the guard reads the saved rules', () => {
  const HOME = '/home/dev'
  const CRED = `${HOME}/.veilio/credential.json`
  const RULES = `${HOME}/.veilio/rules.json`
  const me = { instance: 'https://veilio.test', account: 'dev@example.test' }
  const disk = (files: Record<string, string>) => async (path: string) => {
    if (!(path in files)) throw new Error(`ENOENT ${path}`)
    return files[path]!
  }
  const cred = { [CRED]: JSON.stringify({ token: 't', ...me }) }

  it('no cache: none pulled', async () => {
    expect((await readGuardRules(disk(cred), HOME)).state).toBe('none-pulled')
  })

  it.each([
    ['truncated', '{"instance":'],
    ['holding an entry of an unknown kind', JSON.stringify({ ...me, pulledAt: 'x', rules: [{}] })],
  ])('a cache %s: unreadable, and no rule applied', async (_, text) => {
    expect(await readGuardRules(disk({ ...cred, [RULES]: text }), HOME)).toEqual({
      ...NO_RULES,
      state: 'unreadable',
    })
  })

  it('signed out, a damaged cache is nobody’s: none pulled', async () => {
    expect((await readGuardRules(disk({ [RULES]: '{"instance":' }), HOME)).state).toBe(
      'none-pulled'
    )
  })
})
