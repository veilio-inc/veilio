import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeCredential } from '@veilio-inc/cli/credential'
import {
  toBase64,
  deriveWrappingKey,
  importPublicKey,
  type CryptoKeyLike,
} from '@veilio-inc/engine'
import { primeNamespace, resetNamespaceCache } from '../src/namespace.js'

/**
 * The team namespace, merged here rather than by Cloud (spec 010).
 *
 * Cloud stopped sending `teamNamespace` because producing it meant decrypting
 * every team map, which was the only reason it held a key that could read them.
 * These tests drive the replacement: fetch the member's keypair, unwrap the
 * team key, open each team map, merge.
 *
 * Everything below builds real ciphertext with real WebCrypto and serves it
 * through a mocked `fetch`, so the assertions run the actual decrypt path. A
 * test that stubbed the crypto would prove only that the plumbing is connected.
 */

const INSTANCE = 'https://veilio.test'
const subtle = globalThis.crypto.subtle
const WRAP_ALG = 'AES-GCM'
const enc = new TextEncoder()

/** WebCrypto wants a buffer-backed view; a plain `Uint8Array` is `ArrayBufferLike`
 *  and the two disagree under current lib typings. The bytes are identical, only
 *  the declaration differs. `BufferSource` is not nameable in the engine, whose
 *  tsconfig carries no DOM lib on purpose, so the generic form is used instead. */
const buf = (u: Uint8Array) => u as unknown as Uint8Array<ArrayBuffer>

let fetchMock: ReturnType<typeof vi.fn>
const homes: string[] = []

type Keypair = { publicKey: CryptoKey; privateKey: CryptoKey }

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'veilio-mcp-ns-'))
  homes.push(home)
  writeCredential({ token: 't', account: 'a@example.test', instance: INSTANCE }, home)
  return home
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function makeVaultKey(): Promise<CryptoKey> {
  return subtle.generateKey({ name: WRAP_ALG, length: 256 }, false, ['encrypt', 'decrypt'])
}

