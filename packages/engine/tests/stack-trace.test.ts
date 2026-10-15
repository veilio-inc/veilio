import { describe, it, expect } from 'vitest'
import { runInNewContext } from 'node:vm'
import { anonymize, restore } from '../src/engine.js'

// The workflow a stack trace takes: the code was masked earlier in the session,
// it crashed, and the trace is masked with the SAME map before the agent sees
// it. The agent must be able to tie each frame to the function it read, find
// the line, and hand an answer back that restores to the real trace.

const CODE = `function calculateInvoiceTotal(lineItems, taxRate) {
  const subtotal = lineItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
  return Math.round(subtotal * (1 + taxRate) * 100) / 100
}
function chargeCustomer(customerRecord) {
  return calculateInvoiceTotal(customerRecord.lineItems, customerRecord.taxRate)
}
chargeCustomer({ taxRate: 0.23 })
`

function realTrace(): string {
  try {
    runInNewContext(CODE, {}, { filename: '/srv/app/src/billing/invoice.js' })
  } catch (e) {
    return (e as Error).stack as string
  }
  throw new Error('the fixture was meant to throw')
}

// Copied from a real Node 26 trace: V8 names an accessor frame after the
// property, so `__proto__` turns up in traces of code that never wrote it.
const LOADER_FRAME =
  '    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:646:26)'

const positions = (text: string): string[] => text.match(/:\d+:\d+/g) ?? []

describe('a stack trace masked with the code’s map', () => {
  const code = anonymize(CODE)
  const trace = `${realTrace()}\n${LOADER_FRAME}`
  const masked = anonymize(trace, { existingMap: code.map })

  it('names each user frame with the placeholder the agent saw in the code', () => {
    const placeholderOf = (name: string) =>
      Object.keys(code.map).find((ph) => code.map[ph] === name) as string
    expect(masked.anonymized).toContain(`at ${placeholderOf('calculateInvoiceTotal')} (`)
    expect(masked.anonymized).toContain(`at ${placeholderOf('chargeCustomer')} (`)
    expect(code.anonymized).toContain(`function ${placeholderOf('chargeCustomer')}(`)
  })

  it('keeps every line:column exactly where the trace put it', () => {
    expect(positions(trace).length).toBeGreaterThan(3)
    expect(positions(masked.anonymized)).toEqual(positions(trace))
  })

  it('points at the same line in the masked code as in the real code', () => {
    const line = Number(/invoice\.js:(\d+):\d+\)/.exec(trace)?.[1])
    const maskedLine = code.anonymized.split('\n')[line - 1]
    expect(restore(maskedLine, code.map).restored).toBe(CODE.split('\n')[line - 1])
  })

  it('does not leak a real function name into the masked trace', () => {
    for (const name of ['calculateInvoiceTotal', 'chargeCustomer', 'lineItems', 'billing']) {
      expect(masked.anonymized).not.toContain(name)
    }
  })

  it('reads as Node wrote it, apart from the user’s names and paths', () => {
    const placeholderOf = (name: string) =>
      Object.keys(code.map).find((ph) => code.map[ph] === name) as string
    expect(masked.anonymized).toContain(
      "TypeError: Cannot read properties of undefined (reading 'reduce')"
    )
    expect(masked.anonymized).toContain('    at Script.runInContext (node:vm:')
    expect(masked.anonymized).toContain(LOADER_FRAME)
    expect(code.anonymized).toContain(
      `return Math.round(${placeholderOf('subtotal')} * (1 + ${placeholderOf('taxRate')}) * 100) / 100`
    )
  })

  it('restores to the real trace, character for character', () => {
    expect(masked.anonymized).not.toContain('[object Object]')
    expect(restore(masked.anonymized, masked.map).restored).toBe(trace)
  })
})
