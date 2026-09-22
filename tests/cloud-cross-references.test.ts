import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The legal set is two documents, and what it says about Cloud stays true.
 *
 * ── Two documents, not four ─────────────────────────────────────────────────
 *
 * The Cookie & Local Storage Notice and the Acceptable Use Policy were folded
 * into Privacy and Terms §5. Both said less than the section that replaced
 * them: CE sets no cookies at all, so a Cookie Policy was a page explaining an
 * absence, and half the AUP restated licence terms. That is also the shape
 * counsel gave the Cloud set — acceptable use is Cloud Terms §9, cookies are
 * Cloud Privacy §13 — so the two editions now describe themselves the same way.
 *
 * ── The cross-references ────────────────────────────────────────────────────
 *
 * CE's notices point at the equivalent Cloud position, which creates a
 * dependency on a repository this one cannot see. When Cloud retired its
 * standalone AUP and Cookie Policy, two sentences here quietly became false —
 * and kept WORKING, because Cloud redirects a retired slug rather than 404ing
 * it. A link that resolves while its sentence lies is worse than a dead one,
 * because nobody goes looking.
 *
 * One-way by necessity: this repository cannot enumerate Cloud's documents, so
 * it pins the retirements that have actually happened.
 */

const LEGAL_DIR = 'public/legal'

/** Cloud slugs that no longer name a document of their own. */
const RETIRED_IN_CLOUD = {
  aup: 'acceptable use is Cloud Terms §9',
  cookies: 'cookie and storage information is Cloud Privacy §13',
} as const

/** CE slugs that no longer name a file, and the section that absorbed each. */
const RETIRED_IN_CE = {
  aup: 'terms',
  cookies: 'privacy',
} as const

function legalDocs(): { name: string; text: string }[] {
  return readdirSync(LEGAL_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((name) => ({ name, text: readFileSync(join(LEGAL_DIR, name), 'utf8') }))
}

describe('the CE legal set', () => {
  it('is exactly Terms and Privacy', () => {
    expect(legalDocs().map((d) => d.name).sort()).toEqual(['privacy.md', 'terms.md'])
  })

  it('no longer ships the documents that were folded in', () => {
    for (const slug of Object.keys(RETIRED_IN_CE)) {
      expect(existsSync(join(LEGAL_DIR, `${slug}.md`)), `${slug}.md should be gone`).toBe(false)
    }
  })

  it('kept the content rather than only deleting the files', () => {
    // The point of folding is that nothing is LOST. These are the load-bearing
    // sentences from each retired notice; if a future edit trims the section
    // away, this fails rather than quietly shrinking what CE discloses.
    const terms = readFileSync(join(LEGAL_DIR, 'terms.md'), 'utf8')
    expect(terms).toMatch(/Weaponize anonymization/i)
    expect(terms).toMatch(/no account for us to suspend/i)
    expect(terms).toMatch(/abuse@veilio\.dev/)

    const privacy = readFileSync(join(LEGAL_DIR, 'privacy.md'), 'utf8')
    expect(privacy).toMatch(/sets no cookies/i)
    expect(privacy).toMatch(/consent banner is not required/i)
    expect(privacy).toMatch(/localStorage/)
  })

  it('never links a retired Cloud document as though it still existed', () => {
    const offenders: string[] = []
    for (const { name, text } of legalDocs()) {
      for (const [slug, replacement] of Object.entries(RETIRED_IN_CLOUD)) {
        if (new RegExp(`veilio\\.dev/legal/${slug}\\b`).test(text)) {
          offenders.push(`${name} still points at Cloud /legal/${slug} — ${replacement}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('never links a retired CE document either', () => {
    const offenders: string[] = []
    for (const { name, text } of legalDocs()) {
      for (const slug of Object.keys(RETIRED_IN_CE)) {
        // Relative (`./aup.md`) or routed (`/legal/aup`) — both are dead now.
        if (new RegExp(`\\./${slug}\\.md|/legal/${slug}\\b`).test(text)) {
          offenders.push(`${name} still links CE ${slug}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('still tells a reader where Cloud says the same thing', () => {
    // The opposite failure, and the reason the rules above are not "delete
    // every link to Cloud": a CE notice that mentions Cloud without saying
    // where Cloud's position is leaves the reader worse off than a stale link.
    const terms = readFileSync(join(LEGAL_DIR, 'terms.md'), 'utf8')
    const privacy = readFileSync(join(LEGAL_DIR, 'privacy.md'), 'utf8')

    expect(terms).toMatch(/veilio\.dev\/legal\/terms/)
    expect(terms).toMatch(/§9/)
    expect(privacy).toMatch(/veilio\.dev\/legal\/privacy/)
    expect(privacy).toMatch(/§13/)
  })
})
