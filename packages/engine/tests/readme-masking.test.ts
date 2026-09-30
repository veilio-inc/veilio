import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { anonymize } from '../src/index.js'

/**
 * "What it hides, and what it does not" in the README, against the engine.
 *
 * A reader decides whether to trust this tool from that list, so each line of it
 * is run here: what it says is masked must come out masked, and what it says goes
 * out as written must come out as written. A change to masking that makes the
 * list wrong fails this, instead of leaving the README making a claim the code
 * no longer keeps - in either direction.
 */
const README = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8')
const SECTION = README.slice(
  README.indexOf('## What it hides, and what it does not'),
  README.indexOf('\n## ', README.indexOf('## What it hides, and what it does not') + 1)
)

const SOURCE = `import { refund } from './billing/stripe-refunds'
// Retries a failed Stripe refund for Acme
export class PaymentGateway {
  async refundInvoice(invoiceId: string, ab: number) {
    const ACME_TENANT_ID = 4411
    const key = process.env.ACME_API_KEY
    const url = \`/api/refunds/\${invoiceId}\`
    if (!url) throw new Error('Refund failed for customer')
    return db.query('SELECT amount FROM customer_invoices WHERE id = $1', [invoiceId, ab, key, ACME_TENANT_ID])
  }
}`
const out = anonymize(SOURCE).anonymized

describe('the README section exists', () => {
  it('is there, and is what the other READMEs link to', () => {
    expect(SECTION.length).toBeGreaterThan(100)
  })
})

describe('what it says is masked, is', () => {
  it.each(['PaymentGateway', 'refundInvoice', 'invoiceId'])('identifier %s', (name) => {
    expect(out).not.toContain(name)
  })

  it.each(['billing', 'stripe', 'refunds'])('the import path word %s', (word) => {
    expect(out).not.toMatch(new RegExp(`from '[^']*${word}`))
  })

  it.each([
    ['a URL path', 'refunds/'],
    ['an error message', 'Refund failed'],
    ['a SQL table name', 'customer_invoices'],
    ['a SQL column name', 'SELECT amount'],
  ])('the words of %s', (_what, text) => {
    expect(out).not.toContain(text)
  })
})

describe('what it says goes out as written, does', () => {
  it('comments', () => {
    expect(SECTION).toMatch(/\*\*comments\*\*/)
    expect(out).toContain('// Retries a failed Stripe refund for Acme')
  })

  it.each(['ACME_TENANT_ID', 'process.env.ACME_API_KEY'])(
    'names written entirely in capitals: %s, the README example',
    (name) => {
      expect(SECTION).toContain(name)
      expect(out).toContain(name)
    }
  )

  it('names of one or two characters', () => {
    expect(SECTION).toMatch(/one or two characters/)
    expect(out).toMatch(/\bab\b/)
  })

  it('numbers, and the structure of SQL', () => {
    expect(SECTION).toMatch(/numbers/)
    expect(out).toContain('4411')
    expect(out).toMatch(/SELECT __STR__\d+ FROM __STR__\d+ WHERE id = \$1/)
  })
})
