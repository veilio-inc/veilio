import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { AnonymizeOptions } from '../src/types.js'
import { HELD, MODES, ROWS } from './fixtures/manual-marks.js'
import {
  anonymize,
  restore,
  buildLegend,
  manualTermsIn,
  ManualMaskError,
  MANUAL_BASE,
} from '../src/engine.js'

describe('manual masks', () => {
  it('reaches a name inside a comment', () => {
    // ROADMAP B3: identifiers are replaced, the prose around them is not. A
    // comment naming a customer is the largest remaining silent leak, and the
    // extractor cannot see into it — marking by hand is the way through.
    const code = '// escalated by Kowalska on Tuesday\nconst total = 1'
    const { anonymized, map } = anonymize(code, { manual: ['Kowalska'] })

    expect(anonymized).not.toContain('Kowalska')
    expect(anonymized).toContain('escalated by __MANUAL__1 on Tuesday')
    expect(map['__MANUAL__1']).toBe('Kowalska')
  })

  it('reaches a bare account number', () => {
    // ROADMAP B2: the material the tool is most often reached for is the
    // material it handles least well. A number is not identifier-shaped.
    const { anonymized } = anonymize('wire(88412037, 45_000)', { manual: ['88412037'] })

    expect(anonymized).not.toContain('88412037')
    expect(anonymized).toContain('45_000')
  })

  it('restores unchanged, with no change to restore()', () => {
    const code = '// contact Kowalska about acct 88412037'
    const { anonymized, map } = anonymize(code, { manual: ['Kowalska', '88412037'] })
    const { restored } = restore(anonymized, map, { strip: 'none' })

    expect(restored).toBe(code)
  })

  it('masks the longest overlapping term', () => {
    const { anonymized, map } = anonymize('wire(acct_88412037)', {
      manual: ['88412037', 'acct_88412037'],
    })

    // `wire` is an identifier and masks on its own; what matters here is that
    // the longer term claimed the span rather than `88412037` splitting it.
    expect(anonymized).toContain('(__MANUAL__2)')
    expect(anonymized).not.toContain('acct_')
    expect(map['__MANUAL__2']).toBe('acct_88412037')
  })

  it('wins over the role the classifier would have assigned', () => {
    // The same token would be masked as a variable. An explicit mark outranks
    // the heuristic, so it lands under __MANUAL__ rather than __VAR__.
    const { map } = anonymize('const settlementAccount = 1', { manual: ['settlementAccount'] })

    expect(Object.entries(map)).toContainEqual(['__MANUAL__1', 'settlementAccount'])
    expect(Object.values(map)).not.toContain('settlementAccount_dup')
    expect(Object.keys(map).filter((k) => map[k] === 'settlementAccount')).toHaveLength(1)
  })

  it('survives the round trip through an existing map', () => {
    // Marks live in the map, so a reload, a .veilio import or a sync carries
    // them without any separate store.
    const first = anonymize('// Kowalska signed off', { manual: ['Kowalska'] })
    expect(manualTermsIn(first.map)).toEqual(['Kowalska'])

    const second = anonymize('// Kowalska signed off again', { existingMap: first.map })
    expect(second.anonymized).not.toContain('Kowalska')
    expect(second.anonymized).toContain('__MANUAL__1')
  })

  it('reuses the placeholder for a term marked twice', () => {
    const first = anonymize('// Kowalska', { manual: ['Kowalska'] })
    const second = anonymize('// Kowalska', {
      existingMap: first.map,
      manual: ['Kowalska'],
    })

    expect(Object.keys(second.map).filter((k) => k.startsWith(MANUAL_BASE))).toHaveLength(1)
  })

  it('refuses to mask a detected credential', () => {
    // A manual mask is reversible and is written to the map, which is exported
    // and synced. Masking a live key would store the secret.
    expect(() =>
      anonymize('const k = 1', { manual: ['sk_live_4eC39HqLyjWDarjtT1zdp7dc'] })
    ).toThrow(ManualMaskError)
  })

  it('names the offending term on refusal', () => {
    try {
      anonymize('const k = 1', { manual: ['ok_term', 'sk_live_4eC39HqLyjWDarjtT1zdp7dc'] })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ManualMaskError)
      expect((e as ManualMaskError).term).toBe('sk_live_4eC39HqLyjWDarjtT1zdp7dc')
    }
  })

  it('refuses to mask an existing placeholder', () => {
    // Reachable by double-clicking a placeholder in the output — the most
    // visually obvious token there. Mapping one placeholder to another would
    // survive anonymize and then silently lose the real name on restore, since
    // restore is a single pass and would stop at the literal '__FN__1'.
    const first = anonymize('function settleBerthQuota(quayRate) { return quayRate }')

    expect(() =>
      anonymize(first.anonymized, { existingMap: first.map, manual: ['__FN__1'] })
    ).toThrow(ManualMaskError)
  })

  it('does not corrupt a placeholder when a term occurs inside one', () => {
    // The UI re-anonymizes its own output, so the text being masked is already
    // full of placeholders. Marking 'FN' previously rewrote the middle of
    // __FN__1 and produced ____MANUAL__1__1.
    const first = anonymize('function settleBerthQuota(quayRate) { return quayRate }')
    const second = anonymize(first.anonymized, { existingMap: first.map, manual: ['FN'] })

    expect(second.anonymized).toContain('__FN__1')
    expect(second.anonymized).not.toContain('____MANUAL__')
    expect(restore(second.anonymized, second.map, { strip: 'none' }).restored).toBe(
      'function settleBerthQuota(quayRate) { return quayRate }'
    )
  })

  it('still masks a term sitting next to a placeholder', () => {
    // The placeholder guard must not swallow legitimate neighbouring matches.
    const first = anonymize(
      '// by Kowalska\nfunction settleBerthQuota(quayRate) { return quayRate }'
    )
    const second = anonymize(first.anonymized, {
      existingMap: first.map,
      manual: ['Kowalska'],
    })

    expect(second.anonymized).toContain('__MANUAL__1')
    expect(second.anonymized).toContain('__FN__1')
  })

  it('ignores empty and whitespace-only terms', () => {
    const { map, anonymized } = anonymize('const a = 1', { manual: ['', '   '] })

    expect(Object.keys(map).some((k) => k.startsWith(MANUAL_BASE))).toBe(false)
    expect(anonymized).toContain('= 1')
  })

  it('does not renumber on a second pass over already-masked output', () => {
    const first = anonymize('// Kowalska', { manual: ['Kowalska'] })
    const second = anonymize(first.anonymized, { existingMap: first.map })

    expect(second.anonymized).toBe(first.anonymized)
    expect(Object.keys(second.map).filter((k) => k.startsWith(MANUAL_BASE))).toHaveLength(1)
  })

  it('explains __MANUAL__ to the downstream model', () => {
    const { map, anonymized } = anonymize('// Kowalska', { manual: ['Kowalska'] })

    expect(buildLegend(map, anonymized)).toContain('marked as sensitive')
  })

  it('leaves a term that does not occur in the source out of the output', () => {
    // Marking something absent is not an error — the map entry is created so the
    // mark persists, and nothing in the text changes.
    const { anonymized, map } = anonymize('const a = 1', { manual: ['Kowalska'] })

    expect(anonymized).not.toContain('__MANUAL__1')
    expect(map['__MANUAL__1']).toBe('Kowalska')
  })

  it('masks every occurrence, not just the first', () => {
    const { anonymized } = anonymize('// Kowalska\n// Kowalska again', { manual: ['Kowalska'] })

    expect(anonymized).not.toContain('Kowalska')
    expect(anonymized.match(/__MANUAL__1/g)).toHaveLength(2)
  })

  it('treats a term with regex metacharacters literally', () => {
    const { anonymized } = anonymize('const re = "a.c"', { manual: ['a.c'] })

    expect(anonymized).toContain('__MANUAL__1')
    expect(anonymized).not.toContain('a.c')
  })

  // ─── 004-b3 · US2: marking prose is the way the leak gets closed ───────────
  //
  // Story 1 tells the user their comments leave unmasked. That creates an
  // obligation, and these are the tests that it can be cheaply discharged —
  // without them the warning is just bad news with nothing to do about it.

  it('masks a term read in a comment everywhere it appears, code included', () => {
    // The gesture is one selection. What makes it worth making is that it
    // reaches the whole file: a customer named in a note is usually also a
    // variable, a table or a string somewhere below it.
    const code = [
      '// Workaround for the Contoso Health outage on the 14th.',
      'const contosoHealthRetries = 3',
      'log("Contoso Health degraded")',
    ].join('\n')
    const { anonymized, map } = anonymize(code, { manual: ['Contoso Health'] })

    expect(anonymized).not.toContain('Contoso Health')
    expect(anonymized.match(/__MANUAL__1/g)).toHaveLength(2)
    expect(map['__MANUAL__1']).toBe('Contoso Health')
  })

  it('survives export and re-import of the map', () => {
    // A .veilio file is JSON on the way out and untrusted JSON on the way back.
    // Marks live in the map precisely so nothing has to be kept beside it, which
    // only holds if the map survives the trip through text.
    const first = anonymize('// escalated by Kowalska, acct 88412037', {
      manual: ['Kowalska', '88412037'],
    })
    const reimported = JSON.parse(JSON.stringify(first.map))

    const second = anonymize('// Kowalska again, still acct 88412037', {
      existingMap: reimported,
    })
    expect(second.anonymized).not.toContain('Kowalska')
    expect(second.anonymized).not.toContain('88412037')
    expect(restore(second.anonymized, second.map, { strip: 'none' })).toMatchObject({
      restored: '// Kowalska again, still acct 88412037',
    })
  })

  it('refuses to mask a language keyword', () => {
    // Spec edge case. Manual marks match literal text anywhere, which is the
    // feature — and is why this one is catastrophic rather than merely wrong.
    // `if` is an ordinary English word inside a comment; marking it there
    // rewrites every `if` in the code too and the file stops compiling.
    expect(() =>
      anonymize('if (ready) { ship() } // check if the account is ready', { manual: ['if'] })
    ).toThrow(ManualMaskError)
  })

  it('leaves the source untouched when it refuses a keyword', () => {
    const code = 'if (ready) { ship() } // check if ready'
    try {
      anonymize(code, { manual: ['if'] })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ManualMaskError)
      expect((e as ManualMaskError).term).toBe('if')
      expect((e as ManualMaskError).message).toMatch(/keyword/i)
    }
    // The refusal is the whole protection: a partially applied mask would be
    // worse than none, since the file would be broken and the map would say so.
    // Without the mark the keyword is left alone, the way every keyword is.
    const { anonymized, map } = anonymize(code)
    expect(anonymized).toContain('if (')
    expect(anonymized).toContain('// check if ready')
    expect(manualTermsIn(map)).toEqual([])
  })

  it('judges keywords by the language actually in play', () => {
    // `def` is a keyword in Python and an ordinary word elsewhere — a column
    // name, an abbreviation in a note. A single hard-coded keyword list would
    // refuse the mark that a TypeScript user legitimately needs.
    expect(() => anonymize('def settle(cart):\n    pass', { manual: ['def'] })).toThrow(
      ManualMaskError
    )
    expect(anonymize('const x = 1 // def see the notes', { manual: ['def'] }).map).toMatchObject({
      __MANUAL__1: 'def',
    })
  })

  it('still masks a term that merely contains a keyword', () => {
    // The check is on the marked term, not on what it looks like it contains.
    // `notify` is not `if`, and refusing it would make the feature unusable on
    // the ordinary English that comments are written in.
    const { anonymized } = anonymize('// notify Kowalska', { manual: ['notify'] })
    expect(anonymized).toContain('__MANUAL__1')
  })

  it('does not detonate when a stored mark is a keyword in the next file', () => {
    // A map outlives the file it was made against. `def` is an ordinary word in
    // a TypeScript comment and is Python's grammar, so a perfectly valid map —
    // saved, exported, synced — arrives at a Python file carrying a mark that
    // must not be applied there. Refusing on replay would make that file
    // impossible to anonymize at all, which is worse than the mark not applying.
    const marked = anonymize('const x = 1 // def see the notes', { manual: ['def'] })
    expect(marked.map).toMatchObject({ __MANUAL__1: 'def' })

    const next = anonymize('def settle(cart):\n    return cart', { existingMap: marked.map })
    expect(next.anonymized).toContain('def ')
    expect(next.anonymized).not.toContain('__MANUAL__1')
  })

  it('keeps the stale mark in the map rather than dropping it', () => {
    // Not applied here is not the same as gone. The next file may be TypeScript
    // again, and the user marked that term on purpose.
    const marked = anonymize('const x = 1 // def see the notes', { manual: ['def'] })
    const inPython = anonymize('def settle(cart):\n    return cart', { existingMap: marked.map })
    expect(manualTermsIn(inPython.map)).toEqual(['def'])

    const backInTs = anonymize('// def see the notes', { existingMap: inPython.map })
    expect(backInTs.anonymized).toContain('__MANUAL__1')
  })

  it('still refuses a keyword the user is marking right now', () => {
    // The replay exemption must not become a way to smuggle the mark in. Asking
    // for it in the language where it is grammar is refused, map or no map.
    const marked = anonymize('const x = 1 // def see the notes', { manual: ['def'] })
    expect(() =>
      anonymize('def settle(cart):\n    return cart', {
        existingMap: marked.map,
        manual: ['def'],
      })
    ).toThrow(ManualMaskError)
  })

  it('applies the marks that are still valid alongside one that is not', () => {
    // A single unusable mark must not take the others down with it.
    const marked = anonymize('// def, and Kowalska signed off', {
      manual: ['def', 'Kowalska'],
    })
    const next = anonymize('def settle():\n    return "Kowalska"', { existingMap: marked.map })
    expect(next.anonymized).toContain('def ')
    expect(next.anonymized).not.toContain('Kowalska')
  })
})

