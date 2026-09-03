import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_FINDINGS, EXIT_OK } from '../src/commands.js'
import type { Io } from '../src/commands.js'
import { MapOverwriteError, saveMap } from '../src/store.js'

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

// An AI asked to echo placeholders verbatim is under no obligation to comply.
// When it renames one, restore() has nothing to substitute and stdout carries
// the AI's invention where a real name belonged — indistinguishable, in the
// text alone, from a clean run. stderr is where that difference has to show.
describe('restore — round-trip report', () => {
  // TS masks to exactly three: __CLS__1, __FN__1, __VAR__1.
  it('counts what came back rather than what the map holds', async () => {
    const scrubbed = await run(['scrub'], TS)
    const r = await run(['restore'], scrubbed.out)
    expect(r.err).toMatch(/restored 3 of 3 placeholders/)
  })

  it('counts only what the text actually carried', async () => {
    // The old line reported the map size, which is the same number whether the
    // AI echoed every placeholder or none of them.
    await run(['scrub'], TS)
    const r = await run(['restore'], 'new __CLS__1().__FN__1()\n')
    expect(r.err).toMatch(/restored 2 of 3 placeholders/)
  })

  it('names a placeholder-shaped token that matches no map entry', async () => {
    await run(['scrub'], TS)
    const r = await run(['restore'], 'new __CLS__1().__FN__9()\n')
    expect(r.err).toContain('__FN__9')
    expect(r.err).toMatch(/not in the map/)
    expect(r.err).toMatch(/invented or altered/)
  })

  it('reports an invented token even under --quiet', async () => {
    // --quiet suppresses the all-clear summary; findings always show. Silently
    // dropping this would hide the one case where stdout is wrong.
    await run(['scrub'], TS)
    const r = await run(['restore', '--quiet'], 'new __CLS__1().__FN__9()\n')
    expect(r.err).toContain('__FN__9')
    expect(r.err).not.toMatch(/restored \d+ of/)
  })

  it('keeps a partial answer quiet under --quiet', async () => {
    // A reply covering one function legitimately omits the rest, so this is
    // information, not a finding, and belongs with the summary it sits under.
    await run(['scrub'], TS)
    const r = await run(['restore', '--quiet'], 'new __CLS__1()\n')
    expect(r.err).toBe('')
  })

  it('mentions absent placeholders in the normal summary', async () => {
    await run(['scrub'], TS)
    const r = await run(['restore'], 'new __CLS__1()\n')
    expect(r.err).toMatch(/2 placeholders did not appear/)
    expect(r.err).toMatch(/not recoverable/)
  })

  it('says "placeholder" when exactly one is absent', async () => {
    // Pluralisation is the kind of detail that reads as sloppiness in the one
    // message asking the user to go re-check their code by hand.
    await run(['scrub'], TS)
    const r = await run(['restore'], 'new __CLS__1().__FN__1()\n')
    expect(r.err).toMatch(/1 placeholder did not appear/)
  })

  it('says nothing extra when every placeholder came back', async () => {
    const scrubbed = await run(['scrub'], TS)
    const r = await run(['restore'], scrubbed.out)
    expect(r.err).not.toMatch(/not in the map/)
    expect(r.err).not.toMatch(/did not appear/)
  })

  it('still exits 0 with an unexplained token, so pipelines do not break', async () => {
    // The restored text on stdout is still usable, and `... | veilio restore >
    // file` under `set -e` must not die over a warning the user can act on.
    // Gating that behind a flag is a separate decision from reporting it.
    await run(['scrub'], TS)
    const r = await run(['restore'], 'new __CLS__1().__FN__9()\n')
    expect(r.code).toBe(EXIT_OK)
    expect(r.out).toContain('PaymentGateway')
  })

  it('does not count a redacted credential as an unexplained token', async () => {
    // __REDACTED_*__ never enters the map by design, so remaining in the output
    // is exactly correct. Flagging it would make the warning fire on every
    // restore that involved a credential, and a warning that always fires is
    // one nobody reads.
    const scrubbed = await run(['scrub'], WITH_KEY)
    const r = await run(['restore'], scrubbed.out)
    expect(r.out).toContain('__REDACTED_STRIPE_KEY_1__')
    expect(r.err).not.toMatch(/not in the map/)
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
    const r = await run(
      ['restore', '--keep-docs'],
      '/**\n * Settles an invoice.\n */\nconst x = 1\n'
    )
    expect(r.out).toContain('Settles an invoice')
  })

  it('still strips genuine noise with --keep-docs', async () => {
    await run(['scrub'], DOCUMENTED)
    const r = await run(['restore', '--keep-docs'], '/** Doc. */\n// TODO: fix\nconst x = 1\n')
    expect(r.out).toContain('Doc.')
    expect(r.out).not.toContain('TODO')
  })
})