async function makeKeypair(): Promise<Keypair> {
  return (await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as unknown as Keypair
}

async function publicKeyB64(kp: Keypair): Promise<string> {
  return toBase64(await subtle.exportKey('raw', kp.publicKey))
}

/** As the browser stores it: private half wrapped under the vault key. */
async function storePrivateKey(vaultKey: CryptoKey, kp: Keypair): Promise<string> {
  const pkcs8 = await subtle.exportKey('pkcs8', kp.privateKey)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await subtle.encrypt({ name: WRAP_ALG, iv }, vaultKey, pkcs8)
  return JSON.stringify({ v: 1, alg: WRAP_ALG, iv: toBase64(iv), data: toBase64(data) })
}

/** As a teammate grants it: the team key wrapped to the recipient's public key. */
async function wrapTeamKeyFor(
  teamKeyRaw: Uint8Array,
  granter: Keypair,
  recipientPublicB64: string,
  ctx: { teamId: string; version: number }
): Promise<string> {
  const granterPublicKey = await publicKeyB64(granter)
  const wrappingKey = await deriveWrappingKey(
    granter.privateKey as unknown as CryptoKeyLike,
    await importPublicKey(recipientPublicB64),
    { ...ctx, granterPublicKey, recipientPublicKey: recipientPublicB64 }
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await subtle.encrypt(
    { name: WRAP_ALG, iv },
    wrappingKey as unknown as CryptoKey,
    buf(teamKeyRaw)
  )
  return JSON.stringify({ v: 1, iv: toBase64(iv), data: toBase64(data), from: granterPublicKey })
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

/** A signed-in member of a one-team account, holding v1 of the team key. */
async function scenario(
  opts: {
    maps?: {
      id: string
      createdAt: string
      map: Record<string, string>
      /** Listed under personalMaps because THIS member owns it. Its scope is
       *  still 'team' — the listing splits by ownership, not by scope. */
      mine?: boolean
      /** A genuinely personal-scoped map, which must not reach the namespace. */
      scope?: 'team' | 'personal'
    }[]
    keysInitialized?: boolean
    granted?: boolean
  } = {}
) {
  const { maps = [], keysInitialized = true, granted = true } = opts
  const vaultKey = await makeVaultKey()
  const me = await makeKeypair()
  const granter = await makeKeypair()
  const myPublic = await publicKeyB64(me)
  const teamKeyRaw = crypto.getRandomValues(new Uint8Array(32))

  const wrap = await wrapTeamKeyFor(teamKeyRaw, granter, myPublic, { teamId: 'team-1', version: 1 })
  const stored = await storePrivateKey(vaultKey, me)

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
    '/api/auth/keys': keysInitialized
      ? { initialized: true, publicKey: myPublic, privateKeyEncrypted: stored, alg: 'X25519' }
      : { initialized: false },
    '/api/teams/team-1/key': granted
      ? {
          wraps: [{ version: 1, wrapped_key: wrap, wrapped_by: 'x', created_at: '2026-01-01' }],
          granted: true,
        }
      : { wraps: [], granted: false },
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

  return { home: freshHome(), vaultKey: vaultKey as unknown as CryptoKeyLike, teamKeyRaw, bodies }
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
    const { home, vaultKey } = await scenario({
      maps: [
        { id: 'm1', createdAt: '2026-01-01', map: { __CLS__1: 'PaymentGateway' } },
        { id: 'm2', createdAt: '2026-01-02', map: { __FN__1: 'chargeCard' } },
      ],
    })

    const resolved = await primeNamespace(home, vaultKey)

    expect(resolved.source).toBe('team')
    expect(resolved.namespace).toEqual({ __CLS__1: 'PaymentGateway', __FN__1: 'chargeCard' })
  })

  it("includes the member's OWN team maps, which arrive under personalMaps", async () => {
    // The listing splits by ownership, not by scope. Reading only `teamMaps`
    // drops this member's own placeholders out of the shared namespace, and the
    // symptom is two teammates disagreeing about exactly the names this member
    // created.
    const { home, vaultKey } = await scenario({
      maps: [
        { id: 'mine', createdAt: '2026-01-01', map: { __CLS__1: 'Invoice' }, mine: true },
        { id: 'theirs', createdAt: '2026-01-02', map: { __FN__1: 'charge' } },
      ],
    })

    const resolved = await primeNamespace(home, vaultKey)

    expect(resolved.namespace).toEqual({ __CLS__1: 'Invoice', __FN__1: 'charge' })
  })

  it('leaves genuinely personal-scoped maps out of the team namespace', async () => {
    // The other half of the same filter. A personal map is this member's alone;
    // folding it into the shared namespace would publish names no teammate
    // agreed to and cannot resolve.
    const { home, vaultKey } = await scenario({
      maps: [
        { id: 'shared', createdAt: '2026-01-01', map: { __CLS__1: 'Invoice' } },
        { id: 'private', createdAt: '2026-01-02', map: { __CLS__9: 'Secret' }, scope: 'personal' },
      ],
    })

    const resolved = await primeNamespace(home, vaultKey)

    expect(resolved.namespace).toEqual({ __CLS__1: 'Invoice' })
  })

  it('applies first-write-wins by created_at, not by listing order', async () => {
    const { home, vaultKey } = await scenario({
      maps: [
        { id: 'newer', createdAt: '2026-02-01', map: { __CLS__1: 'Newer' } },
        { id: 'older', createdAt: '2026-01-01', map: { __CLS__1: 'Older' } },
      ],
    })

    const resolved = await primeNamespace(home, vaultKey)

    expect(resolved.namespace.__CLS__1).toBe('Older')
  })

  it('skips a map it cannot open rather than losing the whole namespace', async () => {
    const { home, vaultKey, bodies } = await scenario({
      maps: [
        { id: 'good', createdAt: '2026-01-01', map: { __CLS__1: 'Invoice' } },
        { id: 'bad', createdAt: '2026-01-02', map: { __FN__1: 'charge' } },
      ],
    })
    // Written under a key this member was never granted.
    const foreign = crypto.getRandomValues(new Uint8Array(32))
    bodies['/api/maps/bad'] = {
      ...summary('bad', '2026-01-02'),
      map_data: await encryptTeamMap(foreign, { __FN__1: 'charge' }),
    }

    const resolved = await primeNamespace(home, vaultKey)

    expect(resolved.source).toBe('team')
    expect(resolved.namespace).toEqual({ __CLS__1: 'Invoice' })
  })
})

