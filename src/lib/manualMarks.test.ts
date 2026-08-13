import { describe, it, expect } from 'vitest'
import { anonymize, restore, ManualMaskError } from '@veilio-inc/engine'
import { maskSelection, unmaskTerm, previewTerm, stripOption } from './manualMarks.js'

const SOURCE = '// escalated by Kowalska, acct 88412037\nfunction settle(rate) { return rate }'

function anonymized() {
  const { anonymized, map } = anonymize(SOURCE)
  return { output: anonymized, map }
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
    // C6 — dragging across a word usually catches the space after it, and an
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
    // C4 — a manual mask is reversible and lands in the exported map.
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
    // D5 — the regression the trailing-digit guard exists for. A plain replace
    // rewrites the prefix of the longer token and leaves a stray '0' behind.
    const state = {
      output: 'a = __MANUAL__1; b = __MANUAL__10;',
      map: { __MANUAL__1: 'first', __MANUAL__10: 'tenth' },
    }
    const next = unmaskTerm(state, '__MANUAL__1')

    expect(next.output).toBe('a = first; b = __MANUAL__10;')
    expect(next.map['__MANUAL__10']).toBe('tenth')
  })

  it('replaces every occurrence of the placeholder', () => {
    const state = {
      output: '__MANUAL__1 and __MANUAL__1 again',
      map: { __MANUAL__1: 'Kowalska' },
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
