import { describe, it, expect } from 'vitest'
import { anonymize, isKeyword, type Language } from '../src/index.js'

// Spec 064 FR-003 (F4): a test framework's own names are the framework's, not
// the project's. In spec 062 `toBe`, `assertEqual` and `assertEquals` reached
// the model as __FN__ placeholders in every test run.
const NAMES: Record<string, string[]> = {
  python: [
    'assertEqual',
    'assertTrue',
    'assertFalse',
    'assertRaises',
    'assertIn',
    'assertIsNone',
    'setUp',
    'tearDown',
  ],
  typescript: [
    'toBe',
    'toEqual',
    'toThrow',
    'toHaveLength',
    'toContain',
    'toMatch',
    'beforeEach',
    'afterEach',
  ],
  java: [
    'assertEquals',
    'assertTrue',
    'assertFalse',
    'assertNull',
    'assertNotNull',
    'assertThrows',
    'RoundingMode',
  ],
  ruby: ['assert_equal', 'assert_raises', 'assert_nil'],
}

describe('test-framework names are keywords of their language', () => {
  for (const [lang, names] of Object.entries(NAMES))
    it.each(names)(`${lang}: %s`, (n) => expect(isKeyword(n, lang as Language)).toBe(true))

  it('and are left as written in a test file', () => {
    const { anonymized } = anonymize('expect(skerryTotal(2)).toBe(4)\nexpect(x).toEqual(y)', {
      language: 'typescript',
    })
    expect(anonymized).toContain('.toBe(4)')
    expect(anonymized).toContain('.toEqual(')
    expect(anonymized).not.toContain('skerryTotal')
  })
})
