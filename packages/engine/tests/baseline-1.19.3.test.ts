import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { anonymize, fileKindOf, languageOfPath, restore } from '../src/index.js'
import type { AnonymizeOptions } from '../src/types.js'
import { baselineRows, redactionCount, veiled } from './fixtures/baseline-corpus.js'
import { EXCEPTIONS, REASONS, REPOSITORY_EXCEPTIONS } from './fixtures/baseline-exceptions.js'
import { SYNTAXES, VALUES } from './fixtures/syntax-corpus.js'
import { HELD, ROWS as MARKS } from './fixtures/manual-marks.js'

// What a masking change may alter is listed, row by row, in
// fixtures/baseline-exceptions.ts. Everything else in the corpus must come out
// exactly as the published 1.19.3 gave it (fixtures/baseline-1.19.3.json,
// recorded once from the registry package by baseline-1.19.3.gen.mjs).

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
  JSON.parse(readFileSync(new URL('./fixtures/baseline-1.19.3.json', import.meta.url), 'utf8'))

const rows = baselineRows({ syntaxes: SYNTAXES, values: VALUES, marks: MARKS, held: HELD })
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const id = (row: string, options: AnonymizeOptions): string => `${row} ${JSON.stringify(options)}`
const excepted = new Map(EXCEPTIONS.map((e) => [id(e.row, e.options), e]))

/** Every run of eight characters of `secret` (the whole of a shorter one). */
const slices = (secret: string): string[] =>
  secret.length <= 8
    ? [secret]
    : Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8))

describe('masking is what the published 1.19.3 gave, but for the listed rows', () => {
  it('is a record of the published package', () => {
    expect(BASE.engine.version).toBe('1.19.3')
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

  // The limits on what a map may hold change nothing in masking: the rows
  // with a long value are in the record, and no row is excepted.
  it('holds the long-value rows, and nothing is excepted', () => {
    expect(rows.filter((r) => r.name.startsWith('long: '))).toHaveLength(12)
    expect(EXCEPTIONS).toEqual([])
    expect(REPOSITORY_EXCEPTIONS).toEqual({})
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
      // A token glued to a flag (`-p<token>`) is masked with it as one word:
      // the token then shows only once restored.
      if (!`${anonymized}${restored}`.includes('__REDACTED_')) expect(restored).toBe(code)
    })
  })
})

// A new rule must not redact ordinary text one-way: every tracked file of this
// repository still as the published 1.19.3 saw it (baseline-1.19.3.repo.json,
// by its digest) holds as many redaction tokens as that package left in it,
// but for the files listed in baseline-exceptions.ts. A file edited since is
// not held to its old count.
describe('the repository itself gains no redaction but in the listed files', () => {
  const REPO: { engine: { version: string }; files: Record<string, [string, number]> } = JSON.parse(
    readFileSync(new URL('./fixtures/baseline-1.19.3.repo.json', import.meta.url), 'utf8')
  )
  const root = new URL('../../../', import.meta.url)
  const read = (path: string): string | null => {
    try {
      return readFileSync(new URL(path, root), 'utf8')
    } catch {
      return null
    }
  }
  const digest = (text: string): string =>
    createHash('sha256').update(text).digest('hex').slice(0, 16)

  it('is a record of the published package', () => {
    expect(REPO.engine.version).toBe('1.19.3')
    expect(Object.keys(REPO.files).length).toBeGreaterThan(500)
  })

  it('lists only recorded files, each with a reason and a count', () => {
    for (const [path, { more, reason }] of Object.entries(REPOSITORY_EXCEPTIONS)) {
      expect(REPO.files[path], path).toBeDefined()
      expect(REASONS).toContain(reason)
      expect(more).toBeGreaterThan(0)
    }
  })

  it('every unchanged file holds the recorded count, a listed one its stated count more', () => {
    const differing: string[] = []
    let unchanged = 0
    for (const [path, [recorded, count]] of Object.entries(REPO.files)) {
      const text = read(path)
      if (text === null || digest(text) !== recorded) continue
      unchanged++
      const now = redactionCount({ anonymize, fileKindOf, languageOfPath }, path, text)
      const expected = count + (REPOSITORY_EXCEPTIONS[path]?.more ?? 0)
      if (now !== expected) differing.push(`${path}: ${now}, not ${expected}`)
    }
    expect(differing).toEqual([])
    // The check has not gone hollow: most recorded files are still as they were.
    expect(unchanged).toBeGreaterThan(300)
  }, 120_000)
})
