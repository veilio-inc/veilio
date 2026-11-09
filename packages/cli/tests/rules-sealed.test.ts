import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { toBase64, type RuleBody } from '@veilio-inc/engine'
import { main } from '../src/index.js'
import { EXIT_OK, type Io } from '../src/commands.js'
import { purgeRules, readRules, rulesPath, writeRules } from '../src/rules.js'
import { writeTeamUnlock } from '../src/team-unlock.js'
import { writePersonalMapsKey } from '../src/client/personal-maps-key.js'
import { rulesSkippedSentences } from '../src/client/wording.js'
import {
  INSTANCE,
  ME,
  PMK_RAW,
  TEAM_ID,
  TEAM_RAW,
  sealedPersonalRule,
  sealedTeamRule,
  signIn,
} from './helpers/fake-cloud.js'

/**
 * Spec 065: Cloud serves custom rules sealed under the customer's keys. The
 * CLI opens them with the keys on this machine, applies what opened, and says
 * what it skipped and how to fix it - never failing the pull or the scrub.
 */

let home: string
let cwd: string
let fetchMock: ReturnType<typeof vi.fn>
const OWNER = { instance: INSTANCE, account: ME }
const SOURCE = 'export function settleLedger(customerId: string) {\n  return customerId\n}\n'
const OTHER_KEY = new Uint8Array(32).fill(6)
const TEAM_B = 'team-2'
const TEAM_B_RAW = new Uint8Array(32).fill(8)

const REPLACE: RuleBody = {
  name: 'ledger',
  type: 'replace',
  pattern: '^settle',
  placeholder: '__LEDGER__',
  enabled: true,
}
const KEEP: RuleBody = { name: 'keep', type: 'whitelist', pattern: '^customerId$', enabled: true }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-work-'))
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
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
  const code = await main(argv, io)
  return { code, out, err }
}

