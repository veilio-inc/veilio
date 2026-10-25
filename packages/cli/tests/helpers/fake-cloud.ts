/**
 * A small, stateful Veilio Cloud, built to `specs/052-maps-everywhere/
 * contracts/api.md` (cloud repo) - the backend half is being built in
 * parallel, so the clients are tested against the contract rather than
 * against whatever the server happens to do today.
 *
 * It holds real ciphertext, so the crypto under test is the one users run:
 * personal maps sealed under the vault key or the personal-maps key, team maps
 * under a team key. It decides what the server decides - who may update or
 * remove a map, the rotation lock, the stale-version check, the size cap, the
 * project scope - and records every request, so a test can assert both what
 * was refused and that nothing was sent.
 *
 * Shared by the CLI's tests and the MCP server's (spec 052 SC-002: the same
 * fake server, the same outcome).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  deriveVaultKey,
  encryptMapForVault,
  encryptTeamMap,
  importTeamKey,
  toBase64,
  type CryptoKeyLike,
} from '@veilio-inc/engine'
import { writeCredential } from '../../src/credential.js'
import { writeTeamUnlock } from '../../src/team-unlock.js'
import {
  importPersonalMapsKey,
  wrapPersonalMapsKey,
  writePersonalMapsKey,
} from '../../src/client/personal-maps-key.js'

export const INSTANCE = 'https://veilio.test'
export const ME = 'me@example.test'
export const TEAMMATE = 'ada@example.test'
export const PASSPHRASE = 'correct horse battery staple'
export const SALT = new Uint8Array(32).fill(9)
/** Low on purpose: every test derives the key, and 600k iterations per test is
 *  minutes of CPU for no extra coverage. The client reads it from the vault. */
export const ITERATIONS = 1000
export const TEAM_RAW = new Uint8Array(32).fill(7)
export const PMK_RAW = new Uint8Array(32).fill(5)
export const TEAM_ID = 'team-1'

export interface FakeMap {
  id: string
  owner: string
  scope: 'personal' | 'team'
  name: string
  map_data: string
  identifier_count: number
  created_at: string
  updated_at: string
  project: string | null
}

export interface Recorded {
  method: string
  path: string
  query: URLSearchParams
  body: Record<string, unknown> | null
  raw: string
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

let clock = Date.parse('2026-10-20T10:00:00.000Z')
function tick(): string {
  clock += 1000
  return new Date(clock).toISOString()
}

export class FakeCloud {
  maps: FakeMap[] = []
  requests: Recorded[] = []
  /** The account's vault, or null for an account that never made one. */
  vault: { salt: string; verifier: string; kdf: { name: string; iterations: number } } | null = null
  pmkWrap: string | null = null
  teamId: string | null = TEAM_ID
  projects = [
    { id: 'p-billing', name: 'billing' },
    { id: 'p-tools', name: 'tools' },
  ]
  /** A member left holding the key: team writes answer 423 (PATCH) / 409 (POST). */
  rotationOwed = false
  maxBytes = 200_000
  /** Called after a map is read - a teammate's write can land here. */
  afterGet: ((map: FakeMap) => void) | null = null
  private nextId = 1

  /** Install the vault for PASSPHRASE. */
  async withVault(): Promise<CryptoKeyLike> {
    const key = await vaultKey()
    const iv = new Uint8Array(12).fill(3)
    const ct = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key as unknown as CryptoKey,
      new TextEncoder().encode('veilio-vault-verifier-v1')
    )
    this.vault = {
      salt: toBase64(SALT),
      verifier: JSON.stringify({ iv: toBase64(iv), data: toBase64(ct) }),
      kdf: { name: 'PBKDF2-SHA256', iterations: ITERATIONS },
    }
    return key
  }

  /** The PMK, wrapped under the vault key, as the server would hold it. */
  async withPmkWrap(): Promise<void> {
    this.pmkWrap = await wrapPersonalMapsKey(await vaultKey(), PMK_RAW)
  }

