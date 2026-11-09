import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { confirmPin, confirmedKeys, keyPinsPath, pinOf, readPins } from '../src/key-pins.js'

// Spec 080 item 7a: the teammate keys this member confirmed by fingerprint, on
// this device only (the web app's R-011: pins are never sent to Veilio).

const A = { instance: 'https://veilio.test', account: 'ana@example.test' }
const B = { instance: 'https://veilio.test', account: 'bob@example.test' }
const OTHER_INSTANCE = { instance: 'https://self-hosted.test', account: A.account }
const NOW = new Date('2026-11-09T10:00:00.000Z')

let home: string
const fetchSpy = vi.fn()

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-pins-'))
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
})

describe('key pins', () => {
  it('has none until a key is confirmed', () => {
    expect(readPins(A, home)).toEqual({})
  })

  it('records a confirmed key with the time, readable only by this user', () => {
    confirmPin(A, 'u2', 'K1', home, NOW)
    expect(readPins(A, home).u2).toEqual({
      current: 'K1',
      history: [],
      confirmedAt: NOW.toISOString(),
    })
    expect(statSync(keyPinsPath(home)).mode & 0o777).toBe(0o600)
  })

  it('tightens a file that was left readable by others', () => {
    mkdirSync(dirname(keyPinsPath(home)), { recursive: true })
    writeFileSync(keyPinsPath(home), JSON.stringify({ v: 1, scopes: [] }), { mode: 0o644 })
    chmodSync(keyPinsPath(home), 0o644)
    confirmPin(A, 'u2', 'K1', home, NOW)
    expect(statSync(keyPinsPath(home)).mode & 0o777).toBe(0o600)
  })

  it('writes atomically: no temporary file is left beside it', () => {
    confirmPin(A, 'u2', 'K1', home, NOW)
    confirmPin(A, 'u3', 'K3', home, NOW)
    expect(readdirSync(dirname(keyPinsPath(home)))).toEqual(['key-pins.json'])
  })

  it('a newly confirmed key keeps the earlier one in the history', () => {
    confirmPin(A, 'u2', 'K1', home, NOW)
    confirmPin(A, 'u2', 'K2', home, NOW)
    expect(readPins(A, home).u2).toMatchObject({ current: 'K2', history: ['K1'] })
    expect(confirmedKeys(readPins(A, home).u2)).toEqual(['K2', 'K1'])
  })

  it('confirming again adds no duplicates to the history', () => {
    for (const k of ['K1', 'K2', 'K2', 'K1', 'K2']) confirmPin(A, 'u2', k, home, NOW)
    expect(readPins(A, home).u2).toMatchObject({ current: 'K2', history: ['K1'] })
  })

  it('a deleted granter is pinned under the key itself', () => {
    confirmPin(A, 'key:GONE1', 'GONE1', home, NOW)
    expect(confirmedKeys(readPins(A, home)['key:GONE1'])).toEqual(['GONE1'])
  })

  it('keeps each account’s pins apart', () => {
    confirmPin(A, 'u2', 'K1', home, NOW)
    expect(readPins(B, home)).toEqual({})
    confirmPin(B, 'u2', 'K9', home, NOW)
    expect(readPins(A, home).u2.current).toBe('K1')
    expect(readPins(B, home).u2.current).toBe('K9')
  })

  it('keeps each instance’s pins apart', () => {
    confirmPin(A, 'u2', 'K1', home, NOW)
    expect(readPins(OTHER_INSTANCE, home)).toEqual({})
  })

  it.each([
    ['not JSON', 'not json'],
    ['another format', JSON.stringify({ v: 2, scopes: [] })],
    ['no list of scopes', JSON.stringify({ v: 1, scopes: {} })],
    ['this account with no pins', JSON.stringify({ v: 1, scopes: [{ ...A }] })],
    [
      'this account with pins that are not a record',
      JSON.stringify({ v: 1, scopes: [{ ...A, pins: [] }] }),
    ],
  ])('a damaged file (%s) reads as no pins, and is never overwritten', (_, text) => {
    mkdirSync(dirname(keyPinsPath(home)), { recursive: true })
    writeFileSync(keyPinsPath(home), text)
    expect(readPins(A, home)).toEqual({})
    expect(() => confirmPin(A, 'u2', 'K1', home, NOW)).toThrow(
      `${keyPinsPath(home)} is damaged, so the key was not confirmed. Move it aside and run \`veilio team trust\` again.`
    )
    expect(readFileSync(keyPinsPath(home), 'utf8')).toBe(text)
  })

  it("another account's damaged scope does not stop this one, and is kept as it was", () => {
    mkdirSync(dirname(keyPinsPath(home)), { recursive: true })
    writeFileSync(keyPinsPath(home), JSON.stringify({ v: 1, scopes: [{ ...B, pins: 7 }] }))
    confirmPin(A, 'u2', 'K1', home, NOW)
    expect(readPins(A, home).u2?.current).toBe('K1')
    expect(JSON.parse(readFileSync(keyPinsPath(home), 'utf8')).scopes[0]).toEqual({ ...B, pins: 7 })
  })

  it('a damaged pin is skipped, the others kept', () => {
    confirmPin(A, 'u2', 'K1', home, NOW)
    const file = JSON.parse(readFileSync(keyPinsPath(home), 'utf8'))
    file.scopes[0].pins.u3 = { current: 7 }
    writeFileSync(keyPinsPath(home), JSON.stringify(file))
    expect(Object.keys(readPins(A, home))).toEqual(['u2'])
  })

  it.each(['__proto__', 'constructor', 'toString'])(
    'a granter id %j is kept like any other, on disk and read back',
    (id) => {
      expect(confirmedKeys(pinOf(readPins(A, home), id))).toEqual([])
      confirmPin(A, id, 'K1', home, NOW)
      confirmPin(A, id, 'K2', home, NOW)
      const pins = readPins(A, home)
      expect(Object.hasOwn(pins, id)).toBe(true)
      expect(confirmedKeys(pinOf(pins, id))).toEqual(['K2', 'K1'])
      expect(JSON.parse(readFileSync(keyPinsPath(home), 'utf8')).scopes[0].pins).toHaveProperty(
        [id],
        expect.objectContaining({ current: 'K2' })
      )
    }
  )

  it('a missing pin has no confirmed keys', () => {
    expect(confirmedKeys(undefined)).toEqual([])
  })
})
