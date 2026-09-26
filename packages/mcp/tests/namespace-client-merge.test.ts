import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeCredential } from '@veilio-inc/cli/credential'
import { writeTeamUnlock, expiryFrom } from '@veilio-inc/cli/team-unlock'
import { toBase64 } from '@veilio-inc/engine'
import { primeNamespace, resetNamespaceCache, findConflicts } from '../src/namespace.js'
import { callTool } from '../src/tools.js'
import { saveMap, loadMap, resolveMapPath } from '@veilio-inc/cli/store'

/**
 * The team namespace, merged here rather than by Cloud (spec 010).
 *
 * Cloud stopped sending `teamNamespace` because producing it meant decrypting
 * every team map, which was the only reason it held a key that could read them.
 * The merge happens here now, over maps this member can open with keys that
 * `veilio team unlock` put on disk in a terminal where somebody was present.
 *
 * Ciphertext below is real, built with real WebCrypto and served through a
 * mocked `fetch`, so these run the actual decrypt path. A test that stubbed the
 * crypto would prove only that the plumbing is connected.
 */

const INSTANCE = 'https://veilio.test'
const ACCOUNT = 'a@example.test'
const subtle = globalThis.crypto.subtle
const WRAP_ALG = 'AES-GCM'
const enc = new TextEncoder()

/** WebCrypto wants a buffer-backed view; a plain `Uint8Array` is
 *  `ArrayBufferLike` and the two disagree under current lib typings. */
const buf = (u: Uint8Array) => u as unknown as Uint8Array<ArrayBuffer>

let fetchMock: ReturnType<typeof vi.fn>
const homes: string[] = []

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'veilio-mcp-ns-'))
  homes.push(home)
  writeCredential({ token: 't', account: ACCOUNT, instance: INSTANCE }, home)
  return home
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function encryptTeamMap(
  teamKeyRaw: Uint8Array,
  map: Record<string, string>
): Promise<string> {
  const key = await subtle.importKey('raw', buf(teamKeyRaw), { name: WRAP_ALG }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await subtle.encrypt({ name: WRAP_ALG, iv }, key, enc.encode(JSON.stringify(map)))
  return JSON.stringify({ v: 1, alg: 'AES-256-GCM-TEAM', iv: toBase64(iv), data: toBase64(data) })
}

const summary = (id: string, createdAt: string, scope: 'team' | 'personal' = 'team') => ({
  id,
  name: id,
  scope,
  identifier_count: 1,
  created_at: createdAt,
  updated_at: createdAt,
  storage: 'client-envelope',
})

interface MapFixture {
  id: string
  createdAt: string
  map: Record<string, string>
  /** Listed under personalMaps because THIS member owns it. Its scope is still
   *  'team' — the listing splits by ownership, not by scope. */
  mine?: boolean
  /** A genuinely personal-scoped map, which must not reach the namespace. */
  scope?: 'team' | 'personal'
}

/** A signed-in member of a one-team account, holding v1 of the team key. */
async function scenario(
  opts: {
    maps?: MapFixture[]
    /** Skip the unlock file, i.e. nobody has run `veilio team unlock`. */
    unlocked?: boolean
    /** Write an unlock that has already expired. */
    expired?: boolean
    /** Write an unlock belonging to a different team. */
    otherTeam?: boolean
    /** Write an unlock for a different account. */
    otherAccount?: boolean
    /** Write an unlock holding a key that opens nothing. */
    wrongKey?: boolean
    /** An instance that predates GET /api/maps/team-envelopes (answers 404). */
    noBulk?: boolean
  } = {}
) {
  const {
    maps = [],
    unlocked = true,
    expired = false,
    otherTeam = false,
    otherAccount = false,
    wrongKey = false,
    noBulk = false,
  } = opts
  const teamKeyRaw = crypto.getRandomValues(new Uint8Array(32))

  const bodies: Record<string, unknown> = {
    '/api/maps': {
      personalMaps: maps
        .filter((m) => m.mine || m.scope === 'personal')
        .map((m) => summary(m.id, m.createdAt, m.scope ?? 'team')),
      teamMaps: maps
        .filter((m) => !m.mine && m.scope !== 'personal')
        .map((m) => summary(m.id, m.createdAt)),
      team: { id: 'team-1' },
      plan: 'team',
    },
  }
  for (const m of maps) {
    bodies[`/api/maps/${m.id}`] = {
      ...summary(m.id, m.createdAt, m.scope ?? 'team'),
      map_data: await encryptTeamMap(teamKeyRaw, m.map),
    }
  }
  if (!noBulk) {
    bodies['/api/maps/team-envelopes'] = {
      maps: maps
        .filter((m) => m.scope !== 'personal')
        .map((m) => ({
          id: m.id,
          created_at: m.createdAt,
          map_data: (bodies[`/api/maps/${m.id}`] as { map_data: string }).map_data,
        })),
      unreadable: [],
    }
  }

  fetchMock.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname
    if (path in bodies) return jsonResponse(bodies[path])
    return jsonResponse({ error: 'not found' }, 404)
  })

  const home = freshHome()
  if (unlocked) {
    const now = new Date()
    writeTeamUnlock(
      {
        v: 1,
        instance: INSTANCE,
        account: otherAccount ? 'someone.else@example.test' : ACCOUNT,
        teamId: otherTeam ? 'some-other-team' : 'team-1',
        expiresAt: expired ? new Date(now.getTime() - 1000).toISOString() : expiryFrom(now),
        keys: [
          {
            version: 1,
            key: toBase64(wrongKey ? crypto.getRandomValues(new Uint8Array(32)) : teamKeyRaw),
          },
        ],
      },
      home
    )
  }

  return { home, teamKeyRaw, bodies }
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