  add(map: Partial<FakeMap> & { map_data: string }): FakeMap {
    const at = tick()
    const row: FakeMap = {
      id: `map-${this.nextId++}`,
      owner: ME,
      scope: 'personal',
      name: 'billing',
      identifier_count: 1,
      created_at: at,
      updated_at: at,
      project: null,
      ...map,
    }
    this.maps.push(row)
    return row
  }

  find(id: string): FakeMap | undefined {
    return this.maps.find((m) => m.id === id)
  }

  writes(): Recorded[] {
    return this.requests.filter((r) => r.method !== 'GET')
  }

  /** Everything this run put on the wire, as text: URLs and bodies. */
  wire(): string {
    return this.requests.map((r) => `${r.method} ${r.path}?${r.query} ${r.raw}`).join('\n')
  }

  fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url))
    const method = (init?.method ?? 'GET').toUpperCase()
    const raw = typeof init?.body === 'string' ? init.body : ''
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
    this.requests.push({ method, path: u.pathname, query: u.searchParams, body, raw })
    return this.answer(method, u.pathname, u.searchParams, body)
  }

  private projectFilter(q: URLSearchParams): { id: string | null } | Response {
    const p = q.get('project')
    if (!p) return { id: null }
    if (!this.teamId || !this.projects.some((x) => x.id === p))
      return json(404, { error: 'Project not found' })
    return { id: p }
  }

  private listed(m: FakeMap) {
    return {
      id: m.id,
      name: m.name,
      scope: m.scope,
      identifier_count: m.identifier_count,
      created_at: m.created_at,
      updated_at: m.updated_at,
    }
  }

  private answer(
    method: string,
    path: string,
    q: URLSearchParams,
    body: Record<string, unknown> | null
  ): Response {
    if (path === '/api/maps' && method === 'GET') {
      const f = this.projectFilter(q)
      if (f instanceof Response) return f
      const inProject = (m: FakeMap) => m.scope === 'personal' || !f.id || m.project === f.id
      return json(200, {
        personalMaps: this.maps
          .filter((m) => m.owner === ME && inProject(m))
          .map((m) => this.listed(m)),
        teamMaps: this.teamId
          ? this.maps
              .filter((m) => m.scope === 'team' && m.owner !== ME && inProject(m))
              .map((m) => this.listed(m))
          : [],
        team: this.teamId ? { id: this.teamId } : null,
        plan: 'team',
      })
    }
    if (path === '/api/maps/team-envelopes') {
      const f = this.projectFilter(q)
      if (f instanceof Response) return f
      const rows = this.maps.filter(
        (m) => m.scope === 'team' && this.teamId && (!f.id || m.project === f.id)
      )
      return json(200, {
        maps: rows.map((m) => ({ id: m.id, created_at: m.created_at, map_data: m.map_data })),
        unreadable: [],
      })
    }
    if (path === '/api/maps' && method === 'POST') {
      const b = body ?? {}
      const scope = b.scope === 'team' ? 'team' : 'personal'
      if (scope === 'team' && this.rotationOwed) return json(409, { error: 'rotationRequired' })
      if (String(b.map_data ?? '').length > this.maxBytes) return json(413, { error: 'too large' })
      let project: string | null = null
      if (scope === 'team') {
        if (typeof b.project === 'string') {
          if (!this.projects.some((p) => p.id === b.project))
            return json(404, { error: 'Project not found' })
          project = b.project
        } else project = this.projects[0]!.id
      }
      const row = this.add({
        scope,
        name: String(b.name),
        map_data: String(b.map_data),
        identifier_count: Number(b.identifier_count ?? 0),
        project,
      })
      return json(201, { id: row.id })
    }
    const one = /^\/api\/maps\/([^/]+)$/.exec(path)
    if (one) {
      const map = this.find(decodeURIComponent(one[1]!))
      const reach = map && (map.scope === 'team' ? this.teamId !== null : map.owner === ME)
      if (!map || !reach) return json(404, { error: 'Map not found' })
      if (method === 'GET') {
        const answer = json(200, { ...this.listed(map), map_data: map.map_data })
        this.afterGet?.(map)
        return answer
      }
      if (method === 'PATCH') {
        const b = body ?? {}
        if (map.scope === 'team' && map.owner !== ME)
          return json(403, { error: 'Only the member who published this map can update it' })
        if (map.scope === 'team' && this.rotationOwed)
          return json(423, { error: 'rotationRequired' })
        if (String(b.map_data ?? '').length > this.maxBytes)
          return json(413, { error: 'too large' })
        if (b.if_updated_at !== map.updated_at)
          return json(409, { error: 'stale', current_updated_at: map.updated_at })
        map.map_data = String(b.map_data)
        map.identifier_count = Number(b.identifier_count)
        map.updated_at = tick()
        return json(200, { id: map.id, updated_at: map.updated_at })
      }
      if (method === 'DELETE') {
        if (map.scope === 'team' && map.owner !== ME)
          return json(403, { error: 'Only the member who published this map can remove it' })
        this.maps = this.maps.filter((m) => m !== map)
        return new Response(null, { status: 204 })
      }
    }
    if (path === '/api/auth/vault')
      return json(200, this.vault ? { initialized: true, ...this.vault } : { initialized: false })
    if (path === '/api/auth/keys/personal-maps') {
      if (method === 'GET') return json(200, { wrapped: this.pmkWrap })
      if (method === 'PUT') {
        if (this.pmkWrap !== null) return json(409, { error: 'already set' })
        this.pmkWrap = String(body?.wrapped)
        return json(201, { ok: true })
      }
    }
    if (path === '/api/auth/logout' && method === 'POST') return new Response(null, { status: 204 })
    if (path === '/api/projects') {
      if (!this.teamId) return json(200, { projects: [], teamId: null })
      return json(200, {
        projects: this.projects.map((p) => ({
          ...p,
          maps: this.maps.filter((m) => m.project === p.id).length,
        })),
        teamId: this.teamId,
        defaultProjectId: this.projects[0]?.id ?? null,
      })
    }
    if (path === `/api/teams/${TEAM_ID}/key/pending`) {
      return json(200, {
        version: 1,
        rotationNeededSince: this.rotationOwed ? '2026-10-19T00:00:00.000Z' : null,
        // Who could be asked. The clients must never repeat it.
        holders: [{ email: TEAMMATE }],
      })
    }
    return json(404, { error: 'not found' })
  }
}

