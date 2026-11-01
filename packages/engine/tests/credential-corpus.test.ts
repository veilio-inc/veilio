import { describe, it, expect } from 'vitest'
import { anonymize, credentialSpans } from '../src/index.js'
import type { AnonymizeOptions } from '../src/index.js'
import { SYNTAXES, VALUES } from './fixtures/syntax-corpus.js'

// Security review, round 4 (C): every syntax of the corpus, with every value,
// with its path and with none, in every mode. (1) The value is never readable
// - except where a rule found it and `warn` or `off` leaves it as written, by
// the user's choice (founder ruling). (2) It is never in the map, in any mode.

const MODES = ['redact', 'warn', 'off'] as const

describe(`the syntax corpus: ${SYNTAXES.length} formats`, () => {
  it('covers at least 40 formats', () => {
    expect(new Set(SYNTAXES.map((s) => s.format)).size).toBeGreaterThanOrEqual(40)
  })

  for (const c of SYNTAXES)
    for (const withPath of [true, false])
      it(`${c.format}${withPath ? ` (${c.path})` : ' (no path)'}`, () => {
        const failures: string[] = []
        for (const value of VALUES) {
          const text = c.text(value)
          const at = text.indexOf(value)
          const where: AnonymizeOptions = withPath ? { path: c.path } : {}
          const ruled = credentialSpans(text, withPath ? { path: c.path } : {}).some(
            (s) => s.start <= at && at < s.end
          )
          // Not vacuous: the value is in the text, and something stands in its place.
          if (at === -1) failures.push(`${value}: not in the text`)
          for (const secrets of MODES) {
            const r = anonymize(text, { ...where, secrets })
            if (!r.anonymized.includes(value) && !/__[A-Z][A-Z0-9_]*__/.test(r.anonymized))
              failures.push(`${secrets} ${value}: removed without a placeholder`)
            const readable = r.anonymized.includes(value)
            if (readable && (secrets === 'redact' || !ruled))
              failures.push(`${secrets} ${value}: readable: ${JSON.stringify(r.anonymized)}`)
            if (
              Object.values(r.map).some(
                (v) => v.includes(value) || (value.includes(v) && v.length > 3)
              )
            )
              failures.push(`${secrets} ${value}: in the map: ${JSON.stringify(r.map)}`)
          }
        }
        expect(failures).toEqual([])
      })
})