describe('what the masking did not cover (004-b3, 002-b4)', () => {
  // The engine reports both on every result specifically so the CLI and the MCP
  // server inherit them. A wrapper that drops them leaves the two surfaces where
  // nobody is looking at a panel — pipelines and agents — believing the output
  // is clean.

  it('reports comment prose left unmasked', async () => {
    write('a.ts', '// Ping Kowalska about Contoso, see INC-4471\nexport class Gateway {}\n')
    const { err } = await run(['scrub', 'a.ts'])
    expect(err).toMatch(/comment/i)
    expect(err).toMatch(/NOT masked/)
  })

  it('says how many comments and how much prose', async () => {
    write('a.ts', '// header note\nexport class Gateway {}\nconst x = 1 // trailing note\n')
    const { err } = await run(['scrub', 'a.ts'])
    expect(err).toMatch(/2 comments/)
    expect(err).toMatch(/1 inside the body/)
  })

  it('says nothing about comments when there are none', async () => {
    write('a.ts', 'export class Gateway {}\n')
    const { err } = await run(['scrub', 'a.ts'])
    expect(err).not.toMatch(/comment/i)
  })

  it('keeps the comment note out of stdout', async () => {
    // FR-002: stdout carries the artifact and nothing else, or the CLI cannot
    // sit in a pipe.
    write('a.ts', '// Ping Kowalska about Contoso\nexport class Gateway {}\n')
    const { out } = await run(['scrub', 'a.ts'])
    expect(out).not.toMatch(/NOT masked/)
    expect(out).toContain('// Ping Kowalska about Contoso')
  })

  it('suppresses the comment note under --quiet', async () => {
    // It fires on nearly every real file. Surviving --quiet would defeat the
    // flag and teach people to stop passing it.
    write('a.ts', '// Ping Kowalska about Contoso\nexport class Gateway {}\n')
    const { err } = await run(['scrub', 'a.ts', '--quiet'])
    expect(err).not.toMatch(/NOT masked/)
  })

  it('warns when no language marker matched', async () => {
    // Marker detection falls back to TypeScript. Prose alone matches nothing.
    write('a.txt', 'the quick brown fox jumped over the lazy dog again and again\n')
    const { err } = await run(['scrub', 'a.txt'])
    expect(err).toMatch(/no language marker matched/)
  })

  it('keeps the language warning even under --quiet', async () => {
    // Unlike the comment note: this one says the masking itself may be wrong,
    // and output that looks anonymised and is not must not be swallowed.
    write('a.txt', 'the quick brown fox jumped over the lazy dog again and again\n')
    const { err } = await run(['scrub', 'a.txt', '--quiet'])
    expect(err).toMatch(/no language marker matched/)
  })

  it('does not warn when the language was recognised', async () => {
    write('a.ts', TS)
    const { err } = await run(['scrub', 'a.ts'])
    expect(err).not.toMatch(/no language marker matched/)
  })

  it('does not warn when the language was given explicitly', async () => {
    write('a.txt', 'the quick brown fox jumped over the lazy dog again and again\n')
    const { err } = await run(['scrub', 'a.txt', '--language', 'python'])
    expect(err).not.toMatch(/no language marker matched/)
  })
})

