import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { guardHint, guardInstalled, LINE_A, LINE_B } from '../src/guard-hint.js'
import { main } from '../src/index.js'
import type { Io } from '../src/commands.js'

// Spec 070. Without the guard, the CLI and the MCP server protect only what
// passes through them (benchmark 067 run 3: 93-95 of 96 sessions leaked).

let home: string
let cwd: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-hint-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-hint-cwd-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const record = (body: string) => {
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true })
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), body)
}
const withGuard = (key = 'veilio-guard@veilio') =>
  record(JSON.stringify({ version: 2, plugins: { [key]: [{ scope: 'user' }] } }))

describe('guardInstalled', () => {
  it('is true for a veilio-guard@ entry, from any marketplace', () => {
    withGuard()
    expect(guardInstalled(home)).toBe(true)
    withGuard('veilio-guard@acme')
    expect(guardInstalled(home)).toBe(true)
  })
  it.each([
    ['no record', null],
    ['an empty file', ''],
    ['malformed JSON', '{"plugins":'],
    ['plugins not an object', '{"version":2,"plugins":[]}'],
    ['a null', 'null'],
    ['another plugin only', '{"version":2,"plugins":{"other@x":[]}}'],
    ['a name that only contains it', '{"version":2,"plugins":{"not-veilio-guard@x":[]}}'],
  ])('is false with %s', (_, body) => {
    if (body !== null) record(body)
    expect(guardInstalled(home)).toBe(false)
  })
  it('is false when the home folder does not exist', () => {
    expect(guardInstalled(join(home, 'missing'))).toBe(false)
  })
})

describe('guardHint: the full matrix', () => {
  const cases: Array<[string, 'cli' | 'mcp', boolean, boolean, boolean, string | null]> = []
  for (const surface of ['cli', 'mcp'] as const)
    for (const claude of [true, false])
      for (const guard of [true, false])
        for (const ci of [true, false]) {
          const expected = ci || guard ? null : claude ? LINE_A : surface === 'mcp' ? LINE_B : null
          cases.push([
            `${surface} claude=${claude} guard=${guard} ci=${ci}`,
            surface,
            claude,
            guard,
            ci,
            expected,
          ])
        }
  it.each(cases)('%s', (_, surface, claude, guard, ci, expected) => {
    if (guard) withGuard()
    const env: Record<string, string | undefined> = {}
    if (claude) env.CLAUDECODE = '1'
    if (ci) env.CI = 'true'
    expect(guardHint(surface, env, home)).toBe(expected)
  })
  it('an empty CLAUDECODE is not Claude Code', () => {
    expect(guardHint('cli', { CLAUDECODE: '' }, home)).toBeNull()
  })
})

describe('the lines say what the spec says', () => {
  it('Line A names the install command, Line B does not', () => {
    expect(LINE_A).toBe(
      "veilio: veilio-guard is not installed. In Claude Code the CLI and MCP mask only what passes through them; the agent's own reads reach the model as written. Install it: /plugin install veilio-guard@veilio"
    )
    expect(LINE_B).toBe(
      'veilio: this agent has no Veilio guard yet. Turn off its own file and shell tools so this server is the only way to your code; otherwise its reads reach the model as written.'
    )
  })
})

describe('the CLI prints it (spec 070 US1, US3)', () => {
  const run = async (argv: string[], env?: Record<string, string | undefined>) => {
    let out = ''
    let err = ''
    const io: Io = {
      cwd,
      home,
      env,
      stdin: async () => 'class LedgerVault {}\n',
      stdout: (t) => {
        out += t
      },
      stderr: (t) => {
        err += t
      },
    }
    const code = await main(argv, io)
    return { code, out, err }
  }
  const CLAUDE = { CLAUDECODE: '1' }

  it('inside Claude Code without the guard: Line A once on stderr, stdout unchanged', async () => {
    const plain = await run(['scrub'], {})
    const hinted = await run(['scrub'], CLAUDE)
    expect(hinted.code).toBe(plain.code)
    expect(hinted.out).toBe(plain.out)
    expect(hinted.err.split(LINE_A).length - 1).toBe(1)
    expect(plain.err).not.toContain('veilio-guard is not installed')
  })
  it('with the guard: nothing', async () => {
    withGuard()
    expect((await run(['scrub'], CLAUDE)).err).not.toContain('veilio-guard')
  })
  it('under --quiet: nothing', async () => {
    expect((await run(['scrub', '--quiet'], CLAUDE)).err).not.toContain('veilio-guard')
  })
  it('with CI set: nothing', async () => {
    expect((await run(['scrub'], { ...CLAUDE, CI: '1' })).err).not.toContain('veilio-guard')
  })
  it('an Io without env (a test or an embedding caller): nothing', async () => {
    expect((await run(['scrub'])).err).not.toContain('veilio-guard')
  })
  it('a usage error still exits as before', async () => {
    const r = await run(['--no-such-flag'], CLAUDE)
    expect(r.code).toBe((await run(['--no-such-flag'], {})).code)
  })
})
