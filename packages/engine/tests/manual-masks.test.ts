import { describe, it, expect } from 'vitest'
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
    const first = anonymize('function settle(rate) { return rate }')

    expect(() =>
      anonymize(first.anonymized, { existingMap: first.map, manual: ['__FN__1'] })
    ).toThrow(ManualMaskError)
  })

  it('does not corrupt a placeholder when a term occurs inside one', () => {
    // The UI re-anonymizes its own output, so the text being masked is already
    // full of placeholders. Marking 'FN' previously rewrote the middle of
    // __FN__1 and produced ____MANUAL__1__1.
    const first = anonymize('function settle(rate) { return rate }')
    const second = anonymize(first.anonymized, { existingMap: first.map, manual: ['FN'] })

    expect(second.anonymized).toContain('__FN__1')
    expect(second.anonymized).not.toContain('____MANUAL__')
    expect(restore(second.anonymized, second.map, { strip: 'none' }).restored).toBe(
      'function settle(rate) { return rate }'
    )
  })

  it('still masks a term sitting next to a placeholder', () => {
    // The placeholder guard must not swallow legitimate neighbouring matches.
    const first = anonymize('// by Kowalska\nfunction settle(rate) { return rate }')
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
})
