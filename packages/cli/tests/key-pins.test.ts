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
import { confirmPin, confirmedKeys, keyPinsPath, readPins } from '../src/key-pins.js'

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
    writeFileSync(keyPinsPath(home), '{}', { mode: 0o644 })
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

  it('a damaged file reads as no pins, and the next confirmation replaces it', () => {
    mkdirSync(dirname(keyPinsPath(home)), { recursive: true })
    writeFileSync(keyPinsPath(home), 'not json')
    expect(readPins(A, home)).toEqual({})
    confirmPin(A, 'u2', 'K1', home, NOW)
    expect(readPins(A, home).u2.current).toBe('K1')
  })

  it('a damaged pin is skipped, the others kept', () => {
    confirmPin(A, 'u2', 'K1', home, NOW)
    const file = JSON.parse(readFileSync(keyPinsPath(home), 'utf8'))
    file.scopes[0].pins.u3 = { current: 7 }
    writeFileSync(keyPinsPath(home), JSON.stringify(file))
    expect(Object.keys(readPins(A, home))).toEqual(['u2'])
  })

  it('a missing pin has no confirmed keys', () => {
    expect(confirmedKeys(undefined)).toEqual([])
  })
})