// ─── spec 093 · a mark inside a longer name comes back ───────────────────────
//
// Masking replaces a term where it stands, inside a name too: ACME in
// ACME_API_URL leaves `__MANUAL__1_API_URL`, which is then minted as a name, so
// the map holds a value with a placeholder in it. Restore, one pass, gave that
// value back as written. Masking is unchanged; restore now reads such a value
// through.

type Answer = { anonymized: string; map: Record<string, string> }
/** What origin/main 05931b6 answered for each row (fixtures/manual-marks.ts). */
const MAIN: Record<string, Record<'unmarked' | (typeof MODES)[number], Answer>> = JSON.parse(
  readFileSync(new URL('./fixtures/manual-marks-main.json', import.meta.url), 'utf8')
)

describe('masking with marks is what origin/main gave (spec 093)', () => {
  it('has an answer of main for every row, and no stale one', () => {
    expect(Object.keys(MAIN)).toEqual(ROWS.map((r) => r.name))
  })

  describe.each(ROWS)('a mark $name', ({ name, code, manual, path }) => {
    const answer = (options: AnonymizeOptions): Answer => {
      const { anonymized, map } = anonymize(code, { existingMap: HELD, path, ...options })
      return { anonymized, map }
    }

    it('with nothing marked', () => {
      expect(answer({})).toEqual(MAIN[name]!.unmarked)
    })

    it.each(MODES)('with the marks (%s)', (mode) => {
      expect(answer({ manual, secrets: mode })).toEqual(MAIN[name]![mode])
    })
  })
})

