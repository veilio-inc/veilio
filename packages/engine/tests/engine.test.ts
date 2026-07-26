import { describe, it, expect } from 'vitest'
import { extractIdentifiers, anonymize, restore } from '../src/engine.js'
import type { SymbolMap } from '../src/types.js'

// ─── extractIdentifiers ───────────────────────────────────────────────────────

describe('extractIdentifiers', () => {
  it('extracts PascalCase class names', () => {
    const ids = extractIdentifiers('class UserAuthService {}')
    expect(ids).toContain('UserAuthService')
  })

  it('extracts camelCase method names longer than 2 chars', () => {
    const ids = extractIdentifiers('function validateToken() {}')
    expect(ids).toContain('validateToken')
  })

  it('extracts snake_case names longer than 2 chars', () => {
    const ids = extractIdentifiers('const user_service = null')
    expect(ids).toContain('user_service')
  })

  it('excludes JS keywords', () => {
    const ids = extractIdentifiers('const let var function class return if else for while')
    expect(ids).toHaveLength(0)
  })

  it('excludes ALL_CAPS constants', () => {
    const ids = extractIdentifiers('const MAX_RETRIES = 3; const API_KEY = ""')
    expect(ids).toHaveLength(0)
  })

  it('excludes identifiers of length 1-2', () => {
    const ids = extractIdentifiers('const id = ok; let db = fn()')
    expect(ids).toHaveLength(0)
  })

  it('excludes known framework globals', () => {
    const ids = extractIdentifiers('React.useState()')
    expect(ids).not.toContain('React')
    expect(ids).not.toContain('useState')
  })

  it('returns identifiers sorted by length descending', () => {
    const ids = extractIdentifiers('function longMethodName() { const shortVar = abc }')
    for (let i = 0; i < ids.length - 1; i++) {
      expect(ids[i].length).toBeGreaterThanOrEqual(ids[i + 1].length)
    }
  })

  it('deduplicates repeated identifiers', () => {
    const ids = extractIdentifiers('validateToken(); validateToken(); validateToken()')
    expect(ids.filter((x) => x === 'validateToken')).toHaveLength(1)
  })

  it('returns empty array for empty string', () => {
    expect(extractIdentifiers('')).toEqual([])
  })

  it('returns empty array when no qualifying identifiers', () => {
    expect(extractIdentifiers('const x = 1; let y = 2')).toEqual([])
  })

  it('handles identifiers containing $', () => {
    const ids = extractIdentifiers('const $myStore = createStore()')
    expect(ids).toContain('$myStore')
  })
})

// ─── anonymize ────────────────────────────────────────────────────────────────

describe('anonymize', () => {
  it('replaces identifiers with __P1__, __P2__, etc. (legacy plain style)', () => {
    const { anonymized } = anonymize('class UserAuthService { validateToken() {} }', {
      style: 'plain',
    })
    expect(anonymized).toContain('__P')
    expect(anonymized).not.toContain('UserAuthService')
    expect(anonymized).not.toContain('validateToken')
  })

  it('produces a correct symbol map', () => {
    const { map } = anonymize('class UserAuthService {}')
    const values = Object.values(map)
    expect(values).toContain('UserAuthService')
  })

  it('identifierCount equals number of unique placeholders', () => {
    const { map, identifierCount } = anonymize(
      'class UserAuthService { validateToken() {} }',
    )
    expect(identifierCount).toBe(Object.keys(map).length)
  })

  it('longest-first substitution prevents partial matches', () => {
    const code = 'class OrderService extends Service {}'
    const { anonymized } = anonymize(code, { style: 'plain' })
    // "Service" inside "OrderService" should not produce a double-replaced name
    expect(anonymized).not.toMatch(/__P\d+__Service/)
    expect(anonymized).not.toMatch(/Order__P\d+__/)
  })

  it('continues numbering from existingMap (legacy plain style)', () => {
    const existing = { __P1__: 'FirstName', __P2__: 'LastName' }
    const { map } = anonymize('class NewService {}', { existingMap: existing, style: 'plain' })
    const placeholders = Object.keys(map)
    expect(placeholders).toContain('__P3__')
  })

  it('reuses existing placeholder for identifiers already in map', () => {
    const existing = { __P1__: 'UserService' }
    const { map } = anonymize('class UserService { newMethod() {} }', existing)
    expect(map['__P1__']).toBe('UserService')
    // newMethod gets the next number
    const values = Object.values(map)
    expect(values).toContain('newMethod')
  })

  it('passes through code with no qualifying identifiers', () => {
    const { anonymized, identifierCount } = anonymize('const x = 1 + 2')
    expect(anonymized).toBe('const x = 1 + 2')
    expect(identifierCount).toBe(0)
  })

  it('handles identifiers containing $ (legacy plain style)', () => {
    const { anonymized } = anonymize('const $myStore = null', { style: 'plain' })
    expect(anonymized).not.toContain('$myStore')
    expect(anonymized).toContain('__P')
  })
})

