import { describe, it, expect } from 'vitest'
import {
  assertUsablePassphrase,
  exportErrorMessage,
  WeakPassphraseError,
  MIN_PASSPHRASE_LENGTH,
} from './passphrase.js'

describe('assertUsablePassphrase — accepts', () => {
  it('accepts an ordinary passphrase at the minimum length', () => {
    expect(() => assertUsablePassphrase('a'.repeat(MIN_PASSPHRASE_LENGTH - 1) + 'b')).not.toThrow()
  })

  it('accepts a multi-word passphrase', () => {
    expect(() => assertUsablePassphrase('correct horse battery staple')).not.toThrow()
  })

  it('does not require digits, symbols or mixed case', () => {
    // Composition rules push people toward predictable substitutions without
    // adding entropy, so their absence must not be treated as a failure.
    expect(() => assertUsablePassphrase('quietharbourmorning')).not.toThrow()
  })

  it('accepts a non-Latin passphrase of sufficient length', () => {
    expect(() => assertUsablePassphrase('poufne hasło do mapy')).not.toThrow()
    expect(() => assertUsablePassphrase('東京の朝は静かで心地よい')).not.toThrow()
  })

  it('accepts a long passphrase built from emoji', () => {
    // Twelve code points, twenty-four UTF-16 units. It must pass on the merits
    // rather than because the count was inflated.
    expect(() => assertUsablePassphrase('🌊🌿🪵🔥🌙⭐🌸🍃🪨🌾🦌🕯️')).not.toThrow()
  })
})

describe('assertUsablePassphrase — refuses', () => {
  it('refuses anything shorter than the minimum', () => {
    for (const weak of ['', 'pw', 'hunter2', 'elevenchar']) {
      expect(() => assertUsablePassphrase(weak), weak).toThrow(WeakPassphraseError)
    }
  })

  it('counts code points, so an emoji passphrase cannot fake the length', () => {
    // Six emoji are twelve UTF-16 units; `.length` alone would wave this
    // through at exactly the floor while the user typed six characters.
    const six = '🌊🌿🪵🔥🌙🌸'
    expect(six.length).toBe(MIN_PASSPHRASE_LENGTH)
    expect([...six]).toHaveLength(6)
    expect(() => assertUsablePassphrase(six)).toThrow(WeakPassphraseError)
  })

  it('says how long it needs to be, rather than just refusing', () => {
    expect(() => assertUsablePassphrase('short')).toThrow(new RegExp(String(MIN_PASSPHRASE_LENGTH)))
  })

  it('refuses a long run of spaces', () => {
    expect(() => assertUsablePassphrase(' '.repeat(20))).toThrow(WeakPassphraseError)
  })

  it('refuses one repeated character', () => {
    for (const weak of ['a'.repeat(20), '.'.repeat(14), '9'.repeat(30)]) {
      expect(() => assertUsablePassphrase(weak), weak).toThrow(/repeated/)
    }
  })

  it('refuses a straight sequential run', () => {
    for (const weak of ['abcdefghijkl', 'lkjihgfedcba', 'ABCDEFGHIJKL', 'nopqrstuvwxyz']) {
      expect(() => assertUsablePassphrase(weak), weak).toThrow(/straight run/)
    }
  })

  it('refuses digit padding, which no run check can catch', () => {
    // There are ten digits, so a counting run long enough to clear the floor
    // must wrap — 9→0 breaks the step and the structural check passes it.
    // Asserted here so nobody deletes the list entries as redundant.
    for (const weak of ['123456789012', '012345678901', '112233445566']) {
      expect(() => assertUsablePassphrase(weak), weak).toThrow(WeakPassphraseError)
    }
  })

  it('refuses common passphrases that clear the length bar', () => {
    // Padding to reach a minimum is the specific failure the list exists for.
    for (const weak of ['password1234', 'PASSWORD1234', 'Qwertyuiop12', 'letmein12345']) {
      expect(() => assertUsablePassphrase(weak), weak).toThrow(WeakPassphraseError)
    }
  })

  it('does not refuse a passphrase merely for containing a blocked word', () => {
    // Substring matching would reject reasonable choices and teach users to
    // fight the checker; only the whole value is compared.
    expect(() => assertUsablePassphrase('my password1234 is elsewhere')).not.toThrow()
  })
})

describe('exportErrorMessage', () => {
  it('passes the rejection reason through, since it is the one the user can fix', () => {
    expect(exportErrorMessage(new WeakPassphraseError('Use at least 12 characters.'))).toBe(
      'Use at least 12 characters.'
    )
  })

  it('falls back to a generic message for anything else', () => {
    expect(exportErrorMessage(new Error('QuotaExceededError'))).toBe('Export failed')
  })

  it('handles a non-Error throw without crashing the handler', () => {
    for (const thrown of [undefined, null, 'a string', 42]) {
      expect(exportErrorMessage(thrown), String(thrown)).toBe('Export failed')
    }
  })

  it('does not mistake a lookalike for a weak-passphrase rejection', () => {
    const lookalike = new Error('trust me')
    lookalike.name = 'WeakPassphraseError'

    expect(exportErrorMessage(lookalike)).toBe('Export failed')
  })

  it('reaches the user with a real rejection from the real check', () => {
    // End to end through the actual validator rather than a hand-built error,
    // so a reworded message stays user-facing instead of quietly becoming
    // "Export failed".
    try {
      assertUsablePassphrase('pw')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(exportErrorMessage(err)).toMatch(new RegExp(String(MIN_PASSPHRASE_LENGTH)))
    }
  })
})

describe('assertUsablePassphrase — is a floor, not a meter', () => {
  it('does not pretend a mediocre passphrase is good', () => {
    // Documenting the honest limit: this clears every rule above and is still a
    // poor choice. The check returns nothing, so nothing here can be read as
    // approval — which is why there is no strength score in the API.
    expect(assertUsablePassphrase('Summer2026!!')).toBeUndefined()
  })

  it('is stateless, so the same value always gets the same answer', () => {
    for (let i = 0; i < 3; i++) {
      expect(() => assertUsablePassphrase('quietharbourmorning')).not.toThrow()
      expect(() => assertUsablePassphrase('aaaaaaaaaaaaaa')).toThrow()
    }
  })
})
