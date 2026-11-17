import { describe, it, expect } from 'vitest'
import {
  anonymize,
  restore,
  ManualMaskError,
  MAP_LIMITS,
  isName,
  measureCommentExposure,
  openMap,
  sealMap,
  sealableMap,
} from '@veilio-inc/engine'
import { maskSelection, unmaskTerm, previewTerm, stripOption } from './manualMarks.js'

const SOURCE =
  '// escalated by Kowalska, acct 88412037\nfunction settleQuayFees(tarnRate) { return tarnRate }'

/** Nothing measured. These cases are about the placeholder substitution, and
 *  `unmaskTerm` recomputes the exposure from the output it produces anyway. */
const NO_COMMENTS = { total: 0, inline: 0, characters: 0, severity: 'low' } as const

function anonymized() {
  const { anonymized, map, comments } = anonymize(SOURCE)
  return { output: anonymized, map, comments }
}

describe('maskSelection', () => {
  it('masks a name the engine left in a comment', () => {
    // C3
    const next = maskSelection(anonymized(), 'Kowalska')

    expect(next.output).not.toContain('Kowalska')
    expect(next.output).toContain('__MANUAL__1')
    expect(next.map['__MANUAL__1']).toBe('Kowalska')
  })

  it('trims whitespace picked up by a loose selection', () => {
    // C6 - dragging across a word usually catches the space after it, and an
    // untrimmed term would mask the space and never match again.
    const next = maskSelection(anonymized(), '  Kowalska \n')

    expect(next.map['__MANUAL__1']).toBe('Kowalska')
  })

  it('is a no-op for an empty or whitespace-only selection', () => {
    const state = anonymized()
    expect(maskSelection(state, '   ')).toBe(state)
    expect(maskSelection(state, '')).toBe(state)
  })

  it('preserves placeholders from the first pass', () => {
    // The idempotency this whole approach rests on: re-anonymizing the output
    // must not renumber what is already masked.
    const first = anonymized()
    const next = maskSelection(first, 'Kowalska')

    for (const [placeholder, name] of Object.entries(first.map)) {
      expect(next.map[placeholder]).toBe(name)
    }
  })

  it('accumulates across successive marks', () => {
    const next = maskSelection(maskSelection(anonymized(), 'Kowalska'), '88412037')

    expect(next.output).not.toContain('Kowalska')
    expect(next.output).not.toContain('88412037')
    expect(next.map['__MANUAL__1']).toBe('Kowalska')
    expect(next.map['__MANUAL__2']).toBe('88412037')
  })

  it('still restores losslessly after manual marks', () => {
    const next = maskSelection(maskSelection(anonymized(), 'Kowalska'), '88412037')
    const { restored } = restore(next.output, next.map, { strip: 'none' })

    expect(restored).toBe(SOURCE)
  })

  it('throws rather than masking a credential', () => {
    // C4 - a manual mask is reversible and lands in the exported map.
    expect(() => maskSelection(anonymized(), 'sk_live_4eC39HqLyjWDarjtT1zdp7dc')).toThrow(
      ManualMaskError
    )
  })
})