describe('the map is not overwritten silently (005-c1 FR-005)', () => {
  // The requirement reads "MUST NOT be overwritten without an explicit flag",
  // and its stated reason is that overwriting "loses the only means of restoring
  // earlier output". Both callers already make that impossible: `scrub` and the
  // MCP server load the map, hand it to `anonymize` as `existingMap`, and save
  // the union — so the file only ever grows. Demanding `--force` for that would
  // put the flag on every second command, which is how a safety prompt becomes
  // muscle memory and stops being read.
  //
  // So the guard sits on `saveMap`, which is exported as `@veilio-inc/cli/store`
  // and is what the MCP package imports. These test it there, plus the CLI
  // behaviour that keeps it from firing in the normal path.

  it('appends across runs without needing a flag', async () => {
    write('a.ts', TS)
    write('b.ts', GO)
    expect((await run(['scrub', 'a.ts'])).code).toBe(EXIT_OK)
    const { code, err } = await run(['scrub', 'b.ts'])
    expect(code).toBe(EXIT_OK)
    expect(err).not.toMatch(/refusing to overwrite/)
  })

  it('keeps every earlier placeholder after a second run', async () => {
    // The reason the flag is not demanded. If this ever stops holding, the
    // guard below starts firing on ordinary use and the design has to change.
    write('a.ts', TS)
    write('b.ts', GO)
    await run(['scrub', 'a.ts'])
    const first = JSON.parse(readFileSync(join(cwd, '.veilio', 'map.json'), 'utf8')).map
    await run(['scrub', 'b.ts'])
    const second = JSON.parse(readFileSync(join(cwd, '.veilio', 'map.json'), 'utf8')).map
    for (const [placeholder, real] of Object.entries(first)) {
      expect(second[placeholder]).toBe(real)
    }
  })

  it('refuses a write that would drop an existing placeholder', () => {
    const path = join(cwd, 'map.json')
    saveMap(path, { __CLS__1: 'PaymentGateway', __FN__1: 'chargeCard' })
    expect(() => saveMap(path, { __FN__1: 'chargeCard' })).toThrow(MapOverwriteError)
  })

  it('names what would be lost, and how to proceed anyway', () => {
    const path = join(cwd, 'map.json')
    saveMap(path, { __CLS__1: 'PaymentGateway' })
    try {
      saveMap(path, {})
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(MapOverwriteError)
      expect((e as Error).message).toContain('__CLS__1')
      expect((e as Error).message).toContain('--force')
    }
  })

  it('refuses a write that would repoint a placeholder at a different name', () => {
    // Not only deletions. Re-using `__CLS__1` for something else makes every
    // text already masked with it restore to the wrong identifier, silently.
    const path = join(cwd, 'map.json')
    saveMap(path, { __CLS__1: 'PaymentGateway' })
    expect(() => saveMap(path, { __CLS__1: 'SomethingElse' })).toThrow(MapOverwriteError)
  })

  it('leaves the file untouched when it refuses', () => {
    const path = join(cwd, 'map.json')
    saveMap(path, { __CLS__1: 'PaymentGateway' })
    try {
      saveMap(path, {})
    } catch {
      // expected
    }
    expect(JSON.parse(readFileSync(path, 'utf8')).map.__CLS__1).toBe('PaymentGateway')
  })

  it('allows a superset without a flag', () => {
    const path = join(cwd, 'map.json')
    saveMap(path, { __CLS__1: 'PaymentGateway' })
    expect(() => saveMap(path, { __CLS__1: 'PaymentGateway', __FN__1: 'chargeCard' })).not.toThrow()
  })

  it('allows the first write to a path that does not exist yet', () => {
    expect(() => saveMap(join(cwd, 'fresh.json'), { __CLS__1: 'PaymentGateway' })).not.toThrow()
  })

  it('overwrites when force is given', () => {
    const path = join(cwd, 'map.json')
    saveMap(path, { __CLS__1: 'PaymentGateway' })
    saveMap(path, { __CLS__1: 'SomethingElse' }, { force: true })
    expect(JSON.parse(readFileSync(path, 'utf8')).map.__CLS__1).toBe('SomethingElse')
  })

  it('still locks the file down to 0600 after a forced overwrite', () => {
    const path = join(cwd, 'map.json')
    writeFileSync(path, JSON.stringify({ version: 1, map: { __CLS__1: 'Old' } }), { mode: 0o644 })
    saveMap(path, { __CLS__1: 'New' }, { force: true })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('exposes --force through the CLI', async () => {
    const { code } = await run(['scrub', '--force'], TS)
    expect(code).toBe(EXIT_OK)
  })
})
