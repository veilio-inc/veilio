import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RuleBody } from '@veilio-inc/engine'
import { main } from '../src/index.js'
import { EXIT_OK, type Io } from '../src/commands.js'
import { readRules } from '../src/rules.js'
import { rulesSkippedSentences } from '../src/client/wording.js'
import { callTool } from '../../mcp/src/tools.js'
import { primeRules, resetRulesCache } from '../../mcp/src/rules.js'
import { INSTANCE, ME, sealedPersonalRule, sealedTeamRule, signIn } from './helpers/fake-cloud.js'

/**
 * Spec 065 US3: a locked tool still masks, and says what it skipped. Every
 * combination of {vault locked, open} x {team key locked, open} x {a refused
 * rule present, absent}: `scrub` and the MCP server's `anonymize_text` mask,
 * apply exactly the rules that open, and count every rule served.
 */

const SOURCE = 'export function settleLedger(customerId: string) {\n  return customerId\n}\n'
const REPLACE: RuleBody = {
  name: 'ledger',
  type: 'replace',
  pattern: '^settle',
  placeholder: '__LEDGER__',
  enabled: true,
}
const KEEP: RuleBody = { name: 'keep', type: 'whitelist', pattern: '^customerId$', enabled: true }

let home: string
let cwd: string
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-work-'))
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  resetRulesCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetRulesCache()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

async function run(
  argv: string[],
  stdin = ''
): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    home,
    stdin: async () => stdin,
    stdinBytes: async function* () {
      yield Buffer.from(stdin)
    },
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => ME,
    password: async () => 'pw',
  }
  return { code: await main(argv, io), out, err }
}

const cases = [false, true].flatMap((vault) =>
  [false, true].flatMap((team) => [false, true].map((refused) => ({ vault, team, refused })))
)

describe.each(cases)('vault open: $vault, team key open: $team, refused rule: $refused', (c) => {
  it('scrub and anonymize_text mask, apply exactly the openable rules, and count them all', async () => {
    signIn(home, { pmk: c.vault, team: c.team })
    const rules = [await sealedPersonalRule('p1', 0, REPLACE)]
    if (c.refused) rules.push(await sealedPersonalRule('bad', 1, REPLACE, { bindId: 'elsewhere' }))
    const teamRules = [await sealedTeamRule('t1', 0, KEEP)]
    const served = rules.length + teamRules.length
    fetchMock.mockImplementation(async (url: unknown) =>
      new URL(String(url)).pathname === '/api/rules'
        ? new Response(JSON.stringify({ rules, teamRules }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    )

    const expected = {
      vaultLocked: c.vault ? 0 : rules.length,
      teamLocked: c.team ? 0 : 1,
      unopenable: 0,
      refused: c.vault && c.refused ? 1 : 0,
      teamUnconfirmed: 0,
    }
    const sentences = rulesSkippedSentences(expected)

    const pulled = await run(['rules', 'pull'])
    expect(pulled.code, pulled.err).toBe(EXIT_OK)
    const cached = readRules({ instance: INSTANCE, account: ME }, home)
    expect(cached?.skipped).toEqual(expected)
    const applied = cached?.rules.length ?? 0
    const s = cached!.skipped!
    expect(applied + s.vaultLocked + s.teamLocked + s.unopenable + s.refused).toBe(served)
    for (const sentence of sentences) expect(pulled.out).toContain(sentence)

    const check = (text: string): void => {
      expect(text).not.toContain('settleLedger')
      // The local family when the team key is held but the maps were not read (spec 066).
      expect(/__(?:LOCAL_[A-Z0-9]{6}_)?LEDGER__1/.test(text)).toBe(c.vault)
      expect(text.includes('return customerId')).toBe(c.team)
    }

    const scrubbed = await run(['scrub'], SOURCE)
    expect(scrubbed.code, scrubbed.err).toBe(EXIT_OK)
    check(scrubbed.out)
    // Rules applied and rules skipped are said in one line; skipped alone, in full.
    const short = rulesSkippedSentences(expected, { noun: false }).join(' ')
    if (sentences.length && applied > 0)
      expect(scrubbed.err).toContain(
        `veilio: applied ${applied} custom rule${applied === 1 ? '' : 's'} pulled just now; ${short}\n`
      )
    else if (sentences.length) expect(scrubbed.err).toContain(`veilio: ${sentences.join(' ')}\n`)
    else expect(scrubbed.err).not.toMatch(/not applied/)

    const resolved = await primeRules(home)
    expect(resolved.skipped).toEqual(expected)
    const text = callTool('anonymize_text', { text: SOURCE }, { cwd, mapPath: null }).text
    check(text.slice(text.indexOf('--- masked code ---')))
    for (const sentence of sentences) expect(text).toContain(sentence)
    if (!sentences.length) expect(text).not.toMatch(/not applied/)
  })
})
