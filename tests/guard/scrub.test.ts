import { describe, expect, it } from 'vitest'
import {
  applyMap,
  restoreArgs,
  scrubSource,
  survivingSecrets,
} from '../../plugins/veilio-guard/lib/scrub.ts'

const SRC = `export class QuasarLedgerReconciler {
  reconcile(batchEntries: string[]): number {
    const settledTotal = batchEntries.length
    return settledTotal
  }
}
`
const STRIPE = 'sk_live_' + '51HbFakeFakeFake0123456789abcdefABCDEF'

describe('scrubSource: a source file the model reads', () => {
  it('masks the identifiers and reports the new map entries', () => {
    const r = scrubSource(SRC, {})
    expect(r.text).not.toContain('QuasarLedgerReconciler')
    expect(r.text).not.toContain('settledTotal')
    expect(Object.values(r.additions)).toEqual(
      expect.arrayContaining(['QuasarLedgerReconciler', 'settledTotal'])
    )
  })

  it('reuses the placeholders the map already has, and adds only what is new', () => {
    const first = scrubSource(SRC, {})
    const again = scrubSource(SRC, first.additions)
    expect(again.text).toBe(first.text)
    expect(again.additions).toEqual({})
  })

  it('redacts a credential irreversibly, and never puts it in the map', () => {
    const r = scrubSource(`const key = "${STRIPE}"\n`, {})
    expect(r.text).not.toContain(STRIPE)
    expect(JSON.stringify(r.additions)).not.toContain(STRIPE)
  })
})

describe('applyMap: output, search results and prompts', () => {
  const map = { __CLS__1: 'QuasarLedgerReconciler', __VAR__1: 'settledTotal' }

  it('replaces whole known names and adds nothing', () => {
    const out = applyMap(
      'src/ledger.ts:1: QuasarLedgerReconciler, settledTotal and settledTotals',
      map
    )
    expect(out).toBe('src/ledger.ts:1: __CLS__1, __VAR__1 and settledTotals')
  })

  it('replaces the longest name first', () => {
    expect(
      applyMap('QuasarLedgerReconcilerFactory', {
        ...map,
        __CLS__2: 'QuasarLedgerReconcilerFactory',
      })
    ).toBe('__CLS__2')
  })

  it('treats regular expression characters in a name literally', () => {
    expect(applyMap('a.b and axb', { __STR__1: 'a.b' })).toBe('__STR__1 and axb')
  })

  it('leaves everyday words from string literals in output, and still masks identifiers', () => {
    // The scale run: a map built from a real repository holds the words of its
    // string literals (the, and, keep), and applied everywhere they turned a
    // git log into placeholders. Inside a source file the engine masks them
    // where they sit in a literal.
    expect(
      applyMap('keep the total and Placeholder', {
        __VAR__1: 'total',
        __STR__1: 'the',
        __STR__2: 'keep',
        __STR__3: 'Placeholder',
      })
    ).toBe('keep the __VAR__1 and Placeholder')
  })

  it('masks a string-literal word shaped like a name: a table, a versioned route', () => {
    expect(
      applyMap('from customer_refunds via apiV2 and v2', {
        __STR__1: 'customer_refunds',
        __STR__2: 'apiV2',
        __STR__3: 'v2',
      })
    ).toBe('from __STR__1 via __STR__2 and __STR__3')
  })

  it('redacts a credential in output', () => {
    const out = applyMap(`STRIPE_SECRET_KEY=${STRIPE}\n`, {})
    expect(out).not.toContain(STRIPE)
    expect(out).toMatch(/__REDACTED_/)
  })

  it('removes a regulated number the map does not have (a PESEL), since output adds no entries', () => {
    const out = applyMap('customer pesel 44051401458 failed', {})
    expect(out).not.toContain('44051401458')
  })

  it('uses the placeholder for a regulated number the map already has', () => {
    expect(applyMap('pesel 44051401458', { __PESEL__1: '44051401458' })).toBe('pesel __PESEL__1')
  })
})

describe('survivingSecrets', () => {
  it('finds a credential in text and none in scrubbed text', () => {
    expect(survivingSecrets(`k=${STRIPE}`).length).toBeGreaterThan(0)
    expect(survivingSecrets(applyMap(`k=${STRIPE}`, {}))).toEqual([])
  })
})

describe('restoreArgs', () => {
  const map = { __CLS__1: 'QuasarLedgerReconciler', __VAR__1: 'settledTotal' }

  it('puts the real names back', () => {
    expect(restoreArgs('grep -rn __CLS__1 src', map)).toEqual({
      text: 'grep -rn QuasarLedgerReconciler src',
      unresolved: [],
      altered: [],
    })
  })

  it('reports a placeholder the map does not have', () => {
    expect(restoreArgs('const __VAR__9 = 1', map).unresolved).toEqual(['__VAR__9'])
  })

  it('reports a placeholder the model re-cased', () => {
    expect(restoreArgs('return __var__1', map).altered).toEqual(['__var__1'])
  })

  it('changes nothing else in the text: no comment is stripped', () => {
    const text = '// TODO: keep\n/** doc */\nconst a = __VAR__1\n'
    expect(restoreArgs(text, map).text).toBe('// TODO: keep\n/** doc */\nconst a = settledTotal\n')
  })
})
