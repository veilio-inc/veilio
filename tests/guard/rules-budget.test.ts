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
import type { CustomRule } from '../../plugins/veilio-guard/vendor/engine/index.js'

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
  const read = (g: Guard, name: string, content: string) => {
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
      }
    )
  }

  it('a Bash result in a guard: the band says rules stopped', async () => {
    const g = await hostile()
    g.invocation()
    const started = performance.now()
    const out = JSON.stringify(
      await g.afterTool(
        'Bash',
        { tool: 'Bash', command: 'ls' },
        { result: { stdout: OUTPUT, stderr: '', interrupted: false, isImage: false } }
      )
    )
    expect(performance.now() - started).toBeLessThan(20_000)
    expect(out).not.toMatch(/identifier_name_/)
    expect(bandText(g)).toContain('custom rules stopped matching: too much work')
  })

  it('files read in one invocation share it; the next invocation starts afresh', async () => {
    const g = await hostile()
    g.invocation()
    await read(g, 'big.ts', SOURCE)
    expect(g.budget.spent).toBe(true)
    const afterBig = g.counts.rulesStopped
    expect(afterBig).toBeGreaterThan(0)
    // A one-line file on its own would never spend it: shared, it is spent.
    await read(g, 'small.ts', 'const small_name_x = 1\n')
    expect(g.counts.rulesStopped).toBeGreaterThan(afterBig)
    g.invocation()
    expect(g.budget.spent).toBe(false)
    const before = g.counts.rulesStopped
    await read(g, 'other.ts', 'const other_name_x = 1\n')
    expect(g.budget.spent).toBe(false)
    expect(g.counts.rulesStopped).toBe(before)
  })
})
