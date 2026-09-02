import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import type { Io } from '../src/commands.js'

// 005-c1 FR-003 / SC-003. The CLI makes the same privacy claim the web app
// does, and a claim that is only written down is a claim nobody has checked.
//
// The engine's own purity suite greps its sources, which works there because the
// engine may not touch the filesystem either. This wrapper legitimately reads
// files, writes the map and reads argv, so a source grep alone would have to be
// so narrow it proved almost nothing. So this does the thing the spec asks for
// — trap the globals and run a real command — and keeps a source scan only for
// the network modules that have no business being imported at all.

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'veilio-purity-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

/** Every way out of the process that a bundled CLI could plausibly reach for. */
const NETWORK_GLOBALS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'navigator',
  'importScripts',
] as const

/** Run `argv` with every network global replaced by a tripwire, and report
 *  which ones were touched. Restores the originals whatever happens, so one
 *  failing case cannot poison the rest of the file. */
async function runTrapped(
  argv: string[],
  stdin = ''
): Promise<{ code: number; tripped: string[] }> {
  const tripped: string[] = []
  const g = globalThis as unknown as Record<string, unknown>
  const saved = new Map<string, { present: boolean; value: unknown }>()

  for (const name of NETWORK_GLOBALS) {
    saved.set(name, { present: name in g, value: g[name] })
    Object.defineProperty(g, name, {
      configurable: true,
      writable: true,
      value: new Proxy(function trap() {} as object, {
        get: () => (tripped.push(name), undefined),
        apply: () => {
          tripped.push(name)
          throw new Error(`${name} was called`)
        },
        construct: () => {
          tripped.push(name)
          throw new Error(`${name} was constructed`)
        },
      }),
    })
  }

  try {
    const io: Io = {
      cwd,
      stdin: async () => stdin,
      stdout: () => {},
      stderr: () => {},
    }
    const code = await main(argv, io)
    return { code, tripped }
  } finally {
    for (const [name, { present, value }] of saved) {
      if (present) Object.defineProperty(g, name, { configurable: true, writable: true, value })
      else delete g[name]
    }
  }
}

const SOURCE = [
  '// Ping Kowalska about the Contoso incident, acct 88412037',
  'export class PaymentGateway {',
  '  chargeCard(amount: number) { return amount }',
  '}',
  'const key = "AKIAIOSFODNN7EXAMPLE"',
].join('\n')

describe('CLI purity — every command, with the network trapped', () => {
  // Driven through `main`, not through the command functions, so argument
  // parsing and the store are inside the trap too. A leak added to any of them
  // fails here rather than in whichever unit test happened to cover it.
  it('scrub touches no network global', async () => {
    writeFileSync(join(cwd, 'a.ts'), SOURCE)
    const { tripped } = await runTrapped(['scrub', 'a.ts'])
    expect(tripped).toEqual([])
  })

  it('scrub from stdin touches no network global', async () => {
    const { tripped } = await runTrapped(['scrub'], SOURCE)
    expect(tripped).toEqual([])
  })

  it('restore touches no network global', async () => {
    writeFileSync(join(cwd, 'a.ts'), SOURCE)
    await runTrapped(['scrub', 'a.ts'])
    const { tripped } = await runTrapped(['restore'], '__CLS__1')
    expect(tripped).toEqual([])
  })

  it('scan touches no network global', async () => {
    writeFileSync(join(cwd, 'a.ts'), SOURCE)
    const { tripped } = await runTrapped(['scan', 'a.ts'])
    expect(tripped).toEqual([])
  })

  it('map touches no network global', async () => {
    writeFileSync(join(cwd, 'a.ts'), SOURCE)
    await runTrapped(['scrub', 'a.ts'])
    const { tripped } = await runTrapped(['map'])
    expect(tripped).toEqual([])
  })

  it('the trap actually trips — otherwise the cases above prove nothing', () => {
    // The load-bearing test in this file. Every assertion above is
    // `toEqual([])`, which an inert trap satisfies for ever. This is the one
    // that fails if the tripwire stops being wired to anything.
    const tripped: string[] = []
    const g = globalThis as unknown as Record<string, unknown>
    const original = g.fetch
    g.fetch = new Proxy(function trap() {} as object, {
      apply: () => {
        tripped.push('fetch')
        throw new Error('fetch was called')
      },
    })
    try {
      expect(() => (g.fetch as () => void)()).toThrow()
    } finally {
      g.fetch = original
    }
    expect(tripped).toEqual(['fetch'])
  })
})

describe('CLI purity — nothing that opens a socket is even imported', () => {
  const SOURCES = ['index.ts', 'args.ts', 'commands.ts', 'store.ts'] as const
  const sources = SOURCES.map((name) => ({
    name,
    text: readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'),
  }))

  it('imports no network or subprocess module', () => {
    // A source scan is the right tool here and a runtime trap is not: an import
    // that is never exercised by these tests would still ship, and a socket
    // opened through `node:net` never touches a global the trap can see.
    const banned = [
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dns',
      'node:dgram',
      'node:child_process',
      'node:worker_threads',
      "from 'http'",
      "from 'https'",
      "from 'net'",
    ]
    for (const { name, text } of sources) {
      for (const token of banned) {
        expect(text.includes(token), `${name} must not reference ${token}`).toBe(false)
      }
    }
  })

  it('declares no runtime dependency outside the Veilio scope', () => {
    // The supply-chain claim the engine makes is only as strong as what wraps
    // it. This package may depend on the engine and nothing else.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const outside = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@veilio-inc/'))
    expect(outside).toEqual([])
  })
})
