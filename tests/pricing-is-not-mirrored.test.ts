import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * CE quotes exactly one price, and it is its own.
 *
 * This page used to mirror Cloud's tiers by hand, under a comment insisting
 * that "the tiers have to agree - two editions quoting different plans is worse
 * than either being wrong alone". They did not agree. When this was written the
 * page carried THREE inconsistent price sets simultaneously:
 *
 *   the cards   Individual €9,  Team €19
 *   the FAQ     Individual $3,  Pro $9,  Team €19
 *   reality     Individual €3,  Team €16   (live Stripe tiers, read by Cloud)
 *
 * - plus `Pro`, a tier ROADMAP E12 deleted; map ceilings an earlier comment had
 * itself flagged as stale "in the direction that oversells"; and a 99.9% SLA
 * that Cloud removed under a test forbidding its return.
 *
 * The mirroring did not fail through carelessness. It fails because no
 * mechanism could make it succeed: Cloud reads its prices live from Stripe, and
 * CE cannot read anything. CE publishes - and the server's CSP plus
 * `e2e/security.spec.ts` enforce - that it "contacts no third-party origin at
 * any point" and "works unchanged in air-gapped deployments". Syncing with
 * veilio.dev would break the property the product exists to have.
 *
 * So there is one source of truth and it is Cloud. CE describes the paid tiers
 * by what they DO, and links out for what they COST.
 *
 * Paths resolve from the vitest root.
 */

const PRICING_PAGE = 'src/pages/PricingPage.tsx'

/** The file with comments blanked - prose about this rule quotes what it forbids. */
function code(): string {
  return readFileSync(PRICING_PAGE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('CE does not mirror Cloud pricing', () => {
  it('quotes no currency amount except its own zero', () => {
    const amounts = [...code().matchAll(/[$€£]\s?\d[\d.,]*/g)].map((m) => m[0].trim())
    // `$0` is CE's own price: it is the thing you are running, and it cannot go
    // stale because it is not a price anyone charges.
    expect(amounts.filter((a) => !/^\$\s?0$/.test(a))).toEqual([])
  })

  it('quotes no per-seat or per-month rate', () => {
    expect(code()).not.toMatch(/\bper seat\b|\/\s?mo\b|per user\b/i)
  })

  it('names no numeric product limit it cannot verify', () => {
    // "up to 200 maps", "2,000 maps" - ceilings live in Cloud's own
    // configuration, and every previous number here was wrong by the time
    // somebody checked.
    expect(code()).not.toMatch(/\b[\d,]+\s+maps\b/i)
  })

  it('makes no service-level promise', () => {
    // Cloud removed "99.9% SLA" and pinned its absence with a test. A claim
    // deleted in one edition and left standing in the other is the same
    // overclaim, just harder to find.
    expect(code()).not.toMatch(/\d+(\.\d+)?\s?%\s?(uptime|SLA)|SLA-backed/i)
  })

  it('does not advertise a tier that no longer exists', () => {
    // ROADMAP E12 merged Individual and Pro. The FAQ was still selling Pro.
    expect(code()).not.toMatch(/\bPro\b\s*\(|\bPro\b\s*\$|Everything in Pro/)
  })

  it('still sends the reader somewhere a real price lives', () => {
    // The opposite failure: removing the numbers and saying nothing would leave
    // a visitor who wants to buy with nowhere to go, which is worse than a
    // stale figure.
    const text = readFileSync(PRICING_PAGE, 'utf8')
    expect(text).toMatch(/CLOUD_URL/)
    expect(text).toMatch(/Priced on Veilio Cloud/)
  })

  it('finds pricing content to check, so a broken matcher cannot pass vacuously', () => {
    expect(code()).toMatch(/const PLANS/)
    expect(code().length).toBeGreaterThan(2000)
  })
})
