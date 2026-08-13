import { describe, it, expect } from 'vitest'
import { restore, STRIPPABLE_TYPES } from '../src/engine.js'

const RESPONSE = [
  '/**',
  ' * Settles an invoice against the ledger.',
  ' * @param rate discount rate',
  ' */',
  'function settle(rate) {',
  '  // TODO: handle refunds',
  '  // Step 1: validate',
  '  // Validate the rate before applying it',
  '  // ----------------------------------',
  '  // **Section**',
  '  // @param rate the rate',
  '  return rate',
  '}',
].join('\n')

describe('restore — strip options', () => {
  it('strips every category by default', () => {
    const { restored, strippedItems } = restore(RESPONSE, {})
    expect(restored).not.toContain('Settles an invoice')
    expect(restored).not.toContain('TODO')
    expect(new Set(strippedItems.map((i) => i.type)).size).toBe(STRIPPABLE_TYPES.length)
  })

  it("'all' is explicit for the default", () => {
    expect(restore(RESPONSE, {}, { strip: 'all' }).restored).toBe(restore(RESPONSE, {}).restored)
  })

  it("'none' returns the response untouched", () => {
    const { restored, strippedCount } = restore(RESPONSE, {}, { strip: 'none' })
    expect(restored).toBe(RESPONSE)
    expect(strippedCount).toBe(0)
  })

  it('leaves no whitespace-only line where an indented comment was', () => {
    // Stripping removes the comment text but not the indentation in front of it,
    // so a stripped JSDoc block became a line of spaces: invisible in the UI,
    // trailing whitespace in the editor it is pasted into, and a lint error in
    // any project that enables no-trailing-spaces.
    const input = ['class A {', '  /** Docs. */', '  method() {}', '}'].join('\n')
    const { restored } = restore(input, {})

    expect(restored).not.toContain('Docs')
    expect(restored.split('\n').every((line) => line === line.trimEnd())).toBe(true)
  })

  it("'none' leaves an indented comment's whitespace alone", () => {
    // The same guarantee as the blank-run case: opting out of stripping must not
    // reformat anything, including whitespace we would otherwise tidy.
    const input = 'class A {\n  /** Docs. */\n}'
    expect(restore(input, {}, { strip: 'none' }).restored).toBe(input)
  })

  it("'none' does not even reformat blank runs", () => {
    // Restoring placeholders must not double as a formatter.
    const spaced = 'a\n\n\n\n\nb'
    expect(restore(spaced, {}, { strip: 'none' }).restored).toBe(spaced)
  })

  it('keeps documentation while removing genuine noise', () => {
    // The case that motivated the option: when a model was asked to document
    // its output, deleting the docs destroys requested work.
    const keepDocs = STRIPPABLE_TYPES.filter((t) => t !== 'jsdoc')
    const { restored } = restore(RESPONSE, {}, { strip: keepDocs })
    expect(restored).toContain('Settles an invoice against the ledger.')
    expect(restored).not.toContain('TODO: handle refunds')
    expect(restored).not.toContain('Step 1')
  })

  it('strips exactly the requested category and nothing else', () => {
    const { restored, strippedItems } = restore(RESPONSE, {}, { strip: ['todo'] })
    expect(strippedItems.every((i) => i.type === 'todo')).toBe(true)
    expect(restored).toContain('Settles an invoice')
    expect(restored).not.toContain('TODO: handle refunds')
  })

  it('an empty list strips nothing', () => {
    expect(restore(RESPONSE, {}, { strip: [] }).strippedCount).toBe(0)
  })

  it('still restores placeholders regardless of strip setting', () => {
    const map = { __FN__1: 'settleInvoice' }
    for (const strip of ['all', 'none'] as const) {
      expect(restore('__FN__1()', map, { strip }).restored).toBe('settleInvoice()')
    }
  })

  it('exposes every strippable category', () => {
    expect(STRIPPABLE_TYPES).toContain('jsdoc')
    expect(STRIPPABLE_TYPES).toContain('narration')
    expect(STRIPPABLE_TYPES.length).toBeGreaterThan(4)
  })
})
