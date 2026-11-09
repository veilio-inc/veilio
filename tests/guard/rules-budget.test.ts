import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  NO_CONTEXT,
  applyMap,
  maskShaped,
  scrubSource,
} from '../../plugins/veilio-guard/lib/scrub.ts'
import { bandText } from '../../plugins/veilio-guard/lib/ui.ts'
import { Guard, type GuardIO } from '../../plugins/veilio-guard/lib/guard.ts'
import { ruleBudget } from '../../plugins/veilio-guard/vendor/engine/index.js'
import type { CustomRule, RuleBudget } from '../../plugins/veilio-guard/vendor/engine/index.js'

// Security audit: a Read whose custom rules ran out of matching budget is
// counted, and the band says custom rules stopped matching.
const HOSTILE = Array.from({ length: 20 }, (_, i): CustomRule => ({
  id: `h${i}`,
  scope: 'team',
  team_id: 't1',
  sort_order: i,
  name: `h${i}`,
  type: 'whitelist',
  pattern: `(\\w?\\w?){50}#|x${i}`,
  enabled: true,
}))
const SOURCE = Array.from({ length: 5000 }, (_, i) => `const identifier_name_${i}abc = 1`).join(
  '\n'
)

describe('the guard and the rule budget', () => {
  it('scrubSource says when custom rules stopped matching', () => {
    const r = scrubSource(SOURCE, {}, 'typescript', new Set(), undefined, undefined, HOSTILE)
    expect(r.rulesStopped).toBe(true)
    expect(r.text).not.toMatch(/identifier_name_/)
  })

  it('the band says so once a Read stopped them', () => {
    const g = {
      state: 'on',
      map: {},
      index: null,
      reserved: null,
      rules: {
        state: 'applied',
        rules: HOSTILE,
        skipped: { vaultLocked: 0, teamLocked: 0, unopenable: 0, refused: 0 },
      },
      counts: { withheld: 0, denied: 0, outsideReserved: 0, rulesStopped: 1 },
      mcpRestore: [],
    } as unknown as Guard
    expect(bandText(g)).toContain('custom rules stopped matching: too much work')
  })
})

// Security review of round 1: the guard's own rule matcher, on command output,
// had no budget at all (20 hostile patterns x 10,000 names took 29 s), and each
// file a hook read got a fresh one. One budget per hook invocation, shared by
// every file and the tool output; spent, it masks - the engine's direction.
// rulesStopped and the band are the deterministic checks; the time is a
// backstop CI's emulated container (2.5-3x slower) can meet.
const OUTPUT = Array.from({ length: 10_000 }, (_, i) => `identifier_name_${i}abc`).join(' ')

