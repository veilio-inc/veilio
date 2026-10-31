import { describe, it, expect } from 'vitest'
import { anonymize, ruleBudget, type CustomRule } from '../src/index.js'

// Security audit: MAX_WORK bounds one test of one rule against one name, but
// nothing bounded a call testing every rule against every name - hostile
// rules over 5000 identifiers took seconds. A per-call budget, shared by all
// rules and names: once spent, rule tests answer no-match and the result
// says so.

const names = Array.from({ length: 5000 }, (_, i) => `identifier_name_number_${i}abcdefgh`)
const CODE = names.map((n) => `const ${n} = 1`).join('\n')
const rule = (i: number, type: 'whitelist' | 'replace', pattern: string): CustomRule =>
  ({
    id: String(i),
    scope: 'team',
    team_id: 't',
    sort_order: i,
    name: `r${i}`,
    type,
    pattern,
    enabled: true,
    ...(type === 'replace' ? { placeholder: '__CODENAME__' } : {}),
  }) as CustomRule

describe('the per-call rule budget', () => {
  it('worst-case accepted patterns over 5000 names stop early, and say so', () => {
    const rules = Array.from({ length: 20 }, (_, i) =>
      rule(i, i % 2 ? 'replace' : 'whitelist', `(\\w?\\w?){50}#|x${i}`)
    )
    const started = performance.now()
    const r = anonymize(CODE, { rules })
    // rulesStopped is the deterministic check. The time is a backstop sized for
    // CI's emulated container (2.5-3x slower): budgeted 0.6 s locally, unbounded 11 s.
    expect(r.rulesStopped).toBe(true)
    expect(performance.now() - started).toBeLessThan(6000)
    // No match is the safe direction: every name is still masked.
    expect(r.anonymized).not.toMatch(/identifier_name_number_/)
  })

  it('ordinary rules over the same names are not stopped', () => {
    const rules = Array.from({ length: 50 }, (_, i) => rule(i, 'whitelist', `^acme${i}_`))
    const r = anonymize(CODE, { rules })
    expect(r.rulesStopped).toBeUndefined()
  })

  it('once spent, an ordinary word a replace rule might have matched is masked, not shown', () => {
    const rules = [
      ...Array.from({ length: 20 }, (_, i) => rule(i, 'whitelist', `(\\w?\\w?){50}#|x${i}`)),
      rule(99, 'replace', '^phoenix$'),
    ]
    const r = anonymize(`${CODE}\nconst phoenix = 2\n`, { rules })
    expect(r.rulesStopped).toBe(true)
    expect(r.anonymized).not.toMatch(/\bphoenix\b/)
  })

  it('a later call starts with a full budget', () => {
    const rules = [rule(1, 'replace', '^phoenix$')]
    expect(anonymize('const phoenix = 2\n', { rules }).anonymized).toContain('__CODENAME__1')
  })
})

describe('a budget the caller shares across calls (security review of round 1)', () => {
  it('a later call given the same budget starts where the first left it', () => {
    const hostile = Array.from({ length: 20 }, (_, i) =>
      rule(i, 'whitelist', `(\\w?\\w?){50}#|x${i}`)
    )
    const budget = ruleBudget()
    expect(anonymize(CODE, { rules: hostile, ruleBudget: budget }).rulesStopped).toBe(true)
    const rules = [rule(1, 'replace', '^phoenix$')]
    const later = anonymize('const phoenix = 2\n', { rules, ruleBudget: budget })
    expect(later.rulesStopped).toBe(true)
    expect(later.anonymized).not.toMatch(/\bphoenix\b/)
    // Without it, a fresh budget.
    expect(anonymize('const phoenix = 2\n', { rules }).rulesStopped).toBeUndefined()
  })
})
