import { describe, it, expect } from 'vitest'
import { AI_PREAMBLE, anonymize, buildLegend, withAiPreamble } from '../src/engine.js'

describe('buildLegend', () => {
  it('describes each role base present, with counts', () => {
    const legend = buildLegend({
      __CLS__1: 'PaymentService',
      __FN__1: 'chargeCard',
      __FN__2: 'refund',
      __VAR__1: 'grandTotal',
    })
    expect(legend).toContain('__CLS__* are class or type names (1)')
    expect(legend).toContain('__FN__* are function or method names (2)')
    expect(legend).toContain('__VAR__* are variable or parameter names (1)')
    expect(legend.startsWith('Placeholder legend:')).toBe(true)
  })

  it('describes legacy __P<n>__ maps as opaque identifiers', () => {
    expect(buildLegend({ __P1__: 'Foo', __P2__: 'Bar' })).toContain(
      '__P<n>__ are opaque identifiers (2)'
    )
  })

  it('handles mixed legacy + role + custom-rule maps', () => {
    const legend = buildLegend({ __P1__: 'Old', __CLS__1: 'New', __APIKEY__1: 'stripeKey' })
    expect(legend).toContain('__CLS__*')
    expect(legend).toContain('__APIKEY__* are project-specific identifiers (1)')
    expect(legend).toContain('__P<n>__ are opaque identifiers (1)')
  })

  it('never leaks real names into the legend (negative)', () => {
    const legend = buildLegend({ __CLS__1: 'SuperSecretService' })
    expect(legend).not.toContain('SuperSecretService')
  })

  it('returns empty string for an empty map (edge)', () => {
    expect(buildLegend({})).toBe('')
  })

  it('ignores malformed keys (validation)', () => {
    expect(buildLegend({ 'not-a-placeholder': 'X' })).toBe('')
  })
})

describe('withAiPreamble with a map', () => {
  it('inserts the legend between preamble and code', () => {
    const { anonymized, map } = anonymize('class TokenVault {}')
    const out = withAiPreamble(anonymized, map)
    expect(out.startsWith(AI_PREAMBLE)).toBe(true)
    const legendPos = out.indexOf('Placeholder legend:')
    expect(legendPos).toBeGreaterThan(-1)
    expect(legendPos).toBeLessThan(out.indexOf(anonymized))
  })

  it('omits the legend when no map is given (negative / back-compat)', () => {
    const out = withAiPreamble('const __P3__ = 1')
    expect(out).not.toContain('Placeholder legend:')
    expect(out).toBe(`${AI_PREAMBLE}\n\nconst __P3__ = 1`)
  })

  it('omits the legend for an empty map (edge)', () => {
    expect(withAiPreamble('code', {})).not.toContain('Placeholder legend:')
  })

  it('legend counts only placeholders present in the snippet, not the whole map', () => {
    const map = { __CLS__1: 'A', __CLS__2: 'B', __FN__1: 'c' }
    const out = withAiPreamble('class __CLS__2 {}', map)
    expect(out).toContain('__CLS__* are class or type names (1)')
    expect(out).not.toContain('__FN__*')
  })

  it('snippet filtering is boundary-exact (__CLS__1 vs __CLS__10)', () => {
    const out = withAiPreamble('class __CLS__10 {}', { __CLS__1: 'A', __CLS__10: 'B' })
    expect(out).toContain('__CLS__* are class or type names (1)')
  })
})

describe('buildLegend with a snippet argument', () => {
  it('scopes counts to placeholders present in the snippet', () => {
    const map = { __CLS__1: 'A', __CLS__2: 'B', __FN__1: 'c' }
    const legend = buildLegend(map, 'class __CLS__2 {}')
    expect(legend).toContain('__CLS__* are class or type names (1)')
    expect(legend).not.toContain('__FN__*')
  })

  it('is boundary-exact (__CLS__1 vs __CLS__10)', () => {
    const legend = buildLegend({ __CLS__1: 'A', __CLS__10: 'B' }, 'class __CLS__10 {}')
    expect(legend).toContain('__CLS__* are class or type names (1)')
  })

  it('returns empty string when the snippet contains no map keys (edge)', () => {
    expect(buildLegend({ __CLS__1: 'A' }, 'nothing here')).toBe('')
  })

  it('empty snippet string scopes to nothing (edge)', () => {
    expect(buildLegend({ __CLS__1: 'A' }, '')).toBe('')
  })

  it('single-arg call still describes the whole map (regression pin)', () => {
    const legend = buildLegend({ __CLS__1: 'A', __FN__1: 'b' })
    expect(legend).toContain('__CLS__* are class or type names (1)')
    expect(legend).toContain('__FN__* are function or method names (1)')
  })
})
