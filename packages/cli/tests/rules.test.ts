import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CustomRule } from '@veilio-inc/engine'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_OK, type Io } from '../src/commands.js'
import { writeCredential } from '../src/credential.js'
import { describeAge, mergeRules, readRules, rulesPath, writeRules } from '../src/rules.js'

/**
 * Custom rules outside the browser.
 *
 * Found on staging (2026-09-26): rules defined in the web app were never applied
 * by `veilio scrub` or the MCP server, so the same code masked differently in
 * each. `rules pull` caches them; `scrub` applies the cache offline.
 */

let home: string
let cwd: string
let fetchMock: ReturnType<typeof vi.fn>
const INSTANCE = 'https://veilio.test'
const ACCOUNT = 'user@example.test'

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
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => ACCOUNT,
    password: async () => 'pw',
  }
  const code = await main(argv, io)
  return { code, out, err }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function rule(
  id: string,
  type: 'replace' | 'whitelist',
  scope: 'personal' | 'team',
  sort_order: number,
  pattern: string,
  extra: Partial<CustomRule> = {}
): CustomRule {
  const base = {
    id,
    scope,
    team_id: scope === 'team' ? 't1' : null,
    name: id,
    pattern,
    enabled: true,
    sort_order,
  }
  return (
    type === 'replace'
      ? { ...base, type, placeholder: '__NAME__', ...extra }
      : { ...base, type, ...extra }
  ) as CustomRule
}

function signIn(account = ACCOUNT): void {
  writeCredential({ token: 'session', account, instance: INSTANCE }, home)
}

const SOURCE = 'export function settleLedger(customerId: string) {\n  return customerId\n}\n'

// ─── The merge order, which must match the web app's useMergedRules ──────────

describe('mergeRules', () => {
  it('orders team whitelist, personal whitelist, team replace, personal replace', () => {
    const merged = mergeRules(
      [rule('pr', 'replace', 'personal', 0, 'a'), rule('pw', 'whitelist', 'personal', 1, 'b')],
      [rule('tr', 'replace', 'team', 0, 'c'), rule('tw', 'whitelist', 'team', 1, 'd')]
    )
    expect(merged.map((r) => r.id)).toEqual(['tw', 'pw', 'tr', 'pr'])
    expect(merged.map((r) => r.sort_order)).toEqual([0, 1, 2, 3])
  })

  it('keeps sort_order within each group and drops disabled rules', () => {
    const merged = mergeRules(
      [
        rule('p2', 'replace', 'personal', 5, 'x'),
        rule('p1', 'replace', 'personal', 2, 'y'),
        rule('off', 'replace', 'personal', 0, 'z', { enabled: false }),
      ],
      []
    )
    expect(merged.map((r) => r.id)).toEqual(['p1', 'p2'])
  })

  it('a team replace rule wins a clash with a personal one', () => {
    const merged = mergeRules(
      [
        rule('mine', 'replace', 'personal', 0, '^settle', {
          placeholder: '__MINE__',
        } as Partial<CustomRule>),
      ],
      [
        rule('ours', 'replace', 'team', 0, '^settle', {
          placeholder: '__OURS__',
        } as Partial<CustomRule>),
      ]
    )
    expect(merged[0].id).toBe('ours')
  })
})

// ─── rules pull ──────────────────────────────────────────────────────────────

