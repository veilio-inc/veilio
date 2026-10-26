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
    const code = 'const admin = 1\nPGPASSWORD=admin-hunter psql\n'
    const result = anonymize(code, { secrets: 'warn' })
    expect(Object.values(result.map)).toContain('admin')
    expect(result.anonymized).toContain('PGPASSWORD=admin-hunter ')
  })
})

// Round 3 of the review.
describe('an old map that already holds a credential found in the text', () => {
  const OLD = { __VAR__1: 'Kx9_prodpw', __CLS__1: 'PaymentService' }
  const cases: { name: string; code: string; options: object }[] = [
    { name: 'warn', code: 'PGPASSWORD=Kx9_prodpw psql\n', options: { secrets: 'warn' } },
    { name: 'off', code: 'PGPASSWORD=Kx9_prodpw psql\n', options: { secrets: 'off' } },
    {
      name: 'a weak fixture under redact',
      code: 'PGPASSWORD=Kx9_prodpw psql\n',
      options: { path: 'tests/db.test.ts' },
    },
  ]
  for (const c of cases) {
    it(`drops it and never writes its placeholder there (${c.name})`, () => {
      const result = anonymize(c.code, { existingMap: OLD, ...c.options })
      expect(result.anonymized).not.toContain('__VAR__1')
      expect(result.anonymized).toContain('PGPASSWORD=Kx9_prodpw')
      expect(Object.values(result.map)).not.toContain('Kx9_prodpw')
      expect(result.map.__CLS__1).toBe('PaymentService')
    })
  }
  it('a dropped number is never reused', () => {
    const code = 'PGPASSWORD=Kx9_prodpw psql\nconst invoiceTotal = 1\n'
    const result = anonymize(code, { existingMap: OLD, secrets: 'warn' })
    expect(result.map.__VAR__1).toBeUndefined()
    const placeholder = Object.entries(result.map).find(([, v]) => v === 'invoiceTotal')?.[0]
    expect(placeholder).toBeDefined()
    expect(placeholder).not.toBe('__VAR__1')
  })
  it('a self-identifying credential dropped from the map does not free its number', () => {
    const result = anonymize('const invoiceTotal = 1\n', {
      existingMap: { __VAR__7: 'sk_live_51H8xQ2ABCDEFGHIJKLMNOP' },
    })
    const placeholder = Object.entries(result.map).find(([, v]) => v === 'invoiceTotal')?.[0]
    expect(placeholder).toBe('__VAR__8')
  })
})

// Coordinator ruling (security finding on the fragment rule): a name is
// hidden from the model, never left unmasked because it resembles a
// credential. The map is the user's own and encrypted; the model is the party
// we protect against.
describe('a name next to a credential', () => {
  it('acmeCorp_2024 beside the password acmeCorp_2024! is masked and mapped like any name', () => {
    const code = "const acmeCorp_2024 = 1\nPGPASSWORD='acmeCorp_2024!' psql\n"
    const result = anonymize(code)
    expect(Object.values(result.map)).toContain('acmeCorp_2024')
    expect(Object.values(result.map)).not.toContain('acmeCorp_2024!')
    expect(result.anonymized).not.toContain('acmeCorp_2024')
  })
  it('a part of a credential is masked and mapped like any name, in every mode', () => {
    const code = 'const secret = 1\nconst admin = 2\nPGPASSWORD=admin-secret-pw1 psql\n'
    for (const secrets of MODES) {
      const result = anonymize(code, { secrets })
      expect(Object.values(result.map), secrets).toContain('secret')
      expect(Object.values(result.map), secrets).toContain('admin')
      expect(result.anonymized, secrets).toMatch(/^const __[A-Z]+__\d+ = 1\n/)
    }
  })
  it('a name equal to a credential is replaced by the credential’s own redaction token', () => {
    const code = 'const hunter22 = 1\nconst url = "postgres://app:hunter22@db/app"\n'
    const result = anonymize(code)
    expect(result.anonymized).not.toContain('hunter22')
    expect(Object.values(result.map)).not.toContain('hunter22')
    const tokens = result.anonymized.match(/__REDACTED_[A-Z_]+_\d+__/g) ?? []
    expect(tokens).toHaveLength(2)
    expect(new Set(tokens).size).toBe(1)
  })
  it('a name equal to a credential left in the text by design is left too, and never mapped', () => {
    // Under warn and off, and for a fixture in a test file, the credential is
    // sent as written; the equal name shows nothing more, and is not destroyed.
    const code = 'const hunter22 = 1\nconst url = "postgres://app:hunter22@db/app"\n'
    for (const options of [{ secrets: 'warn' }, { secrets: 'off' }, { path: 'tests/db.test.ts' }]) {
      const result = anonymize(code, options as object)
      expect(result.anonymized, JSON.stringify(options)).toMatch(/^const hunter22 = 1\n/)
      expect(Object.values(result.map)).not.toContain('hunter22')
    }
  })
})

