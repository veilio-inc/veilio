import { describe, expect, it } from 'vitest'
import {
  Destroyed,
  dropResidue,
  redactKnown,
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

  it('leaves lowercase words from string literals in output, and still masks identifiers and capitalised words', () => {
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
    ).toBe('keep the __VAR__1 and __STR__3')
  })

  it('masks a capitalised one-word literal, and states the lowercase residual', () => {
    // Review finding: a client name written in a literal is capitalised and
    // stays masked. A lowercase one-word name (a surname, a codename) in a
    // literal reaches the model in output; COVERAGE.md says so.
    expect(applyMap('Contoso and kowalski', { __STR__1: 'Contoso', __STR__2: 'kowalski' })).toBe(
      '__STR__1 and kowalski'
    )
  })

  it('does not apply a name no language masks, which an older map may hold: length stays', () => {
    // Review finding: maps built before the engine kept `length` hold
    // `__VAR__3: length`, and applying them undid the fix.
    const old = { __VAR__1: 'batchEntries', __VAR__3: 'length' }
    expect(applyMap('batchEntries.length', old)).toBe('__VAR__1.length')
    expect(restoreArgs('x.__VAR__3', old).text).toBe('x.length')
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

  it('reads back every placeholder form the map holds, legacy ones included', () => {
    const map = { __P1__: 'Zx9kQ2mLpW', __S12__: 'Tr0ub4dor' }
    // Each placeholder stands for part of a credential written around it.
    expect(survivingSecrets('token: "__P1__q7Rt5vYb3nHc8dWw2Xx1"', map)).not.toEqual([])
    expect(survivingSecrets('password = "__S12__3xzQ"', map)).not.toEqual([])
  })

  it('reads a placeholder whole: one key is not read inside a longer one', () => {
    const map = { __VAR__12: 'a' }
    // `__VAR__1234567` is a placeholder the map does not hold, judged as it
    // stands; read as `a` and 34567 it would pass as a plain word.
    expect(survivingSecrets('password = "__VAR__1234567"', map)).not.toEqual([])
    expect(survivingSecrets('password = "__VAR__12"', map)).toEqual([])
  })

  it('leaves values masked on purpose masked', () => {
    const map = { __MANUAL__1: 'Tr0ub4dor3xzQ', __IBAN__1: 'GB82WEST12345698765432' }
    expect(survivingSecrets('password = "__MANUAL__1"', map)).toEqual([])
    expect(survivingSecrets('api_key = "__IBAN__1"', map)).toEqual([])
  })

  it('masks a large masked file in linear time', () => {
    const map: Record<string, string> = {}
    const lines: string[] = []
    for (let i = 1; i <= 16_000; i++) {
      map[`__VAR__${i}`] = `name${i}`
      lines.push(`const __VAR__${i} = __VAR__${i}`)
    }
    const text = lines.join('\n')
    const started = performance.now()
    applyMap(text, map)
    survivingSecrets(text, map)
    expect(performance.now() - started).toBeLessThan(10_000)
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

describe('redactKnown', () => {
  it('a 1 MB base64 blob holding a secret thousands of times is redacted fast and whole', () => {
    const secret = 'xk9mq2'
    const chunk = `${secret} AbCdEfGh0123456789+/ `
    const blob = chunk.repeat(Math.ceil(1_000_000 / chunk.length))
    const started = performance.now()
    const known = new Destroyed()
    known.learn([secret])
    const out = redactKnown(blob, known)
    expect(performance.now() - started).toBeLessThan(10_000)
    expect(out).not.toContain(secret)
  })

  it('the rest of a key a rule only partly took goes with it, in its slot and bare', () => {
    const core = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12'
    const key = `${core}${'Zq8vB3nM1kL0pW-_'.repeat(14)}`
    const known = new Destroyed()
    const out = applyMap(`aws_secret_access_key = "${key}"\nlog: ${key} done\n`, {}, undefined, {
      known,
    })
    expect(out).not.toContain('Zq8vB3nM1kL0pW')
    expect(out).not.toContain('wJalrXUtn')
  })

  it('a value that repeats inside itself is found once per occurrence, fast', () => {
    const known = new Destroyed()
    known.learn(['a'.repeat(20)])
    const blob = 'a'.repeat(2_000_000)
    const started = performance.now()
    const out = redactKnown(blob, known)
    expect(performance.now() - started).toBeLessThan(10_000)
    expect(out).not.toContain('a'.repeat(20))
  })
})

describe('residue after a token', () => {
  it('a long run of tokens with no closing quote is read once', () => {
    const text = `x = "${'__REDACTED_SECRET_1__'.repeat(50_000)}`
    const started = performance.now()
    const out = dropResidue(text)
    expect(performance.now() - started).toBeLessThan(10_000)
    expect(out).toBe(text)
  })

  it('a megabyte of key characters after a token, with no quote, is left as it is', () => {
    const text = `x = "__REDACTED_SECRET_1__${'A'.repeat(1_000_000)}`
    expect(dropResidue(text)).toBe(text)
  })

  it('a quoted residue is still removed', () => {
    expect(applyMap('a = "__REDACTED_SECRET_1__3x"', {})).toBe('a = "__REDACTED_SECRET_1__"')
  })
})

describe('a value that overlaps itself', () => {
  it('every occurrence is found, overlapping ones too', () => {
    const known = new Destroyed()
    known.learn(['Qx7!Qx7!'])
    expect(redactKnown('pw Qx7!Qx7!Qx7! end', known)).toBe('pw __REDACTED_CREDENTIAL_1001__ end')
  })
})

describe('a periodic value in a long periodic run', () => {
  it('a megabyte of one letter, with that letter learned four times over, is one span', () => {
    const known = new Destroyed()
    known.learn(['aaaa'])
    const text = 'a'.repeat(1_000_000)
    const started = performance.now()
    const out = redactKnown(text, known)
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(out).toBe('__REDACTED_CREDENTIAL_1001__')
  })

  it('too many separate occurrences fail closed', () => {
    const known = new Destroyed()
    known.learn(['Zq8vB3'])
    expect(() => redactKnown('Zq8vB3 '.repeat(200_000), known)).toThrow(/too many/)
  })
})

describe('a destroyed value too long to remove', () => {
  it('fails closed', () => {
    const known = new Destroyed()
    expect(() => known.learn(['k'.repeat(20_000)])).toThrow(/too long/)
    // Kept by its bounded prefix, so later texts holding it lose it too.
    expect(known.values.map((v) => v.length)).toEqual([16_384])
  })
})

describe('the end of a periodic run', () => {
  it('an occurrence that starts inside a run and crosses its end is removed', () => {
    // `..!..` repeats at shifts 3 and 4: after the run at 2 ends, another
    // occurrence starts inside it.
    const known = new Destroyed()
    known.learn(['..!..'])
    expect(redactKnown('x ..!...!.. y', known)).toBe('x __REDACTED_CREDENTIAL_1001__ y')
  })

  it('the same with a simple repeating value', () => {
    const known = new Destroyed()
    known.learn(['!?!?'])
    expect(redactKnown('x !?!?!?!. !?!? y', known)).toBe(
      'x __REDACTED_CREDENTIAL_1001__. __REDACTED_CREDENTIAL_1001__ y'
    )
  })
})

describe('a batch with one value too long', () => {
  it('the others are still kept, and the long one by its prefix', () => {
    const known = new Destroyed()
    const long = `${'k'.repeat(20_000)}`
    expect(() => known.learn([long, 'secretOne123', 'secretTwo456'])).toThrow(/too long/)
    expect(redactKnown('x secretOne123 secretTwo456 y', known)).toBe(
      'x __REDACTED_CREDENTIAL_1002__ __REDACTED_CREDENTIAL_1003__ y'
    )
    expect(redactKnown(`a ${'k'.repeat(16_384)} b`, known)).not.toContain('kkkk')
  })
})

describe('what the session learns', () => {
  it('a password that is one plain word is not learned', () => {
    const known = new Destroyed()
    applyMap('postgres://postgres:postgres@localhost:5432/app', {}, undefined, { known })
    expect(known.values).toEqual([])
  })

  it('a value the map holds is never learned', () => {
    const known = new Destroyed()
    applyMap(
      "session_token = 'acme_billing_session_token_v2'",
      { __STR__1: 'acme_billing_session_token_v2' },
      undefined,
      { known }
    )
    expect(known.values).toEqual([])
  })

  it('a learned value is removed wherever it appears, inside a longer word too', () => {
    const known = new Destroyed()
    known.learn(['Xk9mQ2vL7'])
    expect(redactKnown('a xXk9mQ2vL7 Xk9mQ2vL7y b', known)).toBe(
      'a x__REDACTED_CREDENTIAL_1001__ __REDACTED_CREDENTIAL_1001__y b'
    )
  })

  it('two secrets side by side are two tokens', () => {
    const known = new Destroyed()
    known.learn(['Qx7!', 'Rz8!'])
    expect(redactKnown('x Qx7!Rz8! y', known)).toBe(
      'x __REDACTED_CREDENTIAL_1001____REDACTED_CREDENTIAL_1002__ y'
    )
  })

  it('the last scan reads placeholders back without building a regex per map', () => {
    const map: Record<string, string> = {}
    for (let i = 1; i <= 500; i++) map[`__VAR__${i}`] = `name${i}`
    const Real = RegExp
    let built = 0
    globalThis.RegExp = new Proxy(Real, {
      construct(target, args) {
        built++
        return new target(...(args as [string, string?]))
      },
    }) as RegExpConstructor
    try {
      // A fresh copy per call, as afterTool and maskMessage pass one.
      for (let i = 0; i < 50; i++) survivingSecrets(`x = __VAR__${i + 1} y`, { ...map })
    } finally {
      globalThis.RegExp = Real
    }
    expect(built).toBe(0)
  })
})

describe('the learn bar, by example (review of da4ff84)', () => {
  const learned = (pw: string) => {
    const known = new Destroyed()
    applyMap(`password = "${pw}"`, {}, undefined, { known })
    return known.values.includes(pw)
  }
  it('underscores and hyphens do not make a word key material', () => {
    expect(learned('app_pass')).toBe(false)
    expect(learned('my-secret')).toBe(false)
    // Strong enough to be destroyed where they stand, and still no key material.
    expect(learned('Kestrel_Harbor_Lantern')).toBe(false)
    expect(learned('Quartz-Meadow-Falcon')).toBe(false)
  })
  it('a plain word is not learned', () => {
    expect(learned('postgres')).toBe(false)
  })
  it('letters and digits are: root1234 is a password, removed wherever it appears', () => {
    expect(learned('root1234')).toBe(true)
  })
  it('a placeholder or a token is never learned', () => {
    const known = new Destroyed()
    applyMap('client_secret = "__VAR__1290x7"', {}, undefined, { known })
    expect(known.values).toEqual([])
  })
})

describe('a map that grows in place', () => {
  it('its new names defer to the map at once', () => {
    const map: Record<string, string> = { __CLS__1: 'X' }
    applyMap('a', map)
    map.__STR__9 = 'Zq8vB3nM1kL0pW9xYc7dE6fG'
    expect(applyMap('auth_token: "Zq8vB3nM1kL0pW9xYc7dE6fG"', map)).toContain('"__STR__9"')
  })
})
