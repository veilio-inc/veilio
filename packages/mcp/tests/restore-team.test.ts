import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { analyzeTeamNamespace } from '@veilio-inc/engine'
import { saveMap, loadMap, resolveMapPath } from '@veilio-inc/cli/store'
import { callTool } from '../src/tools.js'
import {
  primeNamespace,
  resetNamespaceCache,
  namespaceSettled as settled,
} from '../src/namespace.js'
import { RESTORE_CASES } from '../../engine/tests/fixtures/restore-cases.js'
import { mapsFor, teamScenario, unlockLike } from '../../cli/tests/helpers/team-scenario.js'

/**
 * `restore_text` follows the one restore rule (spec 028): the team's maps -
 * aliases included - then this project's map on top; a disputed placeholder is
 * left and named unless the project map settles it. Until now it read the
 * project map only, and removed every disputed placeholder even when the
 * project map settled it.
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

function ctxWith(own: Record<string, string>) {
  const cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-restore-'))
  if (Object.keys(own).length) saveMap(resolveMapPath(null, cwd), own)
  return { cwd, mapPath: null }
}
const restoredPart = (text: string) => text.split('--- restored ---\n')[1] ?? ''

describe('the shared restore cases, through restore_text', () => {
  it.each(RESTORE_CASES)('$name', async (c) => {
    if (c.team) {
      const maps = mapsFor(c.team)
      expect(analyzeTeamNamespace(maps)).toMatchObject(c.team)
      await primeNamespace((await teamScenario(fetchMock, { maps })).home)
    }
    const r = callTool('restore_text', { text: c.text }, ctxWith(c.own))
    expect(r.isError ?? false, r.text).toBe(false)
    expect(restoredPart(r.text)).toBe(c.restored)
    for (const p of c.disputed)
      expect(r.text).toMatch(new RegExp(`left as is: ${p}[\\s\\S]*different identifiers`))
    for (const p of c.locallyNumbered ?? [])
      expect(r.text).toMatch(new RegExp(`left as is: ${p}[\\s\\S]*numbered it locally`))
    if (c.disputed.length === 0 && (c.locallyNumbered ?? []).length === 0)
      expect(r.text).not.toMatch(/left as is/)
    // Neither kind is also called invented by the AI (review).
    expect(r.text).not.toMatch(/invented or altered/)
  })
})

describe('when the team layer is needed but not there', () => {
  const maps = mapsFor({ namespace: { __FN__1: 'settleLedger' }, aliases: {}, conflicts: {} })

  it('a locked team key: an error result naming `veilio team unlock`, text unchanged', async () => {
    await primeNamespace((await teamScenario(fetchMock, { maps, locked: true })).home)
    const r = callTool('restore_text', { text: 'x.__FN__1()' }, ctxWith({}))
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/__FN__1[\s\S]*team key is locked[\s\S]*veilio team unlock/)
    expect(restoredPart(r.text)).toBe('x.__FN__1()')
  })

  it('anonymize says why it is on the local namespace', async () => {
    await primeNamespace((await teamScenario(fetchMock, { maps, locked: true })).home)
    const r = callTool('anonymize_text', { text: 'export function settleLedger() {}' }, ctxWith({}))
    expect(r.text).toMatch(
      /Namespace: local \(the team key is locked on this machine - run `veilio team unlock`\)/
    )
  })

  it('the team maps cannot be read: the reason is given, after one retry', async () => {
    const { home, calls } = await teamScenario(fetchMock, { maps, failures: 5, failStatus: 503 })
    await primeNamespace(home, { retryDelayMs: 1 })
    expect(calls.filter((p) => p === '/api/maps')).toHaveLength(2)
    const r = callTool('restore_text', { text: 'x.__FN__1()' }, ctxWith({}))
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/could not read the team's maps/)
  })

  // Spec 028 R5: the "402 right after a renewal" hypothesis was wrong (the lapse
  // numbering was the cause); only network and server errors are retried.
  it('a transient server failure is retried once and the team namespace used', async () => {
    const { home } = await teamScenario(fetchMock, { maps, failures: 1, failStatus: 503 })
    await primeNamespace(home, { retryDelayMs: 1 })
    const a = callTool('anonymize_text', { text: 'export function settleLedger() {}' }, ctxWith({}))
    expect(a.text).toMatch(/Namespace: team/)
    expect(a.text).toContain('__FN__1')
    const r = callTool('restore_text', { text: 'x.__FN__1()' }, ctxWith({}))
    expect(restoredPart(r.text)).toBe('x.settleLedger()')
  })
})

describe('code review fixes', () => {
  const maps = mapsFor({ namespace: { __FN__1: 'settleLedger' }, aliases: {}, conflicts: {} })

  it('an instance without conflict detection is never used to restore', async () => {
    await primeNamespace((await teamScenario(fetchMock, { maps, legacy: true })).home)
    const r = callTool('restore_text', { text: 'x.__FN__1()' }, ctxWith({ __VAR__1: 'a' }))
    expect(restoredPart(r.text)).toBe('x.__FN__1()')
    expect(r.text).toMatch(/predates conflict detection/)
  })

  it('the report counts this project map and what the team restored, not the whole team layer', async () => {
    const big = mapsFor({
      namespace: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`__FN__${i + 1}`, `fn${i + 1}`])
      ),
      aliases: {},
      conflicts: {},
    })
    await primeNamespace((await teamScenario(fetchMock, { maps: big })).home)
    const r = callTool(
      'restore_text',
      { text: '__FN__3(__VAR__1)' },
      ctxWith({ __VAR__1: 'amount' })
    )
    expect(restoredPart(r.text)).toBe('fn3(amount)')
    expect(r.text).toMatch(/^Restored 2 of 2 placeholders/)
    expect(r.text).not.toMatch(/never appeared in the text/)
  })

  it('a 402 on the listing is no team: no "could not read", no error', async () => {
    const { home } = await teamScenario(fetchMock, { maps, failures: 5, failStatus: 402 })
    await primeNamespace(home, { retryDelayMs: 1 })
    const r = callTool('restore_text', { text: 'x.__VAR__1' }, ctxWith({ __VAR__1: 'amount' }))
    expect(r.isError ?? false).toBe(false)
    expect(r.text).not.toMatch(/could not read/)
  })

  it('`veilio team unlock` after the server started is picked up without a restart', async () => {
    const { home } = await teamScenario(fetchMock, { maps, locked: true })
    await primeNamespace(home)
    const ctx = ctxWith({})
    expect(callTool('restore_text', { text: 'x.__FN__1()' }, ctx).isError).toBe(true)
    // The member unlocks in a terminal: the same team key the maps were sealed with.
    unlockLike(home)
    const loading = callTool('restore_text', { text: 'x.__FN__1()' }, ctx)
    expect(loading.text).toMatch(/team key was unlocked - loading the team's maps/)
    await settled()
    const r = callTool('restore_text', { text: 'x.__FN__1()' }, ctx)
    expect(r.isError ?? false).toBe(false)
    expect(restoredPart(r.text)).toBe('x.settleLedger()')
  })
})

describe('a project numbered during a lapse, after the team is back (spec 028 R5, staging j-business)', () => {
  // The team's maps: __FN__1 chargeCustomer, __FN__2 createInvoice (as on staging).
  const maps = mapsFor({
    namespace: { __FN__1: 'chargeCustomer', __FN__2: 'createInvoice' },
    aliases: {},
    conflicts: {},
  })

  it("new output uses the team's placeholder; old text is never restored to the wrong name", async () => {
    await primeNamespace((await teamScenario(fetchMock, { maps })).home)
    // Written during the lapse, on the local namespace.
    const ctx = ctxWith({ __FN__1: 'createInvoice' })
    const a = callTool(
      'anonymize_text',
      { text: 'const x = createInvoice(); const y = settleAll()' },
      ctx
    )
    expect(a.text).toContain('__FN__2()')
    expect(a.text).not.toMatch(/__FN__1\b/)
    // A new name is numbered above the team's AND this project's own numbers.
    expect(a.text).toMatch(/__FN__3\(\)/)
    // The lapse entry is kept: text already sent with it must not be lost.
    const stored = loadMap(resolveMapPath(null, ctx.cwd))
    expect(stored).toMatchObject({ __FN__1: 'createInvoice', __FN__2: 'createInvoice' })
    // Old text: __FN__1 is left and named - never restored as chargeCustomer.
    const old = callTool('restore_text', { text: 'x.__FN__1()' }, ctx)
    expect(restoredPart(old.text)).toBe('x.__FN__1()')
    expect(old.text).toMatch(/left as is: __FN__1[\s\S]*numbered it locally/)
    // New text restores.
    expect(restoredPart(callTool('restore_text', { text: 'x.__FN__2()' }, ctx).text)).toBe(
      'x.createInvoice()'
    )
  })
})

describe('new numbers stay clear of the project store (spec 028 R5)', () => {
  it("a new identifier is numbered above a lapse-era number higher than the team's", async () => {
    const ns = Object.fromEntries(
      Array.from({ length: 24 }, (_, i) => [`__FN__${i + 1}`, `fn${i + 1}`])
    )
    ns.__FN__2 = 'createInvoice'
    await primeNamespace(
      (
        await teamScenario(fetchMock, {
          maps: mapsFor({ namespace: ns, aliases: {}, conflicts: {} }),
        })
      ).home
    )
    const ctx = ctxWith({ __FN__25: 'createInvoice' })
    const a = callTool('anonymize_text', { text: 'createInvoice(); brandNewThing()' }, ctx)
    expect(a.isError ?? false, a.text).toBe(false)
    expect(a.text).toContain('__FN__2()')
    expect(a.text).toMatch(/__FN__26\(\)/)
    expect(loadMap(resolveMapPath(null, ctx.cwd))).toMatchObject({
      __FN__25: 'createInvoice',
      __FN__26: 'brandNewThing',
    })
  })
})