describe('one rule budget per hook invocation', () => {
  it('command output: the matcher draws on the budget, and once spent masks', () => {
    const ctx = { ...NO_CONTEXT, rules: HOSTILE, budget: ruleBudget() }
    const started = performance.now()
    const out = maskShaped(applyMap(OUTPUT, {}, ctx), {}, ctx)
    expect(ctx.budget.spent).toBe(true)
    expect(performance.now() - started).toBeLessThan(20_000)
    expect(out.text).not.toMatch(/identifier_name_/)
  })

  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'veilio-guard-budget-')))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  const io: GuardIO = {
    read: async (p) => readFileSync(p, 'utf8'),
    write: async (p, t) => {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, t)
    },
    exists: async (p) => existsSync(p),
    realPath: async (p) => (existsSync(p) ? realpathSync(p) : undefined),
  }
  const hostile = async (): Promise<Guard> => {
    const g = new Guard(io, { rawOnly: [], mcpRestore: [] })
    await g.load(root)
    g.rules = {
      state: 'applied',
      rules: HOSTILE,
      skipped: { vaultLocked: 0, teamLocked: 0, unopenable: 0, refused: 0 },
    } as Guard['rules']
    return g
  }
  const read = (g: Guard, name: string, content: string, budget?: RuleBudget) => {
    const path = join(root, name)
    writeFileSync(path, content)
    return g.afterTool(
      'Read',
      { tool: 'Read', file_path: path },
      {
        result: {
          type: 'text',
          file: { filePath: path, content, numLines: 1, startLine: 1, totalLines: 1 },
        },
      },
      Date.now() + 60_000,
      budget
    )
  }

  it('a Bash result in a guard: the band says rules stopped', async () => {
    const g = await hostile()
    const budget = g.invocation()
    const started = performance.now()
    const out = JSON.stringify(
      await g.afterTool(
        'Bash',
        { tool: 'Bash', command: 'ls' },
        { result: { stdout: OUTPUT, stderr: '', interrupted: false, isImage: false } },
        Date.now() + 60_000,
        budget
      )
    )
    expect(performance.now() - started).toBeLessThan(20_000)
    expect(out).not.toMatch(/identifier_name_/)
    expect(bandText(g)).toContain('custom rules stopped matching: too much work')
  })

  it('files read in one invocation share it; the next invocation starts afresh', async () => {
    const g = await hostile()
    let budget = g.invocation()
    await read(g, 'big.ts', SOURCE, budget)
    expect(budget.spent).toBe(true)
    const afterBig = g.counts.rulesStopped
    expect(afterBig).toBeGreaterThan(0)
    // A one-line file on its own would never spend it: shared, it is spent.
    await read(g, 'small.ts', 'const small_name_x = 1\n', budget)
    expect(g.counts.rulesStopped).toBeGreaterThan(afterBig)
    budget = g.invocation()
    expect(budget.spent).toBe(false)
    const before = g.counts.rulesStopped
    await read(g, 'other.ts', 'const other_name_x = 1\n', budget)
    expect(budget.spent).toBe(false)
    expect(g.counts.rulesStopped).toBe(before)
  })

  it('an index slice between beforeTool and afterTool does not refill the hook’s budget', async () => {
    const g = new Guard(io, { rawOnly: [], mcpRestore: [] })
    await g.load(root)
    const keep: CustomRule = { ...HOSTILE[0]!, id: 'keep', pattern: '^keep_me' }
    g.rules = {
      state: 'applied',
      rules: [keep],
      skipped: { vaultLocked: 0, teamLocked: 0, unopenable: 0, refused: 0 },
    } as Guard['rules']
    const path = join(root, 'a.ts')
    writeFileSync(path, 'const keep_me_name = 1\n')
    const budget = g.invocation()
    await g.beforeTool({ tool: 'Read', file_path: path }, budget)
    // The hook's own work spent its budget ...
    budget.left = -1
    budget.spent = true
    // ... then the background index takes a slice, with a budget of its own.
    g.invocation()
    await g.indexProject(Date.now() + 1000)
    const out = JSON.stringify(await read(g, 'a.ts', 'const keep_me_name = 1\n', budget))
    // Spent, no rule keeps a name readable: the whitelisted name is masked.
    expect(out).not.toContain('keep_me_name')
  })
})

// Spec 085 part 3, R2-17 (security audit run-2): the guard matched rules
// with a cache and loop of its own that missed the L8 fix - compile work not
// charged, no 1000-rule cap, the cache cleared whole past 1000. It now matches
// through the engine's matcher and cap, as anonymize does.
describe('the guard matches rules as the engine does (R2-17)', () => {
  const rule = (i: number, pattern: string): CustomRule => ({
    id: `w${i}`,
    scope: 'personal',
    team_id: null,
    sort_order: i,
    name: `w${i}`,
    type: 'whitelist',
    pattern,
    enabled: true,
  })
  const MANY = [
    ...Array.from({ length: 1001 }, (_, i) => rule(i, `^PaymentGateway${i}$`)),
    rule(1001, '^PaymentGateway$'),
  ]

  it('past 1000 rules no whitelist keeps a name readable, and the budget says so', () => {
    const budget = ruleBudget()
    const out = applyMap(
      'new PaymentGateway()',
      { __CLS__1: 'PaymentGateway' },
      {
        ...NO_CONTEXT,
        rules: MANY,
        budget,
      }
    )
    expect(out).not.toContain('PaymentGateway')
    expect(budget.spent).toBe(true)
  })

  it('compiling a pattern draws on the budget', () => {
    const rules = Array.from({ length: 50 }, (_, i) => rule(i, `^(a|b|c|d|e|f|g)+Name${i}$`))
    const used = () => {
      const budget = ruleBudget()
      const before = budget.left
      applyMap(
        'new PaymentGateway()',
        { __CLS__1: 'PaymentGateway' },
        { ...NO_CONTEXT, rules, budget }
      )
      return before - budget.left
    }
    used() // every pattern compiled once in this process
    // A new budget pays each pattern's compile again, as the engine charges
    // it (not only the few steps matching PaymentGateway takes).
    expect(used()).toBeGreaterThan(50 * 10)
  })
})
