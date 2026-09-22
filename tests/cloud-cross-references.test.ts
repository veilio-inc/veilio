import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What CE says about Cloud's documents stays true when Cloud's change.
 *
 * CE's notices are deliberately scoped to CE, and each one points at the
 * equivalent Cloud document so a reader who arrived at the wrong edition is not
 * stranded. That is right, and it creates a dependency on a repository this one
 * cannot see: when Cloud published its counsel-reviewed set, it RETIRED the
 * standalone Acceptable Use Policy and Cookie Policy — acceptable use became
 * Terms §9, cookies became Privacy §13.
 *
 * Both URLs still resolve, because Cloud redirects a retired slug to whatever
 * superseded it rather than dropping the reader on its home page. So nothing
 * 404s, nothing looks broken, and two sentences here quietly became false:
 * CE claimed Cloud "has its own" Cookie Policy and "its own, fuller" AUP. A
 * link that works while its sentence lies is worse than a dead one, because
 * nobody goes looking.
 *
 * This is a one-way check by necessity — CE cannot enumerate Cloud's documents
 * — so it pins the retirements that have actually happened rather than trying
 * to verify the whole set. Adding a slug here is the price of Cloud retiring
 * one, and it is a cheap price for the sentence staying honest.
 */

const LEGAL_DIR = 'public/legal'

/** Cloud slugs that no longer name a document of their own. */
const RETIRED = {
  aup: 'acceptable use is Cloud Terms §9',
  cookies: 'cookie and storage information is Cloud Privacy §13',
} as const

function legalDocs(): { name: string; text: string }[] {
  return readdirSync(LEGAL_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((name) => ({ name, text: readFileSync(join(LEGAL_DIR, name), 'utf8') }))
}

describe('cross-references to Veilio Cloud', () => {
  it('finds documents to check, so a broken path cannot pass vacuously', () => {
    expect(legalDocs().length).toBeGreaterThan(2)
  })

  it('never links a retired Cloud document as though it still existed', () => {
    const offenders: string[] = []
    for (const { name, text } of legalDocs()) {
      for (const [slug, replacement] of Object.entries(RETIRED)) {
        // The bare URL, in a link or in prose. A redirect makes this work and
        // does not make it true.
        if (new RegExp(`veilio\\.dev/legal/${slug}\\b`).test(text)) {
          offenders.push(`${name} still points at /legal/${slug} — ${replacement}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('still tells a reader where Cloud says the same thing', () => {
    // The opposite failure, and the reason the rule above is not "delete every
    // link to Cloud": a CE notice that mentions Cloud without saying where
    // Cloud's position is leaves the reader worse off than the stale link did.
    const aup = readFileSync(join(LEGAL_DIR, 'aup.md'), 'utf8')
    const cookies = readFileSync(join(LEGAL_DIR, 'cookies.md'), 'utf8')

    expect(aup).toMatch(/veilio\.dev\/legal\/terms/)
    expect(aup).toMatch(/§9/)
    expect(cookies).toMatch(/veilio\.dev\/legal\/privacy/)
    expect(cookies).toMatch(/§13/)
  })
})
