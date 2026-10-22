import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  encryptTeamMap,
  decryptTeamMap,
  importTeamKey,
  toBase64,
  type SymbolMap,
  type TeamMapEnvelope,
} from '@veilio-inc/engine'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_OK, type Io } from '../src/commands.js'
import { writeCredential } from '../src/credential.js'
import { writeTeamUnlock } from '../src/team-unlock.js'
import { STORE_DIR, STORE_FILE, loadMap, saveMap } from '../src/store.js'
import { conflictsWithTeam } from '../src/cloud-commands.js'

/**
 * Publishing a shared map from the terminal (spec 011 US1/US2/US3).
 *
 * Two properties carry most of these tests. First, every refusal happens
 * BEFORE anything is sent and leaves the local map byte-identical (FR-007) —
 * checked by comparing the store's bytes, not by trusting the exit code.
 * Second, the map is sealed AS NUMBERED: `maps push --team` never renumbers,
 * because the placeholders are already in the files the user masked, so a
 * renumber here would publish a map disagreeing with every one of them.
 */

let home: string
let cwd: string
let fetchMock: ReturnType<typeof vi.fn>

const INSTANCE = 'https://veilio.test'
const TEAM_RAW = new Uint8Array(32).fill(7)
/** A second, DIFFERENT key, so "which version was used" is observable rather
 *  than a distinction without a difference. */
const TEAM_RAW_OLD = new Uint8Array(32).fill(2)
const TEAM_ID = 'team-1'
const LOCAL: SymbolMap = { __CLS__1: 'PaymentProcessor', __FN__2: 'chargeCard' }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-tp-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-tp-work-'))
  mkdirSync(join(cwd, '.git'), { recursive: true })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  writeCredential({ token: 'tok', account: 'a@b.test', instance: INSTANCE }, home)
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const mapPath = (): string => join(cwd, STORE_DIR, STORE_FILE)
const storeBytes = (): string => readFileSync(mapPath(), 'utf8')

function unlocked(version = 1): void {
  writeTeamUnlock(
    {
      v: 1,
      instance: INSTANCE,
      account: 'a@b.test',
      teamId: TEAM_ID,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      keys: [{ version, key: toBase64(TEAM_RAW) }],
    },
    home
  )
}

/** Mid-rotation: two versions held, v1 old material and v2 the current one. */
function unlockedBoth(): void {
  writeTeamUnlock(
    {
      v: 1,
      instance: INSTANCE,
      account: 'a@b.test',
      teamId: TEAM_ID,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      keys: [
        { version: 1, key: toBase64(TEAM_RAW_OLD) },
        { version: 2, key: toBase64(TEAM_RAW) },
      ],
    },
    home
  )
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** The listing `resolveTeamNamespace` reads, with this account in a team. */
function listing(teamMaps: { id: string; created_at: string }[] = []): unknown {
  return {
    personalMaps: [],
    teamMaps: teamMaps.map((m) => ({
      ...m,
      name: 'team',
      scope: 'team',
      identifier_count: 1,
      updated_at: m.created_at,
    })),
    team: { id: TEAM_ID },
    plan: 'business',
  }
}

/** Wire up: the listing, then the team envelopes, then the create. */
function serve(opts: {
  teamNamespace?: SymbolMap
  create?: Response
  noTeam?: boolean
  listStatus?: number
}): void {
  fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/api/maps/team-envelopes')) {
      const entries = opts.teamNamespace
        ? [
            {
              id: 'm1',
              created_at: '2026-01-01T00:00:00Z',
              map_data: JSON.stringify(
                await encryptTeamMap(await importTeamKey(toBase64(TEAM_RAW)), opts.teamNamespace)
              ),
            },
          ]
        : []
      return json(200, { maps: entries, unreadable: [] })
    }
    if (u.endsWith('/api/maps') && (init?.method ?? 'GET') === 'GET') {
      if (opts.listStatus) return json(opts.listStatus, { error: 'nope' })
      if (opts.noTeam)
        return json(200, { personalMaps: [], teamMaps: [], team: null, plan: 'free' })
      return json(
        200,
        listing(opts.teamNamespace ? [{ id: 'm1', created_at: '2026-01-01T00:00:00Z' }] : [])
      )
    }
    if (u.endsWith('/api/maps') && init?.method === 'POST') {
      return opts.create ?? json(201, { id: 'new-map-id' })
    }
    return json(404, { error: `unexpected ${init?.method ?? 'GET'} ${u}` })
  })
}