describe('unmaskTerm', () => {
  it('puts the term back and drops the entry', () => {
    // D4
    const marked = maskSelection(anonymized(), 'Kowalska')
    const next = unmaskTerm(marked, '__MANUAL__1')

    expect(next.output).toContain('Kowalska')
    expect(next.output).not.toContain('__MANUAL__1')
    expect(next.map['__MANUAL__1']).toBeUndefined()
  })

  it('does not corrupt __MANUAL__10 when unmasking __MANUAL__1', () => {
    // D5 - the regression the trailing-digit guard exists for. A plain replace
    // rewrites the prefix of the longer token and leaves a stray '0' behind.
    const state = {
      output: 'a = __MANUAL__1; b = __MANUAL__10;',
      map: { __MANUAL__1: 'first', __MANUAL__10: 'tenth' },
      comments: NO_COMMENTS,
    }
    const next = unmaskTerm(state, '__MANUAL__1')

    expect(next.output).toBe('a = first; b = __MANUAL__10;')
    expect(next.map['__MANUAL__10']).toBe('tenth')
  })

  it('replaces every occurrence of the placeholder', () => {
    const state = {
      output: '__MANUAL__1 and __MANUAL__1 again',
      map: { __MANUAL__1: 'Kowalska' },
      comments: NO_COMMENTS,
    }

    expect(unmaskTerm(state, '__MANUAL__1').output).toBe('Kowalska and Kowalska again')
  })

  it('is a no-op for a placeholder that is not in the map', () => {
    const state = anonymized()
    expect(unmaskTerm(state, '__MANUAL__99')).toBe(state)
  })

  it('does not mutate the map it was given', () => {
    const marked = maskSelection(anonymized(), 'Kowalska')
    const before = { ...marked.map }
    unmaskTerm(marked, '__MANUAL__1')

    expect(marked.map).toEqual(before)
  })

  it('leaves other placeholder families untouched', () => {
    const marked = maskSelection(anonymized(), 'Kowalska')
    const next = unmaskTerm(marked, '__MANUAL__1')

    expect(next.output).toContain('__FN__1')
  })

  it('round-trips: mark then unmark returns the original output', () => {
    const start = anonymized()
    const next = unmaskTerm(maskSelection(start, 'Kowalska'), '__MANUAL__1')

    expect(next.output).toBe(start.output)
  })
})

describe('unmaskTerm, when another entry refers to the mark', () => {
  // A later mark can cover text that already holds a placeholder, so its map
  // value names the earlier mark. Dropping the earlier entry without rewriting
  // that value left a name that never came back on restore.
  const state = {
    output: 'call __MANUAL__2 and __MANUAL__1',
    map: { __MANUAL__1: 'Kowalska', __MANUAL__2: '__MANUAL__1Client', __MANUAL__10: 'Nowak' },
    comments: { total: 0, masked: 0 },
  } as unknown as Parameters<typeof unmaskTerm>[0]

  it('writes the real text into every map value that named the removed mark', () => {
    const next = unmaskTerm(state, '__MANUAL__1')
    expect(next.map).toEqual({ __MANUAL__2: 'KowalskaClient', __MANUAL__10: 'Nowak' })
    expect(restore(next.output, next.map).restored).toBe('call KowalskaClient and Kowalska')
  })

  it('leaves a value that only shares the prefix alone', () => {
    const longer = { ...state, map: { ...state.map, __MANUAL__3: 'x__MANUAL__10y' } }
    expect(unmaskTerm(longer, '__MANUAL__1').map.__MANUAL__3).toBe('x__MANUAL__10y')
  })

  it('puts back a term holding a dollar sign as written', () => {
    const priced = { ...state, map: { ...state.map, __MANUAL__1: 'price$&$1' } }
    const next = unmaskTerm(priced, '__MANUAL__1')
    expect(next.output).toBe('call __MANUAL__2 and price$&$1')
    expect(next.map.__MANUAL__2).toBe('price$&$1Client')
  })
})

describe('stripOption', () => {
  it('strips everything by default', () => {
    expect(stripOption(false)).toBe('all')
  })

  it('keeps only JSDoc when docs are kept', () => {
    const kept = stripOption(true)
    expect(kept).not.toBe('all')
    expect(kept).not.toContain('jsdoc')
    expect(kept).toContain('todo')
    expect(kept).toContain('narration')
  })

  it('keeps documentation the model was asked to write', () => {
    const reply = ['/** Settles an invoice. */', 'function f() {}', '// TODO: refactor'].join('\n')

    const stripped = restore(reply, {}, { strip: stripOption(false) }).restored
    const kept = restore(reply, {}, { strip: stripOption(true) }).restored

    expect(stripped).not.toContain('Settles an invoice')
    expect(kept).toContain('Settles an invoice')
    expect(kept).not.toContain('TODO')
  })
})