describe('falling back to local, never silently', () => {
  it('falls back when no vault key is available', async () => {
    // The state today: nothing puts key material on disk for a non-interactive
    // MCP start, so this is the path production actually takes until
    // `veilio team unlock` exists.
    const { home } = await scenario({
      maps: [{ id: 'm1', createdAt: '2026-01-01', map: { __CLS__1: 'Invoice' } }],
    })

    expect((await primeNamespace(home, null)).source).toBe('local')
  })

  it('falls back when the account has no keypair yet', async () => {
    const { home, vaultKey } = await scenario({
      maps: [{ id: 'm1', createdAt: '2026-01-01', map: { __CLS__1: 'Invoice' } }],
      keysInitialized: false,
    })

    expect((await primeNamespace(home, vaultKey)).source).toBe('local')
  })

  it('falls back when no teammate has granted the team key yet', async () => {
    const { home, vaultKey } = await scenario({
      maps: [{ id: 'm1', createdAt: '2026-01-01', map: { __CLS__1: 'Invoice' } }],
      granted: false,
    })

    expect((await primeNamespace(home, vaultKey)).source).toBe('local')
  })

  it('falls back when the account has no team', async () => {
    const { home, vaultKey } = await scenario()
    fetchMock.mockImplementation(async () =>
      jsonResponse({ personalMaps: [], teamMaps: [], team: null, plan: 'individual' })
    )

    expect((await primeNamespace(home, vaultKey)).source).toBe('local')
  })

  it('falls back when every team map is unreadable, rather than claiming an empty team', async () => {
    // An empty `team` namespace would assert agreement that does not exist.
    const { home, vaultKey, bodies } = await scenario({
      maps: [{ id: 'm1', createdAt: '2026-01-01', map: { __CLS__1: 'Invoice' } }],
    })
    const foreign = crypto.getRandomValues(new Uint8Array(32))
    bodies['/api/maps/m1'] = {
      ...summary('m1', '2026-01-01'),
      map_data: await encryptTeamMap(foreign, { __CLS__1: 'Invoice' }),
    }

    expect((await primeNamespace(home, vaultKey)).source).toBe('local')
  })

  it('falls back when Cloud is unreachable', async () => {
    const { home, vaultKey } = await scenario()
    fetchMock.mockImplementation(async () => {
      throw new Error('ECONNREFUSED')
    })

    expect((await primeNamespace(home, vaultKey)).source).toBe('local')
  })

  it('falls back on a wrong vault key instead of surfacing a crypto error', async () => {
    const { home } = await scenario({
      maps: [{ id: 'm1', createdAt: '2026-01-01', map: { __CLS__1: 'Invoice' } }],
    })
    const wrong = (await makeVaultKey()) as unknown as CryptoKeyLike

    expect((await primeNamespace(home, wrong)).source).toBe('local')
  })
})

describe('what it asks Cloud for', () => {
  it('makes no request at all when signed out', async () => {
    // The property `UNGATED_CAPABILITIES.mcpServer` claims in veilio-cloud.
    const home = mkdtempSync(join(tmpdir(), 'veilio-mcp-signedout-'))
    homes.push(home)

    expect((await primeNamespace(home, null)).source).toBe('local')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never asks for a map it was not told about', async () => {
    const { home, vaultKey } = await scenario({
      maps: [{ id: 'm1', createdAt: '2026-01-01', map: { __CLS__1: 'Invoice' } }],
    })

    await primeNamespace(home, vaultKey)

    const paths = fetchMock.mock.calls.map((c) => new URL(c[0] as string).pathname)
    expect(paths).toContain('/api/maps')
    expect(paths).toContain('/api/auth/keys')
    expect(paths).toContain('/api/teams/team-1/key')
    expect(paths).toContain('/api/maps/m1')
    expect(paths.filter((p) => p.startsWith('/api/maps/'))).toHaveLength(1)
  })
})

describe('an older Cloud that still merges server-side', () => {
  it('is used as-is, without needing a vault key', async () => {
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

    const resolved = await primeNamespace(home, null)

    expect(resolved).toEqual({ source: 'team', namespace: { __CLS__1: 'PaymentGateway' } })
  })
})
