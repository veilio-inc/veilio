import { describe, it, expect } from 'vitest'
import { anonymize, restore } from '../src/engine.js'
import type { SymbolMap } from '../src/types.js'
import type { SecretPolicy } from '../src/secrets.js'

// Founder decision, 2026-10-26: a credential never goes into the symbol map,
// in any `secrets` mode. `redact` destroys it, `warn` reports it and leaves it
// in the text, `off` ignores it - and in none of them is it, or a name built
// around it, written to the map that is saved to .veilio/map.json and uploaded
// by `maps push`.

const STRIPE = 'sk_live_51H8xQ2ABCDEFGHIJKLMNOP'
const SAMPLES: { name: string; code: string; secret: string; path?: string }[] = [
  { name: 'a provider key in a string', code: `const key = "${STRIPE}"\n`, secret: STRIPE },
  {
    name: 'a password on a command line, inside a longer token',
    code: 'run("mysql -uroot -phunter22 shop")\n',
    secret: 'hunter22',
  },
  {
    name: 'a connection-string password',
    code: 'const url = "postgres://app:Summer24@db/app"\n',
    secret: 'Summer24',
  },
  {
    name: 'a weak fixture in a test file (report-only under redact)',
    code: 'const url = "postgres://app:Summer24@db/app"\n',
    secret: 'Summer24',
    path: 'tests/db.test.ts',
  },
  {
    name: 'an ambiguous generic assignment',
    code: "const config = { password: 'correcthorse' }\n",
    secret: 'correcthorse',
  },
]
const MODES: SecretPolicy[] = ['redact', 'warn', 'off']

function holds(map: SymbolMap, secret: string): string[] {
  return Object.entries(map)
    .filter(([, real]) => real.includes(secret) || (secret.includes(real) && real.length > 2))
    .map(([ph, real]) => `${ph}=${real}`)
}

describe('a credential never goes into the symbol map', () => {
  for (const sample of SAMPLES) {
    for (const secrets of MODES) {
      it(`${sample.name}, secrets: '${secrets}'`, () => {
        const result = anonymize(sample.code, { secrets, path: sample.path })
        expect(holds(result.map, sample.secret)).toEqual([])
        if (secrets !== 'redact') {
          // warn and off leave it in the text, as written.
          expect(result.anonymized).toContain(sample.secret)
        }
        // The text still round-trips: nothing was masked into a value the map
        // does not hold.
        const back = restore(result.anonymized, result.map).restored
        if (secrets !== 'redact') expect(back).toBe(sample.code)
      })
    }
  }

  it('warn still reports the credential, off reports nothing', () => {
    const warn = anonymize(SAMPLES[0].code, { secrets: 'warn' })
    expect(warn.secrets.map((s) => s.type)).toEqual(['stripe-key'])
    expect(anonymize(SAMPLES[0].code, { secrets: 'off' }).secrets).toEqual([])
  })

  it('the identifiers around a credential are still masked', () => {
    const result = anonymize('const PaymentKey = "' + STRIPE + '"\n', { secrets: 'warn' })
    expect(Object.values(result.map)).toContain('PaymentKey')
  })

  it('a credential-shaped entry in an existing map is dropped, positional or not', () => {
    const existing: SymbolMap = { __CLS__1: 'PaymentService', __STR__1: STRIPE }
    for (const options of [existing, { existingMap: existing }]) {
      const result = anonymize('class PaymentService {}', options)
      expect(result.map.__CLS__1).toBe('PaymentService')
      expect(holds(result.map, STRIPE)).toEqual([])
    }
  })

  it('a word that is only a credential by its slot stays in an existing map', () => {
    // `postgres` is not a credential on its own: an existing entry for it is kept.
    const result = anonymize('class Db {}', { existingMap: { __VAR__1: 'postgres' } })
    expect(result.map.__VAR__1).toBe('postgres')
  })
})

describe('a name the map already holds', () => {
  it('is still substituted inside a credential slot: nothing new is written', () => {
    const code = 'export const auth = { client_secret: "disabled" }\n'
    const result = anonymize(code, { existingMap: { __STR__1290: 'disabled' } })
    expect(result.anonymized).toContain('"__STR__1290"')
  })
  it('a new name inside a credential slot is not extracted', () => {
    const code = 'export const auth = { client_secret: "disabled" }\n'
    const result = anonymize(code)
    expect(Object.values(result.map)).not.toContain('disabled')
    expect(result.anonymized).toContain('"disabled"')
  })
})

describe('a credential that is also written as a name elsewhere', () => {
  it('is not mapped through the other occurrence', () => {
    const code = 'const hunter22 = 1\nconst url = "postgres://app:hunter22@db/app"\n'
    for (const secrets of MODES) {
      const result = anonymize(code, { secrets })
      expect(Object.values(result.map), secrets).not.toContain('hunter22')
    }
  })
  it('a mapped name inside a credential is not substituted there: the credential is kept as written', () => {
    const code = 'const hunter = 1\nPGPASSWORD=admin-hunter psql\n'
    const result = anonymize(code, { secrets: 'warn' })
    expect(Object.values(result.map)).toContain('hunter')
    expect(result.anonymized).toContain('PGPASSWORD=admin-hunter ')
  })
})
