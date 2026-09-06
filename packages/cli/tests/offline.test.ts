import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_OK, type Io } from '../src/commands.js'
import { readCredential, removeCredential, credentialPath } from '../src/credential.js'

/**
 * The offline promise, enforced twice over.
 *
 * FR-001, FR-002, FR-003. Anonymize, restore and scan work with no account, no
 * credential and no network — and the absence of a credential produces no
 * prompt, no warning and no failure.
 *
 * `purity.test.ts` already traps the network globals and asserts nothing touches
 * them. This file is not a duplicate of it, and the difference is the point:
 *
 *   - That file asserts nothing was CALLED. This one asserts the command
 *     SUCCEEDED — a command that crashed before reaching its network call
 *     satisfies "touched nothing" perfectly.
 *   - That file scans a hand-written list of four source files. This one walks
 *     the import graph, so a module added later is covered by existing itself
 *     rather than by somebody remembering to add it to a list.
 *   - Neither knew about a credential, because there was not one to know about.
 *
 * T015 requires that a `fetch` added to a local command turns BOTH this file and
 * the graph walk red, because either alone can be satisfied by an accident.
 */

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'veilio-offline-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

const SOURCE = [
  '// Ping Kowalska about the Contoso incident, acct 88412037',
  'export class PaymentGateway {',
  '  chargeCard(amount: number) { return amount }',
  '}',
].join('\n')

interface Run {
  code: number
  out: string
  err: string
  /** Did anything call the stub? */
  tripped: boolean
  /** Was the stub in place while the command ran? */
  installed: boolean
}

/**
 * Run a command with `fetch` replaced by a stub that throws if anything calls it.
 *
 * `tripped` and `installed` are reported back rather than merely asserted at the
 * end, because an exit code of 0 cannot distinguish "succeeded offline" from
 * "succeeded while quietly calling fetch and swallowing the error".
 */
async function runOffline(argv: string[], stdin = ''): Promise<Run> {
  const g = globalThis as unknown as Record<string, unknown>
  const savedFetch = g.fetch
  let tripped = false
  const stub = (): never => {
    tripped = true
    throw new Error('a local command made a network request')
  }
  g.fetch = stub
  let out = ''
  let err = ''
  let installed = false
  const io: Io = {
    cwd,
    // stdin is read during the run, so it is a free place to check that the
    // stub is actually in place for the duration rather than only around it.
    stdin: async () => {
      installed = g.fetch === stub
      return stdin
    },
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  }
  try {
    const code = await main(argv, io)
    return { code, out, err, tripped, installed }
  } finally {
    g.fetch = savedFetch
  }
}

// ─── T010 — the commands succeed offline, with no credential ─────────────────

describe('local commands work with no account and no network (FR-001, FR-002)', () => {
  it('scrub succeeds', async () => {
    writeFileSync(join(cwd, 'a.ts'), SOURCE)
    const run = await runOffline(['scrub', 'a.ts'])
    expect(run.code, run.err).toBe(EXIT_OK)
    expect(run.tripped, 'scrub called fetch').toBe(false)
    // Asserting the output too: an empty stdout with exit 0 is what a command
    // that quietly did nothing looks like, and that shipped once already.
    expect(run.out).toContain('__CLS__')
    expect(run.out).not.toContain('PaymentGateway')
  })

  it('restore succeeds and returns the original identifiers', async () => {
    writeFileSync(join(cwd, 'a.ts'), SOURCE)
    const scrubbed = await runOffline(['scrub', 'a.ts'])
    const run = await runOffline(['restore'], scrubbed.out)
    expect(run.code, run.err).toBe(EXIT_OK)
    expect(run.tripped, 'restore called fetch').toBe(false)
    expect(run.out).toContain('PaymentGateway')
  })

  it('scan succeeds', async () => {
    writeFileSync(join(cwd, 'a.ts'), SOURCE)
    const run = await runOffline(['scan', 'a.ts'])
    // scan exits non-zero when it finds something blocking; either way it must
    // not be the error code, which is what a thrown fetch would produce.
    expect(run.code, run.err).not.toBe(EXIT_ERROR)
    expect(run.tripped, 'scan called fetch').toBe(false)
    // And it must have actually looked: exit 0 with no output is what "did
    // nothing" also looks like.
    expect(run.out + run.err).not.toBe('')
  })

  it('the trap is installed AND armed while a command runs', async () => {
    // The load-bearing case, and it took two goes to get honest.
    //
    // Version one built a FRESH throwing function, called it, and asserted it
    // threw — never once touching the stub `runOffline` installs. Replacing the
    // real one with `() => undefined` left the file green.
    //
    // Version two asserted the installed stub's IDENTITY, which is better and
    // still not enough: an inert stub is the same object. The only thing that
    // proves the trap works is calling it, from inside the window where a
    // command would, and seeing both halves fire.
    let threw = false
    let sawStub = false
    const io: Io = {
      cwd,
      stdin: async () => {
        sawStub = typeof globalThis.fetch === 'function'
        try {
          await (globalThis.fetch as unknown as () => Promise<unknown>)()
        } catch {
          threw = true
        }
        return '__CLS__1'
      },
      stdout: () => {},
      stderr: () => {},
    }
    const g = globalThis as unknown as Record<string, unknown>
    const saved = g.fetch
    let tripped = false
    g.fetch = (): never => {
      tripped = true
      throw new Error('a local command made a network request')
    }
    try {
      await main(['restore'], io)
    } finally {
      g.fetch = saved
    }
    expect(sawStub, 'no fetch was installed during the run').toBe(true)
    expect(tripped, 'the trap did not record the call').toBe(true)
    expect(threw, 'the trap did not stop the call').toBe(true)
  })
})