describe('veilio rules pull', () => {
  it('refuses when signed out, and asks nothing', async () => {
    const res = await run(['rules', 'pull'])
    expect(res.code).toBe(EXIT_ERROR)
    expect(res.err).toMatch(/not signed in/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('writes the merged rules 0600, tied to this account', async () => {
    signIn()
    fetchMock.mockResolvedValue(
      json(200, {
        rules: [rule('pr', 'replace', 'personal', 0, '^settle')],
        teamRules: [rule('tw', 'whitelist', 'team', 0, '^customer')],
      })
    )
    const res = await run(['rules', 'pull'])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(res.out).toMatch(/Pulled 2 custom rules \(1 personal, 1 team\)/)
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${INSTANCE}/api/rules`)
    const cached = readRules({ instance: INSTANCE, account: ACCOUNT }, home)
    expect(cached?.rules.map((r) => r.id)).toEqual(['tw', 'pr'])
    expect((statSync(rulesPath(home)).mode & 0o777).toString(8)).toBe('600')
  })

  it('a plan without custom rules removes the old cache', async () => {
    signIn()
    writeRules(
      { instance: INSTANCE, account: ACCOUNT, pulledAt: new Date().toISOString(), rules: [] },
      home
    )
    fetchMock.mockResolvedValue(
      json(403, { error: 'Pro plan required for custom rules', upgrade: true })
    )
    const res = await run(['rules', 'pull'])
    expect(res.code).toBe(EXIT_ERROR)
    expect(res.err).toMatch(/does not include custom rules - the cached rules were removed/)
    expect(existsSync(rulesPath(home))).toBe(false)
  })

  it('an unreachable instance keeps the cache', async () => {
    signIn()
    writeRules(
      { instance: INSTANCE, account: ACCOUNT, pulledAt: new Date().toISOString(), rules: [] },
      home
    )
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const res = await run(['rules', 'pull'])
    expect(res.code).toBe(EXIT_ERROR)
    expect(existsSync(rulesPath(home))).toBe(true)
  })

  it('`rules` needs an action, and only knows pull', async () => {
    expect((await run(['rules'])).code).toBe(EXIT_ERROR)
    const bad = await run(['rules', 'push'])
    expect(bad.code).toBe(EXIT_ERROR)
    expect(bad.err).toMatch(/unknown rules action "push"/)
  })
})

// ─── scrub applies the cache, offline ────────────────────────────────────────

describe('scrub with cached rules', () => {
  function cache(
    rules: CustomRule[],
    owner = { instance: INSTANCE, account: ACCOUNT },
    pulledAt = new Date().toISOString()
  ): void {
    writeRules({ ...owner, pulledAt, rules }, home)
  }

  it('applies a whitelist and a replace rule, and says so', async () => {
    signIn()
    cache(
      mergeRules(
        [
          rule('r', 'replace', 'personal', 0, '^settle', {
            placeholder: '__LEDGER__',
          } as Partial<CustomRule>),
        ],
        [rule('w', 'whitelist', 'team', 0, '^customerId$')]
      )
    )
    const res = await run(['scrub'], SOURCE)
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(res.out).toContain('customerId') // whitelisted: left readable
    expect(res.out).toContain('__LEDGER__1') // replaced with the rule's placeholder
    expect(res.out).not.toContain('settleLedger')
    expect(res.err).toMatch(/applied 2 custom rules pulled just now/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('without a cache masks as before and mentions no rules', async () => {
    signIn()
    const res = await run(['scrub'], SOURCE)
    expect(res.out).not.toContain('customerId')
    expect(res.err).not.toMatch(/custom rule/)
  })

  it('signed out, the cache is ignored', async () => {
    cache([rule('w', 'whitelist', 'team', 0, '^customerId$')])
    const res = await run(['scrub'], SOURCE)
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(res.out).toMatch(/__VAR__\d+/)
    expect(res.out).not.toContain('customerId')
  })

  it("another account's cache is ignored", async () => {
    signIn('someone-else@example.test')
    cache([rule('w', 'whitelist', 'team', 0, '^customerId$')])
    const res = await run(['scrub'], SOURCE)
    expect(res.out).not.toContain('customerId')
  })

  it('a damaged cache reads as no rules, not as a failed scrub', async () => {
    signIn()
    mkdirSync(dirname(rulesPath(home)), { recursive: true })
    writeFileSync(rulesPath(home), '{"instance":')
    const res = await run(['scrub'], SOURCE)
    expect(res.code).toBe(EXIT_OK)
    expect(res.out).not.toContain('customerId')
  })

  it('a replaced name restores', async () => {
    signIn()
    cache([
      rule('r', 'replace', 'personal', 0, '^settle', {
        placeholder: '__LEDGER__',
      } as Partial<CustomRule>),
    ])
    const scrubbed = await run(['scrub'], SOURCE)
    const restored = await run(['restore'], scrubbed.out)
    expect(restored.out).toContain('settleLedger')
  })
})

describe('logout removes the cached rules', () => {
  it('with the session', async () => {
    signIn()
    writeRules(
      { instance: INSTANCE, account: ACCOUNT, pulledAt: new Date().toISOString(), rules: [] },
      home
    )
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    const res = await run(['logout'])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(existsSync(rulesPath(home))).toBe(false)
  })

  it('also when the session was already revoked', async () => {
    signIn()
    writeRules(
      { instance: INSTANCE, account: ACCOUNT, pulledAt: new Date().toISOString(), rules: [] },
      home
    )
    fetchMock.mockResolvedValue(json(401, { error: 'Unauthorized' }))
    await run(['logout'])
    expect(existsSync(rulesPath(home))).toBe(false)
  })
})

describe('describeAge', () => {
  const now = new Date('2026-09-26T12:00:00Z')
  it.each([
    ['2026-09-26T11:59:30Z', 'just now'],
    ['2026-09-26T11:58:30Z', 'just now'],
    ['2026-09-26T11:58:00Z', '2 minutes ago'],
    ['2026-09-26T11:30:00Z', '30 minutes ago'],
    ['2026-09-26T11:00:00Z', '1 hour ago'],
    ['2026-09-25T00:00:00Z', '36 hours ago'],
    ['2026-09-20T12:00:00Z', '6 days ago'],
    ['not a date', 'at an unknown time'],
  ])('%s → %s', (at, expected) => {
    expect(describeAge(at, now)).toBe(expected)
  })
})