describe('a name equal to an ambiguous word', () => {
  it('is masked and mapped like any name: the word is not a credential', () => {
    const code = 'const disabled = true\nconst auth = { client_secret: "disabled" }\n'
    const result = anonymize(code)
    expect(Object.values(result.map)).toContain('disabled')
    expect(result.anonymized).toMatch(/^const __[A-Z]+__\d+ = true\n/)
  })
})

// 1.12.1 review: a weak password that is an ordinary word or a well-known
// default is redacted where it stands, and nowhere else.
describe('a credential that is an ordinary word is not propagated', () => {
  const code =
    'services:\n  db:\n    image: postgres\n    environment:\n      POSTGRES_PASSWORD: postgres\n' +
    '      DATABASE_URL: postgres://app:postgres@db/app\n'
  it('redacts the password spans and keeps the image name and the scheme', () => {
    const out = anonymize(code).anonymized
    expect(out).toMatch(/POSTGRES_PASSWORD: __REDACTED_[A-Z_]+_\d+__\n/)
    expect(out).toMatch(/ postgres:\/\/app:__REDACTED_[A-Z_]+_\d+__@/)
    // The image key itself may be masked as a name; its value, postgres, stays.
    expect(out).toMatch(/__[A-Z]+__\d+: postgres\n|image: postgres\n/)
    expect(Object.values(anonymize(code).map)).not.toContain('postgres')
  })
  for (const word of [
    'root',
    'admin',
    'mysql',
    'guest',
    'password',
    'postgres',
    'secret',
    'demo',
  ]) {
    it(`does not spread the default "${word}" to a name elsewhere`, () => {
      const text = `const ${word} = 1\nconst url = "mysql://app:${word}@db/app"\n`
      const scan = anonymize(text)
      if (/^(?:password|secret)$/.test(word)) return // placeholders: nothing is redacted at all
      expect(scan.anonymized, word).toMatch(/:\/\/app:__REDACTED_[A-Z_]+_\d+__@/)
      expect(scan.anonymized, word).not.toMatch(/^const __REDACTED_/)
    })
  }
  it('a long lowercase word is not spread either', () => {
    const text = 'const services = 1\nconst url = "mysql://app:services@db/app"\n'
    expect(anonymize(text).anonymized).not.toMatch(/^const __REDACTED_/)
  })
  it('a value of 8+ characters that is not a word is spread', () => {
    const text = 'const hunter22 = 1\nconst url = "mysql://app:hunter22@db/app"\n'
    expect(anonymize(text).anonymized).toMatch(/^const __REDACTED_[A-Z_]+_\d+__ = 1\n/)
  })
  it('a value under 8 characters is not spread', () => {
    const text = 'const hunt22 = 1\nconst url = "mysql://app:hunt22@db/app"\n'
    expect(anonymize(text).anonymized).not.toMatch(/^const __REDACTED_/)
  })
})