// ─── T012 — an absent or broken credential is "not signed in" ────────────────

describe('a credential that is missing, malformed or unreadable reads as signed out', () => {
  it('returns null when there is no file at all', () => {
    expect(readCredential(cwd)).toBeNull()
  })

  it('returns null for a file that is not JSON', () => {
    writeCredentialRaw('not json at all {{{')
    expect(readCredential(cwd)).toBeNull()
  })

  it('returns null for JSON of the wrong shape', () => {
    for (const body of [
      '[]',
      'null',
      '"a string"',
      '{}',
      '{"token":"t"}',
      '{"token":"t","account":"a"}',
      '{"token":1,"account":"a","instance":"https://x"}',
      '{"token":"","account":"a","instance":"https://x"}',
    ]) {
      writeCredentialRaw(body)
      expect(readCredential(cwd), `${body} must not read as a credential`).toBeNull()
    }
  })

  it('returns null when the file cannot be read at all', () => {
    writeCredentialRaw('{"token":"t","account":"a@b.test","instance":"https://x"}')
    // Unreadable rather than absent: a permissions mistake, a half-written file,
    // a directory where a file should be. None of it may reach a local command.
    const path = credentialPath(cwd)
    rmSync(path)
    mkdirSync(path)
    expect(readCredential(cwd)).toBeNull()
  })

  it('reads a well-formed credential', () => {
    // The allow half. Without it, a reader that returns null unconditionally
    // satisfies every case above.
    writeCredentialRaw('{"token":"tok","account":"a@b.test","instance":"https://veilio.test"}')
    expect(readCredential(cwd)).toEqual({
      token: 'tok',
      account: 'a@b.test',
      instance: 'https://veilio.test',
    })
  })

  it('removing a credential that is not there is not an error', () => {
    expect(() => removeCredential(cwd)).not.toThrow()
    expect(removeCredential(cwd)).toBe(false)
  })

  it('reports true when it actually removed one', () => {
    // Without this, `return false` on the success path passes every other case
    // here, and `logout` would tell people they were never signed in.
    writeCredentialRaw('{"token":"t","account":"a@b.test","instance":"https://veilio.test"}')
    expect(removeCredential(cwd)).toBe(true)
    expect(removeCredential(cwd)).toBe(false)
  })

  it('refuses a credential naming a cleartext instance', () => {
    // `http://` would put the bearer token on the wire in the clear on every
    // request, and a hand-written self-hosted credential is exactly where that
    // appears. Unreadable is the safe direction.
    writeCredentialRaw('{"token":"t","account":"a@b.test","instance":"http://veilio.test"}')
    expect(readCredential(cwd)).toBeNull()
  })

  it('allows loopback over http, because that is development', () => {
    for (const instance of ['http://localhost:3000', 'http://127.0.0.1:3000']) {
      writeCredentialRaw(`{"token":"t","account":"a@b.test","instance":"${instance}"}`)
      expect(readCredential(cwd)?.instance, instance).toBe(instance)
    }
  })

  it('puts the credential under the store directory, not loose in $HOME', () => {
    // Every test above injects `home` and reads it back through the same
    // function, so the path itself is otherwise unasserted — dropping
    // STORE_DIR would leave them all green with a token loose in the home
    // directory.
    expect(credentialPath('/h')).toBe('/h/.veilio/credential.json')
  })

  it('never prompts, warns or fails a local command over a broken credential (FR-003)', async () => {
    writeFileSync(join(cwd, 'a.ts'), SOURCE)
    for (const body of ['', 'garbage', '{"token":"t"}', '[]']) {
      writeCredentialRaw(body)
      const run = await runOffline(['scrub', 'a.ts'])
      expect(run.code, run.err).toBe(EXIT_OK)
      // Not merely "did not crash": nothing on stderr may mention signing in.
      expect(run.err).not.toMatch(/sign[ -]?in|log[ -]?in|account|credential|token/i)
    }
  })

  function writeCredentialRaw(body: string): void {
    const path = credentialPath(cwd)
    mkdirSync(dirname(path), { recursive: true })
    rmSync(path, { force: true, recursive: true })
    writeFileSync(path, body)
    chmodSync(path, 0o600)
  }
})