interface Run {
  code: number
  out: string
  err: string
}

async function run(argv: string[]): Promise<Run> {
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    home,
    stdin: async () => '',
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => '',
    password: async () => '',
  }
  const code = await main(argv, io)
  return { code, out, err }
}

/** Every POST body this run produced. */
function posted(): string[] {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => String((init as RequestInit).body))
}

describe('conflictsWithTeam', () => {
  it('finds a placeholder both use for different identifiers', () => {
    expect(conflictsWithTeam({ __CLS__1: 'Mine' }, { __CLS__1: 'Theirs' })).toEqual([
      { placeholder: '__CLS__1', mine: 'Mine', theirs: 'Theirs' },
    ])
  })

  it('allows the same identifier under a different placeholder — that is an alias', () => {
    // Both still restore (spec 017). Refusing these would block a legitimate
    // publish for a name two members happened to add at the same time.
    expect(conflictsWithTeam({ __CLS__5: 'Shared' }, { __CLS__1: 'Shared' })).toEqual([])
  })

  it('allows a placeholder the team does not use at all', () => {
    expect(conflictsWithTeam({ __CLS__9: 'Fresh' }, { __CLS__1: 'Other' })).toEqual([])
  })

  it('agrees with itself on an identical map', () => {
    expect(conflictsWithTeam(LOCAL, LOCAL)).toEqual([])
  })

  it('is empty both ways round for empty input', () => {
    expect(conflictsWithTeam({}, { __CLS__1: 'A' })).toEqual([])
    expect(conflictsWithTeam({ __CLS__1: 'A' }, {})).toEqual([])
  })
})

