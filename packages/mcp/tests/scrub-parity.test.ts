import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../../cli/src/index.js'
import { callTool } from '../src/tools.js'
import { primeNamespace, resetNamespaceCache } from '../src/namespace.js'
import { mapsFor, teamScenario } from '../../cli/tests/helpers/team-scenario.js'

/**
 * `veilio scrub` and the MCP server's `anonymize_text` give the same
 * placeholders for the same code and the same team (spec 030 FR-005). The
 * 2026-09-30 walk found them apart: the CLI numbered from the project map only.
 * They now share one composition; this is what keeps them from drifting again.
 */
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  resetNamespaceCache()
})
afterEach(() => {
  vi.unstubAllGlobals()
  resetNamespaceCache()
})

const fresh = () => mkdtempSync(join(tmpdir(), 'veilio-parity-'))

describe('scrub and anonymize_text, one team, one input', () => {
  it.each([
    [
      'names the team knows, and a new one',
      'export class LedgerService { settleInvoice() {} reverseEntry() {} }\n',
    ],
    ['only new names', 'export function closePeriod(periodId: string) { return periodId }\n'],
    [
      'a team placeholder the project map would have numbered differently',
      'const auditTrail = new LedgerService()\n',
    ],
    ['a name whose placeholder the team disputes', 'export class Foo { settleInvoice() {} }\n'],
  ])('%s: identical output', async (_what, code) => {
    const maps = mapsFor({
      namespace: {
        __CLS__2: 'LedgerService',
        __FN__3: 'settleInvoice',
        __VAR__4: 'entryId',
        __CLS__5: 'Foo',
      },
      aliases: {},
      conflicts: { __CLS__5: 2 },
    })
    const { home } = await teamScenario(fetchMock, { maps })
    let cli = ''
    const code1 = await main(['scrub', '--quiet'], {
      cwd: fresh(),
      home,
      stdin: async () => code,
      stdout: (t) => (cli += t),
      stderr: () => {},
    })
    expect(code1).toBe(0)
    await primeNamespace(home)
    const mcp = callTool('anonymize_text', { text: code }, { cwd: fresh(), mapPath: null })
    const masked = (mcp.text.split('--- masked code ---\n')[1] ?? '').trim()
    expect(mcp.text).toMatch(/Namespace: team/)
    expect(cli.trim()).toBe(masked)
  })
})
