import { describe, it, expect } from 'vitest'
import { anonymize, restore } from '../src/engine.js'

// A Node stack trace mixes two authors. The user's code supplies function
// names, paths and its own error messages - masked as before. Node supplies
// the fixed wording of its error messages and its own internal frames, which
// name nothing of the user's: masking them only made the trace unreadable
// (`TypeError: __CLS__2 __VAR__19 __VAR__10 of undefined`).

const CODE = [
  'const customerRecord = loadCustomer(customerId)',
  'customerRecord.chargeCard(invoiceTotal)',
].join('\n')
const code = anonymize(CODE)
const ph = (name: string): string => {
  const found = Object.keys(code.map).find((k) => code.map[k] === name)
  if (!found) throw new Error(`${name} has no placeholder`)
  return found
}
// A whole Node trace auto-detects as TypeScript; a single frame line can read
// as Java, whose built-in list has no `Promise`. Pin it so each case tests the
// trace rules, not the detector.
const mask = (trace: string) => anonymize(trace, { existingMap: code.map, language: 'typescript' })

// Every word V8 contributes to the messages below. None may enter the map.
const TEMPLATE_WORDS = [
  'Cannot',
  'read',
  'properties',
  'reading',
  'setting',
  'defined',
  'iterable',
  'constructor',
  'access',
  'before',
  'initialization',
  'Assignment',
  'constant',
  'variable',
  'destructure',
  'property',
  'Maximum',
  'call',
  'size',
  'exceeded',
  'return',
  'value',
]

// [header as V8 writes it, with SLOT where the user's name goes]
const TEMPLATES: ReadonlyArray<readonly [string, string]> = [
  ['TypeError', "Cannot read properties of undefined (reading 'SLOT')"],
  ['TypeError', "Cannot read properties of null (reading 'SLOT')"],
  ['TypeError', "Cannot set properties of undefined (setting 'SLOT')"],
  ['TypeError', 'SLOT is not a function'],
  ['TypeError', 'SLOT is not a function or its return value is not iterable'],
  ['TypeError', 'SLOT is not a constructor'],
  ['TypeError', 'SLOT is not iterable'],
  ['ReferenceError', 'SLOT is not defined'],
  ['ReferenceError', "Cannot access 'SLOT' before initialization"],
  ['TypeError', "Cannot destructure property 'SLOT' of 'customerRecord' as it is undefined."],
]

describe('V8 error messages keep their wording', () => {
  it.each(TEMPLATES)('%s: %s', (cls, template) => {
    const real = `${cls}: ${template.replace('SLOT', 'chargeCard')}`
    const masked = mask(real)
    expect(masked.anonymized).toBe(
      `${cls}: ${template.replace('SLOT', ph('chargeCard'))}`.replace(
        "'customerRecord'",
        `'${ph('customerRecord')}'`
      )
    )
    expect(restore(masked.anonymized, masked.map).restored).toBe(real)
  })

  it('messages with no name in them are left whole', () => {
    for (const real of [
      'TypeError: Assignment to constant variable.',
      'RangeError: Maximum call stack size exceeded',
    ]) {
      expect(mask(real).anonymized).toBe(real)
    }
  })

  it('masks every name in a dotted slot with the placeholder from the code', () => {
    const masked = mask('TypeError: customerRecord.chargeCard is not a function')
    expect(masked.anonymized).toBe(
      `TypeError: ${ph('customerRecord')}.${ph('chargeCard')} is not a function`
    )
  })

  it('puts none of V8’s words into the map', () => {
    const all = TEMPLATES.map(([cls, t]) => `${cls}: ${t.replace('SLOT', 'chargeCard')}`)
    all.push(
      'TypeError: Assignment to constant variable.',
      'RangeError: Maximum call stack size exceeded'
    )
    const masked = mask(all.join('\n'))
    const values = Object.values(masked.map)
    for (const word of TEMPLATE_WORDS) expect(values).not.toContain(word)
  })

  it('applies to a custom error class but masks the class name', () => {
    const masked = mask(
      "PaymentDeclinedError: Cannot read properties of undefined (reading 'chargeCard')"
    )
    expect(masked.anonymized).toMatch(
      new RegExp(
        `^__\\w+__\\d+: Cannot read properties of undefined \\(reading '${ph('chargeCard')}'\\)$`
      )
    )
  })

  it('applies after "Uncaught "', () => {
    expect(mask('Uncaught TypeError: chargeCard is not a function').anonymized).toBe(
      `Uncaught TypeError: ${ph('chargeCard')} is not a function`
    )
  })
})

