import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Constitution I: a published claim has a test that fails when it stops being
// true. COVERAGE.md is the published statement for the Claude Code guard, so
// every test it names must exist, and every plugin test must back a claim.
const PLUGIN = join(__dirname, '../../plugins/veilio-guard')
const coverage = readFileSync(join(PLUGIN, 'COVERAGE.md'), 'utf8')

type Ref = { file: string; name: string }
const refs: Ref[] = []
for (const row of coverage
  .split('\n')
  .filter((l) => l.startsWith('| ') && !l.startsWith('| Claim') && !l.startsWith('| ---'))) {
  const cells = row.split(' | ')
  const testCell = cells[cells.length - 1].replace(/\|\s*$/, '')
  for (const part of testCell.split('; ')) {
    const m = /`([^`]+\.test\.ts)` › (.+)$/.exec(part.trim())
    if (m) refs.push({ file: m[1], name: m[2].trim() })
  }
}

describe('COVERAGE.md', () => {
  it('names tests', () => {
    expect(refs.length).toBeGreaterThan(20)
  })

  it.each(refs.map((r) => [`${r.file} › ${r.name}`, r] as const))('%s exists', (_, ref) => {
    const path = join(PLUGIN, 'tests', ref.file)
    expect(existsSync(path)).toBe(true)
    const source = readFileSync(path, 'utf8')
    // The test's name as written in the file, whichever quotes it uses.
    const names = [...source.matchAll(/^test\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gm)].map((m) =>
      m[2].replace(/\\'/g, "'")
    )
    const loop =
      /for \(const path of[\s\S]*?test\(`Read of \$\{path\} is refused before it runs`/.test(source)
    const generated = loop && /^Read of .+ is refused before it runs$/.test(ref.name)
    expect(generated || names.includes(ref.name)).toBe(true)
  })

  it('every plugin test file backs a claim', () => {
    const files = readdirSync(join(PLUGIN, 'tests')).filter((f) => f.endsWith('.test.ts'))
    for (const f of files) expect(refs.map((r) => r.file)).toContain(f)
  })

  it('states what the guard does not cover', () => {
    expect(coverage).toMatch(/## Not covered/)
    expect(coverage).toMatch(/--safe-mode/)
    expect(coverage).toMatch(/Programs that open files themselves/)
  })
})
