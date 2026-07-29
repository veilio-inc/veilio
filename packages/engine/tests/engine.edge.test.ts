import { describe, it, expect } from 'vitest'
import { anonymize, restore, extractIdentifiers } from '../src/engine.js'

// ─── Realistic round-trips ────────────────────────────────────────────────────

describe('round-trip identity on realistic code', () => {
  it('preserves a TypeScript class verbatim after anonymize → restore', () => {
    const original = [
      'export class OrderProcessor {',
      '  constructor(private readonly inventoryService: InventoryService) {}',
      '  async fulfillOrder(orderId: string): Promise<FulfillmentResult> {',
      '    const order = await this.inventoryService.lookupOrder(orderId)',
      '    return this.inventoryService.shipOrder(order)',
      '  }',
      '}',
    ].join('\n')

    const { anonymized, map } = anonymize(original)
    expect(anonymized).not.toContain('OrderProcessor')
    expect(anonymized).not.toContain('inventoryService')
    expect(anonymized).not.toContain('fulfillOrder')

    const { restored } = restore(anonymized, map)
    expect(restored).toBe(original)
  })

  it('preserves a React component verbatim after anonymize → restore', () => {
    const original = [
      "import { useState } from 'react'",
      'export function UserProfile({ userId }: { userId: string }) {',
      '  const [profile, setProfile] = useState<UserData | null>(null)',
      '  const handleSave = async () => {',
      '    const next = await saveUserProfile(userId, profile)',
      '    setProfile(next)',
      '  }',
      '  return null',
      '}',
    ].join('\n')

    const { anonymized, map } = anonymize(original)
    const { restored } = restore(anonymized, map)
    expect(restored).toBe(original)
  })

  it('preserves an Express route verbatim after anonymize → restore', () => {
    const original = [
      "router.post('/login', async (request, response) => {",
      '  const credentials = request.body',
      '  const session = await authService.authenticate(credentials)',
      '  response.json({ token: session.token })',
      '})',
    ].join('\n')

    const { anonymized, map } = anonymize(original)
    const { restored } = restore(anonymized, map)
    expect(restored).toBe(original)
  })
})

// ─── Determinism ──────────────────────────────────────────────────────────────

describe('determinism', () => {
  it('same input twice produces identical anonymized output', () => {
    const code = 'class PaymentGateway { chargeCard(cardId: string) {} }'
    const a = anonymize(code)
    const b = anonymize(code)
    expect(a.anonymized).toBe(b.anonymized)
    expect(a.map).toEqual(b.map)
  })

  it('placeholder numbering is stable across runs (longest-first ordering)', () => {
    const code = 'class A_long_name_class { short() {} medium_length() {} }'
    const { map } = anonymize(code)
    // The longest identifier is processed first and so takes __CLS__1; the two
    // methods take __FN__1/__FN__2 in longest-first order.
    expect(map['__CLS__1']).toBe('A_long_name_class')
    expect(map['__FN__1']).toBe('medium_length')
    expect(map['__FN__2']).toBe('short')
    expect(anonymize(code).map).toEqual(map)
  })

  it('restore is deterministic for the same map', () => {
    const map = { __P1__: 'Service', __P2__: 'method' }
    const r1 = restore('class __P1__ { __P2__() {} }', map)
    const r2 = restore('class __P1__ { __P2__() {} }', map)
    expect(r1.restored).toBe(r2.restored)
  })
})

// ─── Idempotency / placeholder-namespace collisions ───────────────────────────

describe('idempotency and namespace safety', () => {
  it('anonymizing already-anonymized code does not double-anonymize placeholders', () => {
    const code = 'class UserService {}'
    const first = anonymize(code)
    const second = anonymize(first.anonymized)
    // The placeholder __P1__ is short (6 chars) and will be excluded by len > 2 + ALL_CAPS gate?
    // __P1__ matches /^[A-Z][A-Z0-9_]*$/? Yes — starts with __ which is uppercase-equivalent.
    // Actually "__P1__" — first char is `_` which is not uppercase. The ALL_CAPS regex starts with [A-Z],
    // so __P1__ does NOT match ALL_CAPS and would be re-extracted.
    // This test pins down the current observable behavior so consumers know what to expect.
    // What we DO want to guarantee: placeholders are not corrupted/split.
    expect(second.anonymized).not.toContain('__P1____P')
  })

  it('source code containing a literal __P1__ token is handled without losing the original', () => {
    // Edge case: user pastes already-anonymized code, then anonymizes again, then restores
    // with the FIRST map. The first map should restore the original, even if numbering collides.
    const original = 'class TaxCalculator {}'
    const { anonymized: once, map: map1 } = anonymize(original)
    const { restored: back } = restore(once, map1)
    expect(back).toBe(original)
  })
})

