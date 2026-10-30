import { describe, it, expect } from 'vitest'
import { anonymize, type CustomRule } from '../src/index.js'

// Spec 065: the server can no longer refuse a team member's catastrophic
// pattern or engine-base placeholder, so the engine skips such a rule itself -
// the last line of defence when a cache on disk was edited by hand.

const rule = (over: Partial<CustomRule> & Pick<CustomRule, 'type'>): CustomRule =>
  ({
    id: 'r',
    scope: 'team',
    team_id: 't',
    name: 'r',
    pattern: '^x$',
    enabled: true,
    sort_order: 0,
    ...over,
  }) as CustomRule

const code = `const quaywardPlan = 1\nconst ${'a'.repeat(30)}b = 2\n`

describe('anonymize skips a rule it must not run', () => {
  it('an unsafe pattern: skipped, no hang, the safe rule beside it still applies', () => {
    const start = Date.now()
    const { anonymized } = anonymize(code, {
      language: 'typescript',
      rules: [
        rule({ type: 'whitelist', pattern: '(a+)+$', sort_order: 0 }),
        rule({ type: 'whitelist', pattern: '^quaywardPlan$', sort_order: 1 }),
      ],
    })
    expect(Date.now() - start).toBeLessThan(1000)
    expect(anonymized).toContain('quaywardPlan')
    expect(anonymized).not.toContain(`${'a'.repeat(30)}b`)
  })

  it('a replace rule under an engine base: skipped, so it cannot mint __FN__ entries', () => {
    const { anonymized, map } = anonymize('deploy(quaywardPlan)\n', {
      language: 'typescript',
      rules: [rule({ type: 'replace', pattern: '^quaywardPlan$', placeholder: '__FN__' })],
    })
    const placeholder = Object.entries(map).find(([, name]) => name === 'quaywardPlan')?.[0]
    expect(placeholder).toBeDefined()
    expect(placeholder).not.toMatch(/^__FN__/)
    expect(anonymized).not.toContain('quaywardPlan')
  })
})
