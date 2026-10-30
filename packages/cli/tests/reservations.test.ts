import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ALIASES_FILE,
  RESERVED_FILE,
  ReservedFileError,
  addAliases,
  basesNeedingBlocks,
  loadAliases,
  loadReserved,
  saveReserved,
} from '../src/reservations.js'
import { readReservations, reservePlaceholders } from '../src/cloud.js'

// Spec 063: a member's block of the team's numbers, kept beside the map so the
// guard (offline) can number inside it, and the old placeholders a publish
// renumbered, so the member's own restore still reads text masked before.

let dir: string
let mapPath: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'veilio-res-'))
  mkdirSync(join(dir, '.veilio'))
  mapPath = join(dir, '.veilio', 'map.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const reserved = {
  version: 1 as const,
  instance: 'https://veilio.test',
  account: 'a@b.test',
  teamId: 'team-1',
  blocks: { __FN__: { start: 501, end: 1000 } },
}

describe('reserved.json', () => {
  it('round-trips, beside the map, readable by its owner only', () => {
    saveReserved(mapPath, reserved)
    expect(loadReserved(mapPath)).toEqual(reserved)
    expect(statSync(join(dir, '.veilio', RESERVED_FILE)).mode & 0o777).toBe(0o600)
  })

  it('is absent until a block is reserved', () => {
    expect(loadReserved(mapPath)).toBeNull()
  })

  it.each([
    ['not JSON', '{'],
    ['another version', JSON.stringify({ ...reserved, version: 2 })],
    [
      'a block that ends before it starts',
      JSON.stringify({ ...reserved, blocks: { __FN__: { start: 9, end: 3 } } }),
    ],
    [
      'a base that is no placeholder kind',
      JSON.stringify({ ...reserved, blocks: { fn: { start: 1, end: 3 } } }),
    ],
    [
      'numbers that are not whole',
      JSON.stringify({ ...reserved, blocks: { __FN__: { start: 1.5, end: 3 } } }),
    ],
  ])('refuses a file holding %s, rather than numbering from it', (_why, text) => {
    writeFileSync(join(dir, '.veilio', RESERVED_FILE), text)
    expect(() => loadReserved(mapPath)).toThrow(ReservedFileError)
  })
})

describe('when a member needs a new block', () => {
  it('a kind with no block needs one', () => {
    expect(basesNeedingBlocks({}, {}, ['__FN__'])).toEqual(['__FN__'])
  })

  it('a block above everything in the map is kept', () => {
    const map = { __FN__12: 'a', __FN__600: 'b' } // 600 is the member's own, inside the block
    expect(basesNeedingBlocks(map, reserved.blocks, ['__FN__'])).toEqual([])
  })

  it('a teammate’s number above the block makes it unusable: the engine numbers above the highest', () => {
    const map = { __FN__1200: 'pulled from a teammate' }
    expect(basesNeedingBlocks(map, reserved.blocks, ['__FN__'])).toEqual(['__FN__'])
  })

  it('a block used to its last number needs a new one', () => {
    expect(basesNeedingBlocks({ __FN__1000: 'last' }, reserved.blocks, ['__FN__'])).toEqual([
      '__FN__',
    ])
  })

  it('kinds in the map count too, besides the ones asked for', () => {
    expect(basesNeedingBlocks({ __CLS__4: 'x' }, reserved.blocks, ['__FN__']).sort()).toEqual([
      '__CLS__',
    ])
  })
})

describe('aliases.json', () => {
  it('keeps a renumbered placeholder’s old meaning for this member’s own restore', () => {
    addAliases(mapPath, { __FN__3: 'chargeCard' })
    addAliases(mapPath, { __VAR__7: 'amount' })
    expect(loadAliases(mapPath)).toEqual({ __FN__3: 'chargeCard', __VAR__7: 'amount' })
    expect(statSync(join(dir, '.veilio', ALIASES_FILE)).mode & 0o777).toBe(0o600)
  })

  it('never gives an old placeholder a second meaning', () => {
    addAliases(mapPath, { __FN__3: 'chargeCard' })
    expect(() => addAliases(mapPath, { __FN__3: 'refund' })).toThrow(/__FN__3/)
    expect(loadAliases(mapPath)).toEqual({ __FN__3: 'chargeCard' })
  })
})

describe('the Cloud calls', () => {
  const credential = { token: 'tok', account: 'a@b.test', instance: 'https://veilio.test' }
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())
  const answer = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

  it('asks for a block with block: true', async () => {
    fetchMock.mockResolvedValueOnce(answer({ ranges: [{ base: '__FN__', start: 1, end: 500 }] }))
    const r = await reservePlaceholders(
      credential,
      'team-1',
      [{ base: '__FN__', count: 1, floor: 0 }],
      undefined,
      {
        block: true,
      }
    )
    expect(r.ranges[0]).toEqual({ base: '__FN__', start: 1, end: 500 })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      requests: [{ base: '__FN__', count: 1, floor: 0 }],
      block: true,
    })
  })

  it('reads every page of the team’s reservations', async () => {
    fetchMock
      .mockResolvedValueOnce(
        answer({ reservations: [{ base: '__FN__', start: 1, end: 500, member: 'u1' }], next: 7 })
      )
      .mockResolvedValueOnce(
        answer({
          reservations: [{ base: '__FN__', start: 501, end: 1000, member: 'u2' }],
          next: null,
        })
      )
    const all = await readReservations(credential, 'team-1')
    expect(all.map((r) => r.member)).toEqual(['u1', 'u2'])
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/after=7/)
  })
})
