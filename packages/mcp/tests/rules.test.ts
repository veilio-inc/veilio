import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeCredential } from '@veilio-inc/cli/credential'
import { readRules, rulesPath, writeRules } from '@veilio-inc/cli/rules'
import type { CustomRule } from '@veilio-inc/engine'
import { primeRules, resetRulesCache } from '../src/rules.js'
import { callTool } from '../src/tools.js'

/**
 * Custom rules in the MCP server (found on staging, 2026-09-26: an agent
 * ignored the rules the web app applied). Fetched once at startup; every
 * anonymize result says where its rules came from.
 */

const INSTANCE = 'https://veilio.test'
const ACCOUNT = 'a@example.test'
const SOURCE = 'export function settleLedger(customerId: string) {\n  return customerId\n}\n'

let home: string
let cwd: string
let fetchMock: ReturnType<typeof vi.fn>

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
  pattern: string,
  extra = {}
): CustomRule {
  const base = {
    id,
    scope,
    team_id: scope === 'team' ? 't1' : null,
    name: id,
    pattern,
    enabled: true,
    sort_order: 0,
  }
  return (
    type === 'replace'
      ? { ...base, type, placeholder: '__LEDGER__', ...extra }
      : { ...base, type, ...extra }
  ) as CustomRule
}

const WHITELIST = rule('w', 'whitelist', 'team', '^customerId$')
const REPLACE = rule('r', 'replace', 'personal', '^settle')

function anonymize(): string {
  return callTool('anonymize_text', { text: SOURCE }, { cwd, mapPath: null }).text
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-mcp-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-rules-'))
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

function signIn(): void {
  writeCredential({ token: 'session', account: ACCOUNT, instance: INSTANCE }, home)
}

describe('rules at startup', () => {
  it('signed out: none, and no request', async () => {
    expect((await primeRules(home)).source).toBe('none')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(anonymize()).toContain('Custom rules: none')
  })

  it('from Cloud: applied, stated, and cached for the CLI', async () => {
    signIn()
    fetchMock.mockResolvedValue(json(200, { rules: [REPLACE], teamRules: [WHITELIST] }))
    const resolved = await primeRules(home)
    expect(resolved.source).toBe('cloud')
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${INSTANCE}/api/rules`)

    fetchMock.mockClear()
    const text = anonymize()
    expect(text).toContain('Custom rules: 2 custom rules from Cloud')
    expect(text).toContain('return customerId') // whitelisted
    expect(text).toContain('__LEDGER__1') // replaced
    expect(text).not.toContain('settleLedger')
    // The tool call itself touched no network.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(
      readRules({ instance: INSTANCE, account: ACCOUNT }, home)?.rules.map((r) => r.id)
    ).toEqual(['w', 'r'])
  })

  it('Cloud unreachable: the cached pull is used, and says so', async () => {
    signIn()
    writeRules(
      {
        instance: INSTANCE,
        account: ACCOUNT,
        pulledAt: new Date().toISOString(),
        rules: [WHITELIST],
      },
      home
    )
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    expect((await primeRules(home)).source).toBe('cached')
    const text = anonymize()
    expect(text).toContain(
      'Custom rules: 1 custom rule cached, pulled just now - Cloud did not answer'
    )
    expect(text).toContain('return customerId')
  })

  it('Cloud unreachable and no cache: none', async () => {
    signIn()
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    expect((await primeRules(home)).source).toBe('none')
    expect(anonymize()).not.toContain('return customerId')
  })

  it('plan without rules: none, and the old cache is removed', async () => {
    signIn()
    writeRules(
      {
        instance: INSTANCE,
        account: ACCOUNT,
        pulledAt: new Date().toISOString(),
        rules: [WHITELIST],
      },
      home
    )
    fetchMock.mockResolvedValue(
      json(403, { error: 'Pro plan required for custom rules', upgrade: true })
    )
    expect((await primeRules(home)).source).toBe('none')
    expect(existsSync(rulesPath(home))).toBe(false)
    expect(anonymize()).not.toContain('return customerId')
  })

  it('fetches once, however many callers', async () => {
    signIn()
    fetchMock.mockResolvedValue(json(200, { rules: [], teamRules: [] }))
    await Promise.all([primeRules(home), primeRules(home), primeRules(home)])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
