import { describe, expect, it } from 'vitest'
import { applyMap, NO_CONTEXT } from '../../plugins/veilio-guard/lib/scrub.ts'

// Spec 050 US2 / Clarifications Q1 (option C): the names the project declares
// are masked. A third-party package, the names imported from it, conventional
// directories and command-line flags are not the project's, and stay as written.
const MAP = {
  __FN__20: 'describe',
  __FN__23: 'expect',
  __PKG__4: 'vitest',
  __FN__1: 'luhnValid',
  __PKG__40: 'tests',
  __PKG__43: 'src',
  __VAR__7: 'tenant',
  __PKG__2: 'backend',
}
const ctx = (over: Partial<typeof NO_CONTEXT> = {}) => ({
  ...NO_CONTEXT,
  external: new Set(['describe', 'expect', 'vitest']),
  ...over,
})

describe('exemptions, in their order', () => {
  it('third-party names stay; the project name is masked', () => {
    expect(applyMap("import { describe, expect } from 'vitest'; luhnValid()", MAP, ctx())).toBe(
      "import { describe, expect } from 'vitest'; __FN__1()"
    )
  })

  it('the project wins: a name it declares is masked even when a package exports it too', () => {
    const c = ctx({ declared: new Set(['describe']) })
    expect(applyMap('describe and expect', MAP, c)).toBe('__FN__20 and expect')
  })

  it('a name never seen imported is never exempt', () => {
    expect(applyMap('luhnValid', MAP, ctx({ external: new Set() }))).toBe('__FN__1')
  })

  it('a conventional directory that is only a path entry stays', () => {
    expect(applyMap('see tests/a.test.ts and src/b.ts', MAP, ctx())).toBe(
      'see tests/a.test.ts and src/b.ts'
    )
  })

  it('a conventional directory the project also uses as a name is masked', () => {
    const map = { ...MAP, __VAR__9: 'tests' }
    expect(applyMap('tests', map, ctx())).not.toBe('tests')
  })

  it('a flag stays; the project directory after it is masked', () => {
    const prompt = ctx({ kind: 'prompt' })
    expect(applyMap('npx vitest run --tenant packages/backend', MAP, prompt)).toBe(
      'npx vitest run --tenant packages/__PKG__2'
    )
  })

  it('the same word as a value is still masked', () => {
    expect(applyMap('tenant = 1', MAP, ctx())).toBe('__VAR__7 = 1')
  })
})
