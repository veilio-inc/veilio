import { describe, it, expect } from 'vitest'
import { alteredNote, alteredPlaceholders, anonymize, restore } from '../src/index.js'

/**
 * Placeholders whose shape the model changed (spec 029).
 *
 * `__FN__9` - the right shape, in no map - has always come back as
 * `unresolved`. `__fn__1` - the model lower-cased it - was not a placeholder to
 * the engine at all, so every surface passed it through without a word: text
 * that looked restored, and an edit that then failed or called something else.
 * It is in the report now, where the web app, the CLI and the MCP server all
 * read it, so they name the same tokens.
 */
const MAP = { __CLS__1: 'PaymentGateway', __FN__1: 'chargeCard' }

describe('report.altered', () => {
  it.each([
    '__fn__1',
    '_FN__1',
    '___CLS__2',
    '__Var__3__',
    '__str__12',
    '__pkg__4',
    '__iban__1',
    '_PAN__2',
    '__pesel__3',
    '__manual__4',
  ])('names %s, a placeholder whose case or underscores the model changed', (token) => {
    const { restored, report } = restore(`new __CLS__1().${token}()`, MAP)
    expect(restored).toBe(`new PaymentGateway().${token}()`)
    expect(report.altered).toEqual([token])
  })

  it.each([
    ['an exact placeholder the map explains', '__FN__1'],
    ['an exact placeholder no map explains (that is `unresolved`)', '__FN__9'],
    ['a credential redacted on purpose', '__REDACTED_STRIPE_KEY_1__'],
    ['a Python dunder', '__init__'],
    ['a snake_case name with a number', 'tmp_fn_1'],
    ['a private name with a number', '_cache_2'],
    ['a kind the engine never mints', '__FOO__1'],
    ['a new name the model derived from a placeholder', '__CLS__1Factory'],
  ])('leaves alone %s', (_what, token) => {
    expect(restore(`x = ${token}()`, MAP).report.altered).toEqual([])
  })

  it('is found in the restored text, not the input: an exact placeholder glued to a suffix restores', () => {
    // `__FN__1_v2` restores to `chargeCard_v2`. Scanning the input instead would
    // name `__FN__1_` - a placeholder that was restored, reported as one that
    // could not be.
    const { restored, report } = restore('__FN__1_v2()', MAP)
    expect(restored).toBe('chargeCard_v2()')
    expect(report.altered).toEqual([])
  })

  it('names one glued to a word the model added: it cannot be restored either', () => {
    // An exact one glued (`__CLS__1Factory`) restores to PaymentGatewayFactory;
    // an altered one glued restores to nothing, so it is named like any other.
    const { restored, report } = restore('new __cls__1Factory()', MAP)
    expect(restored).toBe('new __cls__1Factory()')
    expect(report.altered).toEqual(['__cls__1'])
  })

  // Code review: a real name of that shape was masked, restored exactly, and
  // then reported as altered - so --strict refused correct output. A token that
  // is a real name in the map restored correctly; it cannot be a mangled one.
  it.each(['_str_1', '__var_1', '_var__1', '_fn_2'])(
    'a real identifier %s, masked and restored exactly, is not altered',
    (name) => {
      const source = `const ${name} = 1\nexport function useIt() { return ${name} }`
      const { anonymized, map } = anonymize(source)
      expect(anonymized).not.toContain(name)
      const { restored, report } = restore(anonymized, map)
      expect(restored).toBe(source)
      expect(report.altered).toEqual([])
    }
  )

  it('never starts inside a name: x__fn__1 is not a placeholder', () => {
    expect(restore('x__fn__1()', MAP).report.altered).toEqual([])
  })

  it('each once, in order of first appearance', () => {
    const { report } = restore('__str__2 __fn__1 __str__2 _FN__1', MAP)
    expect(report.altered).toEqual(['__str__2', '__fn__1', '_FN__1'])
  })

  it('never also unresolved', () => {
    const { report } = restore('__FN__9 __fn__9', MAP)
    expect(report.unresolved).toEqual(['__FN__9'])
    expect(report.altered).toEqual(['__fn__9'])
  })

  it('an empty report on clean text', () => {
    expect(restore('new __CLS__1().__FN__1()', MAP).report.altered).toEqual([])
  })
})

describe('alteredPlaceholders', () => {
  it('the same rule, for text on its own', () => {
    expect(alteredPlaceholders('a.__fn__1() b.__FN__1() c.tmp_fn_1()')).toEqual(['__fn__1'])
  })

  it('given the map, a real name in it is not altered - as restore() reports', () => {
    expect(alteredPlaceholders('a._str_1 b.__fn__1')).toEqual(['_str_1', '__fn__1'])
    expect(alteredPlaceholders('a._str_1 b.__fn__1', { __VAR__1: '_str_1' })).toEqual(['__fn__1'])
  })
})

describe('alteredNote', () => {
  it('names them and says why, in the CLI and MCP wording', () => {
    expect(alteredNote(['__fn__1'])).toBe(
      'left as is: __fn__1. It looks like a placeholder whose shape the AI changed (case or underscores), so nothing could restore it. Ask the AI to use the placeholders exactly as given.'
    )
    expect(alteredNote(['__fn__1', '_FN__2'])).toMatch(
      /^left as is: __fn__1, _FN__2\. They look like placeholders/
    )
  })
})
