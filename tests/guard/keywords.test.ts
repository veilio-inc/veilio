import { describe, expect, it } from 'vitest'
import { applyMap, NO_CONTEXT } from '../../plugins/veilio-guard/lib/scrub.ts'

// Spec 050 US2 / R3: a map built before this fix can hold keywords - on
// 2026-10-24 a misread file put `const`, `export` and `new` into this
// repository's map, and the guard then masked them in every TypeScript file.
// A word is left as written in a text whose own language reserves it.
const POISONED = {
  __VAR__1009: 'const',
  __VAR__690: 'export',
  __VAR__1016: 'new',
  __FN__1006: 'function',
  __FN__2: 'luhnValid',
}
const ts = { ...NO_CONTEXT, language: 'typescript' as const }

describe('keywords of the text language', () => {
  it('TypeScript keeps its keywords; the project name is still masked', () => {
    expect(applyMap('export const x = new Card(); luhnValid(x)', POISONED, ts)).toBe(
      'export const x = new Card(); __FN__2(x)'
    )
  })

  it('a word that is a keyword in TypeScript but a name in Python is masked in Python', () => {
    const py = { ...NO_CONTEXT, language: 'python' as const }
    expect(applyMap('new = luhnValid(1)', POISONED, py)).toBe('__VAR__1016 = __FN__2(1)')
  })

  it('text of unknown language keeps the keywords of every language the project uses', () => {
    const ctx = { ...NO_CONTEXT, projectLanguages: new Set(['typescript'] as const) }
    expect(applyMap('error: export const failed in luhnValid', POISONED, ctx)).toBe(
      'error: export const failed in __FN__2'
    )
  })

  it('in a polyglot project, unknown text masks a word one of its languages uses as a name', () => {
    const ctx = { ...NO_CONTEXT, projectLanguages: new Set(['typescript', 'python'] as const) }
    expect(applyMap('saw new here', POISONED, ctx)).toBe('saw __VAR__1016 here')
  })

  it('before the project languages are known, unknown text behaves as it did', () => {
    expect(applyMap('saw new and export', POISONED, NO_CONTEXT)).toBe(
      'saw __VAR__1016 and __VAR__690'
    )
  })
})
