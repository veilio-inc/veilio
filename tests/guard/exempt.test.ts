import { describe, expect, it } from 'vitest'
import { applyMap, NO_CONTEXT } from '../../plugins/veilio-guard/lib/scrub.ts'

// Spec 050 US2 / Clarifications Q1 (option C): the names the project declares
// are masked. A third-party package, the names imported from it, conventional
// directories and command-line flags are not the project's, and stay as written.
// Spec 064 leaves ordinary words readable whatever their role, so the names
// here are invented: what is proven is the exemption order, not the dictionary.
const MAP = {
  __FN__20: 'skerryCheck',
  __FN__23: 'tarnAssert',
  __PKG__4: 'fenmoor',
  __FN__1: 'luhnValid',
  __PKG__40: 'e2e',
  __PKG__43: 'src',
  __VAR__7: 'tarnwick',
  __PKG__2: 'backend',
}
const ctx = (over: Partial<typeof NO_CONTEXT> = {}) => ({
  ...NO_CONTEXT,
  external: new Set(['skerryCheck', 'tarnAssert', 'fenmoor']),
  ...over,
})

describe('exemptions, in their order', () => {
  it('third-party names stay; the project name is masked', () => {
    expect(
      applyMap("import { skerryCheck, tarnAssert } from 'fenmoor'; luhnValid()", MAP, ctx())
    ).toBe("import { skerryCheck, tarnAssert } from 'fenmoor'; __FN__1()")
  })

  it('the project wins: a name it declares is masked even when a package exports it too', () => {
    const c = ctx({ declared: new Set(['skerryCheck']) })
    expect(applyMap('skerryCheck and tarnAssert', MAP, c)).toBe('__FN__20 and tarnAssert')
  })

  it('a name never seen imported is never exempt', () => {
    expect(applyMap('luhnValid', MAP, ctx({ external: new Set() }))).toBe('__FN__1')
  })

  it('a conventional directory that is only a path entry stays', () => {
    expect(applyMap('see e2e/a.test.ts and src/b.ts', MAP, ctx())).toBe(
      'see e2e/a.test.ts and src/b.ts'
    )
  })

  it('a conventional directory the project also uses as a name is masked', () => {
    const map = { ...MAP, __VAR__9: 'e2e' }
    expect(applyMap('e2e', map, ctx())).not.toBe('e2e')
  })

  it('the same word as a value is still masked', () => {
    expect(applyMap('tarnwick = 1', MAP, ctx())).toBe('__VAR__7 = 1')
  })
})

// Review of 9355866: the flag rule left code names after any dash.
describe('the flag rule is for flags in what you type, nothing else', () => {
  const map = {
    __VAR__1: 'quayward',
    __VAR__2: 'brackwind',
    __FN__3: 'settleAll',
    __PKG__9: 'holmsey',
  }
  it.each([
    ['negation in code', 'return -quayward;'],
    ['a decrement', '--brackwind'],
    ['a double dash inside a word', 'foo--quayward'],
    ['an HTML comment', '<!--quayward-->'],
    ['a removed diff line', '-settleAll()'],
    ['a bullet before a word', '- quayward is low'],
  ])('%s is masked', (_, text) => {
    const out = applyMap(text, map, ctx({ kind: 'prompt' }))
    expect(out).not.toMatch(/quayward|brackwind|settleAll/)
  })
  it('in a result, not even a flag is exempt', () => {
    expect(applyMap('run --holmsey', map, ctx())).toBe('run --__PKG__9')
  })
  it('in a prompt, a flag-shaped word the map holds only as a path stays', () => {
    expect(applyMap('run it with --holmsey', map, ctx({ kind: 'prompt' }))).toBe(
      'run it with --holmsey'
    )
  })
  it('in a prompt, a code name after a dash is masked', () => {
    // "pass" is a credential word: the net would take the flag as its value.
    expect(applyMap('add --quayward to it', map, ctx({ kind: 'prompt' }))).toBe(
      'add --__VAR__1 to it'
    )
  })
})

// Security review of 4446710: only dashes directly before a word count.
it('a bullet is not a flag, even for a word held only as a path', () => {
  expect(applyMap('- holmsey', { __PKG__9: 'holmsey' }, { ...NO_CONTEXT, kind: 'prompt' })).toBe(
    '- __PKG__9'
  )
})
