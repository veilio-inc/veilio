import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeCredential } from '@veilio-inc/cli/credential'
import { writeTeamUnlock, expiryFrom } from '@veilio-inc/cli/team-unlock'
import { toBase64 } from '@veilio-inc/engine'
import { primeNamespace, resetNamespaceCache } from '../src/namespace.js'

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
  } = {}
) {
  const {
    maps = [],
    unlocked = true,
    expired = false,
    otherTeam = false,
    otherAccount = false,
    wrongKey = false,
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
    const { home } = await scenario({
      maps: [
        { id: 'newer', createdAt: '2026-02-01', map: { __CLS__1: 'Newer' } },
        { id: 'older', createdAt: '2026-01-01', map: { __CLS__1: 'Older' } },
      ],
    })

    expect((await primeNamespace(home)).namespace.__CLS__1).toBe('Older')
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
    bodies['/api/maps/bad'] = {
      ...summary('bad', '2026-01-02'),
      map_data: await encryptTeamMap(foreign, { __FN__1: 'charge' }),
    }

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
    expect(paths).toEqual(['/api/maps', '/api/maps/m1'])
  })

  it('fetches each team map exactly once', async () => {
    const { home } = await scenario({
      maps: [
        { id: 'm1', createdAt: '2026-01-01', map: { __CLS__1: 'Invoice' } },
        { id: 'm2', createdAt: '2026-01-02', map: { __FN__1: 'charge' } },
      ],
    })

    await primeNamespace(home)

    const paths = fetchMock.mock.calls.map((c) => new URL(c[0] as string).pathname)
    expect(paths.filter((p) => p.startsWith('/api/maps/'))).toEqual([
      '/api/maps/m1',
      '/api/maps/m2',
    ])
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
    })
  })
})