export function vaultKey(): Promise<CryptoKeyLike> {
  return deriveVaultKey(PASSPHRASE, SALT, { name: 'PBKDF2-SHA256', iterations: ITERATIONS })
}

export async function sealPersonal(
  map: Record<string, string>,
  under: 'pmk' | 'vault'
): Promise<string> {
  const key = under === 'pmk' ? await importPersonalMapsKey(PMK_RAW) : await vaultKey()
  return JSON.stringify(await encryptMapForVault(key, map))
}

export async function sealTeam(map: Record<string, string>, raw = TEAM_RAW): Promise<string> {
  return JSON.stringify(await encryptTeamMap(await importTeamKey(toBase64(raw)), map))
}

/** Sign in under `home`, optionally with the team key and/or the PMK unlocked. */
export function signIn(
  home: string,
  opts: { team?: boolean; pmk?: boolean; project?: string } = {}
): void {
  mkdirSync(join(home, '.veilio'), { recursive: true })
  writeCredential(
    {
      token: 'tok',
      account: ME,
      instance: INSTANCE,
      ...(opts.project ? { project: opts.project } : {}),
    },
    home
  )
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
  if (opts.team)
    writeTeamUnlock(
      {
        v: 1,
        instance: INSTANCE,
        account: ME,
        teamId: TEAM_ID,
        expiresAt,
        keys: [{ version: 1, key: toBase64(TEAM_RAW) }],
      },
      home
    )
  if (opts.pmk)
    writePersonalMapsKey(
      { v: 1, instance: INSTANCE, account: ME, expiresAt, key: toBase64(PMK_RAW) },
      home
    )
}
