import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { credentialSpans, detectSecrets, hasBlockingSecrets } from '../src/secrets.js'

/** What origin/main 05931b6 gave for each row of the table below: with no
 *  marks, and with the marks in each `secrets` mode. */
const MAIN: Record<
  string,
  { unmarked: string } & Record<
    'redact' | 'warn' | 'off',
    { anonymized: string; map: Record<string, string> }
  >
> = JSON.parse(readFileSync(new URL('./fixtures/manual-marks-main.json', import.meta.url), 'utf8'))
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

  // ─── spec 093 · a mark inside a longer name ────────────────────────────────
  //
  // A term used to be replaced where it stood, inside a name too. The rest of
  // the name was then minted with the placeholder in it (`__MANUAL__1_API_URL`),
  // and restore, one pass, gave that back in place of the name.

  /** Mask with the marks, restore, and return all three for the assertions. */
  const roundTrip = (code: string, manual: string[]) => {
    const masked = anonymize(code, { manual })
    // No marked term is readable in what goes out, in any of these cases.
    for (const term of manual) expect(masked.anonymized).not.toContain(term)
    return { ...masked, back: restore(masked.anonymized, masked.map, { strip: 'none' }) }
  }

  it.each([
    ['const u = ACME_API_URL + 1;', 'ACME'],
    ['new AcmeClient()', 'Acme'],
  ])('restores %s exactly when %s is marked', (code, term) => {
    const { anonymized, map, back } = roundTrip(code, [term])

    expect(back.restored).toBe(code)
    expect(back.report.altered).toEqual([])
    expect(back.report.unresolved).toEqual([])
    // Only the mark itself: it is kept in the map so it persists, and stands
    // nowhere alone in this text (as for any mark the text does not hold).
    expect(back.report.missing).toEqual(['__MANUAL__1'])
    expect(anonymized).not.toContain(term)
    // No name in the map holds a placeholder.
    expect(Object.values(map).filter((v) => /__[A-Z]+__\d/.test(v))).toEqual([])
  })

  it('masks the whole name as a name of its role, and keeps the mark for the term alone', () => {
    const code = 'new AcmeClient() // Acme said so'
    const { anonymized, map, back } = roundTrip(code, ['Acme'])

    expect(anonymized).toBe('new __CLS__1() // __MANUAL__1 said so')
    expect(map).toEqual({ __MANUAL__1: 'Acme', __CLS__1: 'AcmeClient' })
    expect(back.restored).toBe(code)
    expect(back.report).toMatchObject({ missing: [], altered: [], unresolved: [] })
  })

  it('masks a name holding a mark where another name would be left readable', () => {
    // An ordinary word, a keyword, a whitelisted name and a lowercase word of a
    // comment are all left as written - not when they hold a marked term.
    const code = 'const total = "acmecorp" // acmecorp settles the total\nreturn total'
    const masked = anonymize(code, {
      manual: ['acme', 'ota', 'etur'],
      rules: [
        {
          id: 'r1',
          scope: 'personal',
          team_id: null,
          name: 'Rule 1',
          type: 'whitelist',
          pattern: '^acmecorp$',
          enabled: true,
          sort_order: 0,
        },
      ],
    })

    for (const shown of ['acme', 'total', 'return']) expect(masked.anonymized).not.toContain(shown)
    expect(restore(masked.anonymized, masked.map, { strip: 'none' }).restored).toBe(code)
  })

  it('takes the longer mark where one mark is part of another', () => {
    const code = 'const a = AcmeClient.make(AcmeClientFactory, Acme)'
    const { anonymized, map, back } = roundTrip(code, ['Acme', 'AcmeClient'])

    expect(anonymized).not.toContain('Acme')
    expect(Object.entries(map)).toContainEqual(['__MANUAL__2', 'AcmeClient'])
    expect(Object.values(map)).toContain('AcmeClientFactory')
    expect(back.restored).toBe(code)
    expect(back.report.missing).toEqual([])
  })

  it('reaches a name holding a mark inside a string and inside a comment', () => {
    const code = 'log("PaymentGateway down") // ask the PaymentGatewayTeam'
    const { anonymized, back } = roundTrip(code, ['Gateway'])

    expect(anonymized).not.toContain('Gateway')
    expect(back.restored).toBe(code)
    expect(back.report.altered).toEqual([])
  })

  it('masks a name holding a mark in a line of a stack trace left as written', () => {
    const code = "TypeError: Cannot read properties of undefined (reading 'charge')"
    const { anonymized, back } = roundTrip(code, ['roper'])

    expect(anonymized).not.toContain('roper')
    expect(back.restored).toBe(code)
  })

  it('never writes a credential value to the map for the mark inside it', () => {
    const secret = 'Acme' + 'Winter' + 'Pass' + '2026'
    const { map } = roundTrip(`const password = "${secret}"`, ['Acme'])

    expect(Object.values(map).filter((v) => v.includes(secret))).toEqual([])
  })

  it('leaves placeholders untouched when masked text is masked again', () => {
    const first = anonymize('const u = ACME_API_URL + new AcmeClient()', { manual: ['ACME'] })
    const again = anonymize(first.anonymized, {
      existingMap: first.map,
      manual: ['ACME', 'API', 'CLS'],
    })

    expect(again.anonymized).toBe(first.anonymized)
  })

  it('gives the same output as before for text with no marks', () => {
    const code = 'const u = ACME_API_URL + new AcmeClient() // total'
    expect(anonymize(code, { manual: [] })).toEqual(anonymize(code))
    expect(anonymize(code).anonymized).toBe('const u = ACME_API_URL + new __CLS__1() // total')
  })

  // ─── spec 093 · the one rule, and where main's behaviour is kept ───────────
  //
  // A name holding a mark is masked whole only when it is a plain name clear
  // of every credential, placeholder and letter of another script. Any other
  // run is handled exactly as origin/main 05931b6 handled it, round-trip defect
  // included: a known limit, pinned here from a run of that build
  // (fixtures/manual-marks-main.json) so it cannot change unnoticed.

  // Provider-shaped values are built here, never written whole.
  const KEY = 'sk_' + 'live_' + '4eC39HqLyjWDAcmetT1zdp7dc'
  const PASSWORD = 'Zt4pw-AcmeHunter7Zq9-x9Kd2'
  const MODES = ['redact', 'warn', 'off'] as const
  const MARKS = ['Acme', 'ACME', '8841']
  const HELD = { __CLS__1: 'Client' }

  // [name, before, credential, after, keeps main's behaviour]
  const SURROUNDINGS: [string, string, string, string, boolean][] = [
    ['inside a name', 'const u = ACME_API_URL + new AcmeClient()', '', '', false],
    ['alone in a string', 'log("Acme")', '', '', false],
    ['inside a name in a string', 'log("PaymentAcmeGateway down")', '', '', false],
    ['in a comment', 'const total = 1 // ask Acme and the AcmeTeam', '', '', false],
    ['beside Polish letters', 'const firma = "ŻAcmeClient" // AcmeŻółć', '', '', true],
    ['beside Greek letters', '// ΑAcmeΔ und AcmeClientΩ', '', '', true],
    ['inside a number', '// acct 88412037\nwire(88412037)', '', '', true],
    ['beside a placeholder', '// AcmeŻ__CLS__1 and Acme__CLS__1x here', '', '', true],
    ['inside a key', 'const k = "', KEY, '"', true],
    [
      'inside a password of a connection string',
      'const dsn = "postgres://svc:',
      PASSWORD,
      '@db.internal:5432/app"',
      true,
    ],
    ['inside a value under a credential key', 'const password = "', PASSWORD, '"', true],
    ['a whole part of a credential', 'const password = "', 'Zt4pw-Acme-x9Kd2', '"', true],
    [
      'inside a credential that holds a placeholder',
      'const password = "',
      'Zt4pwŻ__CLS__1ŻAcmeHunter7Zq9',
      '"',
      true,
    ],
    [
      'in a name that is a credential elsewhere',
      'const password = "',
      'AcmeHunter7Zq9',
      '"\nlog(AcmeHunter7Zq9)',
      true,
    ],
  ]

  describe.each(SURROUNDINGS)('a mark %s', (name, before, credential, after, asMain) => {
    const code = before + credential + after
    const main = MAIN[name]!

    it('masks the text as main did when nothing is marked', () => {
      expect(anonymize(code, { existingMap: HELD }).anonymized).toBe(main.unmarked)
    })

    it.each(MODES)('holds the rules of a mark (%s)', (mode) => {
      const once = anonymize(code, { existingMap: HELD, manual: MARKS, secrets: mode })
      const twice = anonymize(once.anonymized, {
        existingMap: once.map,
        manual: MARKS,
        secrets: mode,
      })
      const secrets = [
        credential,
        ...credentialSpans(code).map((s) => code.slice(s.start, s.end)),
      ].filter((t) => t !== '')

      if (asMain) {
        // Outside the rule: output and map are main's, byte for byte.
        expect({ anonymized: once.anonymized, map: once.map }).toEqual(main[mode])
      } else
        for (const { anonymized, map } of [once, twice]) {
          // 1. The text comes back exactly.
          expect(restore(anonymized, map, { strip: 'none' }).restored).toBe(code)
          // 2. No marked term is readable.
          for (const term of MARKS) expect(anonymized).not.toContain(term)
          // No name in the map holds a placeholder.
          expect(Object.values(map).filter((v) => /__[A-Z]+__\d/.test(v))).toEqual([])
        }
      // 3. No credential, and no piece of one, is in the map. The mark is the
      //    user's own word, and the map must hold it to bring it back.
      for (const value of Object.values(once.map)) {
        expect(hasBlockingSecrets(detectSecrets(value)), value).toBe(false)
        if (!MARKS.includes(value) && value.length >= 4)
          for (const secret of secrets) expect(secret, value).not.toContain(value)
      }
    })
  })

  it.each([
    ['const firma = "ŻClient" // Kowalska', ['Kowalska'], ['Kowalska']],
    ['const firma = "ŻClient" + ledgerShard // Kowalska', ['Kowalska'], ['STR', 'VAR', 'Kowalska']],
  ])('leaves a placeholder beside a letter of another script whole: %s', (code, first, again) => {
    const one = anonymize(code, { manual: first })
    const two = anonymize(one.anonymized, { existingMap: one.map, manual: again })

    expect(two.anonymized).toBe(one.anonymized)
    expect(Object.values(two.map).filter((v) => /__[A-Z]+__\d/.test(v))).toEqual([])
    expect(restore(two.anonymized, two.map, { strip: 'none' }).restored).toBe(code)
  })

  it.each(MODES)('still marks a word that only may be a credential, whole (%s)', (mode) => {
    const code = 'client_secret: "disabled"\n'
    const { anonymized, map } = anonymize(code, {
      path: 'a.yaml',
      manual: ['disabled'],
      secrets: mode,
    })

    expect(anonymized).toContain('"__MANUAL__1"')
    expect(restore(anonymized, map, { strip: 'none' }).restored).toBe(code)
  })
})
