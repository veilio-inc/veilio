import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { toBase64, type RuleBody } from '@veilio-inc/engine'
import { main } from '../src/index.js'
import { EXIT_OK, type Io } from '../src/commands.js'
import { readRules, rulesPath } from '../src/rules.js'
import { personalMapsKeyPath, writePersonalMapsKey } from '../src/client/personal-maps-key.js'
import { teamUnlockPath } from '../src/team-unlock.js'
import { callTool } from '../../mcp/src/tools.js'
import { primeRules, resetRulesCache } from '../../mcp/src/rules.js'
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
 * Spec 065 FR-006, code review: readable rule content must not outlive the
 * key it was opened with. `vault lock` / `team lock` purge the cache, and every
 * reader checks the key is still held - which also covers a key that expired
 * with no lock command at all.
 */

const SOURCE = 'export function settleLedger(customerId: string) {\n  return customerId\n}\n'
const REPLACE: RuleBody = {
  name: 'ledger',
  type: 'replace',
  pattern: '^settle',
  placeholder: '__LEDGER__',
  enabled: true,
}
const REPLACE_2: RuleBody = { ...REPLACE, name: 'ledger2', pattern: '^ledger$' }
const KEEP: RuleBody = { name: 'keep', type: 'whitelist', pattern: '^customerId$', enabled: true }
const OWNER = { instance: INSTANCE, account: ME }

let home: string
let cwd: string
let fetchMock: ReturnType<typeof vi.fn>
let cloudDown = false

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-work-'))
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  resetRulesCache()
  cloudDown = false
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
    stdinBytes: async () => Buffer.from(stdin),
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => ME,
    password: async () => 'pw',
  }
  return { code: await main(argv, io), out, err }
}

