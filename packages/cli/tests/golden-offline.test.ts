import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { main } from '../src/index.js'
import type { Io } from '../src/commands.js'

/**
 * FR-022 / SC-008 (spec 052): with nobody signed in, the offline commands are
 * BYTE-IDENTICAL to what they were before spec 052 touched this package.
 *
 * "Behaves the same" checked by a handful of `toContain`s is a claim about the
 * lines somebody thought to check. This compares every byte of stdout and
 * stderr, and the exit code, for each offline command against outputs recorded
 * at e6e6a09 (npm 0.5.4, before any of spec 052's code existed). A change to
 * any of them fails here rather than in somebody's pre-commit hook.
 *
 * The fixture is written only by `VEILIO_WRITE_GOLDEN=1`, and only against the
 * commit it claims to describe. Regenerating it to make this pass would turn
 * the test into a record of whatever the code does now, which proves nothing.
 *
 * The one thing normalised is the temp directory's path, which `map` prints.
 */

const GOLDEN = fileURLToPath(new URL('./fixtures/offline-golden.json', import.meta.url))

const SOURCE = `import { Injectable } from '@nestjs/common'
import { readFileSync } from 'node:fs'
import { ledgerTotals } from '@acme/ledger-core'

// Settles a customer's ledger. Ticket ACME-42.
export class LedgerService {
  private readonly apiKey = 'AKIAIOSFODNN7EXAMPLE'

  settleInvoice(customerAccount: string, total: number): number {
    const balance = ledgerTotals(customerAccount)
    return balance + total
  }
}
`

const PY = `class InvoiceRouter:
    def route_payment(self, merchant_id):
        return merchant_id
`

const CREDS = 'const awsKey = "AKIAIOSFODNN7EXAMPLE"\nconst mail = "ops@acme.internal"\n'

/** Each case runs in a fresh project so no case sees another's map. */
const CASES: { name: string; steps: { argv: string[]; stdin?: string | 'PREV' }[] }[] = [
  { name: 'scrub a file', steps: [{ argv: ['scrub', 'src/ledger.ts'] }] },
  { name: 'scrub two files', steps: [{ argv: ['scrub', 'src/ledger.ts', 'src/router.py'] }] },
  { name: 'scrub stdin', steps: [{ argv: ['scrub'], stdin: SOURCE }] },
  { name: 'scrub --preamble', steps: [{ argv: ['scrub', '--preamble', 'src/ledger.ts'] }] },
  { name: 'scrub --quiet', steps: [{ argv: ['scrub', '-q', 'src/ledger.ts'] }] },
  { name: 'scrub --secrets warn', steps: [{ argv: ['scrub', '-s', 'warn', 'src/ledger.ts'] }] },
  { name: 'scrub --team signed out', steps: [{ argv: ['scrub', '--team', 'src/ledger.ts'] }] },
  {
    name: 'scrub then restore',
    steps: [{ argv: ['scrub', 'src/ledger.ts'] }, { argv: ['restore'], stdin: 'PREV' }],
  },
  {
    name: 'restore an invented placeholder',
    steps: [
      { argv: ['scrub', 'src/ledger.ts'] },
      { argv: ['restore'], stdin: 'class __CLS__1 { __FN__99() {} }\n' },
    ],
  },
  {
    name: 'restore --strict refuses',
    steps: [
      { argv: ['scrub', 'src/ledger.ts'] },
      { argv: ['restore', '--strict'], stdin: 'class __CLS__1 { __FN__99() {} }\n' },
    ],
  },
  {
    name: 'restore --keep-docs',
    steps: [
      { argv: ['scrub', 'src/ledger.ts'] },
      {
        argv: ['restore', '--keep-docs'],
        stdin: '/** Docs. */\nclass __CLS__1 {}\n// TODO: tidy\n',
      },
    ],
  },
  { name: 'restore with no map', steps: [{ argv: ['restore'], stdin: 'class __CLS__1 {}\n' }] },
  { name: 'scan a file', steps: [{ argv: ['scan', 'src/creds.ts'] }] },
  { name: 'scan --json', steps: [{ argv: ['scan', '--json', 'src/creds.ts'] }] },
  { name: 'scan --strict', steps: [{ argv: ['scan', '--strict', 'src/creds.ts'] }] },
  { name: 'scan clean', steps: [{ argv: ['scan', 'src/router.py'] }] },
  { name: 'map empty', steps: [{ argv: ['map'] }] },
  { name: 'map after scrub', steps: [{ argv: ['scrub', 'src/ledger.ts'] }, { argv: ['map'] }] },
  {
    name: 'map --json after scrub',
    steps: [{ argv: ['scrub', 'src/ledger.ts'] }, { argv: ['map', '--json'] }],
  },
  {
    name: 'map --clear',
    steps: [{ argv: ['scrub', 'src/ledger.ts'] }, { argv: ['map', '--clear'] }],
  },
]

interface Recorded {
  code: number
  out: string
  err: string
}

let home: string
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-golden-home-'))
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
})

async function runCase(steps: (typeof CASES)[number]['steps']): Promise<Recorded[]> {
  const cwd = mkdtempSync(join(tmpdir(), 'veilio-golden-work-'))
  try {
    mkdirSync(join(cwd, '.git'), { recursive: true })
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(cwd, 'src', 'ledger.ts'), SOURCE)
    writeFileSync(join(cwd, 'src', 'router.py'), PY)
    writeFileSync(join(cwd, 'src', 'creds.ts'), CREDS)
    const recorded: Recorded[] = []
    let prev = ''
    for (const step of steps) {
      let out = ''
      let err = ''
      const io: Io = {
        cwd,
        home,
        stdin: async () => (step.stdin === 'PREV' ? prev : (step.stdin ?? '')),
        stdout: (t) => (out += t),
        stderr: (t) => (err += t),
        prompt: async () => '',
        password: async () => '',
      }
      const code = await main(step.argv, io)
      prev = out
      const norm = (s: string): string => s.split(cwd).join('<CWD>')
      recorded.push({ code, out: norm(out), err: norm(err) })
    }
    return recorded
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

describe('signed out, the offline commands are byte-identical to before spec 052 (FR-022)', () => {
  if (process.env.VEILIO_WRITE_GOLDEN === '1') {
    it('writes the golden outputs', async () => {
      const all: Record<string, Recorded[]> = {}
      for (const c of CASES) all[c.name] = await runCase(c.steps)
      mkdirSync(join(GOLDEN, '..'), { recursive: true })
      writeFileSync(GOLDEN, `${JSON.stringify(all, null, 2)}\n`)
    })
    return
  }

  const golden = existsSync(GOLDEN)
    ? (JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, Recorded[]>)
    : {}

  it('has a recorded output for every case, and no stale ones', () => {
    expect(Object.keys(golden).sort()).toEqual(CASES.map((c) => c.name).sort())
  })

  it.each(CASES.map((c) => [c.name, c] as const))('%s', async (name, c) => {
    const got = await runCase(c.steps)
    expect(got).toEqual(golden[name])
    expect(fetchMock, `${name} made a request`).not.toHaveBeenCalled()
  })
})