// ─── T011 — nothing on the local path can even reach the network module ──────

describe('no module reachable from the local commands imports the cloud boundary', () => {
  const SRC = fileURLToPath(new URL('../src/', import.meta.url))

  /** Every relative import in a source file, resolved to a path under src/. */
  function importsOf(file: string): string[] {
    const text = readFileSync(file, 'utf8')
    const found: string[] = []
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      // Source is .ts; the imports are written .js for ESM output resolution.
      found.push(resolve(dirname(file), m[1].replace(/\.js$/, '.ts')))
    }
    return found
  }

  /** Everything reachable from `entry` by following relative imports. */
  function reachableFrom(entry: string): Set<string> {
    const seen = new Set<string>()
    const queue = [entry]
    while (queue.length > 0) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      for (const next of importsOf(file)) queue.push(next)
    }
    return seen
  }

  it('walks a graph that actually contains something', () => {
    // A walker that returns the entry alone would report every module below as
    // unreachable and pass for ever.
    const reachable = reachableFrom(join(SRC, 'commands.ts'))
    expect(reachable.size).toBeGreaterThan(1)
    expect([...reachable].some((f) => f.endsWith('store.ts'))).toBe(true)
  })

  it('cannot reach cloud.ts from commands.ts', () => {
    // The structural half of FR-002. The runtime stub above proves no request
    // was made on the paths the tests happen to drive; this proves the code that
    // could make one is not even linked into the local command path — including
    // on the branches no test exercises.
    const reachable = reachableFrom(join(SRC, 'commands.ts'))
    const cloud = join(SRC, 'cloud.ts')
    expect([...reachable], 'commands.ts must not reach the network boundary').not.toContain(cloud)
  })

  it('the entry point may dispatch to the cloud, but never reaches it directly', () => {
    // index.ts is the one file that legitimately sits on both sides: it routes
    // `scrub` to the local commands and `login` to the cloud ones. What it must
    // not do is import the request boundary ITSELF — that would put a `fetch`
    // one `case` away from every local command, with nothing between them.
    //
    // Walking from commands.ts alone never looked at index.ts at all, which is
    // how an earlier version of this test could be named for the entry point
    // while never opening it.
    expect(importsOf(join(SRC, 'index.ts'))).not.toContain(join(SRC, 'cloud.ts'))
    for (const file of reachableFrom(join(SRC, 'commands.ts'))) {
      expect(importsOf(file), `${file} must not import the cloud boundary`).not.toContain(
        join(SRC, 'cloud.ts')
      )
    }
  })

  it('nothing reachable from the local commands can open a socket', () => {
    // The check that matters most, and the one that was missing.
    //
    // `purity.test.ts` scans a hand-written list of four files for these, and
    // the graph walk above asks only "is this cloud.ts?". So a NEW module doing
    // `import { request } from 'node:https'`, imported and called from a local
    // command, passed everything: node:https touches no global, so the runtime
    // traps sit it out, and the module was not on anybody's list.
    //
    // Driving the scan from the reachable set is what makes that unnecessary to
    // remember — a module is covered by being imported.
    const banned = [
      /\bnode:(?:http|https|net|tls|dns|dgram|child_process|worker_threads)\b/,
      /from\s*['"](?:http|https|net|tls|dns|dgram|child_process|worker_threads)['"]/,
    ]
    for (const file of reachableFrom(join(SRC, 'commands.ts'))) {
      const text = readFileSync(file, 'utf8')
      for (const pattern of banned) {
        expect(pattern.test(text), `${file} must not open a socket (${pattern})`).toBe(false)
      }
    }
  })

  it('cloud.ts is the only module that so much as names fetch', () => {
    // Belt to the graph walk's braces, and the check that survives a refactor
    // that reorganises the modules: whatever the shape, exactly one file may
    // speak to the network.
    //
    // Two things this got wrong at first, both found by mutation. It matched
    // `fetch(` — a CALL — so `const send = globalThis.fetch` and a later
    // `send(...)` passed. And it read one directory, so `src/net/http.ts` was
    // never opened. A bare reference, scanned recursively, closes both.
    const speakers = tsFilesUnder(SRC).filter((f) =>
      /\bfetch\b/.test(stripComments(readFileSync(f, 'utf8')))
    )
    expect(speakers.map((f) => f.slice(SRC.length))).toEqual(['cloud.ts'])
  })

  function tsFilesUnder(dir: string): string[] {
    return readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((n) => n.endsWith('.ts'))
      .map((n) => join(dir, n))
      .sort()
  }

  /** Comments are prose. `cloud.ts` is discussed by name all over this package. */
  function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  }
})
