import { describe, it, expect, vi, beforeEach } from 'vitest'

// Security review of spec 085 L8: a spent budget, or a rule set past the cap,
// still compiled every new pattern, so a huge sealed rule set still cost its
// full compile time. Counted at the compiler itself.
const calls = vi.hoisted(() => ({ n: 0 }))
vi.mock('../src/rule-pattern.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/rule-pattern.js')>()
  return {
    ...real,
    compileRulePattern: (...args: Parameters<typeof real.compileRulePattern>) => {
      calls.n++
      return real.compileRulePattern(...args)
    },
  }
})
const { anonymize, ruleBudget } = await import('../src/index.js')
type Rule = NonNullable<Parameters<typeof anonymize>[1]>['rules'] extends (infer R)[] | undefined
  ? R
  : never

const rule = (i: number, pattern: string) =>
  ({
    id: String(i),
    scope: 'team',
    team_id: 't',
    sort_order: i,
    name: `r${i}`,
    type: 'whitelist',
    pattern,
    enabled: true,
  }) as Rule
const NAMES = Array.from({ length: 50 }, (_, i) => `PaymentGatewayAlpha${i + 1}`)
const CODE = NAMES.map((n) => `const ${n} = 1`).join('\n')
beforeEach(() => {
  calls.n = 0
})

describe('no rule is compiled once the rules have stopped', () => {
  it('5000 rules: none is compiled, the call says the rules stopped, every name is masked', () => {
    const r = anonymize(CODE, {
      rules: Array.from({ length: 5000 }, (_, i) => rule(i, `^zz${i}[a-c]+$`)),
    })
    expect(calls.n).toBe(0)
    expect(r.rulesStopped).toBe(true)
    expect(r.anonymized).not.toMatch(/PaymentGatewayAlpha/)
  })

  it('near-limit patterns: compiling stops where the budget runs out', () => {
    const heavy = Array.from({ length: 1000 }, (_, i) => rule(i, `(((){50}){50}){38}[]x${i}`))
    const r = anonymize(CODE, { rules: heavy })
    expect(r.rulesStopped).toBe(true)
    // About 505 compiles spend the 5e7 steps; without the stop, all 1000 are compiled.
    expect(calls.n).toBeLessThan(600)
  })

  it('one budget shared across calls compiles at most 1000 patterns', () => {
    const budget = ruleBudget()
    for (let k = 0; k < 3; k++)
      anonymize(CODE, {
        rules: Array.from({ length: 600 }, (_, i) => rule(i, `^zz${k}x${i}[a-c]+$`)),
        ruleBudget: budget,
      })
    expect(calls.n).toBeLessThanOrEqual(1000)
    expect(budget.spent).toBe(true)
  })
})
