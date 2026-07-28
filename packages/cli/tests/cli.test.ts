import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_FINDINGS, EXIT_OK } from '../src/commands.js'
import type { Io } from '../src/commands.js'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'veilio-cli-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

interface Run {
  code: number
  out: string
  err: string
}

async function run(argv: string[], stdin = ''): Promise<Run> {
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    stdin: async () => stdin,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  }
  const code = await main(argv, io)
  return { code, out, err }
}

function write(name: string, content: string): string {
  const path = join(cwd, name)
  writeFileSync(path, content)
  return path
}

const TS = 'export class PaymentGateway {\n  chargeCard(amount: number) { return amount }\n}\n'
const GO = 'package billing\n\nfunc Apply(rate float64) error {\n\treturn nil\n}\n'
const WITH_KEY = 'const client = init("sk_live_51H8xQ2ABCDEFGHIJKLMNOP")\n'

describe('argument handling', () => {
  it('shows help with no arguments', async () => {
    const r = await run([])
    expect(r.code).toBe(EXIT_OK)
    expect(r.out).toContain('veilio — anonymize code')
  })

  it('shows help on --help', async () => {
    expect((await run(['--help'])).out).toContain('USAGE')
  })

  it('shows help on --help even after a command', async () => {
    expect((await run(['scrub', '--help'])).out).toContain('USAGE')
  })

  it('prints a version', async () => {
    const r = await run(['--version'])
    expect(r.out.trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('rejects an unknown command', async () => {
    const r = await run(['frobnicate'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain('unknown command')
  })

  it('rejects an unknown flag', async () => {
    const r = await run(['scrub', '--turbo'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain('unknown flag')
  })

  it('rejects an unknown language', async () => {
    const r = await run(['scrub', '--language', 'cobol'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain('unknown language')
  })

  it('rejects an invalid secrets policy', async () => {
    const r = await run(['scrub', '--secrets', 'maybe'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain('--secrets must be')
  })

  it('rejects a flag missing its value', async () => {
    const r = await run(['scrub', '--language'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain('requires a value')
  })

  it('rejects a flag whose value is another flag', async () => {
    const r = await run(['scrub', '--map', '--quiet'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain('requires a value')
  })
})

describe('scrub', () => {
  it('masks identifiers from stdin', async () => {
    const r = await run(['scrub'], TS)
    expect(r.code).toBe(EXIT_OK)
    expect(r.out).not.toContain('PaymentGateway')
    expect(r.out).toContain('__CLS__1')
  })

  it('masks identifiers from a file', async () => {
    write('a.ts', TS)
    const r = await run(['scrub', 'a.ts'])
    expect(r.out).not.toContain('PaymentGateway')
  })

  it('detects the language and reports it', async () => {
    const r = await run(['scrub'], GO)
    expect(r.err).toContain('Go')
    // Go reserved words must survive — the whole point of language awareness.
    expect(r.out).toContain('func')
    expect(r.out).toContain('package')
  })

  it('honours an explicit language override', async () => {
    const r = await run(['scrub', '--language', 'python'], GO)
    expect(r.err).toContain('Python')
  })

  it('writes the map to the project store', async () => {
    await run(['scrub'], TS)
    const stored = JSON.parse(readFileSync(join(cwd, '.veilio', 'map.json'), 'utf8'))
    expect(stored.version).toBe(1)
    expect(Object.values(stored.map)).toContain('PaymentGateway')
  })

  it('writes the map 0600 — it holds the real names', async () => {
    await run(['scrub'], TS)
    const mode = statSync(join(cwd, '.veilio', 'map.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('gitignores the store so real names are never committed', async () => {
    await run(['scrub'], TS)
    expect(readFileSync(join(cwd, '.veilio', '.gitignore'), 'utf8')).toBe('*\n')
  })

  it('reuses placeholders across runs so the map stays stable', async () => {
    const first = await run(['scrub'], TS)
    const second = await run(['scrub'], TS)
    expect(second.out).toBe(first.out)
  })

  it('extends the map when new identifiers appear', async () => {
    await run(['scrub'], TS)
    await run(['scrub'], 'export class LedgerWriter {}\n')
    const stored = JSON.parse(readFileSync(join(cwd, '.veilio', 'map.json'), 'utf8'))
    expect(Object.values(stored.map)).toContain('PaymentGateway')
    expect(Object.values(stored.map)).toContain('LedgerWriter')
  })

  it('honours an explicit --map path', async () => {
    await run(['scrub', '--map', 'custom.json'], TS)
    expect(JSON.parse(readFileSync(join(cwd, 'custom.json'), 'utf8')).version).toBe(1)
  })

  it('adds the AI preamble with --preamble', async () => {
    const r = await run(['scrub', '--preamble'], TS)
    expect(r.out).toContain('processed by Veilio')
    expect(r.out).toContain('Placeholder legend')
  })

  it('says nothing on stderr with --quiet', async () => {
    expect((await run(['scrub', '--quiet'], TS)).err).toBe('')
  })

  it('concatenates several files', async () => {
    write('a.ts', TS)
    write('b.ts', 'export class LedgerWriter {}\n')
    const r = await run(['scrub', 'a.ts', 'b.ts'])
    expect(r.out).toContain('__CLS__1')
    expect(r.out).toContain('__CLS__2')
  })

  it('fails cleanly on a missing file', async () => {
    const r = await run(['scrub', 'nope.ts'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain('veilio:')
  })
})

describe('scrub — credential guard', () => {
  it('redacts a live key and warns', async () => {
    const r = await run(['scrub'], WITH_KEY)
    expect(r.out).toContain('__REDACTED_STRIPE_KEY_1__')
    expect(r.out).not.toContain('sk_live_51H8xQ2ABCDEFGHIJKLMNOP')
    expect(r.err).toContain('1 critical')
    expect(r.err).toContain('NOT recoverable')
  })

  it('keeps the key out of the persisted map', async () => {
    await run(['scrub'], WITH_KEY)
    const stored = readFileSync(join(cwd, '.veilio', 'map.json'), 'utf8')
    expect(stored).not.toContain('sk_live_51H8xQ2ABCDEFGHIJKLMNOP')
  })

  it('never prints the full key in the warning', async () => {
    const r = await run(['scrub'], WITH_KEY)
    expect(r.err).not.toContain('sk_live_51H8xQ2ABCDEFGHIJKLMNOP')
  })

  it('reports without redacting under --secrets warn', async () => {
    const r = await run(['scrub', '--secrets', 'warn'], WITH_KEY)
    expect(r.out).not.toContain('__REDACTED_')
    expect(r.err).toContain('critical')
  })

  it('skips the scan entirely under --secrets off', async () => {
    const r = await run(['scrub', '--secrets', 'off'], WITH_KEY)
    expect(r.err).not.toContain('credentials detected')
  })
})

describe('restore', () => {
  it('round-trips scrub output exactly', async () => {
    const scrubbed = await run(['scrub'], TS)
    const restored = await run(['restore'], scrubbed.out)
    expect(restored.code).toBe(EXIT_OK)
    expect(restored.out).toBe(TS)
  })

  it('strips AI-generated noise', async () => {
    await run(['scrub'], TS)
    const r = await run(['restore'], '/** Generated doc. */\nconst x = 1\n')
    expect(r.out).not.toContain('Generated doc')
    expect(r.err).toContain('stripped 1 AI artifact')
  })

  it('errors rather than silently echoing when there is no map', async () => {
    // restore() against an empty map returns the input unchanged, which reads
    // as success. The CLI must not let that pass.
    const r = await run(['restore'], 'const __CLS__1 = 1\n')
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain('run "veilio scrub" first')
  })

  it('does not resurrect a redacted credential', async () => {
    const scrubbed = await run(['scrub'], WITH_KEY)
    const restored = await run(['restore'], scrubbed.out)
    expect(restored.out).not.toContain('sk_live_51H8xQ2ABCDEFGHIJKLMNOP')
    expect(restored.out).toContain('__REDACTED_STRIPE_KEY_1__')
  })
})

describe('scan', () => {
  it('exits 0 and rewrites nothing on clean input', async () => {
    const r = await run(['scan'], TS)
    expect(r.code).toBe(EXIT_OK)
    expect(r.out).toBe('')
    expect(r.err).toContain('no credentials detected')
  })

  it('exits 1 when it finds a live key', async () => {
    const r = await run(['scan'], WITH_KEY)
    expect(r.code).toBe(EXIT_FINDINGS)
    expect(r.err).toContain('critical')
  })

  it('leaves stdout clean so it composes in a pipe', async () => {
    expect((await run(['scan'], WITH_KEY)).out).toBe('')
  })

  it('does not write a map — scan is detect-only', async () => {
    await run(['scan'], WITH_KEY)
    expect(() => readFileSync(join(cwd, '.veilio', 'map.json'))).toThrow()
  })

  it('exits 0 on advisory-only findings by default', async () => {
    const r = await run(['scan'], 'const owner = "person@example.com"\n')
    expect(r.code).toBe(EXIT_OK)
  })

  it('exits 1 on advisory findings under --strict', async () => {
    const r = await run(['scan', '--strict'], 'const owner = "person@example.com"\n')
    expect(r.code).toBe(EXIT_FINDINGS)
  })

  it('reports file, line and column for each finding', async () => {
    write('leak.ts', `const a = 1\n${WITH_KEY}`)
    const r = await run(['scan', 'leak.ts'])
    expect(r.err).toContain('leak.ts:2:')
  })

  it('emits machine-readable JSON with --json', async () => {
    write('leak.ts', WITH_KEY)
    const r = await run(['scan', 'leak.ts', '--json'])
    const parsed = JSON.parse(r.out)
    expect(parsed[0].file).toBe('leak.ts')
    expect(parsed[0].type).toBe('stripe-key')
    expect(parsed[0].preview).not.toContain('sk_live_51H8xQ2ABCDEFGHIJKLMNOP')
  })

  it('scans several files at once', async () => {
    write('a.ts', WITH_KEY)
    write('b.ts', 'const id = "AKIAIOSFODNN7EXAMPLE"\n')
    const r = await run(['scan', 'a.ts', 'b.ts'])
    expect(r.code).toBe(EXIT_FINDINGS)
    expect(r.err).toContain('2 critical')
  })

  it('stays quiet on clean input with --quiet', async () => {
    expect((await run(['scan', '--quiet'], TS)).err).toBe('')
  })
})

describe('map', () => {
  it('reports an empty store', async () => {
    expect((await run(['map'])).err).toContain('no map at')
  })

  it('lists placeholders after a scrub', async () => {
    await run(['scrub'], TS)
    const r = await run(['map'])
    expect(r.out).toContain('PaymentGateway')
    expect(r.err).toContain('placeholders at')
  })

  it('emits the raw map with --json', async () => {
    await run(['scrub'], TS)
    expect(Object.values(JSON.parse((await run(['map', '--json'])).out))).toContain(
      'PaymentGateway'
    )
  })

  it('clears the store', async () => {
    await run(['scrub'], TS)
    const r = await run(['map', '--clear'])
    expect(r.err).toContain('cleared')
    expect((await run(['map'])).err).toContain('no map at')
  })

  it('is a no-op when clearing an absent store', async () => {
    const r = await run(['map', '--clear'])
    expect(r.code).toBe(EXIT_OK)
    expect(r.err).toContain('no map at')
  })
})

describe('map store robustness', () => {
  it('refuses a corrupt map rather than starting from empty', async () => {
    // Silently resetting would orphan every placeholder already in flight.
    mkdirSync(join(cwd, '.veilio'), { recursive: true })
    write('.veilio/map.json', 'not json at all')
    const r = await run(['scrub'], TS)
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain('not valid JSON')
  })

  it('rejects a structurally wrong map', async () => {
    mkdirSync(join(cwd, '.veilio'), { recursive: true })
    write('.veilio/map.json', '{"version":1,"map":{"__CLS__1":123}}')
    const r = await run(['scrub'], TS)
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain('malformed')
  })

  it('rejects a map with no version wrapper', async () => {
    mkdirSync(join(cwd, '.veilio'), { recursive: true })
    write('.veilio/map.json', '{"__CLS__9":"SomeName"}')
    const r = await run(['scrub'], TS)
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain('malformed')
  })

  it('finds the project store from a subdirectory', async () => {
    await run(['scrub'], TS)
    const nested = join(cwd, 'src', 'deep')
    mkdirSync(nested, { recursive: true })
    let out = ''
    const code = await main(['map'], {
      cwd: nested,
      stdin: async () => '',
      stdout: (t) => (out += t),
      stderr: () => {},
    })
    expect(code).toBe(EXIT_OK)
    expect(out).toContain('PaymentGateway')
  })
})

describe('restore --keep-docs', () => {
  const DOCUMENTED = '/**\n * Settles an invoice.\n */\nexport class PaymentGateway {}\n'

  it('strips JSDoc by default', async () => {
    await run(['scrub'], DOCUMENTED)
    const r = await run(['restore'], '/**\n * Settles an invoice.\n */\nconst x = 1\n')
    expect(r.out).not.toContain('Settles an invoice')
  })

  it('keeps JSDoc with --keep-docs', async () => {
    // When the model was asked to document its output, stripping the docs is
    // destroying requested work rather than removing noise.
    await run(['scrub'], DOCUMENTED)
    const r = await run(['restore', '--keep-docs'], '/**\n * Settles an invoice.\n */\nconst x = 1\n')
    expect(r.out).toContain('Settles an invoice')
  })

  it('still strips genuine noise with --keep-docs', async () => {
    await run(['scrub'], DOCUMENTED)
    const r = await run(['restore', '--keep-docs'], '/** Doc. */\n// TODO: fix\nconst x = 1\n')
    expect(r.out).toContain('Doc.')
    expect(r.out).not.toContain('TODO')
  })
})