// ─── restore ─────────────────────────────────────────────────────────────────

describe('restore', () => {
  it('restores all placeholders from map', () => {
    const map = { __P1__: 'UserAuthService', __P2__: 'validateToken' }
    const { restored } = restore('class __P1__ { __P2__() {} }', map)
    expect(restored).toContain('UserAuthService')
    expect(restored).toContain('validateToken')
  })

  it('strips JSDoc blocks', () => {
    const input = '/** This is a doc block */\nfunction foo() {}'
    const { restored, strippedItems } = restore(input, {})
    expect(restored).not.toContain('/** ')
    expect(strippedItems.some((i) => i.type === 'jsdoc')).toBe(true)
  })

  it('strips TODO comments', () => {
    const input = '// TODO: fix this later\nconst x = 1'
    const { strippedItems } = restore(input, {})
    expect(strippedItems.some((i) => i.type === 'todo')).toBe(true)
  })

  it('strips FIXME comments', () => {
    const input = '// FIXME: broken\nconst x = 1'
    const { strippedItems } = restore(input, {})
    expect(strippedItems.some((i) => i.type === 'todo')).toBe(true)
  })

  it('strips step marker comments', () => {
    const input = '// Step 1: Initialize the service\nconst x = 1'
    const { strippedItems } = restore(input, {})
    expect(strippedItems.some((i) => i.type === 'step-marker')).toBe(true)
  })

  it('strips narration comments', () => {
    const input = '// Handle the request\nconst x = 1'
    const { strippedItems } = restore(input, {})
    expect(strippedItems.some((i) => i.type === 'narration')).toBe(true)
  })

  it('strips separator lines', () => {
    const input = '// ---\nconst x = 1\n// ==='
    const { strippedItems } = restore(input, {})
    expect(strippedItems.filter((i) => i.type === 'separator')).toHaveLength(2)
  })

  it('strips section header comments', () => {
    const input = '// ** Section **\nconst x = 1'
    const { strippedItems } = restore(input, {})
    expect(strippedItems.some((i) => i.type === 'section-header')).toBe(true)
  })

  it('strips inline annotation comments', () => {
    const input = '// @param name - the name\nconst x = 1'
    const { strippedItems } = restore(input, {})
    expect(strippedItems.some((i) => i.type === 'inline-annotation')).toBe(true)
  })

  it('collapses multiple blank lines to maximum 2', () => {
    const input = 'line1\n\n\n\n\nline2'
    const { restored } = restore(input, {})
    expect(restored).not.toMatch(/\n{3,}/)
  })

  it('strippedCount matches strippedItems length', () => {
    const input = '/** doc */\n// TODO: something\nconst x = 1'
    const { strippedCount, strippedItems } = restore(input, {})
    expect(strippedCount).toBe(strippedItems.length)
  })

  it('passes through with empty map', () => {
    const { restored } = restore('const x = 1', {})
    expect(restored).toContain('const x = 1')
  })

  it('round-trip: anonymize then restore returns original identifiers', () => {
    const original = 'class PaymentProcessor { handleRefund(orderId: string) { return orderId } }'
    const { anonymized, map } = anonymize(original)
    const { restored } = restore(anonymized, map)
    expect(restored).toContain('PaymentProcessor')
    expect(restored).toContain('handleRefund')
    expect(restored).toContain('orderId')
  })

  it('real names do not accidentally trigger strip patterns after restore', () => {
    // A real name like "Validate" should NOT be stripped as a narration comment
    const map = { __P1__: 'ValidateService' }
    const { restored } = restore('class __P1__ {}', map)
    expect(restored).toContain('ValidateService')
  })
})

