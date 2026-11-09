import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readRules, writeRules } from '@veilio-inc/cli/rules'
import type { RuleBody } from '@veilio-inc/engine'
import { primeRules, resetRulesCache } from '../src/rules.js'
import { callTool } from '../src/tools.js'
import {
  INSTANCE,
  ME,
  sealedPersonalRule,
  sealedTeamRule,
  signIn,
} from '../../cli/tests/helpers/fake-cloud.js'

/**
 * Spec 065 in the MCP server: the rules fetched once at startup are sealed, and
 * are opened with the keys on this machine - this server has no passphrase.
 * Every anonymize result says what was skipped and how to fix it.
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
const VAULT_LINE =
  '1 custom rule not applied: vault locked - run `veilio vault unlock`, then `veilio rules pull`.'
const TEAM_LINE =
  '1 custom rule not applied: team key locked - run `veilio team unlock`, then `veilio rules pull`.'

let home: string
let cwd: string
let fetchMock: ReturnType<typeof vi.fn>

function serve(body: { rules?: unknown[]; teamRules?: unknown[] }): void {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ rules: [], teamRules: [], ...body }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  )
}

const anonymize = (): string =>
  callTool('anonymize_text', { text: SOURCE }, { cwd, mapPath: null }).text

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-mcp-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-sealed-'))
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

describe('sealed rules in the MCP server', () => {
  it('opens them with the on-disk keys, once, and says nothing was skipped', async () => {
    signIn(home, { pmk: true, team: true })
    serve({
      rules: [await sealedPersonalRule('p1', 0, REPLACE)],
      teamRules: [await sealedTeamRule('t1', 0, KEEP)],
    })
    const resolved = await primeRules(home)
    expect(resolved.rules.map((r) => r.id)).toEqual(['t1', 'p1'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const text = anonymize()
    expect(text).toContain('__LEDGER__1')
    expect(text).toContain('return customerId')
    expect(text).not.toContain('not applied')
  })

  it('a locked vault: team rules apply, the result says personal ones did not', async () => {
    signIn(home, { team: true })
    serve({
      rules: [await sealedPersonalRule('p1', 0, REPLACE)],
      teamRules: [await sealedTeamRule('t1', 0, KEEP)],
    })
    await primeRules(home)
    const text = anonymize()
    expect(text).toContain('Custom rules: 1 custom rule from Cloud')
    expect(text).toContain(VAULT_LINE)
    expect(text).toContain('return customerId')
    expect(text).not.toContain('settleLedger')
    expect(text).not.toContain('__LEDGER__')
    // On every result, not once.
    expect(anonymize()).toContain(VAULT_LINE)
    // And the CLI's cache records it for `veilio scrub`.
    expect(readRules({ instance: INSTANCE, account: ME }, home)?.skipped?.vaultLocked).toBe(1)
  })

  it('a locked team key: the result says so', async () => {
    signIn(home, { pmk: true })
    serve({ teamRules: [await sealedTeamRule('t1', 0, KEEP)] })
    await primeRules(home)
    expect(anonymize()).toContain(TEAM_LINE)
  })

  it('refused and unopenable rules are named on the result', async () => {
    signIn(home, { pmk: true })
    serve({
      rules: [
        await sealedPersonalRule('moved', 0, REPLACE, { bindId: 'elsewhere' }),
        await sealedPersonalRule('wrong', 1, REPLACE, { key: new Uint8Array(32).fill(6) }),
      ],
    })
    await primeRules(home)
    const text = anonymize()
    expect(text).toContain('1 custom rule not applied: refused as unsafe to apply')
    expect(text).toContain('1 custom rule not applied: could not be opened')
  })

  it('Cloud unreachable: the cached skipped counts still show, even with no rules', async () => {
    signIn(home)
    writeRules(
      {
        instance: INSTANCE,
        account: ME,
        pulledAt: new Date().toISOString(),
        rules: [],
        skipped: { vaultLocked: 1, teamLocked: 0, unopenable: 0, refused: 0, teamUnconfirmed: 0 },
      },
      home
    )
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    expect((await primeRules(home)).source).toBe('cached')
    expect(anonymize()).toContain(VAULT_LINE)
  })
})

// Spec 085 part 3, R2-7 and R2-8 in the MCP server.
describe('team rules in the MCP server (R2-7, R2-8)', () => {
  const EXACT: RuleBody = {
    name: 'keep-id',
    type: 'whitelist',
    pattern: '^customerId$',
    enabled: true,
  }

  it('a new team whitelist is told once, in the session that first sees it', async () => {
    signIn(home, { team: true })
    serve({ teamRules: [await sealedTeamRule('t-new', 0, EXACT)] })
    await primeRules(home)
    expect(anonymize()).toContain(
      'WARNING: a new team rule keeps names as written: `keep-id` (`^customerId$`).'
    )
    resetRulesCache()
    await primeRules(home)
    expect(anonymize()).not.toContain('a new team rule')
  })

  it('a team rule under a key not confirmed is held back and said', async () => {
    signIn(home, { team: true, teamWritable: false })
    serve({ teamRules: [await sealedTeamRule('t1', 0, EXACT)] })
    const resolved = await primeRules(home)
    expect(resolved.rules).toEqual([])
    expect(anonymize()).toContain('sealed under a team key whose sender you have not confirmed')
  })
})
