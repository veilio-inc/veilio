import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getUserKeys, getTeamKeyWraps, listMaps } from '../src/cloud.js'
import type { Credential } from '../src/credential.js'

/**
 * The two endpoints the MCP server needs to build a team namespace locally
 * (spec 010), plus the listing fields the merge orders by.
 *
 * Nothing here decrypts anything — that is the engine's job and is tested
 * there. What these assert is the part that is this client's responsibility:
 * the right path, the credential attached, and a shape the caller can rely on.
 */

const CRED: Credential = {
  token: 'tok',
  account: 'a@example.test',
  instance: 'https://veilio.test',
}

let fetchMock: ReturnType<typeof vi.fn>

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function lastRequest(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1)
  return { url: call?.[0] as string, init: (call?.[1] ?? {}) as RequestInit }
}

describe('getUserKeys', () => {
  it('asks the account keys endpoint with the credential', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ initialized: false }))

    await getUserKeys(CRED)

    const { url, init } = lastRequest()
    expect(url).toBe('https://veilio.test/api/auth/keys')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok')
  })

  it('reports an account that has never opened the web app', async () => {
    // No keypair means no teammate could ever have wrapped a key to it. An
    // ordinary state, not a failure.
    fetchMock.mockResolvedValue(jsonResponse({ initialized: false }))

    await expect(getUserKeys(CRED)).resolves.toEqual({ initialized: false })
  })

  it('returns the wrapped private half, which the server cannot open', async () => {
    const body = {
      initialized: true,
      publicKey: 'cHVi',
      privateKeyEncrypted: '{"v":1,"alg":"AES-GCM","iv":"aXY=","data":"ZGF0YQ=="}',
      alg: 'X25519',
    }
    fetchMock.mockResolvedValue(jsonResponse(body))

    await expect(getUserKeys(CRED)).resolves.toEqual(body)
  })
})

describe('getTeamKeyWraps', () => {
  it('asks for one team by id, encoded', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ wraps: [], granted: false }))

    await getTeamKeyWraps(CRED, 'team/../other')

    expect(lastRequest().url).toBe('https://veilio.test/api/teams/team%2F..%2Fother/key')
  })

  it('reports a member still waiting on a grant', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ wraps: [], granted: false }))

    await expect(getTeamKeyWraps(CRED, 't1')).resolves.toEqual({ wraps: [], granted: false })
  })

  it('returns every held version, so a mid-rotation team can open both', async () => {
    const wraps = [
      { version: 1, wrapped_key: '{}', wrapped_by: 'u1', created_at: '2026-01-01' },
      { version: 2, wrapped_key: '{}', wrapped_by: 'u2', created_at: '2026-02-01' },
    ]
    fetchMock.mockResolvedValue(jsonResponse({ wraps, granted: true }))

    await expect(getTeamKeyWraps(CRED, 't1')).resolves.toEqual({ wraps, granted: true })
  })

  it('surfaces a refusal rather than pretending the team has no key', async () => {
    // A non-member is refused outright, and that is the subscription gate doing
    // its job. Swallowing it would look identical to "no key granted yet".
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Forbidden' }, 403))

    await expect(getTeamKeyWraps(CRED, 't1')).rejects.toThrow()
  })
})

describe('the map listing the merge depends on', () => {
  it('carries created_at and the active team', async () => {
    // created_at is the ordering key for first-write-wins; team.id is what the
    // key request above is addressed to. Both were added for spec 010 and a
    // listing without them cannot produce a namespace.
    fetchMock.mockResolvedValue(
      jsonResponse({
        personalMaps: [
          {
            id: 'm1',
            name: 'm1',
            scope: 'team',
            identifier_count: 1,
            created_at: '2026-01-01',
            updated_at: '2026-03-01',
          },
        ],
        teamMaps: [],
        team: { id: 'team-1' },
        plan: 'team',
      })
    )

    const list = await listMaps(CRED)

    expect(list.team?.id).toBe('team-1')
    expect(list.personalMaps[0].created_at).toBe('2026-01-01')
    // Ordering is by creation, not by last edit — an edit must not let a newer
    // map steal a placeholder an older one already claimed.
    expect(list.personalMaps[0].updated_at).not.toBe(list.personalMaps[0].created_at)
  })

  it('tolerates a Cloud that sends no teamNamespace, which is every current one', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ personalMaps: [], teamMaps: [], team: null, plan: 'free' })
    )

    const list = await listMaps(CRED)

    expect(list.teamNamespace).toBeUndefined()
    expect(list.team).toBeNull()
  })
})
