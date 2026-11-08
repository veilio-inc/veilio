import { describe, it, expect, vi, beforeEach } from 'vitest'

// Security review of spec 085 L8: a spent budget, or a rule set past the cap,
// still compiled every new pattern, so a huge sealed rule set still cost its
// full compile time. Counted at the compiler itself (compileRuleProgram).
const calls = vi.hoisted(() => ({ n: 0 }))
vi.mock('../src/rule-pattern.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/rule-pattern.js')>()
  return {
    ...real,
    compileRuleProgram: (...args: Parameters<typeof real.compileRuleProgram>) => {
      calls.n++
      return real.compileRuleProgram(...args)
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

// Review round 1 (#8): compiled once per process, but each budget is still
// charged what compiling cost, on its first use of the pattern.
describe('a pattern is compiled once per process and charged to every budget', () => {
  it('a second call does not recompile, and is charged the compile again', () => {
    const rules = Array.from({ length: 10 }, (_, i) => rule(i, `^qq${i}[a-c]+$`))
    const first = ruleBudget()
    anonymize(CODE, { rules, ruleBudget: first })
    expect(calls.n).toBe(10)
    const second = ruleBudget()
    anonymize(CODE, { rules, ruleBudget: second })
    expect(calls.n).toBe(10)
    expect(second.left).toBeLessThan(ruleBudget().left)
  })

  it('cached near-limit patterns still spend a fresh budget, with no compile', () => {
    const heavy = Array.from({ length: 600 }, (_, i) => rule(i, `(((){50}){50}){38}[]y${i}`))
    expect(anonymize('const PaymentGatewayAlpha1 = 1', { rules: heavy }).rulesStopped).toBe(true)
    const compiled = calls.n
    expect(anonymize('const PaymentGatewayAlpha1 = 1', { rules: heavy }).rulesStopped).toBe(true)
    expect(calls.n).toBe(compiled)
  })
})

// Security review of #8: the shared cache kept each matcher's per-name memo
// for the life of the process. Only the compiled program is shared now; each
// budget gets its own memo, so a second call is charged the matching again.
describe('only the compiled program is shared across calls', () => {
  it('a second call with the same rules and names spends exactly what the first did', () => {
    const rules = Array.from({ length: 20 }, (_, i) => rule(i, `^pp${i}(?:[a-c]|d)+$`))
    const steps = () => {
      const b = ruleBudget()
      anonymize(CODE, { rules, ruleBudget: b })
      return ruleBudget().left - b.left
    }
    const first = steps()
    expect(first).toBeGreaterThan(0)
    expect(steps()).toBe(first)
  })

  it('at most 512 patterns stay compiled; the least recently used goes first', () => {
    const one = (p: string) => anonymize('const PaymentGatewayAlpha1 = 1', { rules: [rule(0, p)] })
    one('^lru0[a-c]+$')
    for (let i = 1; i < 512; i++) one(`^lru${i}[a-c]+$`)
    one('^lru0[a-c]+$') // used again: now the most recent
    const before = calls.n
    one('^lru512[a-c]+$') // the 513th: evicts lru1, not lru0
    one('^lru0[a-c]+$')
    expect(calls.n).toBe(before + 1)
    one('^lru1[a-c]+$')
    expect(calls.n).toBe(before + 2)
  })

  it('a pattern past the rule limit that needs the matcher is never compiled; a list of names may be longer', () => {
    // One state for the long class: the state cap does not stop it, the length does.
    const long = `^(?:Payment[A-Za-z0-9]+|[${'q'.repeat(490)}]z)$`
    const r = anonymize('const PaymentGatewayAlpha1 = 1', { rules: [rule(0, long)] })
    expect(r.anonymized).not.toContain('PaymentGatewayAlpha1')
    const keep = `^(?:${Array.from({ length: 200 }, (_, i) => `PaymentGatewayAlpha${i + 1}`).join('|')})$`
    expect(keep.length).toBeGreaterThan(500)
    expect(
      anonymize('const PaymentGatewayAlpha1 = 1', { rules: [rule(0, keep)] }).anonymized
    ).toContain('PaymentGatewayAlpha1')
  })
})