/** Two personal rules, one team rule - all open when both keys are held. */
async function serveAndPull(): Promise<void> {
  const rules = [
    await sealedPersonalRule('p1', 0, REPLACE),
    await sealedPersonalRule('p2', 1, REPLACE_2),
  ]
  const teamRules = [await sealedTeamRule('t1', 0, KEEP)]
  fetchMock.mockImplementation(async (url: unknown) => {
    if (cloudDown) return new Response('down', { status: 503 })
    return new URL(String(url)).pathname === '/api/rules'
      ? new Response(JSON.stringify({ rules, teamRules }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      : new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  })
  signIn(home, { pmk: true, team: true })
  const pulled = await run(['rules', 'pull'])
  expect(pulled.code, pulled.err).toBe(EXIT_OK)
  expect(readRules(OWNER, home)?.rules).toHaveLength(3)
}

/** What scrub, the MCP fallback and the cache say after the change. */
async function surfaces(): Promise<{
  scrub: string
  scrubErr: string
  mcp: string
  mcpSource: string
}> {
  const scrubbed = await run(['scrub'], SOURCE)
  expect(scrubbed.code, scrubbed.err).toBe(EXIT_OK)
  cloudDown = true // Cloud does not answer: the MCP server falls back to the cache
  resetRulesCache()
  const resolved = await primeRules(home)
  const text = callTool('anonymize_text', { text: SOURCE }, { cwd, mapPath: null }).text
  return {
    scrub: scrubbed.out,
    scrubErr: scrubbed.err,
    mcp: text.slice(text.indexOf('--- masked code ---')),
    mcpSource: resolved.source,
  }
}

const mode = (): number => statSync(rulesPath(home)).mode & 0o777

describe('vault lock removes the personal rules from the cache', () => {
  it('after unlock + pull, vault lock leaves scrub and anonymize_text with no personal rules and vaultLocked=2', async () => {
    await serveAndPull()
    const locked = await run(['vault', 'lock'])
    expect(locked.code, locked.err).toBe(EXIT_OK)
    expect(locked.out).toContain(
      '2 personal custom rules removed from this machine until the next `veilio vault unlock` and `veilio rules pull`.'
    )
    const cached = readRules(OWNER, home)
    expect(cached?.rules.map((r) => r.id)).toEqual(['t1'])
    expect(cached?.skipped).toMatchObject({ vaultLocked: 2, teamLocked: 0 })
    // On disk, not just as read: the opened personal rules are gone.
    const raw = readFileSync(rulesPath(home), 'utf8')
    expect(raw).not.toContain('^settle')
    expect(raw).not.toContain('__LEDGER__')
    expect(mode()).toBe(0o600)

    const s = await surfaces()
    expect(s.mcpSource).toBe('cached')
    for (const out of [s.scrub, s.mcp]) {
      expect(out).not.toContain('__LEDGER__')
      expect(out).not.toContain('settleLedger')
      expect(out).toContain('return customerId') // the team whitelist still applies
    }
    // One line, not two: what applied and what did not, together.
    expect(s.scrubErr).toContain(
      'veilio: applied 1 custom rule pulled just now; 2 not applied: vault locked - run `veilio vault unlock`, then `veilio rules pull`.\n'
    )
    expect(s.scrubErr.split('\n').filter((l) => /custom rule/.test(l))).toHaveLength(1)
    expect(s.mcp + s.scrubErr).toMatch(/vault locked/)
  })

  it('under --quiet, only what was not applied is said, in full', async () => {
    await serveAndPull()
    await run(['vault', 'lock'])
    const s = await run(['scrub', '--quiet'], SOURCE)
    expect(s.code, s.err).toBe(EXIT_OK)
    expect(s.err).toContain(
      'veilio: 2 custom rules not applied: vault locked - run `veilio vault unlock`, then `veilio rules pull`.\n'
    )
    expect(s.err).not.toContain('applied 1 custom rule')
  })

  it('a rules pull while the vault is locked does not bring the personal rules back', async () => {
    await serveAndPull()
    await run(['vault', 'lock'])
    const pulled = await run(['rules', 'pull'])
    expect(pulled.code, pulled.err).toBe(EXIT_OK)
    const cached = readRules(OWNER, home)
    expect(cached?.rules.map((r) => r.id)).toEqual(['t1'])
    expect(cached?.skipped).toMatchObject({ vaultLocked: 2 })
    expect(readFileSync(rulesPath(home), 'utf8')).not.toContain('__LEDGER__')
    expect(mode()).toBe(0o600)
  })

  it('vault lock with no key on disk still purges the personal rules', async () => {
    await serveAndPull()
    rmSync(personalMapsKeyPath(home))
    const locked = await run(['vault', 'lock'])
    expect(locked.code).toBe(EXIT_OK)
    expect(locked.out).toContain('No personal-maps key was unlocked.')
    expect(locked.out).toContain('2 personal custom rules removed from this machine')
    expect(readFileSync(rulesPath(home), 'utf8')).not.toContain('__LEDGER__')
  })
})

describe('team lock removes the team rules from the cache', () => {
  it('after unlock + pull, team lock leaves scrub and anonymize_text with no team rules and teamLocked=1', async () => {
    await serveAndPull()
    const locked = await run(['team', 'lock'])
    expect(locked.code, locked.err).toBe(EXIT_OK)
    expect(locked.out).toContain(
      '1 team custom rule removed from this machine until the next `veilio team unlock` and `veilio rules pull`.'
    )
    const cached = readRules(OWNER, home)
    expect(cached?.rules.map((r) => r.id)).toEqual(['p1', 'p2'])
    expect(cached?.skipped).toMatchObject({ vaultLocked: 0, teamLocked: 1 })
    expect(readFileSync(rulesPath(home), 'utf8')).not.toContain('^customerId$')
    expect(mode()).toBe(0o600)

    const s = await surfaces()
    expect(s.mcpSource).toBe('cached')
    for (const out of [s.scrub, s.mcp]) {
      expect(out).not.toContain('return customerId')
      expect(out).toMatch(/__(?:LOCAL_[A-Z0-9]{6}_)?LEDGER__1/) // signed in, maps unread: local (spec 066)
    }
    expect(s.scrubErr).toContain(
      'veilio: applied 2 custom rules pulled just now; 1 not applied: team key locked - run `veilio team unlock`, then `veilio rules pull`.\n'
    )
  })

  it('a rules pull while the team key is locked does not bring the team rules back', async () => {
    await serveAndPull()
    await run(['team', 'lock'])
    expect((await run(['rules', 'pull'])).code).toBe(EXIT_OK)
    const cached = readRules(OWNER, home)
    expect(cached?.rules.map((r) => r.id)).toEqual(['p1', 'p2'])
    expect(cached?.skipped).toMatchObject({ teamLocked: 1 })
    expect(mode()).toBe(0o600)
  })

  it('locking both keeps the cache: it still reports what was not applied', async () => {
    await serveAndPull()
    await run(['vault', 'lock'])
    await run(['team', 'lock'])
    // Still there: it says 3 rules were not applied, and why.
    expect(readRules(OWNER, home)).toMatchObject({
      rules: [],
      skipped: { vaultLocked: 2, teamLocked: 1 },
    })
    expect(mode()).toBe(0o600)
  })
})

describe('readers apply only rules whose key is still held', () => {
  it('an expired personal-maps key, with no lock command, drops the personal rules everywhere and counts vaultLocked=2', async () => {
    await serveAndPull()
    const past = new Date(Date.now() - 1000).toISOString()
    writePersonalMapsKey(
      { v: 1, instance: INSTANCE, account: ME, expiresAt: past, key: toBase64(PMK_RAW) },
      home
    )
    expect(readRules(OWNER, home)?.skipped).toMatchObject({ vaultLocked: 2 })
    const s = await surfaces()
    for (const out of [s.scrub, s.mcp]) {
      expect(out).not.toContain('__LEDGER__')
      expect(out).toContain('return customerId')
    }
    expect(s.scrubErr).toContain(
      'veilio: applied 1 custom rule pulled just now; 2 not applied: vault locked - run `veilio vault unlock`, then `veilio rules pull`.\n'
    )
  })

  it('an expired team key drops the team rules and counts teamLocked=1', async () => {
    await serveAndPull()
    const unlock = JSON.parse(readFileSync(teamUnlockPath(home), 'utf8'))
    unlock.expiresAt = new Date(Date.now() - 1000).toISOString()
    writeFileSync(teamUnlockPath(home), JSON.stringify(unlock))
    expect(readRules(OWNER, home)?.rules.map((r) => r.id)).toEqual(['p1', 'p2'])
    expect(readRules(OWNER, home)?.skipped).toMatchObject({ teamLocked: 1 })
    const s = await surfaces()
    for (const out of [s.scrub, s.mcp]) expect(out).not.toContain('return customerId')
  })

  // The one definition of "held" (rules.ts keysHeld). The guard's
  // lib/rules.ts mirrors it; its custom-rules.test.ts runs the same table.
  const future = new Date(Date.now() + 3_600_000).toISOString()
  const past = new Date(Date.now() - 1000).toISOString()
  const pmk = (o: Record<string, unknown> = {}): string =>
    JSON.stringify({
      v: 1,
      instance: INSTANCE,
      account: ME,
      expiresAt: future,
      key: toBase64(PMK_RAW),
      ...o,
    })
  const team = (o: Record<string, unknown> = {}): string =>
    JSON.stringify({
      v: 1,
      instance: INSTANCE,
      account: ME,
      teamId: TEAM_ID,
      expiresAt: future,
      keys: [{ version: 1, key: toBase64(TEAM_RAW) }],
      ...o,
    })
  const table: [string, boolean, string | null][] = [
    ['absent', false, null],
    ['damaged JSON', false, '{"v":'],
    ['wrong version', false, pmk({ v: 2 })],
    ['another account', false, pmk({ account: 'ada@example.test' })],
    ['another instance', false, pmk({ instance: 'https://other.test' })],
    ['expired', false, pmk({ expiresAt: past })],
    ['unparseable expiry', false, pmk({ expiresAt: 'soon' })],
    ['a key of the wrong length', false, pmk({ key: toBase64(new Uint8Array(16)) })],
    ['a key that is not base64', false, pmk({ key: '***' })],
    ['valid', true, pmk()],
  ]
  it.each(table)('personal-maps key %s: held = %s', async (_, held, file) => {
    await serveAndPull()
    rmSync(personalMapsKeyPath(home))
    if (file !== null) writeFileSync(personalMapsKeyPath(home), file)
    const ids = readRules(OWNER, home)?.rules.map((r) => r.id)
    expect(ids).toEqual(held ? ['t1', 'p1', 'p2'] : ['t1'])
  })

  const teamTable: [string, boolean, string | null][] = [
    ['absent', false, null],
    ['damaged JSON', false, '['],
    ['another account', false, team({ account: 'ada@example.test' })],
    ['expired', false, team({ expiresAt: past })],
    ['another team', false, team({ teamId: 'team-2' })],
    ['no keys', false, team({ keys: [] })],
    [
      'only damaged keys',
      false,
      team({ keys: [{ version: 1, key: toBase64(new Uint8Array(8)) }] }),
    ],
    [
      'one damaged key and one good',
      true,
      team({
        keys: [
          { version: 1, key: '***' },
          { version: 2, key: toBase64(TEAM_RAW) },
        ],
      }),
    ],
    ['valid', true, team()],
  ]
  it.each(teamTable)('team key %s: held = %s', async (_, held, file) => {
    await serveAndPull()
    rmSync(teamUnlockPath(home))
    if (file !== null) writeFileSync(teamUnlockPath(home), file)
    const ids = readRules(OWNER, home)?.rules.map((r) => r.id)
    expect(ids).toEqual(held ? ['t1', 'p1', 'p2'] : ['p1', 'p2'])
  })
})
