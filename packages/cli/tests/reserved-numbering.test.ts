import { describe, it, expect, vi } from 'vitest'
import {
  reservedAnonymizeOverTeam,
  anonymizeOverTeam,
  highestPerBase,
  highestInText,
  ReservationFailed,
  ReservationMismatch,
  type Reserve,
} from '../src/team-anonymize.js'
import { reservePlaceholders, CloudError } from '../src/cloud.js'
import type { Credential } from '../src/credential.js'

/**
 * Numbers for a map that will be PUBLISHED come out of the team's shared
 * allocation, not from a locally-computed floor (spec 011 FR-003).
 *
 * The failure this guards is not hypothetical and not loud: on staging two
 * members each minted `__FN__6` from the same floor, both maps looked correct,
 * and one member's restore named the other member's function. Nothing errored.
 * So the assertions below are mostly about numbers NOBODY reserved never
 * reaching a map — the only point at which that collision is still catchable.
 */

const SRC = 'class PaymentProcessor { chargeCard() { return 1 } }'
const OPTS = { language: 'typescript' as const, secrets: 'off' as const }
const CRED: Credential = {
  instance: 'https://veilio.test',
  account: 'a@b.test',
  token: 'tok',
} as unknown as Credential

const noTeam = { namespace: {}, highest: {} }

/** A reserve that hands out exactly what was asked for, starting above floor. */
function granting(starts: Record<string, number>): { reserve: Reserve; seen: () => unknown } {
  const calls: unknown[] = []
  const reserve: Reserve = async (requests) => {
    calls.push(requests)
    return requests.map(({ base, count, floor }) => {
      const start = Math.max(starts[base] ?? 0, floor) + 1
      return { base, start, end: start + count - 1 }
    })
  }
  return { reserve, seen: () => calls }
}

