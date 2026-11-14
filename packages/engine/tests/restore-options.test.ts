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

// Spec 093: the narration filter matched a verb as a prefix (`Set` in
// `Settings`), and every line filter also fired inside a template literal.
describe('restore — the line filters take whole words, outside literals (spec 093)', () => {
  it.each([
    '// Settings must match prod',
    '// Logic below is order-dependent',
    '// Runtime: node 20',
    '// Checksum of the header',
    // A word going on in a letter outside ASCII is one word too.
    '// Logów z produkcji nie kasujemy',
    '// Formatów jest pięć',
    '// Startübersicht der Dienste',
    '// Set_point of the valve',
  ])('keeps the real comment %s', (comment) => {
    const input = `const a = 1\n  ${comment}\nconst b = 2`
    expect(restore(input, {}).restored).toBe(input)
  })

  it.each([
    '// Set the retry count',
    '// Validate the rate before applying it',
    '// Log the outcome',
    '// Run the migration',
    '// Check that the header is present',
    '// Set: x',
    '// Return',
    '//Get the row',
  ])('still removes the narration line %s', (comment) => {
    const { restored, strippedItems } = restore(`const a = 1\n  ${comment}\nconst b = 2`, {})
    expect(restored).toBe('const a = 1\nconst b = 2')
    expect(strippedItems.map((i) => i.type)).toEqual(['narration'])
  })

  it.each([
    '// Set the retry count',
    '// TODO: later',
    '// Step 1: open',
    '// -----------',
    '// @param rate the rate',
  ])('keeps the line %s inside a template literal', (line) => {
    const input = ['const help = `', `  ${line}`, '`', 'const b = 2'].join('\n')
    const { restored, strippedCount } = restore(input, {})
    expect(restored).toBe(input)
    expect(strippedCount).toBe(0)
  })

  it('still removes a narration line of fenced code in a prose answer with apostrophes', () => {
    const answer = [
      "Here's the fix, it doesn't touch the rest:",
      '```ts',
      '// Set the retry count',
      'const retries = 3',
      '```',
      "That's all.",
    ].join('\n')
    expect(restore(answer, {}).restored).not.toContain('Set the retry count')
  })

  it('removes a narration line after a template literal has closed', () => {
    const input = 'const a = `x`\n// Set the retry count\nconst b = `y`'
    expect(restore(input, {}).restored).toBe('const a = `x`\nconst b = `y`')
  })
})