describe('previewTerm', () => {
  it('leaves a short term alone', () => {
    expect(previewTerm('Kowalska')).toBe('Kowalska')
  })

  it('truncates a long term with an ellipsis', () => {
    expect(previewTerm('x'.repeat(50))).toBe(`${'x'.repeat(30)}…`)
  })

  it('does not truncate at exactly the limit', () => {
    expect(previewTerm('x'.repeat(30))).toBe('x'.repeat(30))
  })
})

/** The app's own refusals (approved texts). */
const ONE_LINE =
  'A mark cannot span lines or hold a tab. Nothing was masked. Mark the text on each line separately.'
const TOO_LONG = `That selection is longer than ${MAP_LIMITS.valueLength.toLocaleString('en-US')} characters, the most one mark can hold. Nothing was masked. Mark a shorter part.`

/** A state whose output holds `term` in a comment, so a mark of it would match. */
function holding(term: string) {
  const output = `// escalated by ${term} today\n`
  return { output, map: {}, comments: measureCommentExposure(output) }
}

// Built at run time, so no provider-shaped secret sits in the source.
const CREDENTIAL = 'sk_' + 'live_' + '4eC39HqLyjWDarjtT1zdp7dc'

/** Every term no other tool would read back from a map: a line break, a tab,
 *  another control character, a Unicode line or paragraph separator. */
const ACROSS_LINES: [string, string][] = [
  ['a line feed', 'Kowalska,\nacct'],
  ['a CRLF', 'Kowalska,\r\nacct'],
  ['a lone CR', 'a\rb'],
  ['a tab', 'Sp.\tz o.o.'],
  ['an escape', 'a\u001bb'],
  ['a NEL', 'a\u0085b'],
  ['a line separator', 'a\u2028b'],
  ['a paragraph separator', 'a\u2029b'],
]

/** Accepted as before, each with the term the map should hold. */
const ONE_LINE_TERMS: [string, string, string][] = [
  ['a loose selection ending in a line break', '  Kowalska \n', 'Kowalska'],
  ['a selection with a tab and CRLF at its ends', '\tKowalska\r\n', 'Kowalska'],
  ['Polish letters', 'Zażółć gęślą jaźń', 'Zażółć gęślą jaźń'],
  ['German letters and a digit', 'Straße 12', 'Straße 12'],
  ['Greek letters', 'Ελλάδα', 'Ελλάδα'],
  ['a no-break space', 'Acme Holdings', 'Acme Holdings'],
]

