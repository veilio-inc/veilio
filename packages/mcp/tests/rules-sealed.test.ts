import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readRules, writeRules } from '@veilio-inc/cli/rules'
import { writeTeamUnlock } from '@veilio-inc/cli/team-unlock'
import { toBase64, type RuleBody } from '@veilio-inc/engine'
import { primeRules, resetRulesCache } from '../src/rules.js'
import { callTool } from '../src/tools.js'
import {
  INSTANCE,
  ME,
  TEAM_ID,
  TEAM_RAW,
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
    // Spec 092: said on the rules line, in place of the general sentence.
    expect(anonymize()).toContain(
      'Custom rules: 0 custom rules from Cloud (1 team rule for team "team-1" waits for a key confirmation)'
    )
  })
})

// Spec 092: the rules line says how many team rules wait for a key
// confirmation, and for which team; the general sentence is then left out.
describe('team rules waiting for a key confirmation (092)', () => {
  const OTHER_KEY = new Uint8Array(32).fill(6)
  const GENERAL = 'whose sender you have not confirmed'
  const planted = (n: number): RuleBody => ({
    name: `Planted${n}`,
    type: 'replace',
    pattern: `^PaymentGateway${n}$`,
    placeholder: '__GATEWAY__',
    enabled: true,
  })
  /** The team key(s) on disk, none confirmed, as `team unlock` stores them. */
  function unconfirmed(keys: { version: number; raw: Uint8Array; who: string }[]): void {
    writeTeamUnlock(
      {
        v: 1,
        instance: INSTANCE,
        account: ME,
        teamId: TEAM_ID,
        teamName: 'Zespół',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        keys: keys.map((k) => ({
          version: k.version,
          key: toBase64(k.raw),
          granter: {
            id: `u-${k.who}`,
            publicKey: `GRANTER-${k.who}`,
            label: `${k.who}@example.com`,
            current: true,
          },
          writable: false,
        })),
      },
      home
    )
  }
  const expectNoSecrets = (text: string): void => {
    for (const secret of [
      'Planted',
      'PaymentGateway',
      '__GATEWAY__',
      toBase64(TEAM_RAW),
      'GRANTER-ola',
      'ola@example.com',
    ])
      expect(text).not.toContain(secret)
  }

  it('two rules: the parenthesis, word for word, and no general sentence', async () => {
    signIn(home)
    unconfirmed([{ version: 1, raw: TEAM_RAW, who: 'ola' }])
    serve({
      teamRules: [
        await sealedTeamRule('r1', 0, planted(1)),
        await sealedTeamRule('r2', 1, planted(2)),
      ],
    })
    await primeRules(home)
    const text = anonymize()
    expect(text).toContain(
      '\nCustom rules: 0 custom rules from Cloud (2 team rules for team "Zespół" wait for a key confirmation)\n'
    )
    expect(text).not.toContain(GENERAL)
    expectNoSecrets(text)
  })

  it('one rule: the singular', async () => {
    signIn(home)
    unconfirmed([{ version: 1, raw: TEAM_RAW, who: 'ola' }])
    serve({ teamRules: [await sealedTeamRule('r1', 0, planted(1))] })
    await primeRules(home)
    const text = anonymize()
    expect(text).toContain(
      '\nCustom rules: 0 custom rules from Cloud (1 team rule for team "Zespół" waits for a key confirmation)\n'
    )
    expect(text).not.toContain(GENERAL)
  })

  it("two granters: the team's total, nobody named", async () => {
    signIn(home)
    unconfirmed([
      { version: 1, raw: TEAM_RAW, who: 'ola' },
      { version: 2, raw: OTHER_KEY, who: 'jan' },
    ])
    serve({
      teamRules: [
        await sealedTeamRule('r1', 0, planted(1)),
        await sealedTeamRule('r2', 1, planted(2), { key: OTHER_KEY, version: 2 }),
        await sealedTeamRule('r3', 2, planted(3)),
      ],
    })
    await primeRules(home)
    const text = anonymize()
    expect(text).toContain(
      '\nCustom rules: 0 custom rules from Cloud (3 team rules for team "Zespół" wait for a key confirmation)\n'
    )
    expect(text).not.toContain('jan@example.com')
    expectNoSecrets(text)
  })

  it('with a personal rule applied, the count before the parenthesis is its own', async () => {
    signIn(home, { pmk: true })
    unconfirmed([{ version: 1, raw: TEAM_RAW, who: 'ola' }])
    serve({
      rules: [await sealedPersonalRule('p1', 0, REPLACE)],
      teamRules: [
        await sealedTeamRule('r1', 0, planted(1)),
        await sealedTeamRule('r2', 1, planted(2)),
      ],
    })
    await primeRules(home)
    expect(anonymize()).toContain(
      '\nCustom rules: 1 custom rule from Cloud (2 team rules for team "Zespół" wait for a key confirmation)\n'
    )
  })

  it('Cloud unreachable: the cached line and the general sentence, as before', async () => {
    signIn(home)
    unconfirmed([{ version: 1, raw: TEAM_RAW, who: 'ola' }])
    serve({
      teamRules: [
        await sealedTeamRule('r1', 0, planted(1)),
        await sealedTeamRule('r2', 1, planted(2)),
      ],
    })
    await primeRules(home)
    resetRulesCache()
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    expect((await primeRules(home)).source).toBe('cached')
    const text = anonymize()
    expect(text).toMatch(
      /\nCustom rules: 0 custom rules cached, pulled .* - Cloud did not answer\n/
    )
    expect(text).toContain(`2 team rules not applied: they are sealed under a team key ${GENERAL}.`)
    expect(text).not.toContain('wait for a key confirmation')
  })
})