describe('restore reads a map value that holds a placeholder (spec 093)', () => {
  it.each([
    ['const u = ACME_API_URL + 1;', 'ACME'],
    ['new AcmeClient()', 'Acme'],
    ['log("PaymentAcmeGateway down") // ask the AcmeTeam', 'Acme'],
  ])('restores %s exactly when %s is marked', (code, term) => {
    const { anonymized, map } = anonymize(code, { manual: [term] })
    const { restored, report } = restore(anonymized, map, { strip: 'none' })

    expect(anonymized).not.toContain(term)
    expect(restored).toBe(code)
    expect(report.missing).toEqual([])
    expect(report.altered).toEqual([])
    expect(report.unresolved).toEqual([])
  })

  it('restores a mark standing alone as before', () => {
    const code = '// escalated by Kowalska'
    const { anonymized, map } = anonymize(code, { manual: ['Kowalska'] })

    expect(restore(anonymized, map, { strip: 'none' })).toMatchObject({
      restored: code,
      report: { resolved: ['__MANUAL__1'], missing: [], unresolved: [], altered: [] },
    })
  })

  it('reads a value through two levels', () => {
    const map = { __CLS__1: '__VAR__1Client', __VAR__1: '__MANUAL__1_API', __MANUAL__1: 'ACME' }
    const { restored, report } = restore('new __CLS__1()', map, { strip: 'none' })

    expect(restored).toBe('new ACME_APIClient()')
    expect(report.missing).toEqual([])
    expect(report.resolved).toEqual(['__CLS__1', '__VAR__1', '__MANUAL__1'])
  })

  it('counts a placeholder only read through a value that was not used as missing', () => {
    const map = { __CLS__1: '__MANUAL__1Client', __MANUAL__1: 'Acme', __FN__1: 'settle' }
    expect(restore('__FN__1()', map, { strip: 'none' }).report.missing).toEqual([
      '__CLS__1',
      '__MANUAL__1',
    ])
  })

  it('stops on a cycle and leaves those values as they are', () => {
    const map = { __VAR__1: '__VAR__2x', __VAR__2: '__VAR__1y', __FN__1: 'settle' }
    const { restored } = restore('__FN__1(__VAR__1, __VAR__2)', map, { strip: 'none' })

    expect(restored).toBe('settle(__VAR__2x, __VAR__1y)')
  })

  it('leaves a value that holds itself as it is', () => {
    expect(restore('__VAR__1', { __VAR__1: 'a__VAR__1' }, { strip: 'none' }).restored).toBe(
      'a__VAR__1'
    )
  })

  it('leaves a value that would not stop growing as it is', () => {
    // Each level doubles: read through, the first would be 2^20 names long.
    const map: Record<string, string> = { __VAR__21: 'x' }
    for (let i = 1; i <= 20; i++) map[`__VAR__${i}`] = `__VAR__${i + 1}__VAR__${i + 1}`
    const t0 = performance.now()
    const { restored } = restore('__VAR__1', map, { strip: 'none' })

    expect(restored).toBe('__VAR__2__VAR__2')
    expect(performance.now() - t0).toBeLessThan(1000)
  })

  it('leaves a value nested deeper than it reads as it is', () => {
    // Masking nests one level per mark; eight is no map the engine wrote.
    const map: Record<string, string> = { __VAR__9: 'x' }
    for (let i = 1; i <= 8; i++) map[`__VAR__${i}`] = `a__VAR__${i + 1}`
    expect(restore('__VAR__1 __VAR__6', map, { strip: 'none' }).restored).toBe('a__VAR__2 aaax')
  })

  it('leaves a value that would grow past the length allowed as it is', () => {
    // Four levels of sixty each: read through, 13 million characters.
    const sixty = (key: string): string => key.repeat(60)
    const map = {
      __VAR__1: sixty('__VAR__2'),
      __VAR__2: sixty('__VAR__3'),
      __VAR__3: sixty('__VAR__4'),
      __VAR__4: sixty('x'),
    }
    expect(restore('__VAR__1', map, { strip: 'none' }).restored).toBe(sixty('__VAR__2'))
    expect(restore('__VAR__3', map, { strip: 'none' }).restored).toBe('x'.repeat(3600))
  })

  it('does no more work than the map is long for a map built to grow', () => {
    // A map may be someone else's (a team map, an imported file). Thirty keys,
    // each holding the next six times over, and a long last value: read
    // through, the first would be 6^29 times 10,000 characters.
    const keys = 30
    const map: Record<string, string> = { [`__VAR__${keys}`]: 'x'.repeat(10_000) }
    for (let i = 1; i < keys; i++) map[`__VAR__${i}`] = `__VAR__${i + 1} `.repeat(6)
    const text = Array.from({ length: keys }, (_, i) => `__VAR__${i + 1}`).join('\n')
    const t0 = performance.now()
    const { restored } = restore(text, map, { strip: 'none' })

    expect(performance.now() - t0).toBeLessThan(500)
    // Even the last level (60,000 characters) is more than the call may build,
    // four times the map's own length: every value comes back as written.
    expect(restored.length).toBeLessThan(200_000)
    expect(restored.startsWith('__VAR__2 __VAR__2 ')).toBe(true)
    expect(restored.endsWith('x'.repeat(10_000))).toBe(true)
  })

  it('reads a value many others share once, within one budget for the call', () => {
    // 2,000 values each holding the same 40,000-character one: each fits the
    // length a value may reach, all of them together do not fit the call.
    const map: Record<string, string> = { __CLS__1: 'y'.repeat(40_000) }
    for (let i = 1; i <= 2000; i++) map[`__VAR__${i}`] = `a__CLS__1`
    const text = Object.keys(map).join(' ')
    const t0 = performance.now()
    const { restored } = restore(text, map, { strip: 'none' })

    expect(performance.now() - t0).toBeLessThan(1000)
    expect(restored.length).toBeLessThan(1_000_000)
    expect(restored).toContain('a__CLS__1')
  })

  it('counts the placeholders read through, not only the characters, as work', () => {
    // Values that come to nothing, three levels of 300: no length ever grows,
    // yet reading the top one through means 27 million placeholders.
    const level = (base: string, holds: string): string[] => {
      const keys = Array.from({ length: 300 }, (_, i) => `__${base}__${i + 1}`)
      for (const key of keys) map[key] = holds
      return keys
    }
    const map: Record<string, string> = {}
    const classes = level('CLS', level('VAR', level('STR', '').join('')).join(''))
    map.__FN__1 = classes.join('')
    const t0 = performance.now()
    const { restored } = restore('__FN__1 __VAR__1.', map, { strip: 'none' })

    expect(performance.now() - t0).toBeLessThan(2000)
    expect(restored).toBe(`${map.__FN__1} .`)
  })

  it('leaves a placeholder-shaped token in a value alone when the map has no such key', () => {
    const map = { __VAR__1: '__GNUC__ and __CLS__7 stay', __CLS__70: 'Other' }
    expect(restore('__VAR__1', map, { strip: 'none' }).restored).toBe('__GNUC__ and __CLS__7 stay')
  })

  it('does not read a key followed by a digit as that key', () => {
    const map = { __VAR__1: '__CLS__10', __CLS__1: 'Invoice' }
    expect(restore('__VAR__1', map, { strip: 'none' }).restored).toBe('__CLS__10')
  })

  it('restores text whose map has no such value exactly as before', () => {
    const code = 'function settleBerthQuota(quayRate) { return quayRate } // Kowalska'
    const { anonymized, map } = anonymize(code, { manual: ['Kowalska'] })

    expect(Object.values(map).some((v) => v.includes('__'))).toBe(false)
    expect(restore(anonymized, map, { strip: 'none' })).toEqual({
      restored: code,
      strippedCount: 0,
      strippedItems: [],
      report: {
        resolved: Object.keys(map),
        missing: [],
        unresolved: [],
        altered: [],
      },
    })
  })
})
