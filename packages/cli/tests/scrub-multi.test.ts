import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_OK, type Io } from '../src/commands.js'

// Spec 050 US3: `veilio scrub a.ts b.go` reads each file in its own language
// and builds the map one file at a time would. On 2026-10-24 one call over this
// repository's 226 source files guessed Go for all of them and put TypeScript's
// `export`, `from` and `function` into the map as names.

const FILES: Record<string, string> = {
  'src/ledger.ts': [
    "import { describe, expect } from 'vitest'",
    'export function settleLedger(batchTotal: number): number {',
    '  const remainder = batchTotal % 97',
    '  return remainder',
    '}',
  ].join('\n'),
  // A TypeScript file whose strings and comments are other languages' code, as
  // the engine's language tests are: content detection reads it as Go.
  'src/samples.ts': [
    '// package main',
    '// func main() { fmt.Println("x") }',
    'export const GO_SAMPLE = `package billing',
    'func Apply(rate float64) error {',
    '\treturn nil',
    '}`',
    "export const PY_SAMPLE = 'def settle(batch):\\n    return batch'",
    'export function sampleFor(languageName: string): string {',
    '  return languageName === "go" ? GO_SAMPLE : PY_SAMPLE',
    '}',
  ].join('\n'),
  'cmd/apply.go': 'package billing\n\nfunc ApplyRate(rateValue float64) error {\n\treturn nil\n}\n',
  'notes.txt': 'settleLedger runs nightly.\n',
}

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'veilio-multi-'))
  mkdirSync(join(cwd, '.git'))
  for (const [name, text] of Object.entries(FILES)) {
    mkdirSync(join(cwd, name, '..'), { recursive: true })
    writeFileSync(join(cwd, name), text)
  }
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

async function scrub(files: string[], mapName: string) {
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    stdin: async () => '',
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  }
  const code = await main(['scrub', '--map', mapName, ...files], io)
  const map = JSON.parse(readFileSync(join(cwd, mapName), 'utf8')).map as Record<string, string>
  return { code, out, err, map }
}

const SOURCES = ['src/ledger.ts', 'src/samples.ts', 'cmd/apply.go', 'notes.txt']

describe('veilio scrub with several files', () => {
  it('gives the same map as one file per call', async () => {
    const together = await scrub(SOURCES, 'together.json')
    expect(together.code).toBe(EXIT_OK)
    let apart: Record<string, string> = {}
    for (const f of SOURCES) apart = (await scrub([f], 'apart.json')).map
    expect(Object.values(together.map).sort()).toEqual(Object.values(apart).sort())
  })

  it('puts no keyword and no third-party name into the map', async () => {
    const { map } = await scrub(SOURCES, 'map.json')
    const names = Object.values(map)
    for (const word of [
      'export',
      'from',
      'function',
      'const',
      'return',
      'vitest',
      'describe',
      'expect',
    ])
      expect(names, word).not.toContain(word)
    for (const own of ['settleLedger', 'batchTotal', 'sampleFor', 'ApplyRate', 'rateValue'])
      expect(names, own).toContain(own)
  })

  it('says which languages it read', async () => {
    const { err } = await scrub(SOURCES, 'map.json')
    expect(err).toMatch(/TypeScript/)
    expect(err).toMatch(/Go\b/)
  })

  it('writes the files to stdout in the order given', async () => {
    const { out } = await scrub(['cmd/apply.go', 'src/ledger.ts'], 'map.json')
    expect(out.indexOf('package billing')).toBeLessThan(out.indexOf('import {'))
  })
})

describe('a shell script among the inputs (security review of ce30398)', () => {
  it('what it declares stays masked, though a TypeScript file imports the same word', async () => {
    mkdirSync(join(cwd, 'scripts'), { recursive: true })
    writeFileSync(join(cwd, 'scripts/run.sh'), 'describe() { echo "$1"; }\n')
    const { out, map } = await scrub(['src/ledger.ts', 'scripts/run.sh'], 'map.json')
    const ledger = out.split('\n').find((l) => l.includes('vitest')) ?? ''
    // The import line: vitest and expect as written, describe masked.
    expect(ledger).toMatch(/^import \{ __\w+__\d+, expect \} from 'vitest'/)
    expect(Object.values(map)).toContain('describe')
  })
})
