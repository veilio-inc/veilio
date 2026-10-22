import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { encryptTeamMap, importTeamKey, toBase64, type SymbolMap } from '@veilio-inc/engine'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_OK, type Io } from '../src/commands.js'
import { writeCredential } from '../src/credential.js'
import { writeTeamUnlock } from '../src/team-unlock.js'
import { STORE_DIR, STORE_FILE } from '../src/store.js'

/**
 * `veilio scrub --team`: new placeholder numbers out of the team's shared
 * allocation (spec 011 FR-003).
 *
 * Opt-in, and the reason is a second spec rather than caution. Spec 030 FR-005
 * requires `scrub` and the MCP server's `anonymize_text` to give the SAME
 * placeholders for the same code and the same team, and the MCP must never
 * reserve (FR-009). Reserving by default would split the two surfaces for
 * every user in order to help the few about to publish — so the person about
 * to publish says so. The parity assertion is in
 * `packages/mcp/tests/scrub-parity.test.ts`; the default-path half of it is
 * asserted here too, because that is the property this flag must not break.
 */

let home: string
let cwd: string
let fetchMock: ReturnType<typeof vi.fn>

const INSTANCE = 'https://veilio.test'
const TEAM_RAW = new Uint8Array(32).fill(7)
const TEAM_ID = 'team-1'
const SRC = 'export class PaymentProcessor { chargeCard() {} }\n'

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-sr-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-sr-work-'))
  mkdirSync(join(cwd, '.git'), { recursive: true })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  writeCredential({ token: 'tok', account: 'a@b.test', instance: INSTANCE }, home)
  writeTeamUnlock(
    {
      v: 1,
      instance: INSTANCE,
      account: 'a@b.test',
      teamId: TEAM_ID,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      keys: [{ version: 1, key: toBase64(TEAM_RAW) }],
    },
    home
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const mapPath = (): string => join(cwd, STORE_DIR, STORE_FILE)

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Serve the listing, the team envelopes, and the reservation. */
function serve(opts: { teamMap?: SymbolMap; reserve?: Response | 'count' } = {}): void {
  fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/placeholders/reserve')) {
      if (opts.reserve && opts.reserve !== 'count') return opts.reserve
      const body = JSON.parse(String(init?.body)) as {
        requests: { base: string; count: number; floor: number }[]
      }
      return json(200, {
        ranges: body.requests.map(({ base, count, floor }) => ({
          // Deliberately far above the floor, so a number that did NOT come
          // from here is unmistakable in the output.
          base,
          start: floor + 500,
          end: floor + 500 + count - 1,
        })),
      })
    }
    if (u.endsWith('/api/maps/team-envelopes')) {
      const maps = opts.teamMap
        ? [
            {
              id: 'm1',
              created_at: '2026-01-01T00:00:00Z',
              map_data: JSON.stringify(
                await encryptTeamMap(await importTeamKey(toBase64(TEAM_RAW)), opts.teamMap)
              ),
            },
          ]
        : []
      return json(200, { maps, unreadable: [] })
    }
    if (u.endsWith('/api/maps')) {
      return json(200, {
        personalMaps: [],
        teamMaps: opts.teamMap
          ? [
              {
                id: 'm1',
                name: 't',
                scope: 'team',
                identifier_count: 1,
                created_at: '2026-01-01T00:00:00Z',
                updated_at: '2026-01-01T00:00:00Z',
              },
            ]
          : [],
        team: { id: TEAM_ID },
        plan: 'business',
      })
    }
    return json(404, { error: `unexpected ${u}` })
  })
}

async function run(
  argv: string[],
  stdin = SRC
): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    home,
    stdin: async () => stdin,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => '',
    password: async () => '',
  }
  const code = await main(argv, io)
  return { code, out, err }
}

const reserveCalls = (): number =>
  fetchMock.mock.calls.filter(([u]) => String(u).includes('/placeholders/reserve')).length

