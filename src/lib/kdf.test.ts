import { describe, it, expect } from 'vitest'
import { parseKdfParams, KdfParamsError, CURRENT_FILE_KDF, LEGACY_FILE_KDF } from './kdf.js'

describe('parseKdfParams', () => {
  it('falls back when the file records nothing', () => {
    // Files written before parameters were recorded have no kdf field at all.
    expect(parseKdfParams(undefined, LEGACY_FILE_KDF)).toEqual(LEGACY_FILE_KDF)
    expect(parseKdfParams(null, LEGACY_FILE_KDF)).toEqual(LEGACY_FILE_KDF)
  })

  it('uses what the file records rather than the current constant', () => {
    const recorded = { name: 'PBKDF2-SHA256' as const, iterations: 250_000 }
    expect(parseKdfParams(recorded, LEGACY_FILE_KDF)).toEqual(recorded)
  })

  it('refuses an unknown KDF instead of guessing', () => {
    expect(() => parseKdfParams({ name: 'argon2id', iterations: 3 }, LEGACY_FILE_KDF)).toThrow(
      KdfParamsError
    )
  })

  it('refuses non-object parameters', () => {
    for (const bad of [42, 'PBKDF2', true]) {
      expect(() => parseKdfParams(bad, LEGACY_FILE_KDF), String(bad)).toThrow(KdfParamsError)
    }
  })

  it('refuses an iteration count that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, '600000', null]) {
      expect(
        () => parseKdfParams({ name: 'PBKDF2-SHA256', iterations: bad }, LEGACY_FILE_KDF),
        String(bad)
      ).toThrow(KdfParamsError)
    }
  })

  it('returns a fresh object rather than the input', () => {
    const input = { name: 'PBKDF2-SHA256' as const, iterations: 200_000, extra: 'ignored' }
    const out = parseKdfParams(input, LEGACY_FILE_KDF)

    expect(out).not.toBe(input)
    expect(out).toEqual({ name: 'PBKDF2-SHA256', iterations: 200_000 })
  })
})

describe('the iteration ceiling (ROADMAP E8)', () => {
  const at = (iterations: number) =>
    parseKdfParams({ name: 'PBKDF2-SHA256', iterations }, LEGACY_FILE_KDF)

  // Hardcoded on purpose: the constant is not exported, and a silent change to
  // it — in either direction — should fail here rather than pass unnoticed.
  it('accepts exactly the ceiling and refuses one past it', () => {
    expect(at(4_000_000)).toEqual({ name: 'PBKDF2-SHA256', iterations: 4_000_000 })
    expect(() => at(4_000_001)).toThrow(/iteration count/i)
  })

  it('refuses the value that used to be allowed', () => {
    // The old ceiling was 10,000,000, which bought no legitimate capability and
    // was seconds of frozen tab on a low-end phone.
    expect(() => at(10_000_000)).toThrow(KdfParamsError)
    expect(() => at(1_000_000_000)).toThrow(KdfParamsError)
  })

  // The invariant that actually matters: a ceiling below what this app writes
  // would make the app unable to read its own exports. Derived from the
  // constants, so it keeps holding when either is raised.
  it('is never below what this build writes', () => {
    expect(() => at(CURRENT_FILE_KDF.iterations)).not.toThrow()
    expect(() => at(LEGACY_FILE_KDF.iterations)).not.toThrow()
  })

  it('leaves real headroom above the current cost', () => {
    // A ceiling only just above CURRENT would have to be edited in lockstep
    // with every raise, and would be forgotten once.
    expect(() => at(CURRENT_FILE_KDF.iterations * 4)).not.toThrow()
  })
})