describe('the client-side merge', () => {
  it('opens team maps and merges them into one namespace', async () => {
    const { home } = await scenario({
      maps: [
        { id: 'm1', createdAt: '2026-01-01', map: { __CLS__1: 'PaymentGateway' } },
        { id: 'm2', createdAt: '2026-01-02', map: { __FN__1: 'chargeCard' } },
      ],
    })

    const resolved = await primeNamespace(home)

    expect(resolved.source).toBe('team')
    expect(resolved.namespace).toEqual({ __CLS__1: 'PaymentGateway', __FN__1: 'chargeCard' })
  })

  it("includes the member's OWN team maps, which arrive under personalMaps", async () => {
    // The listing splits by ownership, not by scope. Reading only `teamMaps`
    // drops this member's own placeholders out of the shared namespace, and the
    // symptom is two teammates disagreeing about exactly the names this member
    // created.
    const { home } = await scenario({
      maps: [
        { id: 'mine', createdAt: '2026-01-01', map: { __CLS__1: 'Invoice' }, mine: true },
        { id: 'theirs', createdAt: '2026-01-02', map: { __FN__1: 'charge' } },
      ],
    })

    expect((await primeNamespace(home)).namespace).toEqual({
      __CLS__1: 'Invoice',
      __FN__1: 'charge',
    })
  })

  it('leaves genuinely personal-scoped maps out of the team namespace', async () => {
    // The other half of the same filter. Folding a personal map into the shared
    // namespace would publish names no teammate agreed to and cannot resolve.
    const { home } = await scenario({
      maps: [
        { id: 'shared', createdAt: '2026-01-01', map: { __CLS__1: 'Invoice' } },
        { id: 'private', createdAt: '2026-01-02', map: { __CLS__9: 'Secret' }, scope: 'personal' },
      ],
    })

    expect((await primeNamespace(home)).namespace).toEqual({ __CLS__1: 'Invoice' })
  })

  it('applies first-write-wins by created_at, not by listing order', async () => {
    // Same identifier under two numbers: the older number is the one reused.
    // (Two identifiers under ONE number is a conflict instead - spec 017, below.)
    const { home } = await scenario({
      maps: [
        { id: 'newer', createdAt: '2026-02-01', map: { __CLS__2: 'Invoice' } },
        { id: 'older', createdAt: '2026-01-01', map: { __CLS__1: 'Invoice' } },
      ],
    })

    expect((await primeNamespace(home)).namespace).toEqual({ __CLS__1: 'Invoice' })
  })

  it('skips a map it cannot open rather than losing the whole namespace', async () => {
    const { home, bodies } = await scenario({
      maps: [
        { id: 'good', createdAt: '2026-01-01', map: { __CLS__1: 'Invoice' } },
        { id: 'bad', createdAt: '2026-01-02', map: { __FN__1: 'charge' } },
      ],
    })
    // Written under a key this member was never granted — the ordinary shape of
    // a mid-rotation team, or a map from before they joined.
    const foreign = crypto.getRandomValues(new Uint8Array(32))
    const foreignEnvelope = await encryptTeamMap(foreign, { __FN__1: 'charge' })
    bodies['/api/maps/bad'] = { ...summary('bad', '2026-01-02'), map_data: foreignEnvelope }
    const bulk = bodies['/api/maps/team-envelopes'] as { maps: { id: string; map_data: string }[] }
    bulk.maps.find((m) => m.id === 'bad')!.map_data = foreignEnvelope

    const resolved = await primeNamespace(home)

    expect(resolved.source).toBe('team')
    expect(resolved.namespace).toEqual({ __CLS__1: 'Invoice' })
  })
})

