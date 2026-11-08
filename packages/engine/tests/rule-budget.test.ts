import { describe, it, expect } from 'vitest'
import { anonymize, ruleBudget, type CustomRule } from '../src/index.js'
import { RULE_WORK_BUDGET } from '../src/rule-pattern.js'

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

// Spec 085 L8 (security audit run-1): compiling a rule was not charged to the
// budget, and the matcher cache was cleared past 1000 patterns, so a large
// sealed rule set could stall every teammate's scrub. Checked on the budget
// itself, not on the clock: the steps a call spends are deterministic.
describe('rule compile work is charged to the budget (L8)', () => {
  // About 98,900 build steps each, and it matches nothing (the audit's shape).
  const heavy = (i: number) => `(((){50}){50}){38}[]x${i}`
  const ALPHA = Array.from({ length: 50 }, (_, i) => `PaymentGatewayAlpha${i + 1}`)
  const ALPHA_CODE = ALPHA.map((n) => `const ${n} = 1`).join('\n')
  const spent = (rules: CustomRule[], code = ALPHA_CODE) => {
    const budget = ruleBudget()
    const r = anonymize(code, { rules, ruleBudget: budget })
    return { steps: RULE_WORK_BUDGET - budget.left, stopped: r.rulesStopped === true, r }
  }

  it('compiling alone can spend the budget, and the call says so', () => {
    const rules = Array.from({ length: 600 }, (_, i) => rule(i, 'whitelist', heavy(i)))
    expect(spent(rules, 'const PaymentGatewayAlpha1 = 1').stopped).toBe(true)
  })

  it('a rule after the budget ran out keeps nothing readable: the name stays masked', () => {
    const rules = [
      ...Array.from({ length: 600 }, (_, i) => rule(i, 'whitelist', heavy(i))),
      rule(600, 'whitelist', '^PaymentGatewayAlpha1$'),
    ]
    const { r, stopped } = spent(rules, 'const PaymentGatewayAlpha1 = 1')
    expect(stopped).toBe(true)
    expect(r.anonymized).not.toContain('PaymentGatewayAlpha1')
  })

  it('more than 1000 rules in one call stop the rules, and say so', () => {
    const cheap = (n: number) =>
      Array.from({ length: n }, (_, i) => rule(i, 'whitelist', `^zz${i}[a-c]+$`))
    expect(spent(cheap(1000)).stopped).toBe(false)
    expect(spent(cheap(1001)).stopped).toBe(true)
  })

  // Security review: a dropped set must not forget it held replace rules. An
  // ordinary word stays readable only when no replace rule could claim it.
  it('a set past the cap with a replace rule masks an ordinary word, as a spent budget does', () => {
    const code = 'export const ledger = 1'
    expect(anonymize(code).anonymized).toContain('ledger') // no rules: readable
    const rules = [
      ...Array.from({ length: 1000 }, (_, i) => rule(i, 'whitelist', `^zz${i}[a-c]+$`)),
      rule(1000, 'replace', '^ledger$'),
    ]
    const r = anonymize(code, { rules })
    expect(r.rulesStopped).toBe(true)
    expect(r.anonymized).not.toContain('ledger')
  })

  it('a disabled replace rule in a set past the cap claims nothing: the word stays readable', () => {
    const rules = [
      ...Array.from({ length: 1000 }, (_, i) => rule(i, 'whitelist', `^zz${i}[a-c]+$`)),
      { ...rule(1000, 'replace', '^ledger$'), enabled: false },
    ]
    expect(anonymize('export const ledger = 1', { rules }).anonymized).toContain('ledger')
  })

  it('the steps grow linearly with the rules, and a repeat call spends the same', () => {
    const cheap = (n: number) =>
      Array.from({ length: n }, (_, i) => rule(i, 'whitelist', `^zz${i}[a-c]+$`))
    const s250 = spent(cheap(250)).steps
    const s500 = spent(cheap(500)).steps
    const s1000 = spent(cheap(1000)).steps
    expect(s1000 / s500).toBeGreaterThan(1.8)
    expect(s1000 / s500).toBeLessThan(2.2)
    expect(s500 / s250).toBeLessThan(2.2)
    // Compiled per call: a second call is charged the compile again.
    expect(spent(cheap(1000)).steps).toBe(s1000)
  })
})