// ─── anonymize with custom rules (sub-project #4a) ───────────────────────────

describe('anonymize with custom rules', () => {
  const helper = (n: number, type: 'replace' | 'whitelist', pattern: string, placeholder?: string) => {
    const base = {
      id: `r${n}`,
      type,
      name: `Rule ${n}`,
      pattern,
      enabled: true,
      sort_order: n,
    }
    return type === 'replace'
      ? { ...base, type: 'replace' as const, placeholder: placeholder ?? '__X__' }
      : { ...base, type: 'whitelist' as const }
  }

  it('passes options shape: { existingMap, rules } works (legacy plain style)', () => {
    const { anonymized, map } = anonymize('class Foo {}', { rules: [], style: 'plain' })
    expect(anonymized).toContain('__P1__')
    expect(map['__P1__']).toBe('Foo')
  })

  it('existingMap + plain style via options object (legacy plain style)', () => {
    // existing tests cover this; explicit regression case here:
    const seed: SymbolMap = { '__P1__': 'OldName' }
    const { map } = anonymize('class NewName {}', { existingMap: seed, style: 'plain' })
    // OldName stays mapped, NewName gets __P2__
    expect(map['__P1__']).toBe('OldName')
    expect(map['__P2__']).toBe('NewName')
  })

  it('single replace rule: matching identifier gets the named placeholder + counter', () => {
    const rules = [helper(1, 'replace', '^api[A-Z]\\w*Key$', '__APIKEY__')]
    const { anonymized, map } = anonymize('const apiSecretKey = "x"', { rules })
    expect(anonymized).toContain('__APIKEY__1')
    expect(anonymized).not.toContain('apiSecretKey')
    expect(map['__APIKEY__1']).toBe('apiSecretKey')
  })

  it('multiple identifiers matching same replace rule get numbered variants', () => {
    const rules = [helper(1, 'replace', '^api[A-Z]\\w*Key$', '__APIKEY__')]
    const code = 'const apiSecretKey = "a"; const apiPublicKey = "b"'
    const { anonymized, map } = anonymize(code, { rules })
    expect(anonymized).toMatch(/__APIKEY__1/)
    expect(anonymized).toMatch(/__APIKEY__2/)
    expect(map['__APIKEY__1']).toBeDefined()
    expect(map['__APIKEY__2']).toBeDefined()
  })

  it('whitelist rule prevents anonymization (legacy plain style)', () => {
    // Use a non-keyword name as the whitelisted token (React is already in KEYWORDS).
    // ReactHelper (11 chars) sorts before Foo (3 chars) in the identifier list,
    // so it is processed first, whitelisted, and does NOT consume a placeholder.
    // Foo then becomes __P1__.
    const rulesH = [helper(1, 'whitelist', '^ReactHelper$')]
    const { anonymized, map } = anonymize('const ReactHelper = null; class Foo {}', {
      rules: rulesH,
      style: 'plain',
    })
    expect(anonymized).toContain('ReactHelper')       // whitelisted: left in source
    expect(map['__P1__']).toBe('Foo')                 // Foo is numbered normally
    // ReactHelper is NOT in the map (it wasn't anonymized)
    expect(Object.values(map)).not.toContain('ReactHelper')
  })

  it('whitelist takes precedence over replace (no named placeholder for whitelisted name)', () => {
    const rules = [
      helper(1, 'whitelist', '^apiSecretKey$'),
      helper(2, 'replace', '^api[A-Z]\\w*Key$', '__APIKEY__'),
    ]
    const { anonymized, map } = anonymize('const apiSecretKey = "x"', { rules })
    expect(anonymized).toContain('apiSecretKey')           // whitelisted
    expect(anonymized).not.toContain('__APIKEY__')         // replace skipped
    expect(Object.values(map)).not.toContain('apiSecretKey')
  })

  it('first matching replace rule wins by sort_order', () => {
    const rules = [
      helper(1, 'replace', '^api', '__FIRST__'),
      helper(2, 'replace', '^apiSecret', '__SECOND__'),
    ]
    const { anonymized, map } = anonymize('const apiSecret = "x"', { rules })
    // sort_order 1 (broader pattern) wins because it's first
    expect(anonymized).toContain('__FIRST__1')
    expect(map['__FIRST__1']).toBe('apiSecret')
  })

  it('disabled rules are ignored (legacy plain style)', () => {
    const rules = [{ ...helper(1, 'replace', '^api', '__APIKEY__'), enabled: false }]
    const { anonymized, map } = anonymize('const apiKey = "x"', { rules, style: 'plain' })
    // falls through to default __P1__
    expect(anonymized).toContain('__P1__')
    expect(map['__P1__']).toBe('apiKey')
  })

  it('round-trip: anonymize + restore returns original code', async () => {
    const { restore } = await import('../src/engine.js')
    const rules = [helper(1, 'replace', '^api[A-Z]\\w*Key$', '__APIKEY__')]
    const code = 'const apiSecretKey = "x"; const apiPublicKey = "y"; class Foo {}'
    const { anonymized, map } = anonymize(code, { rules })
    const { restored } = restore(anonymized, map)
    expect(restored).toContain('apiSecretKey')
    expect(restored).toContain('apiPublicKey')
    expect(restored).toContain('Foo')
  })

  it('mixed: some identifiers match rules, some fall through to __P<n>__ (legacy plain style)', () => {
    const rules = [helper(1, 'replace', '^api', '__APIKEY__')]
    const code = 'const apiKey = "x"; const userName = "y"'
    const { anonymized, map } = anonymize(code, { rules, style: 'plain' })
    expect(anonymized).toContain('__APIKEY__1')
    expect(anonymized).toContain('__P1__')
    expect(map['__APIKEY__1']).toBe('apiKey')
    expect(map['__P1__']).toBe('userName')
  })

  it('invalid regex in a rule does not crash; rule is silently skipped (legacy plain style)', () => {
    const rules = [helper(1, 'replace', '[invalid(regex', '__BAD__')]
    const { anonymized, map } = anonymize('const apiKey = "x"', { rules, style: 'plain' })
    // rule skipped, falls through to default
    expect(anonymized).toContain('__P1__')
    expect(map['__P1__']).toBe('apiKey')
  })

  it('empty rules array produces identical behavior to legacy shape', () => {
    const a = anonymize('class Foo {}', { rules: [] })
    const b = anonymize('class Foo {}', {})
    expect(a.anonymized).toBe(b.anonymized)
    expect(a.map).toEqual(b.map)
  })

  it('seeds named counters from existingMap to avoid overwriting prior named placeholders', () => {
    // Regression: namedCounters used to be initialized as {} per call, so a
    // second anonymize() with the same rule would generate __APIKEY__1 again
    // and clobber a prior mapping in existingMap.
    const rules = [helper(1, 'replace', '^api[A-Z]\\w*Key$', '__APIKEY__')]
    const first = anonymize('const apiSecretKey = "x"', { rules })
    expect(first.map['__APIKEY__1']).toBe('apiSecretKey')

    // Second call: same rule, a new matching identifier, carrying the first map forward.
    const second = anonymize('const apiPublicKey = "y"', { existingMap: first.map, rules })

    // Both mappings must survive — original wasn't overwritten.
    expect(second.map['__APIKEY__1']).toBe('apiSecretKey')
    expect(second.map['__APIKEY__2']).toBe('apiPublicKey')
  })
})