describe('what the unlock file gates', () => {
  const oneMap: MapFixture[] = [{ id: 'm1', createdAt: '2026-01-01', map: { __CLS__1: 'Invoice' } }]

  it('falls back when nobody has run `veilio team unlock`', async () => {
    // The state on a fresh machine, and the one production takes today.
    const { home } = await scenario({ maps: oneMap, unlocked: false })

    expect((await primeNamespace(home)).source).toBe('local')
  })

  it('falls back when the unlock has expired', async () => {
    // A machine compromised weeks after somebody unlocked must not hand over a
    // live key for a session everyone forgot about.
    const { home } = await scenario({ maps: oneMap, expired: true })

    expect((await primeNamespace(home)).source).toBe('local')
  })

  it('falls back when the unlock belongs to another account', async () => {
    // Two people sharing a machine, or one account signed out and another in.
    const { home } = await scenario({ maps: oneMap, otherAccount: true })

    expect((await primeNamespace(home)).source).toBe('local')
  })

  it('falls back when the unlock is for a different team', async () => {
    // Left one team, joined another, never re-unlocked.
    const { home } = await scenario({ maps: oneMap, otherTeam: true })

    expect((await primeNamespace(home)).source).toBe('local')
  })

  it('falls back when the held key opens nothing, rather than claiming an empty team', async () => {
    // An empty `team` namespace would assert agreement that does not exist.
    const { home } = await scenario({ maps: oneMap, wrongKey: true })

    expect((await primeNamespace(home)).source).toBe('local')
  })
})

describe('falling back to local, never silently', () => {
  it('falls back when the account has no team', async () => {
    const { home } = await scenario()
    fetchMock.mockImplementation(async () =>
      jsonResponse({ personalMaps: [], teamMaps: [], team: null, plan: 'individual' })
    )

    expect((await primeNamespace(home)).source).toBe('local')
  })

  it('falls back when Cloud is unreachable', async () => {
    const { home } = await scenario()
    fetchMock.mockImplementation(async () => {
      throw new Error('ECONNREFUSED')
    })

    expect((await primeNamespace(home)).source).toBe('local')
  })
})

describe('what it asks Cloud for', () => {
  it('makes no request at all when signed out', async () => {
    // The property `UNGATED_CAPABILITIES.mcpServer` claims in veilio-cloud.
    const home = mkdtempSync(join(tmpdir(), 'veilio-mcp-signedout-'))
    homes.push(home)

    expect((await primeNamespace(home)).source).toBe('local')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never asks for the keypair or the key wraps — those are on disk already', async () => {
    // Unlocking is the interactive step, and it already happened. Re-fetching
    // wraps here would mean needing a passphrase nobody is present to type.
    const { home } = await scenario({
      maps: [{ id: 'm1', createdAt: '2026-01-01', map: { __CLS__1: 'Invoice' } }],
    })

    await primeNamespace(home)

    const paths = fetchMock.mock.calls.map((c) => new URL(c[0] as string).pathname)
    expect(paths).toEqual(['/api/maps', '/api/maps/team-envelopes'])
  })

  it('reads every team map in ONE request, not one per map (spec 017)', async () => {
    const { home } = await scenario({
      maps: [
        { id: 'm1', createdAt: '2026-01-01', map: { __CLS__1: 'Invoice' } },
        { id: 'm2', createdAt: '2026-01-02', map: { __FN__1: 'charge' } },
      ],
    })

    const resolved = await primeNamespace(home)

    expect(resolved.namespace).toEqual({ __CLS__1: 'Invoice', __FN__1: 'charge' })
    const paths = fetchMock.mock.calls.map((c) => new URL(c[0] as string).pathname)
    expect(paths.filter((p) => p.startsWith('/api/maps/'))).toEqual(['/api/maps/team-envelopes'])
  })

  it('an instance without the bulk endpoint is read one map at a time, each once', async () => {
    const { home } = await scenario({
      noBulk: true,
      maps: [
        { id: 'm1', createdAt: '2026-01-01', map: { __CLS__1: 'Invoice' } },
        { id: 'm2', createdAt: '2026-01-02', map: { __FN__1: 'charge' } },
      ],
    })

    const resolved = await primeNamespace(home)

    expect(resolved.namespace).toEqual({ __CLS__1: 'Invoice', __FN__1: 'charge' })
    const paths = fetchMock.mock.calls.map((c) => new URL(c[0] as string).pathname)
    expect(paths.filter((p) => p.startsWith('/api/maps/'))).toEqual([
      '/api/maps/team-envelopes',
      '/api/maps/m1',
      '/api/maps/m2',
    ])
  })

  it('a failed bulk read is local, never a namespace missing maps (spec 017)', async () => {
    const { home } = await scenario({
      maps: [{ id: 'm1', createdAt: '2026-01-01', map: { __CLS__1: 'Invoice' } }],
    })
    const serve = fetchMock.getMockImplementation() as (url: string) => Promise<Response>
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === '/api/maps/team-envelopes'
        ? jsonResponse({ error: 'Too many requests' }, 429)
        : serve(url)
    )
    const resolved = await primeNamespace(home)
    expect(resolved.source).toBe('local')
    const paths = fetchMock.mock.calls.map((c) => new URL(c[0] as string).pathname)
    expect(paths).not.toContain('/api/maps/m1')
  })
})

