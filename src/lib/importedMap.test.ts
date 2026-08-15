import { describe, it, expect } from 'vitest'
import { anonymize, restore } from '@veilio-inc/engine'
import { parseSymbolMap, importErrorMessage, InvalidMapError } from './importedMap.js'

describe('parseSymbolMap — accepts what the engine produces', () => {
  it('accepts a real map from anonymize', () => {
    const { map } = anonymize('class Ledger { settleInvoice(rate) { return rate } }')

    expect(parseSymbolMap(map)).toEqual(map)
  })

  it('accepts a map containing a manual mark', () => {
    const { map } = anonymize('// escalated by Kowalska', { manual: ['Kowalska'] })

    expect(parseSymbolMap(map)).toEqual(map)
  })

  it('accepts a legacy plain-style map', () => {
    // Refusing this would make .veilio files exported before role-typed
    // placeholders unimportable, which is data loss rather than hardening.
    const legacy = { __P1__: 'UserAuthService', __P2__: 'settleInvoice' }

    expect(parseSymbolMap(legacy)).toEqual(legacy)
  })

  it('accepts an empty map', () => {
    expect(parseSymbolMap({})).toEqual({})
  })

  it('survives a round trip through JSON, which is how it actually arrives', () => {
    const { map } = anonymize('class Ledger { settle(rate) { return rate } }')
    const parsed = parseSymbolMap(JSON.parse(JSON.stringify(map)))

    expect(parsed).toEqual(map)
  })

  it('still restores correctly after validation', () => {
    const source = 'class Ledger { settleInvoice(rate) { return rate } }'
    const { anonymized, map } = anonymize(source)
    const { restored } = restore(anonymized, parseSymbolMap(map), { strip: 'none' })

    expect(restored).toBe(source)
  })
})

describe('parseSymbolMap — refuses malformed input', () => {
  it('refuses non-objects', () => {
    for (const bad of [null, undefined, 42, 'a string', true]) {
      expect(() => parseSymbolMap(bad), String(bad)).toThrow(InvalidMapError)
    }
  })

  it('refuses an array', () => {
    // JSON.parse('[...]') is an object, so this needs its own check.
    expect(() => parseSymbolMap([])).toThrow(InvalidMapError)
    expect(() => parseSymbolMap(['__FN__1', 'settle'])).toThrow(InvalidMapError)
  })

  it('refuses keys that are not placeholders', () => {
    expect(() => parseSymbolMap({ settleInvoice: 'x' })).toThrow(InvalidMapError)
    expect(() => parseSymbolMap({ '': 'x' })).toThrow(InvalidMapError)
  })

  it('refuses values that are not strings', () => {
    for (const bad of [42, null, {}, [], true]) {
      expect(() => parseSymbolMap({ __FN__1: bad }), String(bad)).toThrow(InvalidMapError)
    }
  })

  it('names the offending placeholder so the error is actionable', () => {
    expect(() => parseSymbolMap({ __FN__1: 42 })).toThrow(/__FN__1/)
  })
})

describe('parseSymbolMap — refuses hostile input', () => {
  it('refuses a prototype-pollution key', () => {
    // Delegated to isPlaceholder: `__proto__` has no uppercase first character,
    // so the shape check refuses it. Asserted here because that is load-bearing
    // and could be regressed by loosening the pattern in the engine.
    const hostile = JSON.parse('{"__proto__": {"polluted": true}}')

    expect(() => parseSymbolMap(hostile)).toThrow(InvalidMapError)
  })

  it('refuses constructor and prototype keys', () => {
    expect(() => parseSymbolMap(JSON.parse('{"constructor":"x"}'))).toThrow(InvalidMapError)
    expect(() => parseSymbolMap(JSON.parse('{"prototype":"x"}'))).toThrow(InvalidMapError)
  })

  it('does not pollute Object.prototype even while rejecting', () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}}')
    try {
      parseSymbolMap(hostile)
    } catch {
      /* expected */
    }

    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  it('refuses a map with too many entries', () => {
    const huge: Record<string, string> = {}
    for (let i = 0; i < 50_001; i++) huge[`__FN__${i}`] = 'x'

    expect(() => parseSymbolMap(huge)).toThrow(/entries/)
  })

  it('refuses an absurdly long value', () => {
    expect(() => parseSymbolMap({ __FN__1: 'x'.repeat(10_001) })).toThrow(/characters/)
  })

  it('allows a value right at the limit', () => {
    // The bound must not be so tight that a legitimate manual mark trips it.
    expect(parseSymbolMap({ __FN__1: 'x'.repeat(10_000) })).toEqual({ __FN__1: 'x'.repeat(10_000) })
  })

  it('truncates a hostile key in the error message', () => {
    // Otherwise a crafted key becomes the toast, which is its own small problem.
    const long = 'z'.repeat(500)
    expect(() => parseSymbolMap({ [long]: 'x' })).toThrow(/…/)
  })

  it('returns a fresh object rather than the input', () => {
    // Validating one object and using another is how a check gets bypassed by
    // anything exotic about the original — a getter, a stray prototype.
    const input = { __FN__1: 'settleInvoice' }
    const out = parseSymbolMap(input)

    expect(out).not.toBe(input)
    expect(out).toEqual(input)
  })

  it('truncated preview keeps the head of the key, not just an ellipsis', () => {
    // A message of pure "…" would name nothing, defeating the point of naming
    // the offender at all.
    expect(() => parseSymbolMap({ [`notAPlaceholder_${'z'.repeat(500)}`]: 'x' })).toThrow(
      /notAPlaceholder_/
    )
  })

  it('collapses whitespace in the preview so a key cannot reshape the toast', () => {
    expect(() => parseSymbolMap({ 'a\n\n\nb': 'x' })).toThrow(/Not a placeholder: a b/)
  })

  it('does not carry over a getter that could re-run on read', () => {
    let reads = 0
    const sneaky = {}
    Object.defineProperty(sneaky, '__FN__1', {
      enumerable: true,
      get() {
        reads++
        return 'settleInvoice'
      },
    })

    const out = parseSymbolMap(sneaky)
    const before = reads
    void out.__FN__1
    void out.__FN__1

    expect(out.__FN__1).toBe('settleInvoice')
    expect(reads).toBe(before)
  })
})

describe('importErrorMessage', () => {
  it('passes a validation failure through so the reader learns what was wrong', () => {
    expect(importErrorMessage(new InvalidMapError('Not a placeholder: settleInvoice'))).toBe(
      'Not a placeholder: settleInvoice'
    )
  })

  it('blames the passphrase only when the failure was not a validation failure', () => {
    // A failed decrypt surfaces as a bare OperationError from WebCrypto.
    expect(importErrorMessage(new Error('OperationError'))).toMatch(/wrong passphrase/)
  })

  it('handles a non-Error throw without crashing the handler', () => {
    for (const thrown of [undefined, null, 'a string', 42]) {
      expect(importErrorMessage(thrown), String(thrown)).toMatch(/wrong passphrase/)
    }
  })

  it('does not mistake a lookalike for a validation failure', () => {
    // A plain Error with the same name must not slip through: the branch is on
    // the class, and this is what would break if it were switched to a name
    // comparison.
    const lookalike = new Error('trust me')
    lookalike.name = 'InvalidMapError'

    expect(importErrorMessage(lookalike)).toMatch(/wrong passphrase/)
  })
})