describe('what stays masked', () => {
  it('a message the user’s own code throws', () => {
    const masked = mask('Error: missing paymentMethod for Acme')
    for (const word of ['missing', 'paymentMethod', 'Acme']) {
      expect(masked.anonymized).not.toContain(word)
    }
  })

  it('a message that only starts like V8’s', () => {
    const masked = mask(
      "TypeError: Cannot read properties of undefined (reading 'chargeCard') for customerAcme"
    )
    expect(masked.anonymized).not.toContain('properties')
    expect(masked.anonymized).not.toContain('customerAcme')
  })

  it('V8 wording that is not at the start of a line', () => {
    const masked = mask("log('TypeError: chargeCard is not defined')")
    expect(masked.anonymized).not.toContain('defined')
  })

  it('a frame in the user’s own file, path included', () => {
    const masked = mask('    at chargeCustomer (/srv/app/src/billing/invoice.js:6:10)')
    for (const word of ['chargeCustomer', 'billing', 'invoice']) {
      expect(masked.anonymized).not.toContain(word)
    }
    expect(masked.anonymized).toContain(':6:10)')
  })

  it('a user function evaluated as <anonymous>', () => {
    const masked = mask('    at chargeCustomer (<anonymous>)')
    expect(masked.anonymized).not.toContain('chargeCustomer')
    expect(masked.anonymized).toContain('(<anonymous>)')
  })
})

describe('the spans are positions in the whole text', () => {
  it('a name after a quoted string on a later line is still masked', () => {
    // Each string literal is its own segment; a span check that forgot the
    // segment's offset would test `customerRecord` against the `Uncaught ` span.
    const masked = mask("Uncaught TypeError: chargeCard is not a function\nlog('customerRecord')")
    expect(masked.anonymized).not.toContain('customerRecord')
  })

  it('V8’s word stays even when the code uses the same word as a name', () => {
    const own = anonymize('const defined = isReady(properties)', { language: 'typescript' })
    const masked = anonymize(
      [
        'ReferenceError: chargeCard is not defined',
        "TypeError: Cannot read properties of null (reading 'chargeCard')",
        'const ready = defined && properties',
      ].join('\n'),
      { existingMap: own.map, language: 'typescript' }
    )
    const [first, second, third] = masked.anonymized.split('\n')
    expect(first).toMatch(/ is not defined$/)
    expect(second).toMatch(/^TypeError: Cannot read properties of null/)
    expect(third).not.toContain('defined')
    expect(third).not.toContain('properties')
  })

  it('an unquoted slot is one expression, not a phrase', () => {
    const masked = mask('TypeError: customer Acme is not defined')
    expect(masked.anonymized).not.toContain('defined')
    expect(masked.anonymized).not.toContain('Acme')
  })
})

describe('Node’s own frames stay as Node wrote them', () => {
  it.each([
    '    at Script.runInContext (node:vm:149:12)',
    '    at Module._compile (node:internal/modules/cjs/loader:1554:14)',
    '    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:646:26)',
    '    at node:internal/main/run_main_module:36:49',
    '    at async node:internal/main/run_main_module:36:49',
    '    at new Promise (<anonymous>)',
    '    at Array.forEach (<anonymous>)',
    '    at async Promise.all (index 0)',
  ])('%s', (frame) => {
    const masked = mask(frame)
    expect(masked.anonymized).toBe(frame)
  })

  it('keeps <anonymous> on a user frame and masks the path', () => {
    const masked = mask('    at Object.<anonymous> (/srv/app/src/billing/invoice.js:8:1)')
    expect(masked.anonymized).toContain('Object.<anonymous> (/')
    expect(masked.anonymized).not.toContain('billing')
  })
})

describe('a masked trace is stable', () => {
  const TRACE = [
    "TypeError: Cannot read properties of undefined (reading 'chargeCard')",
    '    at chargeCustomer (/srv/app/src/billing/invoice.js:6:10)',
    '    at Object.<anonymous> (/srv/app/src/billing/invoice.js:8:1)',
    '    at Module._compile (node:internal/modules/cjs/loader:1554:14)',
  ].join('\n')

  it('masking it again with its own map changes nothing', () => {
    const once = mask(TRACE)
    const twice = anonymize(once.anonymized, { existingMap: once.map, language: 'typescript' })
    expect(twice.anonymized).toBe(once.anonymized)
  })

  it('restores character for character', () => {
    const once = mask(TRACE)
    expect(restore(once.anonymized, once.map).restored).toBe(TRACE)
  })
})
