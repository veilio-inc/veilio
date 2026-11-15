import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { anonymize, restore } from '../src/index.js'
import type { AnonymizeOptions } from '../src/types.js'
import { baselineRows, veiled } from './fixtures/baseline-corpus.js'
import { EXCEPTIONS, REASONS } from './fixtures/baseline-exceptions.js'
import { SYNTAXES, VALUES } from './fixtures/syntax-corpus.js'
import { HELD, ROWS as MARKS } from './fixtures/manual-marks.js'

// What a masking change may alter is listed, row by row, in
// fixtures/baseline-exceptions.ts. Everything else in the corpus must come out
// exactly as the published 1.19.1 gave it (fixtures/baseline-1.19.1.json,
// recorded once from the registry package by baseline-1.19.1.gen.mjs).

interface Answer {
  options: AnonymizeOptions
  anonymized: string
  map: Record<string, string>
  language: string
  languageFallback: boolean
  comments: unknown
  restored: string
}

const BASE: { engine: { version: string; shasum: string }; rows: Record<string, Answer[]> } =
  JSON.parse(readFileSync(new URL('./fixtures/baseline-1.19.1.json', import.meta.url), 'utf8'))

const rows = baselineRows({ syntaxes: SYNTAXES, values: VALUES, marks: MARKS, held: HELD })
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const id = (row: string, options: AnonymizeOptions): string => `${row} ${JSON.stringify(options)}`
const excepted = new Map(EXCEPTIONS.map((e) => [id(e.row, e.options), e]))

/** Every run of eight characters of `secret` (the whole of a shorter one). */
const slices = (secret: string): string[] =>
  secret.length <= 8
    ? [secret]
    : Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8))

describe('masking is what the published 1.19.1 gave, but for the listed rows', () => {
  it('is a record of the published package', () => {
    expect(BASE.engine.version).toBe('1.19.1')
    expect(BASE.engine.shasum).toMatch(/^[0-9a-f]{40}$/)
  })

  it('has an answer for every row and option set, and no stale one', () => {
    expect(Object.keys(BASE.rows)).toEqual(rows.map((r) => r.name))
    for (const { name, options } of rows)
      expect(BASE.rows[name]!.map((a) => a.options)).toEqual(plain(options))
  })

  it('lists only rows and option sets of the corpus, each once, with a reason', () => {
    const known = new Set(rows.flatMap((r) => r.options.map((o) => id(r.name, o))))
    expect(EXCEPTIONS.map((e) => id(e.row, e.options)).filter((e) => !known.has(e))).toEqual([])
    expect(excepted.size).toBe(EXCEPTIONS.length)
    for (const e of EXCEPTIONS) {
      expect(REASONS).toContain(e.reason)
      expect(e.why).not.toBe('')
    }
  })

  describe.each(rows)('$name', ({ name, code, options, names = [], secrets = [] }) => {
    it.each(options.map((o, i) => [JSON.stringify(o), o, i] as const))('%s', (_, given, i) => {
      const { anonymized, map, language, languageFallback, comments } = anonymize(code, given)
      const { restored } = restore(anonymized, map)
      const answer = veiled(
        { options: given, anonymized, map, language, languageFallback, comments, restored },
        secrets
      )
      const recorded = BASE.rows[name]![i]!
      if (!excepted.has(id(name, given))) {
        expect(answer).toEqual(recorded)
        return
      }
      // A listed row: it differs (a stale entry fails), and toward masking.
      expect(answer).not.toEqual(recorded)
      for (const planted of names)
        expect(anonymized).not.toMatch(new RegExp(`(?<![\\w$])${planted}(?![\\w$])`))
      const held = Object.values(map).join('\n')
      for (const secret of secrets)
        for (const slice of slices(secret)) expect(held.includes(slice)).toBe(false)
      if (!anonymized.includes('__REDACTED_')) expect(restored).toBe(code)
    })
  })
})
