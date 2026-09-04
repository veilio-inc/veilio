import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeCredential } from '@veilio-inc/cli/credential'
import { resolveMapPath, saveMap, loadMap } from '@veilio-inc/cli/store'
import { callTool, type ToolContext } from '../src/tools.js'
import {
  primeNamespace,
  getNamespace,
  resetNamespaceCache,
  mergeNamespace,
} from '../src/namespace.js'

/**
 * The shared namespace two teammates' agents must agree on, and the fallback
 * that must never happen quietly (contracts/shared-namespace.md).
 *
 * Namespace priming is process-lifetime, not test-lifetime — see namespace.ts
 * — so every test resets the module cache itself rather than relying on
 * `beforeEach` module isolation.
 */

const INSTANCE = 'https://veilio.test'
let fetchMock: ReturnType<typeof vi.fn>
const homes: string[] = []

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'veilio-mcp-home-'))
  homes.push(home)
  return home
}

function signIn(home: string): void {
  writeCredential({ token: 't', account: 'a@example.test', instance: INSTANCE }, home)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  resetNamespaceCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetNamespaceCache()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function newCtx(): ToolContext {
  const cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-work-'))
  homes.push(cwd) // reuse cleanup list; not actually a home, just needs removing
  return { cwd, mapPath: null }
}

const TEAM_NAMESPACE = { __CLS__1: 'PaymentGateway' }
const SOURCE = 'export class PaymentGateway {\n  chargeCard(amount: number) { return amount }\n}\n'

describe('two members of one paid team', () => {
  it('resolve the same identifier to the same placeholder', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ personalMaps: [], teamMaps: [], teamNamespace: TEAM_NAMESPACE, plan: 'team' })
    )

    resetNamespaceCache()
    await primeNamespace(signInHome())
    const first = callTool('anonymize_text', { text: SOURCE }, newCtx())

    resetNamespaceCache()
    await primeNamespace(signInHome())
    const second = callTool('anonymize_text', { text: SOURCE }, newCtx())

    expect(first.text).toContain('__CLS__1')
    expect(second.text).toContain('__CLS__1')
    expect(first.text).not.toContain('PaymentGateway')
    expect(second.text).not.toContain('PaymentGateway')
  })
})

function signInHome(): string {
  const home = freshHome()
  signIn(home)
  return home
}

describe('every anonymize result states its namespace source', () => {
  it('says "team" when the namespace resolved against Cloud', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ personalMaps: [], teamMaps: [], teamNamespace: TEAM_NAMESPACE, plan: 'team' })
    )
    await primeNamespace(signInHome())
    const res = callTool('anonymize_text', { text: SOURCE }, newCtx())
    expect(res.text).toContain('Namespace: team')
  })

  it('says "local" when never signed in', async () => {
    await primeNamespace(freshHome())
    const res = callTool('anonymize_text', { text: SOURCE }, newCtx())
    expect(res.text).toContain('Namespace: local')
  })

  it('is never absent from any anonymize result', async () => {
    await primeNamespace(freshHome())
    const file = callTool('anonymize_file', {}, newCtx()) // errors, but check the happy path too
    expect(file.isError).toBe(true)
    const ctx = newCtx()
    const res = callTool('anonymize_text', { text: SOURCE }, ctx)
    expect(res.text).toMatch(/Namespace: (team|local)/)
  })
})

describe('the fallback to local', () => {
  it('happens when offline, and does not fail the operation', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const resolved = await primeNamespace(signInHome())
    expect(resolved.source).toBe('local')
    const res = callTool('anonymize_text', { text: SOURCE }, newCtx())
    expect(res.isError).toBeUndefined()
    expect(res.text).toContain('Namespace: local')
  })

  it('happens when never signed in, and does not fail the operation', async () => {
    const resolved = await primeNamespace(freshHome())
    expect(resolved.source).toBe('local')
    expect(fetchMock).not.toHaveBeenCalled()
    const res = callTool('anonymize_text', { text: SOURCE }, newCtx())
    expect(res.isError).toBeUndefined()
  })

  it('happens when the plan has no shared dictionaries, and does not fail the operation', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ personalMaps: [], teamMaps: [], teamNamespace: null, plan: 'individual' })
    )
    const resolved = await primeNamespace(signInHome())
    expect(resolved.source).toBe('local')
    const res = callTool('anonymize_text', { text: SOURCE }, newCtx())
    expect(res.isError).toBeUndefined()
  })
})

