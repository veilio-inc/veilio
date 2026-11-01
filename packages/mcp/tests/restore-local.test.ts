import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { localFamilyNote } from '@veilio-inc/engine'
import { saveMap, resolveMapPath } from '@veilio-inc/cli/store'
import { addAliases } from '@veilio-inc/cli/reservations'
import { callTool } from '../src/tools.js'
import { primeNamespace, resetNamespaceCache } from '../src/namespace.js'
import { mapsFor, teamScenario } from '../../cli/tests/helpers/team-scenario.js'

/**
 * Spec 066 R5/R8: `restore_text` leaves another checkout's local placeholders
 * as written, counts them as left and names them with `localFamilyNote`; the
 * own ones restore, from the map or from aliases.json after a publish.
 */

const OTHER = '__LOCAL_ZZ9QQ1_VAR__1'
const MINE = '__LOCAL_K7Q2XA_VAR__1'

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

function ctxWith(own: Record<string, string>, aliases: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-rsl-'))
  const mapPath = resolveMapPath(null, cwd)
  if (Object.keys(own).length) saveMap(mapPath, own)
  if (Object.keys(aliases).length) addAliases(mapPath, aliases)
  return { cwd, mapPath: null }
}
const restoredPart = (text: string) => text.split('--- restored ---\n')[1] ?? ''

async function inTeam() {
  // A team map holding the other checkout's key - an old or hostile client's.
  const maps = mapsFor({
    namespace: { __VAR__1: 'amount', [OTHER]: 'teammateGuess' },
    aliases: {},
    conflicts: {},
  })
  await primeNamespace((await teamScenario(fetchMock, { maps })).home)
}

describe('restore_text and the local family', () => {
  it('another checkout’s local placeholder is left, named, and not called invented', async () => {
    await inTeam()
    const r = callTool(
      'restore_text',
      { text: `x = ${OTHER} + __VAR__1` },
      ctxWith({ __VAR__1: 'amount' })
    )
    expect(r.isError ?? false, r.text).toBe(false)
    expect(restoredPart(r.text)).toBe(`x = ${OTHER} + amount`)
    expect(r.text).not.toContain('teammateGuess')
    expect(r.text).toContain(localFamilyNote([OTHER]))
    expect(r.text).not.toMatch(/invented or altered/)
  })

  it('it counts as left: strict withholds the text', async () => {
    await inTeam()
    const r = callTool(
      'restore_text',
      { text: `x = ${OTHER}`, strict: true },
      ctxWith({ __VAR__1: 'amount' })
    )
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(new RegExp(`strict: the restored text is withheld - ${OTHER}`))
  })

  it('the own local placeholder restores, and so it does through aliases after a publish', async () => {
    await inTeam()
    const own = callTool(
      'restore_text',
      { text: `x = ${MINE}` },
      ctxWith({ [MINE]: 'holdbackDays' })
    )
    expect(restoredPart(own.text)).toBe('x = holdbackDays')
    const after = callTool(
      'restore_text',
      { text: `x = ${MINE}` },
      ctxWith({ __VAR__502: 'holdbackDays' }, { [MINE]: 'holdbackDays' })
    )
    expect(restoredPart(after.text)).toBe('x = holdbackDays')
    expect(after.text).not.toContain('left as is')
  })

  it('signed out (no team at all), the own aliases still restore and another’s is named', () => {
    const r = callTool(
      'restore_text',
      { text: `x = ${MINE} ${OTHER}` },
      ctxWith({ __VAR__502: 'holdbackDays' }, { [MINE]: 'holdbackDays' })
    )
    expect(restoredPart(r.text)).toBe(`x = holdbackDays ${OTHER}`)
    expect(r.text).toContain(localFamilyNote([OTHER]))
  })

  it('a pasted local literal is a placeholder: anonymize leaves it, restore names it', async () => {
    const ctx = ctxWith({ __VAR__1: 'amount' })
    const masked = callTool('anonymize_text', { text: `export const total = ${OTHER}` }, ctx)
    const body = masked.text.split('--- masked code ---\n')[1] ?? ''
    expect(body).toContain(OTHER)
    const r = callTool('restore_text', { text: body, strict: true }, ctx)
    expect(r.isError).toBe(true)
    expect(r.text).toContain(localFamilyNote([OTHER]))
  })
})

// Spec 067 benchmark: a file restored with a redaction in it was written over
// the original and its tests failed. The redaction is named; strict withholds.
describe('restore_text and a redacted value (spec 067)', () => {
  const body = "throw new GatewayFault(__STR__1, '__REDACTED_CREDENTIAL_1__')"
  it('names it and still hands the text back', () => {
    const r = callTool('restore_text', { text: body }, ctxWith({ __STR__1: "'unauthorized'" }))
    expect(r.text).toMatch(/__REDACTED_CREDENTIAL_1__[\s\S]*cannot be restored[\s\S]*do not write/i)
    expect(restoredPart(r.text)).toContain('__REDACTED_CREDENTIAL_1__')
  })
  it('strict withholds the text', () => {
    const r = callTool('restore_text', { text: body, strict: true }, ctxWith({ __STR__1: "'x'" }))
    expect(r.isError).toBe(true)
    expect(restoredPart(r.text)).toBe('')
    expect(r.text).toMatch(/strict: the restored text is withheld - __REDACTED_CREDENTIAL_1__/)
  })
})
