/**
 * A signed-in member of a one-team account, with REAL team-map ciphertext
 * served through a mocked fetch and a real `veilio team unlock` file - so the
 * decrypt path under test is the one users run. Shared by the CLI's and the
 * MCP's restore tests (spec 028): one scenario, so the two surfaces are judged
 * against the same maps.
 */
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { toBase64 } from '@veilio-inc/engine'
import { writeCredential } from '../../src/credential.js'
import { writeTeamUnlock, expiryFrom } from '../../src/team-unlock.js'

export const INSTANCE = 'https://veilio.test'
const keysByHome = new Map<string, Uint8Array>()
export const ACCOUNT = 'member@example.test'
const subtle = globalThis.crypto.subtle
const buf = (u: Uint8Array) => u as unknown as Uint8Array<ArrayBuffer>

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function encryptTeamMap(
  teamKeyRaw: Uint8Array,
  map: Record<string, string>
): Promise<string> {
  const key = await subtle.importKey('raw', buf(teamKeyRaw), { name: 'AES-GCM' }, false, [
    'encrypt',
  ])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(map))
  )
  return JSON.stringify({ v: 1, alg: 'AES-256-GCM-TEAM', iv: toBase64(iv), data: toBase64(data) })
}

export interface TeamLayerSpec {
  namespace: Record<string, string>
  aliases: Record<string, string>
  conflicts: Record<string, number>
}

/**
 * Team maps that analyze to exactly `layer`: the namespace first, then a later
 * map holding the aliases (a second number for an identifier already held),
 * then a later one giving each disputed placeholder a different identifier.
 */
export function mapsFor(
  layer: TeamLayerSpec
): { createdAt: string; map: Record<string, string> }[] {
  const out = [{ createdAt: '2026-09-01T10:00:00Z', map: { ...layer.namespace } }]
  if (Object.keys(layer.aliases).length)
    out.push({ createdAt: '2026-09-02T10:00:00Z', map: { ...layer.aliases } })
  const disputed = Object.fromEntries(
    Object.keys(layer.conflicts).map((p) => [p, `${layer.namespace[p] ?? 'x'}Elsewhere`])
  )
  if (Object.keys(disputed).length) out.push({ createdAt: '2026-09-03T10:00:00Z', map: disputed })
  return out
}

/**
 * Serve `maps` for team-1 through `fetchMock`, sign a member in under a fresh
 * home, and (unless `locked`) write the unlock holding the team key.
 * `failures`: how many times /api/maps answers with `failStatus` first.
 */
export async function teamScenario(
  fetchMock: {
    mockImplementation: (
      fn: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>
    ) => unknown
  },
  opts: {
    maps: { createdAt: string; map: Record<string, string> }[]
    locked?: boolean
    failures?: number
    failStatus?: number
    /** An older instance that merges server-side (no conflict detection). */
    legacy?: boolean
    /** /api/maps never answers until the request is aborted. */
    hang?: boolean
    /** Signed in, but not in any team. */
    noTeam?: boolean
  }
): Promise<{ home: string; calls: string[] }> {
  const teamKeyRaw = crypto.getRandomValues(new Uint8Array(32))
  const envelopes = await Promise.all(opts.maps.map((m) => encryptTeamMap(teamKeyRaw, m.map)))
  const rows = opts.maps.map((m, i) => ({
    id: `map-${i}`,
    created_at: m.createdAt,
    map_data: envelopes[i],
  }))
  const calls: string[] = []
  let failuresLeft = opts.failures ?? 0
  fetchMock.mockImplementation(async (url: string, init?: { signal?: AbortSignal }) => {
    const path = new URL(url).pathname
    calls.push(path)
    if (path === '/api/maps' && opts.hang) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        )
      })
    }
    if (path === '/api/maps' && opts.legacy)
      return jsonResponse({
        personalMaps: [],
        teamMaps: [],
        team: { id: 'team-1' },
        teamNamespace: Object.assign({}, ...opts.maps.map((m) => m.map)),
        plan: 'team',
      })
    if (path === '/api/maps' && opts.noTeam)
      return jsonResponse({ personalMaps: [], teamMaps: [], plan: 'individual' })
    if (path === '/api/maps' && failuresLeft > 0) {
      failuresLeft--
      return jsonResponse({ error: 'try again' }, opts.failStatus ?? 429)
    }
    if (path === '/api/maps')
      return jsonResponse({
        personalMaps: [],
        teamMaps: rows.map((r) => ({
          id: r.id,
          name: r.id,
          scope: 'team',
          identifier_count: 1,
          created_at: r.created_at,
          updated_at: r.created_at,
        })),
        team: { id: 'team-1' },
        plan: 'team',
      })
    if (path === '/api/maps/team-envelopes') return jsonResponse({ maps: rows, unreadable: [] })
    return jsonResponse({ error: 'not found' }, 404)
  })
  const home = mkdtempSync(join(tmpdir(), 'veilio-team-home-'))
  writeCredential({ token: 't', account: ACCOUNT, instance: INSTANCE }, home)
  keysByHome.set(home, teamKeyRaw)
  if (!opts.locked) {
    writeTeamUnlock(
      {
        v: 1,
        instance: INSTANCE,
        account: ACCOUNT,
        teamId: 'team-1',
        expiresAt: expiryFrom(new Date()),
        keys: [{ version: 1, key: toBase64(teamKeyRaw) }],
      },
      home
    )
  }
  return { home, calls }
}

/** What `veilio team unlock` leaves behind, for a scenario that started locked. */
export function unlockLike(home: string): void {
  const key = keysByHome.get(home)
  if (!key) throw new Error('no scenario for this home')
  writeTeamUnlock(
    {
      v: 1,
      instance: INSTANCE,
      account: ACCOUNT,
      teamId: 'team-1',
      expiresAt: expiryFrom(new Date()),
      keys: [{ version: 1, key: toBase64(key) }],
    },
    home
  )
}