describe('scrub --team', () => {
  it('numbers new placeholders from the reserved run', async () => {
    serve()

    const { code, out } = await run(['scrub', '--team'])

    expect(code).toBe(EXIT_OK)
    // The run starts 500 above the floor, so the FIRST new placeholder is
    // exactly `start` — which is what `floors[base] = start - 1` buys, and a
    // number this far from the local floor can only have come from the server.
    expect(out).toContain('__CLS__500')
    expect(out).toContain('__FN__500')
    expect(out).not.toMatch(/__CLS__1\b/)
    expect(reserveCalls()).toBe(1)
  })

  it('asks for one count per base, and sends no identifier', async () => {
    serve()

    await run(['scrub', '--team'])

    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('reserve'))!
    const body = JSON.parse(String((call[1] as RequestInit).body)) as {
      requests: Record<string, unknown>[]
    }
    for (const r of body.requests) expect(Object.keys(r).sort()).toEqual(['base', 'count', 'floor'])
    expect(JSON.stringify(body)).not.toContain('PaymentProcessor')
    expect(JSON.stringify(body)).not.toContain('chargeCard')
  })

  it('raises the floor above what the team already holds', async () => {
    serve({ teamMap: { __CLS__40: 'SomethingElse' } })

    await run(['scrub', '--team'])

    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('reserve'))!
    const body = JSON.parse(String((call[1] as RequestInit).body)) as {
      requests: { base: string; floor: number }[]
    }
    expect(body.requests.find((r) => r.base === '__CLS__')!.floor).toBe(40)
  })

  it('reuses the team placeholder for a name the team already knows', async () => {
    serve({ teamMap: { __CLS__7: 'PaymentProcessor' } })

    const { out } = await run(['scrub', '--team'])

    expect(out).toContain('__CLS__7')
  })

  // ── the property this flag must not break ─────────────────────────────────

  it('reserves nothing without the flag — that is spec 030 FR-005', async () => {
    // `scrub` and the MCP server's anonymize_text must agree, and the MCP
    // never reserves. If this ever calls the endpoint, the two surfaces have
    // been split apart for every user.
    serve()

    const { code, out } = await run(['scrub'])

    expect(code).toBe(EXIT_OK)
    expect(reserveCalls()).toBe(0)
    expect(out).toContain('__CLS__1')
  })

  // ── negative ──────────────────────────────────────────────────────────────

  it('writes nothing and masks nothing when the reservation is refused', async () => {
    // Numbering locally instead would hand back placeholders that look right
    // and collide with a teammate's. The local map must survive untouched.
    serve({ reserve: json(402, { error: "This team's plan is not active", paywall: true }) })

    const { code, out, err } = await run(['scrub', '--team'])

    expect(code).toBe(EXIT_ERROR)
    expect(out).toBe('')
    expect(err).toMatch(/could not reserve placeholder numbers/)
    expect(existsSync(mapPath())).toBe(false)
  })

  it('does not offer retrying without reservation', async () => {
    serve({ reserve: json(500, { error: 'boom' }) })

    const { err } = await run(['scrub', '--team'])

    expect(err).toMatch(/clash with a teammate/)
    expect(err).not.toMatch(/--no-team|without --team|try again/i)
  })

  it('leaves an existing local map byte-identical when the reservation fails', async () => {
    serve()
    await run(['scrub', '--team'])
    const before = readFileSync(mapPath(), 'utf8')
    fetchMock.mockClear()
    serve({ reserve: json(500, { error: 'boom' }) })

    const { code } = await run(['scrub', '--team'], 'export class LaterService {}\n')

    expect(code).toBe(EXIT_ERROR)
    expect(readFileSync(mapPath(), 'utf8')).toBe(before)
  })

  it('refuses when the run is too small for the names minted', async () => {
    // A server that handed back fewer numbers than asked would otherwise let
    // the engine number past the end — placeholders nobody reserved.
    serve({ reserve: json(200, { ranges: [{ base: '__CLS__', start: 1, end: 1 }] }) })

    const { code, err } = await run(['scrub', '--team'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toMatch(/could not reserve|outside the numbers reserved/)
  })

  it('falls back to a local floor with a note when not in a team', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/api/maps'))
        return json(200, { personalMaps: [], teamMaps: [], team: null, plan: 'free' })
      return json(404, { error: 'no' })
    })

    const { code, out } = await run(['scrub', '--team'])

    expect(code).toBe(EXIT_OK)
    expect(out).toContain('__CLS__1')
    expect(reserveCalls()).toBe(0)
  })
})
