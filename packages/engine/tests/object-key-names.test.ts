import { describe, it, expect } from 'vitest'
import { anonymize, restore, classifyIdentifiers } from '../src/engine.js'

// Identifiers are looked up by name, and some names are also properties every
// plain object inherits. `__proto__` resolved to Object.prototype, so the
// masked text read `x.[object Object]` and restore could not bring it back:
// the code that came home was not the code that left.

const INHERITED = [
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'toString',
  'valueOf',
  '__defineGetter__',
]

describe('names every plain object inherits', () => {
  it.each(INHERITED)('%s round-trips as written', (name) => {
    const original = `const parentRecord = customerRecord.${name}`
    const { anonymized, map } = anonymize(original)
    expect(anonymized).not.toContain('[object Object]')
    expect(restore(anonymized, map).restored).toBe(original)
  })

  it('masks __proto__ like any other member name', () => {
    const { anonymized, map } = anonymize('const parentRecord = customerRecord.__proto__')
    expect(anonymized).not.toContain('__proto__')
    expect(Object.values(map)).toContain('__proto__')
  })

  it('round-trips __proto__ through an existing map', () => {
    const first = anonymize('const parentRecord = customerRecord.__proto__')
    const second = anonymize('return customerRecord.__proto__', { existingMap: first.map })
    expect(second.anonymized).toBe(first.anonymized.replace(/^const \S+ = /, 'return '))
    expect(restore(second.anonymized, second.map).restored).toBe('return customerRecord.__proto__')
  })

  it('round-trips Python dunder names', () => {
    const original =
      'def build_report(record):\n    return record.__class__.__name__ + str(record.__dict__)'
    const { anonymized, map } = anonymize(original, { language: 'python' })
    expect(restore(anonymized, map).restored).toBe(original)
  })

  it('classifies __proto__ with a role, not an inherited object', () => {
    const roles = classifyIdentifiers('const parentRecord = customerRecord.__proto__')
    expect(Object.keys(roles)).toContain('__proto__')
    expect(typeof roles['__proto__']).toBe('string')
  })
})
