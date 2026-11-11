import { describe, expect, it } from 'vitest'
import { applyMap, NO_CONTEXT, scrubSource } from '../../plugins/veilio-guard/lib/scrub.ts'

// The guard's copy of the engine masks a name the map holds in a comment, and
// the guard's own pass over that text then finds nothing left to mask.

const PROBE = `/** QuasarLedgerReconciler settles Globex invoices via settleInvoice */
export class QuasarLedgerReconciler {
  // calls settleInvoice for AcmePay
  settleInvoice() { return 1 } // QuasarLedgerReconciler inline
}
`

describe('a file read: names in comments', () => {
  it('the engine copy masks them, and the second pass masks nothing twice', () => {
    const { text, additions } = scrubSource(PROBE, {}, 'typescript')
    expect(text).not.toContain('QuasarLedgerReconciler')
    expect(text).not.toContain('settleInvoice')
    expect(text).toContain('// calls __FN__1 for AcmePay')
    const again = applyMap(text, additions, NO_CONTEXT, { scanned: true })
    expect(again).toBe(text)
    expect(again).not.toContain('____')
  })
})