function serve(body: { rules?: unknown[]; teamRules?: unknown[] }): void {
  fetchMock.mockImplementation(async (url: unknown) => {
    const path = new URL(String(url)).pathname
    if (path === '/api/rules')
      return new Response(JSON.stringify({ rules: [], teamRules: [], ...body }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  })
}

function unlockTeam(
  teamId: string,
  keys: { version: number; raw: Uint8Array }[],
  writable = true
): void {
  writeTeamUnlock(
    {
      v: 1,
      ...OWNER,
      teamId,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      keys: keys.map((k) => ({
        version: k.version,
        key: toBase64(k.raw),
        granter: { id: 'u-granter', publicKey: 'GRANTER' },
        writable,
      })),
    },
    home
  )
}

const cached = () => readRules(OWNER, home)

describe('rules pull, personal rules', () => {
  it('with an unexpired personal-maps key on disk, opens them', async () => {
    signIn(home, { pmk: true })
    serve({ rules: [await sealedPersonalRule('p1', 4, REPLACE)] })
    const res = await run(['rules', 'pull'])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(res.out).toMatch(/Pulled 1 custom rule \(1 personal, 0 team\)/)
    expect(res.out).not.toMatch(/not applied/)
    expect(cached()?.rules).toEqual([
      {
        id: 'p1',
        scope: 'personal',
        team_id: null,
        sort_order: 0,
        name: 'ledger',
        type: 'replace',
        pattern: '^settle',
        placeholder: '__LEDGER__',
        enabled: true,
      },
    ])
    expect(cached()?.skipped).toEqual({
      vaultLocked: 0,
      teamLocked: 0,
      unopenable: 0,
      refused: 0,
      teamUnconfirmed: 0,
    })
  })

  it('without one, records vaultLocked, says how to fix it, and exits 0', async () => {
    signIn(home)
    serve({
      rules: [await sealedPersonalRule('p1', 0, REPLACE), await sealedPersonalRule('p2', 1, KEEP)],
    })
    const res = await run(['rules', 'pull'])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(res.out).toContain(
      '2 custom rules not applied: vault locked - run `veilio vault unlock`, then `veilio rules pull`.'
    )
    expect(cached()?.rules).toEqual([])
    expect(cached()?.skipped?.vaultLocked).toBe(2)
  })

  it('an expired key on disk reads as locked', async () => {
    signIn(home)
    writePersonalMapsKey(
      {
        v: 1,
        ...OWNER,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        key: toBase64(PMK_RAW),
      },
      home
    )
    serve({ rules: [await sealedPersonalRule('p1', 0, REPLACE)] })
    await run(['rules', 'pull'])
    expect(cached()?.skipped?.vaultLocked).toBe(1)
  })

  it('counts refused and unopenable rules, applies the rest', async () => {
    signIn(home, { pmk: true })
    const engineBase = {
      kind: 'veilio-rule',
      v: '1',
      id: 'bad-base',
      team: '',
      name: 'x',
      type: 'replace',
      pattern: '^settle',
      placeholder: '__FN__',
      enabled: 'true',
    }
    const unsafe = { ...engineBase, id: 'bad-regex', placeholder: '__OK__', pattern: '(a)\\1' }
    serve({
      rules: [
        await sealedPersonalRule('good', 0, KEEP),
        await sealedPersonalRule('bad-base', 1, REPLACE, { record: engineBase }),
        await sealedPersonalRule('bad-regex', 2, REPLACE, { record: unsafe }),
        await sealedPersonalRule('moved', 3, REPLACE, { bindId: 'some-other-row' }),
        await sealedPersonalRule('wrong-key', 4, REPLACE, { key: OTHER_KEY }),
        await sealedPersonalRule('a-map', 5, REPLACE, { record: { settleLedger: '__FN__1' } }),
        { id: 'garbage', scope: 'personal', team_id: null, sort_order: 6, data: 'not json' },
      ],
    })
    const res = await run(['rules', 'pull'])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(cached()?.rules.map((r) => r.id)).toEqual(['good'])
    expect(cached()?.skipped).toEqual({
      vaultLocked: 0,
      teamLocked: 0,
      unopenable: 3,
      refused: 3,
      teamUnconfirmed: 0,
    })
    expect(res.out).toContain(
      '3 custom rules not applied: could not be opened with the keys on this machine, and skipped.'
    )
    expect(res.out).toContain(
      '3 custom rules not applied: refused as unsafe to apply (an engine placeholder, a pattern rules do not support, or a team whitelist that does not name the identifiers it keeps), and skipped.'
    )
  })

  it('a body sealed for another row is refused, not applied', async () => {
    signIn(home, { pmk: true })
    serve({ rules: [await sealedPersonalRule('r1', 0, REPLACE, { bindId: 'r2' })] })
    await run(['rules', 'pull'])
    expect(cached()?.rules).toEqual([])
    expect(cached()?.skipped?.refused).toBe(1)
  })

  it('the cache keeps 0600 and the account tag', async () => {
    signIn(home)
    serve({ rules: [await sealedPersonalRule('p1', 0, REPLACE)] })
    await run(['rules', 'pull'])
    expect((statSync(rulesPath(home)).mode & 0o777).toString(8)).toBe('600')
    const raw = JSON.parse(readFileSync(rulesPath(home), 'utf8'))
    expect(raw).toMatchObject({ instance: INSTANCE, account: ME, skipped: { vaultLocked: 1 } })
    expect(readRules({ instance: INSTANCE, account: 'someone@else.test' }, home)).toBeNull()
  })
})

describe('the cache', () => {
  it('without `skipped` (written before spec 065) reads as zeros', () => {
    writeFileSync(
      rulesPath((signIn(home), home)),
      JSON.stringify({ ...OWNER, pulledAt: new Date().toISOString(), rules: [] })
    )
    expect(cached()?.skipped).toEqual({
      vaultLocked: 0,
      teamLocked: 0,
      unopenable: 0,
      refused: 0,
      teamUnconfirmed: 0,
    })
  })

  it('a damaged `skipped` reads as zeros too', () => {
    signIn(home)
    writeFileSync(
      rulesPath(home),
      JSON.stringify({
        ...OWNER,
        pulledAt: new Date().toISOString(),
        rules: [],
        skipped: { vaultLocked: -1, teamLocked: 'x', unopenable: 1.5 },
      })
    )
    expect(cached()?.skipped).toEqual({
      vaultLocked: 0,
      teamLocked: 0,
      unopenable: 0,
      refused: 0,
      teamUnconfirmed: 0,
    })
  })
})

describe('rules pull, team rules', () => {
  it('open with team-keys.json, at any held version', async () => {
    signIn(home)
    unlockTeam(TEAM_ID, [
      { version: 1, raw: TEAM_RAW },
      { version: 2, raw: OTHER_KEY },
    ])
    serve({ teamRules: [await sealedTeamRule('t1', 0, KEEP, { version: 1 })] })
    const res = await run(['rules', 'pull'])
    expect(res.out).toMatch(/Pulled 1 custom rule \(0 personal, 1 team\)/)
    expect(cached()?.rules[0]).toMatchObject({ id: 't1', scope: 'team', team_id: TEAM_ID })
  })

  // Security audit: the scope is the list a row came in, never the row's own
  // label - a team-sealed rule labelled personal is still the team's.
  it('a team rule labelled personal is treated as team: key-held check and purge', async () => {
    signIn(home, { pmk: true })
    unlockTeam(TEAM_ID, [{ version: 1, raw: TEAM_RAW }])
    const row = { ...(await sealedTeamRule('t1', 0, KEEP)), scope: 'personal' }
    const mine = { ...(await sealedPersonalRule('p1', 1, REPLACE)), scope: 'team' }
    serve({ rules: [mine], teamRules: [row] })
    const res = await run(['rules', 'pull'])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(cached()?.rules.find((r) => r.id === 't1')).toMatchObject({ scope: 'team' })
    expect(cached()?.rules.find((r) => r.id === 'p1')).toMatchObject({ scope: 'personal' })
    expect(purgeRules('team', home)).toBe(1)
    expect(cached()?.rules.map((r) => r.id)).toEqual(['p1'])
  })

  it('with no team key, counted as teamLocked, and says how to fix it', async () => {
    signIn(home, { pmk: true })
    serve({ teamRules: [await sealedTeamRule('t1', 0, KEEP)] })
    const res = await run(['rules', 'pull'])
    expect(res.code).toBe(EXIT_OK)
    expect(cached()?.skipped?.teamLocked).toBe(1)
    expect(res.out).toContain(
      '1 custom rule not applied: team key locked - run `veilio team unlock`, then `veilio rules pull`.'
    )
  })

  it('a version this machine does not hold is unopenable', async () => {
    signIn(home, { team: true })
    serve({ teamRules: [await sealedTeamRule('t1', 0, KEEP, { key: OTHER_KEY, version: 2 })] })
    await run(['rules', 'pull'])
    expect(cached()?.skipped).toMatchObject({ teamLocked: 0, unopenable: 1 })
  })

  it("a member of two teams opens each team's rules with that team's own key", async () => {
    signIn(home, { team: true })
    const teamA = await sealedTeamRule('a1', 0, KEEP)
    const teamB = await sealedTeamRule('b1', 0, REPLACE, { teamId: TEAM_B, key: TEAM_B_RAW })
    // Sealed under team A's key but served as team B's: never opened with A's key.
    const misfiled = await sealedTeamRule('b2', 1, REPLACE, { teamId: TEAM_B })
    serve({ teamRules: [teamA, teamB, misfiled] })

    await run(['rules', 'pull'])
    expect(cached()?.rules.map((r) => r.id)).toEqual(['a1'])
    expect(cached()?.skipped?.teamLocked).toBe(2)

    unlockTeam(TEAM_B, [{ version: 1, raw: TEAM_B_RAW }])
    await run(['rules', 'pull'])
    expect(cached()?.rules.map((r) => r.id)).toEqual(['b1'])
    expect(cached()?.skipped).toMatchObject({ teamLocked: 1, unopenable: 1 })
  })
})

describe('scrub with skipped rules', () => {
  function cache(skipped: {
    vaultLocked?: number
    teamLocked?: number
    unopenable?: number
    refused?: number
  }): void {
    writeRules(
      {
        ...OWNER,
        pulledAt: new Date().toISOString(),
        rules: [],
        skipped: {
          vaultLocked: 0,
          teamLocked: 0,
          unopenable: 0,
          refused: 0,
          teamUnconfirmed: 0,
          ...skipped,
        },
      },
      home
    )
  }

  it('prints the skipped line with the unlock command, masks, and exits 0', async () => {
    signIn(home)
    serve({})
    cache({ vaultLocked: 2, teamLocked: 1 })
    const res = await run(['scrub'], SOURCE)
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(res.out).not.toContain('settleLedger')
    const line = rulesSkippedSentences({
      vaultLocked: 2,
      teamLocked: 1,
      unopenable: 0,
      refused: 0,
      teamUnconfirmed: 0,
    }).join(' ')
    expect(res.err).toContain(`veilio: ${line}\n`)
    expect(res.err).toContain('run `veilio vault unlock`, then `veilio rules pull`')
    expect(res.err).toContain('run `veilio team unlock`, then `veilio rules pull`')
  })

  it('says it under --quiet too', async () => {
    signIn(home)
    serve({})
    cache({ refused: 1 })
    const res = await run(['scrub', '--quiet'], SOURCE)
    expect(res.code).toBe(EXIT_OK)
    expect(res.err).toContain('1 custom rule not applied: refused as unsafe to apply')
  })

  it('nothing skipped, nothing said', async () => {
    signIn(home)
    serve({})
    cache({})
    const res = await run(['scrub'], SOURCE)
    expect(res.err).not.toMatch(/not applied/)
  })

  it('applies a pulled rule end to end, with the personal-maps key', async () => {
    signIn(home, { pmk: true })
    serve({ rules: [await sealedPersonalRule('p1', 0, REPLACE)] })
    await run(['rules', 'pull'])
    const res = await run(['scrub'], SOURCE)
    expect(res.out).toMatch(/__(?:LOCAL_[A-Z0-9]{6}_)?LEDGER__1/) // signed in, maps unread: local (spec 066)
    expect(res.out).not.toContain('settleLedger')
  })
})

// Spec 085 part 3, R2-7 (security audit run-2), Q5 = A (founder, 2026-11-09):
// a team whitelist is exact names, checked wherever a rule is opened, and a
// member is told once when a new one applies.
describe('a team whitelist names what it keeps (R2-7)', () => {
  const NAMES = 'class PaymentGateway { chargeCard() {} }\n'
  const wideRecord = {
    kind: 'veilio-rule',
    v: '1',
    id: 'wide',
    team: TEAM_ID,
    name: 'WideOpen',
    type: 'whitelist',
    pattern: '[A-Za-z_$][A-Za-z0-9_$]*',
    enabled: 'true',
  }

  it('a WideOpen team whitelist is refused at pull, and scrub masks every name', async () => {
    signIn(home)
    unlockTeam(TEAM_ID, [{ version: 1, raw: TEAM_RAW }])
    serve({ teamRules: [await sealedTeamRule('wide', 0, KEEP, { record: wideRecord })] })
    const res = await run(['rules', 'pull'])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(cached()?.rules).toEqual([])
    expect(cached()?.skipped?.refused).toBe(1)
    expect(res.out).toContain('a team whitelist that does not name the identifiers it keeps')
    const scrubbed = await run(['scrub'], NAMES)
    expect(scrubbed.out).not.toContain('PaymentGateway')
    expect(scrubbed.out).not.toContain('chargeCard')
  })

  it('a cache written before the check does not apply a broad team whitelist', async () => {
    signIn(home)
    unlockTeam(TEAM_ID, [{ version: 1, raw: TEAM_RAW }])
    writeRules(
      {
        ...OWNER,
        pulledAt: new Date().toISOString(),
        rules: [
          {
            id: 'wide',
            scope: 'team',
            team_id: TEAM_ID,
            sort_order: 0,
            name: 'WideOpen',
            type: 'whitelist',
            pattern: '[A-Za-z_$][A-Za-z0-9_$]*',
            enabled: true,
          },
        ],
      },
      home
    )
    expect(cached()?.rules).toEqual([])
    expect(cached()?.skipped?.refused).toBe(1)
    const scrubbed = await run(['scrub'], NAMES)
    expect(scrubbed.out).not.toContain('PaymentGateway')
  })

  it('a new exact-name team whitelist is announced once, then not again', async () => {
    signIn(home)
    unlockTeam(TEAM_ID, [{ version: 1, raw: TEAM_RAW }])
    const exact: RuleBody = {
      name: 'keep-gateway',
      type: 'whitelist',
      pattern: '^PaymentGateway$',
      enabled: true,
    }
    serve({ teamRules: [await sealedTeamRule('t-exact', 0, exact)] })
    const first = await run(['rules', 'pull'])
    expect(first.out).toContain(
      'veilio: a new team rule keeps names as written: `keep-gateway` (`^PaymentGateway$`).'
    )
    const second = await run(['rules', 'pull'])
    expect(second.out).not.toContain('a new team rule')
    expect(cached()?.rules.map((r) => r.id)).toEqual(['t-exact'])
  })
})

// Spec 085 part 3, R2-8: a team rule applies only under a key whose sender
// the member confirmed (writable, spec 080 item 7a); a planted key authors no
// masking rule.
describe('team rules open only under confirmed keys (R2-8)', () => {
  const planted: RuleBody = {
    name: 'PlantedRule',
    type: 'whitelist',
    pattern: '^PaymentGateway$',
    enabled: true,
  }

  it('under a key not confirmed: held back, counted, and said how to see it', async () => {
    signIn(home)
    unlockTeam(TEAM_ID, [{ version: 2, raw: TEAM_RAW }], false)
    serve({ teamRules: [await sealedTeamRule('rule-1', 0, planted, { version: 2 })] })
    const res = await run(['rules', 'pull'])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(cached()?.rules).toEqual([])
    expect(cached()?.skipped?.teamUnconfirmed).toBe(1)
    expect(res.out).toContain(
      '1 team rule not applied: they are sealed under a team key whose sender you have not confirmed. `veilio team unlock` shows that key.'
    )
    const scrubbed = await run(['scrub'], 'class PaymentGateway {}\n')
    expect(scrubbed.out).not.toContain('PaymentGateway')
  })

  it('under a confirmed key: applied', async () => {
    signIn(home)
    unlockTeam(TEAM_ID, [{ version: 2, raw: TEAM_RAW }])
    serve({ teamRules: [await sealedTeamRule('rule-1', 0, planted, { version: 2 })] })
    await run(['rules', 'pull'])
    expect(cached()?.rules.map((r) => r.id)).toEqual(['rule-1'])
  })

  it('a cached rule of a team whose keys are no longer confirmed is not applied', async () => {
    signIn(home)
    unlockTeam(TEAM_ID, [{ version: 2, raw: TEAM_RAW }])
    serve({ teamRules: [await sealedTeamRule('rule-1', 0, planted, { version: 2 })] })
    await run(['rules', 'pull'])
    unlockTeam(TEAM_ID, [{ version: 2, raw: TEAM_RAW }], false)
    expect(cached()?.rules).toEqual([])
    expect(cached()?.skipped?.teamUnconfirmed).toBe(1)
  })
})