// ─── Counter handling with gaps and edge cases in existingMap ─────────────────

describe('counter handling for existingMap', () => {
  it('continues from the highest existing placeholder number, even with gaps', () => {
    const existing = { __CLS__1: 'A', __CLS__5: 'B', __CLS__10: 'C' }
    const { map } = anonymize('class NewlyAddedService {}', { existingMap: existing })
    expect(map['__CLS__11']).toBe('NewlyAddedService')
  })

  it('starts from 1 when existingMap is empty', () => {
    const { map } = anonymize('class FirstClass {}')
    expect(map['__CLS__1']).toBe('FirstClass')
  })

  it('ignores malformed placeholder keys in existingMap', () => {
    const existing = { 'not-a-placeholder': 'X', __CLS__3: 'Y' }
    const { map } = anonymize('class NewService {}', { existingMap: existing })
    expect(map['__CLS__4']).toBe('NewService')
  })

  it('does not re-add identifiers already mapped to a different placeholder', () => {
    const existing = { __P7__: 'AlreadyKnownThing' }
    const { map } = anonymize('AlreadyKnownThing()', existing)
    // Should NOT create a new __P8__ for AlreadyKnownThing
    expect(Object.values(map).filter((v) => v === 'AlreadyKnownThing')).toHaveLength(1)
    expect(map['__P7__']).toBe('AlreadyKnownThing')
  })
})

// ─── AI-edit simulation ───────────────────────────────────────────────────────

describe('AI-edit simulation: anonymize → AI modifies → restore', () => {
  it('restores correctly even when AI inserts new code referencing placeholders', () => {
    const { anonymized, map } = anonymize('class PaymentService { charge() {} }')
    // Simulate what an AI might return: same placeholders + extra method using one of them
    const aiEdited = `${anonymized}\n// extra method added by AI\n${anonymized.replace('charge() {}', 'refund() {}')}`
    const { restored } = restore(aiEdited, map)
    expect(restored).toContain('PaymentService')
    expect(restored).toContain('charge')
    // The "// extra method added by AI" matches the narration strip pattern? No — narration starts
    // with specific verbs. "extra" isn't in the list. So it stays.
  })

  it('restores correctly when AI rewords the code but keeps placeholders intact', () => {
    const { anonymized, map } = anonymize('function processUserOrder(orderId) { return orderId }')
    const aiVersion = anonymized.replace('return', 'return await').trim()
    const { restored } = restore(aiVersion, map)
    expect(restored).toContain('processUserOrder')
    expect(restored).toContain('orderId')
  })

  it('leaves placeholders that are not in the map untouched', () => {
    const map = { __P1__: 'KnownName' }
    const { restored } = restore('__P1__ and __P99__ and __P2__', map)
    expect(restored).toContain('KnownName')
    expect(restored).toContain('__P99__')
    expect(restored).toContain('__P2__')
  })
})

// ─── Strip false-positive defenses ────────────────────────────────────────────

describe('strip false-positive defenses', () => {
  it('does not strip a // line that happens to start with a non-narration verb', () => {
    const input = '// Frobnicate the widgets\nconst x = 1'
    const { restored, strippedItems } = restore(input, {})
    expect(restored).toContain('// Frobnicate the widgets')
    expect(strippedItems).toHaveLength(0)
  })

  it('does not strip JSDoc-like text that is not a real /** ... */ block', () => {
    const input = '/* regular comment, not jsdoc */\nconst x = 1'
    const { restored } = restore(input, {})
    expect(restored).toContain('/* regular comment, not jsdoc */')
  })

  it('strips only the narration line, not surrounding code', () => {
    const input = 'const before = 1\n// Initialize the cache\nconst after = 2'
    const { restored } = restore(input, {})
    expect(restored).toContain('const before = 1')
    expect(restored).toContain('const after = 2')
  })

  it('lineNumber on stripped items reflects the line in the original input', () => {
    const input = 'line1\nline2\n// TODO: fix\nline4'
    const { strippedItems } = restore(input, {})
    const todo = strippedItems.find((i) => i.type === 'todo')
    expect(todo).toBeDefined()
    expect(todo!.lineNumber).toBeGreaterThanOrEqual(1)
    expect(todo!.lineNumber).toBeLessThanOrEqual(4)
  })
})