describe('maskSelection refuses a mark no other tool can read back', () => {
  it.each(ACROSS_LINES)('%s is refused, and nothing changes', (_, term) => {
    const state = holding(term)
    const before = structuredClone(state)

    let error: unknown
    try {
      maskSelection(state, term)
    } catch (e) {
      error = e
    }

    expect(error).toBeInstanceOf(ManualMaskError)
    expect((error as Error).message).toBe(ONE_LINE)
    expect((error as Error).message).not.toContain(term)
    expect(state).toEqual(before)
  })

  it('a selection one character over the limit for a value is refused with its own message', () => {
    const term = 'a'.repeat(MAP_LIMITS.valueLength + 1)
    const state = holding(term)
    const before = structuredClone(state)

    expect(() => maskSelection(state, term)).toThrow(TOO_LONG)
    expect(TOO_LONG).toContain('200,000')
    expect(state).toEqual(before)
  })

  it('a selection of exactly the limit passes the app check', () => {
    // Only the app's own refusal is asserted: the engine cannot build its
    // pattern for a term this long and throws a SyntaxError of its own, which
    // the page shows as "Could not mask that selection." (known, not changed here).
    const term = 'b'.repeat(MAP_LIMITS.valueLength)
    expect(isName(term)).toBe(true)
    let error: unknown
    try {
      maskSelection(holding(term), term)
    } catch (e) {
      error = e
    }
    expect(error).not.toBeInstanceOf(ManualMaskError)
  })

  it.each(ONE_LINE_TERMS)('%s is masked as before', (_, term, kept) => {
    const next = maskSelection(holding(kept), term)

    expect(next.map['__MANUAL__1']).toBe(kept)
    expect(next.output).not.toContain(kept)
  })

  it('a line break is named before a credential in the same selection', () => {
    const term = `${CREDENTIAL}\nacct`
    expect(() => maskSelection(holding(term), term)).toThrow(ONE_LINE)
  })

  it('a credential on one line still gets the engine refusal', () => {
    let error: unknown
    try {
      maskSelection(holding(CREDENTIAL), CREDENTIAL)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(ManualMaskError)
    expect((error as Error).message).toMatch(/^Refusing to mask a detected credential/)
  })
})

describe('a map the app makes can be sealed and read by every other tool', () => {
  const rows: [string, string][] = [
    ...ACROSS_LINES,
    ...ONE_LINE_TERMS.map(([name, term]) => [name, term] as [string, string]),
    ['a line break with a credential', `${CREDENTIAL}\nacct`],
  ]

  it.each(rows)('%s', { timeout: 60_000 }, async (_, term) => {
    let state = holding(term.trim())
    const source = state.output
    try {
      state = maskSelection(state, term)
    } catch {
      // refused: the state is the one before the gesture
    }

    expect(() => sealableMap(state.map)).not.toThrow()
    const opened = await openMap(
      await sealMap(state.map, 'correct horse battery staple'),
      'correct horse battery staple'
    )
    expect(opened).toEqual(state.map)
    expect(restore(state.output, opened, { strip: 'none' }).restored).toBe(source)
  })
})

describe('marks made by an earlier version keep working', () => {
  const EARLIER = { __MANUAL__1: 'Acme\nHoldings', __MANUAL__2: 'Sp.\tz o.o.' }
  const ORIGINAL = '// owned by Acme\nHoldings and Sp.\tz o.o., escalated by Kowalska\n'

  function earlier() {
    const output = '// owned by __MANUAL__1 and __MANUAL__2, escalated by Kowalska\n'
    return { output, map: { ...EARLIER }, comments: measureCommentExposure(output) }
  }

  it('a new one-line mark is made beside them, and they are kept as written', () => {
    const next = maskSelection(earlier(), 'Kowalska')

    expect(next.map['__MANUAL__3']).toBe('Kowalska')
    expect(next.map['__MANUAL__1']).toBe(EARLIER.__MANUAL__1)
    expect(next.map['__MANUAL__2']).toBe(EARLIER.__MANUAL__2)
    expect(next.output).toContain('__MANUAL__1')
    expect(next.output).toContain('__MANUAL__2')
  })

  it('unmarking one puts its text back exactly', () => {
    expect(unmaskTerm(earlier(), '__MANUAL__1').output).toContain('Acme\nHoldings')
    expect(unmaskTerm(earlier(), '__MANUAL__2').output).toContain('Sp.\tz o.o.')
  })

  it('restore returns the line break and the tab', () => {
    const state = earlier()
    expect(restore(state.output, state.map, { strip: 'none' }).restored).toBe(ORIGINAL)
  })
})

describe('what the engine README says about the manual option', () => {
  // It holds both halves of the paragraph: the engine masks such a term when a
  // program asks it to, and the map readers refuse the result.
  it('anonymize masks a term across lines, and the map cannot be sealed', () => {
    const { anonymized, map } = anonymize('// owned by Acme\nHoldings\n', {
      manual: ['Acme\nHoldings'],
    })

    expect(anonymized).toContain('__MANUAL__1')
    expect(map['__MANUAL__1']).toBe('Acme\nHoldings')
    expect(() => sealableMap(map)).toThrow()
    expect(isName('Acme\nHoldings')).toBe(false)
  })
})