describe('the namespace fetch', () => {
  it('happens once per session and is reused', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ personalMaps: [], teamMaps: [], teamNamespace: TEAM_NAMESPACE, plan: 'team' })
    )
    const home = signInHome()
    await primeNamespace(home)
    await primeNamespace(home)
    callTool('anonymize_text', { text: SOURCE }, newCtx())
    callTool('anonymize_text', { text: SOURCE }, newCtx())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getNamespace().source).toBe('team')
  })
})

/**
 * `local` and `team` are both `Record<placeholder, identifier>`, and a shared
 * key between them is coincidence, not identity — each is numbered
 * independently. A naive `{ ...local, ...team }` merge treats the coincidence
 * as identity and either throws (`saveMap`'s overwrite guard) or silently
 * drops the local identifier's real mapping. Caught by code review before
 * shipping; these pin the fix.
 */
describe('mergeNamespace — the two placeholder spaces are not the same space', () => {
  it('keeps a local identifier on its local placeholder when a team entry claims the same key', () => {
    const merged = mergeNamespace({ __CLS__1: 'LocalThing' }, { __CLS__1: 'PaymentGateway' })
    expect(merged).toEqual({ __CLS__1: 'LocalThing' })
  })

  it('adds a team identifier under its own placeholder when nothing local collides', () => {
    const merged = mergeNamespace({}, { __CLS__1: 'PaymentGateway' })
    expect(merged).toEqual({ __CLS__1: 'PaymentGateway' })
  })

  it('does not give an identifier a second placeholder when local already has one for it', () => {
    const merged = mergeNamespace({ __CLS__5: 'PaymentGateway' }, { __CLS__1: 'PaymentGateway' })
    expect(merged).toEqual({ __CLS__5: 'PaymentGateway' })
  })
})

describe('a local map with a pre-existing entry', () => {
  it('is never corrupted by a colliding team placeholder key', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        personalMaps: [],
        teamMaps: [],
        teamNamespace: { __CLS__1: 'PaymentGateway' },
        plan: 'team',
      })
    )
    await primeNamespace(signInHome())
    const ctx = newCtx()
    saveMap(resolveMapPath(null, ctx.cwd), { __CLS__1: 'LocalThing' })

    const res = callTool('anonymize_text', { text: SOURCE }, ctx)

    expect(res.isError).toBeUndefined()
    const stored = loadMap(resolveMapPath(null, ctx.cwd))
    // Local's own entry survives untouched — this is what the naive merge lost.
    expect(stored.__CLS__1).toBe('LocalThing')
    // PaymentGateway still gets masked, just not under the contested key.
    expect(res.text).not.toContain('PaymentGateway')
    expect(Object.values(stored)).toContain('PaymentGateway')
    expect(Object.entries(stored).find(([, v]) => v === 'PaymentGateway')?.[0]).not.toBe('__CLS__1')
  })

  it('does not persist a team entry this call never referenced', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        personalMaps: [],
        teamMaps: [],
        teamNamespace: { __CLS__1: 'PaymentGateway', __CLS__2: 'SomeOtherClass' },
        plan: 'team',
      })
    )
    await primeNamespace(signInHome())
    const ctx = newCtx()

    callTool('anonymize_text', { text: SOURCE }, ctx) // only mentions PaymentGateway

    const stored = loadMap(resolveMapPath(null, ctx.cwd))
    expect(Object.values(stored)).toContain('PaymentGateway')
    expect(Object.values(stored)).not.toContain('SomeOtherClass')
  })

  it('does persist a team entry this call DID use, so restore_text keeps working', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        personalMaps: [],
        teamMaps: [],
        teamNamespace: TEAM_NAMESPACE,
        plan: 'team',
      })
    )
    await primeNamespace(signInHome())
    const ctx = newCtx()

    const masked = callTool('anonymize_text', { text: SOURCE }, ctx)
    const placeholder = Object.keys(TEAM_NAMESPACE)[0]
    expect(masked.text).toContain(placeholder)

    const restored = callTool('restore_text', { text: placeholder }, ctx)
    expect(restored.text).toContain('PaymentGateway')
  })
})