describe('maps push --team', () => {
  // ── positive ──────────────────────────────────────────────────────────────

  it('seals the local map under the team key and declares its version', async () => {
    unlocked(3)
    saveMap(mapPath(), LOCAL, { force: true })
    serve({})

    const { code, out } = await run(['maps', 'push', 'shared', '--team'])

    expect(code).toBe(EXIT_OK)
    expect(out).toContain('new-map-id')
    const body = JSON.parse(posted()[0]!) as {
      scope: string
      key_version: number
      map_data: string
      identifier_count: number
      name: string
    }
    expect(body.scope).toBe('team')
    expect(body.key_version).toBe(3)
    expect(body.name).toBe('shared')
    expect(body.identifier_count).toBe(2)
    // The envelope opens with the team key, and holds exactly the local map.
    const opened = await decryptTeamMap(
      await importTeamKey(toBase64(TEAM_RAW)),
      JSON.parse(body.map_data) as TeamMapEnvelope
    )
    expect(opened).toEqual(LOCAL)
  })

  it('seals under the NEWEST held key, and declares that same version (T009)', async () => {
    // Mid-rotation a member holds two keys. Sealing under the older one while
    // declaring the newer - or the reverse - produces a map whose declared
    // version is a lie: the server's key lock checks the DECLARATION, so the
    // mismatch is accepted and only surfaces as a map somebody cannot open.
    //
    // Both halves are asserted here because only one of them is observable
    // from the request body alone, and a test that checked just the number
    // passed while the implementation picked the oldest key.
    unlockedBoth()
    saveMap(mapPath(), LOCAL, { force: true })
    serve({})

    const { code } = await run(['maps', 'push', '--team'])

    expect(code).toBe(EXIT_OK)
    const body = JSON.parse(posted()[0]!) as { key_version: number; map_data: string }
    expect(body.key_version).toBe(2)

    const envelope = JSON.parse(body.map_data) as TeamMapEnvelope
    // Opens with v2's material...
    await expect(
      decryptTeamMap(await importTeamKey(toBase64(TEAM_RAW)), envelope)
    ).resolves.toEqual(LOCAL)
    // ...and NOT with v1's, which is what "declared == sealed" actually means.
    await expect(
      decryptTeamMap(await importTeamKey(toBase64(TEAM_RAW_OLD)), envelope)
    ).rejects.toThrow()
  })

  it('sends map_data as a string, which is the only form the server stores', async () => {
    unlocked()
    saveMap(mapPath(), LOCAL, { force: true })
    serve({})

    await run(['maps', 'push', '--team'])

    const body = JSON.parse(posted()[0]!) as { map_data: unknown }
    expect(typeof body.map_data).toBe('string')
  })

  it('seals AS NUMBERED — it never renumbers what is already on disk', async () => {
    // The placeholders are already in the files the user masked. Renumbering
    // here would publish a map that disagrees with every one of them.
    unlocked()
    const odd: SymbolMap = { __CLS__41: 'PaymentProcessor', __FN__97: 'chargeCard' }
    saveMap(mapPath(), odd, { force: true })
    serve({})

    await run(['maps', 'push', '--team'])

    const body = JSON.parse(posted()[0]!) as { map_data: string }
    const opened = await decryptTeamMap(
      await importTeamKey(toBase64(TEAM_RAW)),
      JSON.parse(body.map_data) as TeamMapEnvelope
    )
    expect(Object.keys(opened).sort()).toEqual(['__CLS__41', '__FN__97'])
  })

  it('reserves nothing — reservation belongs to the anonymize path', async () => {
    unlocked()
    saveMap(mapPath(), LOCAL, { force: true })
    serve({})

    await run(['maps', 'push', '--team'])

    const reserved = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes('/placeholders/reserve')
    )
    expect(reserved).toHaveLength(0)
  })

  it('leaves the local store untouched on success — a team map is not this project’s copy', async () => {
    // Recording a remote id here would make the next `maps pull` treat the
    // team's map as this project's own.
    unlocked()
    saveMap(mapPath(), LOCAL, { force: true })
    serve({})
    const before = storeBytes()

    await run(['maps', 'push', '--team'])

    expect(storeBytes()).toBe(before)
    expect(loadMap(mapPath())).toEqual(LOCAL)
  })

  it('reports the shared set size and whether anything is disputed (FR-008)', async () => {
    unlocked()
    saveMap(mapPath(), { __CLS__9: 'Fresh' }, { force: true })
    serve({ teamNamespace: { __CLS__1: 'Existing' } })

    const { out } = await run(['maps', 'push', '--team'])

    expect(out).toMatch(/shared set now holds/)
    expect(out).toContain('none disputed')
  })

  it('does not report a team map as a personal push', async () => {
    unlocked()
    saveMap(mapPath(), LOCAL, { force: true })
    serve({})

    const { out } = await run(['maps', 'push', '--team'])

    expect(out).toContain('to the team')
    expect(out).not.toMatch(/to Cloud as/)
  })

  // ── the conflict pre-flight ───────────────────────────────────────────────

  it('refuses when a placeholder already means something else to the team', async () => {
    unlocked()
    saveMap(mapPath(), { __CLS__1: 'MyProcessor' }, { force: true })
    serve({ teamNamespace: { __CLS__1: 'TheirProcessor' } })
    const before = storeBytes()

    const { code, err } = await run(['maps', 'push', '--team'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toContain('__CLS__1')
    expect(err).toContain('MyProcessor')
    expect(err).toContain('TheirProcessor')
    expect(err).toMatch(/unrestorable for every member/)
    expect(posted()).toHaveLength(0)
    expect(storeBytes()).toBe(before)
  })

  it('names the remedy, which is to re-scrub rather than to retry', async () => {
    unlocked()
    saveMap(mapPath(), { __CLS__1: 'Mine' }, { force: true })
    serve({ teamNamespace: { __CLS__1: 'Theirs' } })

    const { err } = await run(['maps', 'push', '--team'])

    expect(err).toContain('veilio scrub')
    expect(err).not.toMatch(/try again|retry/i)
  })

  it('publishes when the overlap agrees — an identical entry is not a conflict', async () => {
    unlocked()
    saveMap(mapPath(), { __CLS__1: 'Same', __FN__5: 'mine' }, { force: true })
    serve({ teamNamespace: { __CLS__1: 'Same' } })

    const { code } = await run(['maps', 'push', '--team'])

    expect(code).toBe(EXIT_OK)
    expect(posted()).toHaveLength(1)
  })

  // ── negative: refusals that send nothing (FR-004, FR-007) ─────────────────

  it('refuses with nothing sent when no team key is unlocked', async () => {
    saveMap(mapPath(), LOCAL, { force: true })
    serve({})
    const before = storeBytes()

    const { code, err } = await run(['maps', 'push', '--team'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toContain('team unlock')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(storeBytes()).toBe(before)
  })

  it('refuses when the account is not in a team', async () => {
    unlocked()
    saveMap(mapPath(), LOCAL, { force: true })
    serve({ noTeam: true })

    const { code, err } = await run(['maps', 'push', '--team'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toMatch(/not in a team/)
    expect(posted()).toHaveLength(0)
  })

  it('refuses when the local map is empty', async () => {
    unlocked()
    saveMap(mapPath(), {}, { force: true })
    serve({})

    const { code, err } = await run(['maps', 'push', '--team'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toMatch(/no local map/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses when the team’s maps cannot be read, rather than publishing blind', async () => {
    // Falling back to "no namespace" here would skip the conflict check, which
    // is the one thing standing between one push and a team-wide dispute.
    unlocked()
    saveMap(mapPath(), LOCAL, { force: true })
    serve({ listStatus: 500 })

    const { code, err } = await run(['maps', 'push', '--team'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toMatch(/could not read the team's maps/)
    expect(posted()).toHaveLength(0)
  })

  it('refuses when not signed in', async () => {
    rmSync(join(home, '.veilio'), { recursive: true, force: true })
    saveMap(mapPath(), LOCAL, { force: true })

    const { code, err } = await run(['maps', 'push', '--team'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toMatch(/not signed in/)
  })

  // ── negative: what the server refuses (US3) ───────────────────────────────

  it('explains a 409 as a rotation someone else has to do', async () => {
    unlocked()
    saveMap(mapPath(), LOCAL, { force: true })
    serve({
      create: json(409, {
        error: 'A team key change is required.',
        rotationRequired: true,
        rotateBy: 'any team member who holds the current key',
      }),
    })
    const before = storeBytes()

    const { code, err } = await run(['maps', 'push', '--team'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toMatch(/teammate left/)
    expect(err).toMatch(/holds the current key/)
    expect(err).not.toMatch(/HTTP 409|server error/i)
    expect(storeBytes()).toBe(before)
  })

  it('explains a 413 as too large, with nothing stored', async () => {
    unlocked()
    saveMap(mapPath(), LOCAL, { force: true })
    serve({ create: json(413, { error: 'Map envelope too large.' }) })

    const { code, err } = await run(['maps', 'push', '--team'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toMatch(/too large/)
    expect(err).toMatch(/nothing was stored/i)
  })

  it('says the map ceiling is the same on every paid plan, so upgrading will not help', async () => {
    unlocked()
    saveMap(mapPath(), LOCAL, { force: true })
    serve({
      create: json(403, {
        error: 'Map limit reached (200 active maps).',
        upgrade: false,
      }),
    })

    const { code, err } = await run(['maps', 'push', '--team'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toMatch(/same on every paid plan/)
    expect(err).not.toMatch(/upgrade to|choose a bigger plan/i)
  })
})

describe('maps rm', () => {
  it('removes a map and says so', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

    const { code, out } = await run(['maps', 'rm', 'abc'])

    expect(code).toBe(EXIT_OK)
    expect(out).toContain('abc')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain('/api/maps/abc')
    expect((init as RequestInit).method).toBe('DELETE')
  })

  it('reports a 403 as somebody else’s map', async () => {
    fetchMock.mockResolvedValue(json(403, { error: 'Not yours' }))

    const { code, err } = await run(['maps', 'rm', 'abc'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toMatch(/belongs to someone else/)
  })

  it('reports a 404 as no such map', async () => {
    fetchMock.mockResolvedValue(json(404, { error: 'Not found' }))

    const { code, err } = await run(['maps', 'rm', 'abc'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toMatch(/no map abc/)
  })

  it('asks which map when given no id', async () => {
    const { code, err } = await run(['maps', 'rm'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toMatch(/which map/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('leaves the local store alone whatever the server says', async () => {
    saveMap(mapPath(), LOCAL, { force: true })
    const before = storeBytes()
    fetchMock.mockResolvedValue(json(403, { error: 'Not yours' }))

    await run(['maps', 'rm', 'abc'])

    expect(storeBytes()).toBe(before)
  })

  it('refuses when not signed in', async () => {
    rmSync(join(home, '.veilio'), { recursive: true, force: true })

    const { code, err } = await run(['maps', 'rm', 'abc'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toMatch(/not signed in/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still removes a map while the team owes a key change (T022)', async () => {
    // The key write-lock exists to stop NEW content being written under a key
    // a departed member knows. Removing a map stores nothing under any key, so
    // it is not refused — the server applies the lock to the create and
    // re-encrypt routes only. Asserted here because the natural over-reach is
    // to block every team write while a rotation is owed, which would leave a
    // team unable to clean up precisely when it most wants to.
    unlocked()
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

    const { code, err } = await run(['maps', 'rm', 'abc'])

    expect(code).toBe(EXIT_OK)
    expect(err).not.toMatch(/rotation|key change/i)
  })
})