describe('reservePlaceholders (the client call)', () => {
  it('sends base, count and floor per base, as a POST to the team', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ranges: [{ base: '__CLS__', start: 4, end: 5 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const out = await reservePlaceholders(CRED, 'team-1', [{ base: '__CLS__', count: 2, floor: 3 }])

    expect(out.ranges).toEqual([{ base: '__CLS__', start: 4, end: 5 }])
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain('/api/teams/team-1/placeholders/reserve')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      requests: [{ base: '__CLS__', count: 2, floor: 3 }],
    })
    vi.unstubAllGlobals()
  })

  it('never sends an identifier — only bases, counts and floors', async () => {
    // The server cannot read a team's maps and does not need to in order to
    // count. Anything else in this body would be a leak by a different name.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ranges: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await reservePlaceholders(CRED, 't', [{ base: '__FN__', count: 1, floor: 0 }])

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      requests: Record<string, unknown>[]
    }
    for (const r of body.requests) {
      expect(Object.keys(r).sort()).toEqual(['base', 'count', 'floor'])
    }
    expect(JSON.stringify(body)).not.toContain('PaymentProcessor')
    vi.unstubAllGlobals()
  })

  it.each([
    ['not-a-base', 'lowercase and unbracketed'],
    ['__cls__', 'lowercase'],
    ['__1BAD__', 'leading digit'],
    ['CLS__', 'no leading underscores'],
    ['', 'empty'],
  ])('refuses %s as a base before any request (%s)', async (base) => {
    // A malformed base would create a counter row no placeholder can ever
    // match, and the numbers reserved against it would be silently unusable.
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(reservePlaceholders(CRED, 't', [{ base, count: 1, floor: 0 }])).rejects.toThrow(
      CloudError
    )
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it.each([0, -1, 1.5, NaN])('refuses a count of %s before any request', async (count) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      reservePlaceholders(CRED, 't', [{ base: '__CLS__', count, floor: 0 }])
    ).rejects.toThrow(CloudError)
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('highestPerBase / highestInText', () => {
  it('reads the highest number per base out of a map', () => {
    expect(highestPerBase({ __CLS__1: 'A', __CLS__7: 'B', __FN__3: 'c' })).toEqual({
      __CLS__: 7,
      __FN__: 3,
    })
  })

  it('reads placeholders already present in the text', () => {
    // The engine numbers above these too. A floor that ignored them would
    // reserve a run the engine then numbers straight past.
    expect(highestInText('class __CLS__9 { __FN__2() {} }')).toEqual({ __CLS__: 9, __FN__: 2 })
  })

  it('does not mistake a longer number for a shorter one', () => {
    expect(highestInText('__CLS__10')).toEqual({ __CLS__: 10 })
    expect(highestPerBase({ __CLS__10: 'A' })).toEqual({ __CLS__: 10 })
  })

  it('ignores a placeholder glued to other identifier characters', () => {
    expect(highestInText('x__CLS__9 __CLS__8y')).toEqual({})
  })

  it('is empty for text and maps with no placeholders', () => {
    expect(highestInText('class Foo {}')).toEqual({})
    expect(highestPerBase({})).toEqual({})
  })
})

describe('reservedAnonymizeOverTeam', () => {
  it('mints every new placeholder inside the reserved run', async () => {
    const { reserve } = granting({ __CLS__: 5, __FN__: 9 })

    const { result } = await reservedAnonymizeOverTeam(SRC, {}, noTeam, OPTS, reserve)

    expect(result.map).toEqual({ __CLS__6: 'PaymentProcessor', __FN__10: 'chargeCard' })
    expect(result.anonymized).toContain('__CLS__6')
    expect(result.anonymized).not.toContain('__CLS__1')
  })

  it('declares a floor that is the highest of team, map and text', async () => {
    const { reserve, seen } = granting({})
    const local = { __CLS__4: 'Unrelated' }
    const team = { namespace: {}, highest: { __CLS__: 2 } }
    const source = `${SRC}\n// already masked: __CLS__11`

    await reservedAnonymizeOverTeam(source, local, team, OPTS, reserve)

    const requests = (seen() as { base: string; floor: number }[][])[0]!
    const cls = requests.find((r) => r.base === '__CLS__')!
    // team says 2, the local map says 4, the text says 11 — 11 wins.
    expect(cls.floor).toBe(11)
  })

  it('does not reserve anything when the text needs no new names', async () => {
    // Reserving zero would consume a request and come back with an empty run
    // the verification then rejects. More importantly it would burn the team's
    // allocation on a no-op.
    const reserve = vi.fn<Reserve>()
    const team = {
      namespace: { __CLS__3: 'PaymentProcessor', __FN__4: 'chargeCard' },
      highest: { __CLS__: 3, __FN__: 4 },
    }

    const { result } = await reservedAnonymizeOverTeam(SRC, {}, team, OPTS, reserve)

    expect(reserve).not.toHaveBeenCalled()
    expect(result.anonymized).toContain('__CLS__3')
    expect(result.anonymized).toContain('__FN__4')
  })

  it('reuses the team placeholder for a name the team knows, and reserves only the rest', async () => {
    const { reserve, seen } = granting({ __FN__: 20 })
    const team = { namespace: { __CLS__3: 'PaymentProcessor' }, highest: { __CLS__: 3 } }

    const { result } = await reservedAnonymizeOverTeam(SRC, {}, team, OPTS, reserve)

    expect(result.map.__CLS__3).toBe('PaymentProcessor')
    expect(result.map.__FN__21).toBe('chargeCard')
    const requests = (seen() as { base: string }[][])[0]!
    expect(requests.map((r) => r.base)).toEqual(['__FN__'])
  })

  it('reserves each base independently', async () => {
    const { reserve, seen } = granting({ __CLS__: 100, __FN__: 0 })

    const { result } = await reservedAnonymizeOverTeam(SRC, {}, noTeam, OPTS, reserve)

    expect(result.map).toEqual({ __CLS__101: 'PaymentProcessor', __FN__1: 'chargeCard' })
    const requests = (seen() as { base: string; count: number }[][])[0]!
    expect(requests.every((r) => r.count === 1)).toBe(true)
  })

  it('never emits a placeholder the team disputes', async () => {
    // A disputed placeholder means different things in two of the team's maps.
    // Emitting it would pick one meaning for every teammate; restore refuses it
    // precisely because it cannot be guessed (spec 028).
    const { reserve } = granting({ __CLS__: 0 })
    const team = {
      namespace: { __CLS__1: 'PaymentProcessor' },
      highest: { __CLS__: 1 },
      conflicts: { __CLS__1: 2 },
    }

    const { result } = await reservedAnonymizeOverTeam(SRC, {}, team, OPTS, reserve)

    expect(result.map.__CLS__1).toBeUndefined()
    expect(Object.values(result.map)).toContain('PaymentProcessor')
  })

  // ── negative ──────────────────────────────────────────────────────────────

  it('fails as ReservationFailed when the reservation does not happen', async () => {
    const reserve: Reserve = () => Promise.reject(new CloudError('unreachable', 'no network'))

    await expect(reservedAnonymizeOverTeam(SRC, {}, noTeam, OPTS, reserve)).rejects.toThrow(
      ReservationFailed
    )
  })

  it('carries the cause, so the caller can word the refusal', async () => {
    const cause = new CloudError('unentitled', "this team's plan is not active", 402)
    const reserve: Reserve = () => Promise.reject(cause)

    await expect(reservedAnonymizeOverTeam(SRC, {}, noTeam, OPTS, reserve)).rejects.toMatchObject({
      name: 'ReservationFailed',
      cause,
    })
  })

  it('refuses when a requested base came back with no run', async () => {
    const reserve: Reserve = async (requests) =>
      requests.filter((r) => r.base !== '__FN__').map((r) => ({ base: r.base, start: 1, end: 1 }))

    await expect(reservedAnonymizeOverTeam(SRC, {}, noTeam, OPTS, reserve)).rejects.toThrow(
      ReservationMismatch
    )
  })

  it('refuses when the run is too small for the names minted', async () => {
    // The engine numbers past the end of a short run. Returning that output
    // would publish numbers nobody reserved — which is the collision this path
    // exists to prevent, arriving by a different door.
    const source = 'class AlphaService {}\nclass BetaService {}\nclass GammaService {}'
    const reserve: Reserve = async (requests) =>
      requests.map((r) => ({ base: r.base, start: r.floor + 1, end: r.floor + 1 }))

    await expect(reservedAnonymizeOverTeam(source, {}, noTeam, OPTS, reserve)).rejects.toThrow(
      ReservationMismatch
    )
  })

  it('refuses a run that starts below the floor it was given', async () => {
    // A server that ignored the floor would hand back numbers the local map is
    // already using, and the second pass would collide with its own store.
    const local = { __CLS__9: 'Existing' }
    const reserve: Reserve = async (requests) =>
      requests.map((r) => ({ base: r.base, start: 2, end: 2 }))

    await expect(reservedAnonymizeOverTeam(SRC, local, noTeam, OPTS, reserve)).rejects.toThrow(
      ReservationMismatch
    )
  })

  // ── the local path must be untouched ──────────────────────────────────────

  it('leaves anonymizeOverTeam numbering from the local floor, with no reservation', () => {
    // The MCP server shares that function and never publishes (FR-009), so it
    // must never reach the network. If this ever needs a `reserve` argument,
    // reservation has leaked into the agent path.
    const { result } = anonymizeOverTeam(SRC, {}, { namespace: {}, highest: { __CLS__: 4 } }, OPTS)

    expect(result.map.__CLS__5).toBe('PaymentProcessor')
  })
})
