import { describe, expect, it } from 'vitest'

// A map grown any way but grow() throws here (review of 5347c7c).
;(globalThis as { __veilioStrictMaps?: boolean }).__veilioStrictMaps = true
import {
  ENV_NAME_WORDS,
  carriedForward,
  ownedMap,
  highSignal,
  NEVER_RESTORED,
  restoresNeverRestored,
  grow,
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
    expect(restoreArgs('grep -rn __CLS__1 src', map)).toMatchObject({
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
    known.learn(['Qx7mK2pL9!', 'Rz8vB3nM1!'])
    expect(redactKnown('x Qx7mK2pL9!Rz8vB3nM1! y', known)).toBe(
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

describe('the learn bar, by example (reviews of da4ff84 and 7b930ad)', () => {
  const learnedFrom = (text: string) => {
    const known = new Destroyed()
    applyMap(text, {}, undefined, { known })
    return known
  }

  it('only values with structural signal are learned (research R4)', () => {
    for (const plain of [
      'required',
      'Required',
      'Configuration',
      'postgres',
      'root1234',
      'app_pass',
      'my-secret-pass',
      'Welcome2024',
    ])
      expect(learnedFrom(`password = "${plain}"`).values).toEqual([])
    for (const strong of ['S3cretpw!', 'Xk9mQ2vL7Zp'])
      expect(learnedFrom(`password = "${strong}"`).values).toContain(strong)
  })

  it('a learned value glued to a flag, run into another or inside a word is removed', () => {
    const known = learnedFrom('password = "S3cretpw!"\napi_key = "Zq8vB3nM1kL0"')
    expect(redactKnown('mysql -pS3cretpw! xS3cretpw!y S3cretpw!Zq8vB3nM1kL0', known)).not.toMatch(
      /S3cretpw|Zq8vB3nM1kL0/
    )
  })

  it('a weak password seen bare away from its assignment is not swept: the documented limit', () => {
    const known = learnedFrom('password = "my-secret-pass"')
    expect(redactKnown('echo my-secret-pass', known)).toBe('echo my-secret-pass')
  })

  it('a high-entropy value is removed inside a longer word', () => {
    const known = learnedFrom('password = "Xk9mQ2vL7Zp"')
    expect(redactKnown('xXk9mQ2vL7Zp', known)).toBe('x__REDACTED_CREDENTIAL_1001__')
  })
  it('a value made only of placeholders is never learned; one written against a placeholder is', () => {
    expect(learnedFrom('client_secret = "__VAR__1290__STR__3"').values).toEqual([])
    expect(learnedFrom('client_secret = "xQ7zW2vR9t__VAR__1"').values).toContain(
      'xQ7zW2vR9t__VAR__1'
    )
  })
})

describe('a map that grows in place', () => {
  it('its new names defer to the map at once', () => {
    const map: Record<string, string> = { __CLS__1: 'X' }
    applyMap('a', map)
    grow(map, { __STR__9: 'Zq8vB3nM1kL0pW9xYc7dE6fG' })
    expect(applyMap('auth_token: "Zq8vB3nM1kL0pW9xYc7dE6fG"', map)).toContain('"__STR__9"')
  })
})

describe('a large map', () => {
  it('20,000 entries: masking many short texts never recounts the map', () => {
    const map: Record<string, string> = {}
    for (let i = 1; i <= 20_000; i++) map[`__VAR__${i}`] = `name${i}x`
    applyMap('warm', map)
    // As in a session: the strict check counts keys on purpose, so it is off.
    const g = globalThis as { __veilioStrictMaps?: boolean }
    g.__veilioStrictMaps = false
    try {
      const started = performance.now()
      for (let i = 0; i < 3_000; i++) applyMap(`call name${(i % 20_000) + 1}x now`, map)
      expect(performance.now() - started).toBeLessThan(4_000)
    } finally {
      g.__veilioStrictMaps = true
    }
  })
})

describe('the context fallback', () => {
  it('a hold that leaves a credential falls back to full masking before failing', async () => {
    const { Guard } = await import('../../plugins/veilio-guard/lib/guard.ts')
    const { MODEL_NOTE } = await import('../../plugins/veilio-guard/lib/ui.ts')
    const io = {
      read: async () => '',
      write: async () => undefined,
      exists: async () => false,
      realPath: async () => undefined,
      sleep: async () => undefined,
      list: async () => null,
    }
    // A hold path that leaves a credential behind, as a bug in it would.
    class Leaky extends Guard {
      override maskText(text: string, kind?: any, scan?: any): string {
        return text.includes('\u0000')
          ? `${super.maskText(text, kind, scan)} password = "Tr0ub4dor3xzQ"`
          : super.maskText(text, kind, scan)
      }
    }
    const g = new Leaky(io as any, { rawOnly: [], mcpRestore: [] } as any)
    const out = g.applyContext(`# veilioGuard\n${MODEL_NOTE}`)
    expect(out).not.toContain('Tr0ub4dor3xzQ')
    expect(out).toContain('guard is on')
  })
})

describe('the kinds never restored', () => {
  it('are the same list for the last scan and for restores', () => {
    for (const base of NEVER_RESTORED) {
      const p = `${base}${base.endsWith('__') ? '' : '__'}7`
      const map = { [p]: 'AKIAQ7RZ2XKM4PLB8WNE' }
      // Kept masked by the last scan: read back, the key would be found…
      expect(survivingSecrets(`id ${p} end`, map)).toEqual([])
      expect(survivingSecrets('id AKIAQ7RZ2XKM4PLB8WNE end', map)).not.toEqual([])
      // …and refused on restore.
      expect(restoresNeverRestored('x', [p], map)).not.toBeNull()
    }
  })
})

describe('structural signal, by example (review of 5347c7c)', () => {
  const learned = (v: string) => {
    const known = new Destroyed()
    applyMap(`api_token = "${v}"`, {}, undefined, { known })
    return known.values.includes(v)
  }
  it('letters-only and separated tokens are learned and swept', () => {
    for (const v of ['xQzWvRtYpLmNbKjHgFdSaBcDeF', 'kSjdhf-KJhsdf-kjHSDk-fjhsdk']) {
      expect(highSignal(v)).toBe(true)
      expect(learned(v)).toBe(true)
    }
    const known = new Destroyed()
    known.learn(['xQzWvRtYpLmNbKjHgFdSaBcDeF'])
    expect(redactKnown('Bearer xQzWvRtYpLmNbKjHgFdSaBcDeF.', known)).not.toContain('xQzW')
  })
  it('identifiers and words are not', () => {
    for (const v of [
      'requiredFieldsConfiguration',
      'HelloWorldWide',
      'snake_case_identifier_name',
      'Hello World',
      '/usr/local/Lib',
      'https://example.org/Path',
    ])
      expect(highSignal(v)).toBe(false)
  })
})

describe('strict maps', () => {
  it('a map grown without grow() throws at the next read', () => {
    const map: Record<string, string> = { __CLS__1: 'Alpha' }
    applyMap('Alpha', map)
    map.__CLS__2 = 'Beta'
    expect(() => applyMap('Beta', map)).toThrow(/grow\(\)/)
  })
})

describe('structural signal, the second pass (review of 0ef312b)', () => {
  it('paths, URLs, versions and Windows paths never have it', () => {
    for (const v of [
      '/usr/lib/python3.11',
      'https://example.org/v2/Path',
      'v1.2.3-Beta.4',
      'C:\\Users\\Bob2',
      '/run/secrets/Client2',
    ])
      expect(highSignal(v)).toBe(false)
  })
  it('identifiers with a digit do not have it', () => {
    for (const v of ['Hello_World_2026', 'requiredFields2', 'Configuration2', 'Version_2_Release'])
      expect(highSignal(v)).toBe(false)
  })
  it('random-looking keys with digits do', () => {
    for (const v of ['xQ7zW2vR9tY4pLmN', 'S3cretpw!', 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY'])
      expect(highSignal(v)).toBe(true)
  })
  it('a word with a year after it is an identifier: Welcome2024 lands outside', () => {
    expect(highSignal('Welcome2024')).toBe(false)
  })
  it('one-letter camelCase pieces between words are part of the words', () => {
    expect(highSignal('getXOrYFromAToBNowPlease')).toBe(false)
    expect(highSignal('getXFromYToZWithQNow')).toBe(false)
    expect(highSignal('xQzWvRtYpLmNbKjHgFdSaBcDeF')).toBe(true)
  })
})

describe('owned maps (review of 0ef312b)', () => {
  it('a change that keeps the count is caught under strict maps', () => {
    const map: Record<string, string> = { __CLS__1: 'Alpha' }
    applyMap('Alpha', map)
    map.__CLS__1 = 'Gamma'
    expect(() => applyMap('Gamma', map)).toThrow(/grow\(\)/)
  })
  it('an owned map takes no write but through grow()', () => {
    const map = ownedMap({ __CLS__1: 'Alpha' })
    expect(() => {
      map.__CLS__2 = 'Beta'
    }).toThrow(/grow\(\)/)
    grow(map, { __CLS__2: 'Beta' })
    expect(map.__CLS__2).toBe('Beta')
  })
})

describe('punctuated tokens and references (review of 6b5d4b0, founder decision 2)', () => {
  const learned = (text: string, v: string) => {
    const known = new Destroyed()
    applyMap(text, {}, undefined, { known })
    return known.values.includes(v)
  }
  it('a base64 secret with / and + is learned and swept', () => {
    const v = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
    expect(learned(`aws_secret = "${v}"`, v)).toBe(true)
  })
  it('a three-part dotted bearer token is learned and swept', () => {
    const v = 'aB3dE5fG.hI9jK1lM.nO5pQ7rS'
    expect(learned(`Authorization: Bearer ${v}`, v)).toBe(true)
    const known = new Destroyed()
    applyMap(`Authorization: Bearer ${v}`, {}, undefined, { known })
    expect(redactKnown(`curl -H x${v}y`, known)).not.toContain('hI9jK1lM')
  })
  it('the path, URL and version shapes still are not', () => {
    for (const v of [
      '/usr/lib/python3.11',
      'https://example.org/v2/Path',
      'v1.2.3-Beta.4',
      'C:\\Users\\Bob2',
      '/run/secrets/Client2',
    ])
      expect(highSignal(v)).toBe(false)
  })
  it('an environment variable name used as a value is left as written', () => {
    expect(applyMap(`const kinds = { 'google-api-key': 'GOOGLE_KEY' }`, {})).toContain(
      "'GOOGLE_KEY'"
    )
    expect(applyMap(`password = "AWS_SECRET_ACCESS_KEY"`, {})).toContain('"AWS_SECRET_ACCESS_KEY"')
    expect(survivingSecrets(`password = "AWS_SECRET_ACCESS_KEY"`)).toEqual([])
    expect(applyMap(`password = "DATABASE_URL"`, {})).toContain('"DATABASE_URL"')
    expect(applyMap(`secret = "STRIPE_SECRET_KEY"`, {})).toContain('"STRIPE_SECRET_KEY"')
    // Narrowed (review of f19df80): all caps alone is not a name.
    expect(applyMap(`password = "QXZRTPLMKWVBNHGF"`, {})).not.toContain('QXZRTPLMKWVBNHGF')
    expect(applyMap(`password = "ABCDEFGHQWERTZ"`, {})).not.toContain('ABCDEFGHQWERTZ')
    expect(applyMap(`password = "QXZRT_PLMKW_VBNHG"`, {})).not.toContain('QXZRT_PLMKW_VBNHG')
    expect(applyMap(`password = "ABCDEFGHIJKLMNOP_KEY"`, {})).not.toContain('ABCDEFGHIJKLMNOP')
    expect(applyMap(`password = "ABCDEFGHIJKLM_KEY"`, {})).not.toContain('ABCDEFGHIJKLM')
    // Review of 968b3b2: digits only at a segment's end, and it must not look random.
    expect(applyMap(`password = "X7K9A2_Q2LE4M8P"`, {})).not.toContain('X7K9A2_Q2LE4M8P')
    expect(applyMap(`password = "XA_QE_ZI_PO_KU_VE"`, {})).not.toContain('XA_QE_ZI_PO_KU_VE')
    expect(applyMap(`password = "AWS_REGION_2"`, {})).toContain('"AWS_REGION_2"')
    expect(applyMap(`secret = "API_KEY2"`, {})).toContain('"API_KEY2"')
    // A bearer token shaped like a name is a token still. (The engine's bearer
    // rule needs twenty characters; `Bearer ABCDEF_GHIJKL` it does not find.)
    expect(applyMap(`Authorization: Bearer ABCDEF_GHIJKL_MNOPQR`, {})).not.toContain(
      'ABCDEF_GHIJKL'
    )
    expect(survivingSecrets(`Authorization: Bearer GOOGLE_API_TOKEN_VALUE`)).not.toEqual([])
    // An all-caps value that looks random is a credential still.
    expect(applyMap(`password = "X7K9Q2LM4PZ8"`, {})).not.toContain('X7K9Q2LM4PZ8')
    // Review of d55d9e2: a long run of digits is a secret, not a version
    // number, and a name is mostly letters.
    expect(applyMap(`password = "KEY_83749201847362910473"`, {})).not.toContain(
      '83749201847362910473'
    )
    expect(applyMap(`password = "API_2024_0917_KEY"`, {})).not.toContain('API_2024_0917_KEY')
    expect(applyMap(`password = "PORT_8080"`, {})).toContain('"PORT_8080"')
    // One value per rule, each refused by that rule alone: a number segment
    // longer than four digits, two number segments, mostly digits.
    expect(applyMap(`password = "DATABASE_PASSWORD_839201"`, {})).not.toContain(
      'DATABASE_PASSWORD_839201'
    )
    expect(applyMap(`password = "RELEASE_SERVICE_2024_10"`, {})).not.toContain(
      'RELEASE_SERVICE_2024_10'
    )
    expect(applyMap(`password = "KEY_2024"`, {})).not.toContain('KEY_2024')
  })
})

describe('final review of 0ef312b..d55d9e2: reproduced leaks', () => {
  const carried = (text: string, v: string) => {
    const known = new Destroyed()
    applyMap(text, {}, undefined, { known })
    return known.values.includes(v) && !redactKnown(`bare ${v} again`, known).includes(v)
  }
  it('1: a dotted bearer, basic-auth or connection-string value is carried by its rule', () => {
    expect(carriedForward('bearer-token', 'Kq7.Zw3.Xv9.Rt2.Pm5.Ln8')).toBe(true)
    expect(
      carried('Authorization: Bearer Kq7.Zw3.Xv9.Rt2.Pm5.Ln8', 'Kq7.Zw3.Xv9.Rt2.Pm5.Ln8')
    ).toBe(true)
    expect(carriedForward('connection-string', 'v1.2.3-Beta.4')).toBe(true)
    expect(carriedForward('password-assignment', 'v1.2.3-Beta.4')).toBe(false)
  })
  it('2: a letters+digits value with few vowels is carried, words with a number are not', () => {
    for (const [text, v] of [
      ['password = "qzkvwpxmrtbn8274"', 'qzkvwpxmrtbn8274'],
      ['api_key = "8274qzkvwpxmrtbn"', '8274qzkvwpxmrtbn'],
      ['secret = "ZXKQWPMRTBVH2847"', 'ZXKQWPMRTBVH2847'],
    ])
      expect(carried(text, v)).toBe(true)
    for (const v of ['Configuration2', 'requiredFields2', 'Version_2_Release', 'Hello_World_2026'])
      expect(highSignal(v)).toBe(false)
  })
  it('3: an env-var name is made of known words; random letter blocks are redacted', () => {
    for (const v of ['XQAE_ZPOW_KIVR_TUYM', 'KXEQ_ZUVW_PYOT_RAIM_QOEX'])
      expect(applyMap(`password = "${v}"`, {})).not.toContain(v)
    for (const v of [
      'GOOGLE_KEY',
      'DATABASE_URL',
      'STRIPE_SECRET_KEY',
      'AWS_REGION_2',
      'PORT_8080',
    ])
      expect(applyMap(`password = "${v}"`, {})).toContain(`"${v}"`)
    expect(ENV_NAME_WORDS.has('SECRET')).toBe(true)
    expect(ENV_NAME_WORDS.size).toBeGreaterThanOrEqual(150)
  })
  it('5: one random segment after / or ./, or dotted random segments, are not paths', () => {
    for (const [text, v] of [
      ['password = "/Qm8x7Zr+Lk2Pw9aB3"', '/Qm8x7Zr+Lk2Pw9aB3'],
      ['password = "./Kq9xZ2mW7pR4tY"', './Kq9xZ2mW7pR4tY'],
      ['password = "Kq7.Zw3.Xv9.Rt2"', 'Kq7.Zw3.Xv9.Rt2'],
      // One segment is no path, even a word-like one; nor random segments
      // beside one word.
      ['password = "/aBcDeFgHiJkLmNoP"', '/aBcDeFgHiJkLmNoP'],
      ['password = "Kqzx7.Wmrt3.Lpvn9.Release"', 'Kqzx7.Wmrt3.Lpvn9.Release'],
      // Random segments with vowels enough, and a dashed key: no path either
      // (commit review of f9c46d4).
      ['password = "/Qaiv/EuXoBa/PiTaZuE9"', '/Qaiv/EuXoBa/PiTaZuE9'],
      ['password = "Lorem.AeIoBu.UxEvAi7"', 'Lorem.AeIoBu.UxEvAi7'],
      ['password = "aBecE1-iDebI4-kLemO3-pQusE4"', 'aBecE1-iDebI4-kLemO3-pQusE4'],
      ['api_key = "aBc1-dEf2-gHi3-jKl4"', 'aBc1-dEf2-gHi3-jKl4'],
    ])
      expect(carried(text, v)).toBe(true)
    for (const v of [
      '/usr/lib/python3.11',
      'v1.2.3-Beta.4',
      'https://example.org/v2/Path',
      'C:\\Users\\Bob2',
      '/run/secrets/Client2',
    ])
      expect(highSignal(v)).toBe(false)
  })
})