describe('an older Cloud that still merges server-side', () => {
  it('is used as-is, without needing anything unlocked', async () => {
    const home = freshHome()
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        personalMaps: [],
        teamMaps: [],
        team: { id: 'team-1' },
        teamNamespace: { __CLS__1: 'PaymentGateway' },
        plan: 'team',
      })
    )

    expect(await primeNamespace(home)).toEqual({
      source: 'team',
      namespace: { __CLS__1: 'PaymentGateway' },
      conflicts: [],
      highest: {},
    })
  })
})

// ─── Spec 017: maps that disagree about a placeholder ────────────────────────
//
// Saved before Cloud reserved numbers: two members' maps both hold __FN__6, for
// different functions. The server must never emit it, and never guess it back.

describe('placeholders the team disagrees about', () => {
  const MAPS = [
    { id: 'm1', createdAt: '2026-09-26T10:00:00Z', map: { __FN__6: 'settleLedger', __CLS__1: 'Ledger' } },
    { id: 'm2', createdAt: '2026-09-26T10:00:05Z', map: { __FN__6: 'voidLedger', __CLS__1: 'Ledger' } },
  ]

  it('are reported, and left out of the namespace used to anonymize', async () => {
    const { home } = await scenario({ maps: MAPS })
    const resolved = await primeNamespace(home)
    expect(resolved.source).toBe('team')
    expect(resolved.conflicts).toEqual(['__FN__6'])
    expect(resolved.namespace).toEqual({ __CLS__1: 'Ledger' })
  })

  it('restore_text leaves them and says why, whatever the local store holds', async () => {
    const { home } = await scenario({ maps: MAPS })
    await primeNamespace(home)
    const cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-conflict-'))
    homes.push(cwd)
    saveMap(resolveMapPath(null, cwd), { __FN__6: 'settleLedger', __CLS__1: 'Ledger' })
    const res = callTool('restore_text', { text: 'new __CLS__1().__FN__6()' }, { cwd, mapPath: null })
    expect(res.text).toContain('new Ledger().__FN__6()')
    expect(res.text).not.toContain('settleLedger')
    expect(res.text).toContain('WARNING: left as is: __FN__6')
  })

  it('no warning when the text does not hold one', async () => {
    const { home } = await scenario({ maps: MAPS })
    await primeNamespace(home)
    const cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-conflict-'))
    homes.push(cwd)
    saveMap(resolveMapPath(null, cwd), { __CLS__1: 'Ledger' })
    expect(callTool('restore_text', { text: 'new __CLS__1()' }, { cwd, mapPath: null }).text).not.toContain('left as is')
  })

  it("a new name never takes a conflicting number, and the agent's own output restores (review)", async () => {
    // __FN__6 is the conflict and the highest __FN__; without the floor the
    // engine would give it to the new name, and restore_text would refuse it.
    const { home } = await scenario({ maps: MAPS })
    expect((await primeNamespace(home)).highest).toEqual({ __FN__: 6, __CLS__: 1 })
    const cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-conflict-'))
    homes.push(cwd)
    const ctx = { cwd, mapPath: null }
    const out = callTool('anonymize_text', { text: 'function chargeCard() {}' }, ctx).text
    expect(out).toContain('function __FN__7()')
    expect(out).not.toContain('__FN__6')
    expect(out).not.toContain('\u0000')
    const back = callTool('restore_text', { text: '__FN__7()' }, ctx).text
    expect(back).toContain('chargeCard()')
    expect(back).not.toContain('left as is')
    // The floor marker never reaches the saved store.
    const stored = loadMap(resolveMapPath(null, cwd))
    expect(Object.values(stored).some((v) => v.includes('\u0000'))).toBe(false)
    // At the map's own highest (__CLS__1) no marker is added over the real entry.
    expect(callTool('anonymize_text', { text: 'class Ledger {}' }, ctx).text).toContain('class __CLS__1')
  })

  it('findConflicts ignores unreadable maps and agreeing ones', () => {
    expect(findConflicts([{ createdAt: 'a', map: null }, { createdAt: 'b', map: { __X__1: 'a' } }, { createdAt: 'c', map: { __X__1: 'a' } }])).toEqual([])
  })
})