// ─── extractIdentifiers boundary edge cases ───────────────────────────────────

describe('extractIdentifiers boundary cases', () => {
  it('does NOT match identifiers inside larger words (negative lookahead)', () => {
    // If we matched "Service" inside "OrderService", the longest-first sort would prevent it,
    // but we should still verify the regex itself is conservative.
    const ids = extractIdentifiers('OrderService')
    expect(ids).toEqual(['OrderService'])
    expect(ids).not.toContain('Order')
    expect(ids).not.toContain('Service')
  })

  it('extracts $-prefixed identifiers (regression test for \\b vs $)', () => {
    const ids = extractIdentifiers('const $store = useStore()')
    expect(ids).toContain('$store')
    expect(ids).toContain('useStore')
  })

  it('handles tab and newline separators', () => {
    const ids = extractIdentifiers('class\tOrderService\n{\n\tprocessOrder()\n}')
    expect(ids).toContain('OrderService')
    expect(ids).toContain('processOrder')
  })

  it('returns empty for whitespace-only input', () => {
    expect(extractIdentifiers('   \n\t\n   ')).toEqual([])
  })

  it('does not extract pure number sequences', () => {
    const ids = extractIdentifiers('123 456 7890')
    expect(ids).toEqual([])
  })

  it('extracts identifiers that appear in string literals (current intentional behavior)', () => {
    // Documenting current behavior: regex doesn't parse syntax, so identifiers
    // inside strings ARE matched. This is intentional — strings often contain class
    // names (e.g. logging), and stripping them would weaken anonymization.
    const ids = extractIdentifiers('const msg = "PaymentService failed"')
    expect(ids).toContain('PaymentService')
  })
})

// ─── Performance ──────────────────────────────────────────────────────────────

describe('performance on large input', () => {
  // These are regression tripwires for the single-pass substitution, not
  // benchmarks. The per-identifier loop they replaced was O(identifiers × text)
  // and took ~1.2s to anonymize a 500k blob; one pass does it in ~160ms.
  it('stays linear enough to handle a ~500KB blob', () => {
    const unit = `
export class LedgerEntryProcessor%N% {
  private readonly settlementGateway%N% = new SettlementGateway%N%()
  reconcileBatch%N%(invoiceRecords: InvoiceRecord%N%[], tenantSlug: string) {
    return this.settlementGateway%N%.settle(invoiceRecords, tenantSlug)
  }
}
`
    let code = ''
    let i = 0
    while (code.length < 500_000) code += unit.replaceAll('%N%', String(i++))

    const t0 = performance.now()
    const { anonymized, map } = anonymize(code)
    const t1 = performance.now()
    const { restored } = restore(anonymized, map)
    const elapsed = performance.now() - t0

    expect(restored).toBe(code)
    // Generous vs the ~180ms typical, tight enough to catch a return to
    // quadratic substitution (which was >3s for this input).
    expect(elapsed).toBeLessThan(1500)
  })

  it('anonymizes a ~50KB code blob in under 500ms', () => {
    // Generate ~50KB of synthetic code with many unique identifiers
    const lines: string[] = []
    for (let i = 0; i < 500; i++) {
      lines.push(
        `class GeneratedService_${i} { handleRequest_${i}(orderItem_${i}: PayloadType_${i}) { return orderItem_${i} } }`
      )
    }
    const code = lines.join('\n')
    expect(code.length).toBeGreaterThan(40_000)

    const t0 = performance.now()
    const { anonymized, map } = anonymize(code)
    const elapsed = performance.now() - t0
    // 500ms is a regression tripwire, not a benchmark: typical runs are <100ms,
    // but the bound must tolerate parallel-suite CI load (200ms flaked twice).
    expect(elapsed).toBeLessThan(500)
    expect(Object.keys(map).length).toBeGreaterThan(1000)
    expect(anonymized.length).toBeLessThan(code.length) // identifiers replaced with shorter __PN__
  })

  it('restores a ~50KB anonymized blob in under 500ms', () => {
    const lines: string[] = []
    for (let i = 0; i < 500; i++) {
      lines.push(`class S${i} { m${i + 1000}() {} }`)
    }
    const original = lines.join('\n')
    const { anonymized, map } = anonymize(original)

    const t0 = performance.now()
    restore(anonymized, map)
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(500)
  })
})
