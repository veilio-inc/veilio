import { describe, it, expect } from 'vitest'
import { alteredPlaceholders, anonymize, buildLegend, withAiPreamble } from '../src/index.js'

// Spec 066: everywhere the engine reads a role placeholder, a local one of the
// same kind reads the same way.

const codename = {
  id: 'r1',
  scope: 'team' as const,
  team_id: 't',
  name: 'codename',
  type: 'replace' as const,
  pattern: '^phoenix$',
  placeholder: '__CODENAME__',
  enabled: true,
  sort_order: 0,
}

describe('spec 064: a rule made after the engine masked an ordinary word', () => {
  it('overrides a local role entry like a team one', () => {
    const { anonymized, map } = anonymize('deploy(phoenix)\n', {
      language: 'typescript',
      existingMap: { __LOCAL_K7Q2XA_VAR__3: 'phoenix' },
      rules: [codename],
    })
    expect(anonymized).not.toMatch(/\bphoenix\b/)
    expect(anonymized).toContain('__CODENAME__1')
    expect(map.__CODENAME__1).toBe('phoenix')
    // The old placeholder still restores old text.
    expect(map.__LOCAL_K7Q2XA_VAR__3).toBe('phoenix')
  })

  it('leaves a local entry of a rule kind alone, as it does a team one', () => {
    const { anonymized, map } = anonymize('deploy(phoenix)\n', {
      language: 'typescript',
      existingMap: { __LOCAL_K7Q2XA_OTHER__3: 'phoenix' },
      rules: [codename],
    })
    expect(anonymized).toContain('__LOCAL_K7Q2XA_OTHER__3')
    expect(map.__CODENAME__1).toBeUndefined()
  })
})

describe('alteredPlaceholders finds a local placeholder the model mangled', () => {
  it.each([
    '__local_k7q2xa_var__3',
    '_LOCAL_K7Q2XA_VAR__3',
    '__LOCAL_K7Q2XA_VAR_3',
    '__local__k7q2xa__var__3',
    '__Local_K7q2xa_Iban__1',
    '__local_k7q2xa_manual__2',
  ])('%s', (token) => {
    expect(alteredPlaceholders(`call(${token})`)).toEqual([token])
  })

  it('not the placeholder itself, nor one still placeholder-shaped (restore calls that unresolved)', () => {
    expect(alteredPlaceholders('call(__LOCAL_K7Q2XA_VAR__3)')).toEqual([])
    expect(alteredPlaceholders('call(__LOCAL__K7Q2XA_VAR__3)')).toEqual([])
  })

  it('not a word that only looks like the start of one', () => {
    expect(alteredPlaceholders('my_local_k7q2xa_var_3 x__local_k7q2xa_var__3')).toEqual([])
  })

  it('not a user’s own name of that shape the map restored', () => {
    expect(
      alteredPlaceholders('call(__local_k7q2xa_var__3)', { __VAR__1: '__local_k7q2xa_var__3' })
    ).toEqual([])
  })
})

describe('the preamble legend names the local family', () => {
  const map = {
    __LOCAL_K7Q2XA_VAR__1: 'skerryOne',
    __LOCAL_K7Q2XA_VAR__2: 'skerryTwo',
    __CLS__1: 'Plan',
  }

  it('in the legend of text holding local placeholders', () => {
    const text = 'new __CLS__1(__LOCAL_K7Q2XA_VAR__1, __LOCAL_K7Q2XA_VAR__2)'
    const legend = buildLegend(map, text)
    expect(legend).toContain('__LOCAL_K7Q2XA_VAR__* are variable or parameter names')
    expect(legend).toMatch(/__LOCAL_K7Q2XA_VAR__\* [^;]*numbered on one machine[^;]*\(2\)/)
    expect(legend).not.toMatch(/__LOCAL_K7Q2XA_VAR__\* are project-specific/)
    expect(withAiPreamble(text, map)).toContain('numbered on one machine')
  })

  it('and not where there are none', () => {
    expect(buildLegend(map, 'new __CLS__1()')).not.toMatch(/LOCAL|one machine/)
    expect(withAiPreamble('new __CLS__1()', map)).not.toMatch(/LOCAL|one machine/)
  })
})
