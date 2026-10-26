import { describe, it, expect } from 'vitest'
import { anonymize, restore } from '../src/engine.js'
import { scanSecrets } from '../src/secrets.js'
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

// 1.12.1 security finding on f9ae1f8: a destroyed credential's redaction
// spreads to every other occurrence in the text. The one exception is a
// well-known default word in a position that is structurally not a secret: an
// image name, a URL scheme, a URL user or user field, a compose service name.
describe('a destroyed credential is redacted wherever else it appears', () => {
  const TOKEN = /__REDACTED_[A-Z_]+_\d+__/
  it('a short random password, used again in a string', () => {
    const out = anonymize('PGPASSWORD=Xk9!p psql\nconst greeting = "Xk9!p"\n').anonymized
    expect(out).not.toContain('Xk9!p')
    expect(out.match(new RegExp(TOKEN.source, 'g'))).toHaveLength(2)
  })
  it('a lowercase passphrase, used again as an identifier', () => {
    const result = anonymize('PGPASSWORD=sunshinedolphin psql\nconst sunshinedolphin = 1\n')
    expect(result.anonymized).not.toContain('sunshinedolphin')
    expect(result.anonymized).toMatch(/const __REDACTED_[A-Z_]+_\d+__ = 1\n/)
    expect(Object.values(result.map)).not.toContain('sunshinedolphin')
  })
  it('a default word as a variable in code is redacted too', () => {
    const out = anonymize('const postgres = require("pg")\nPGPASSWORD=postgres psql\n').anonymized
    expect(out).not.toMatch(/\bpostgres\b/)
  })
  for (const word of ['root', 'admin', 'mysql', 'guest', 'demo', 'user']) {
    it(`the default "${word}" used as a name elsewhere in code is redacted`, () => {
      const out = anonymize(`const ${word} = 1\nconst url = "mysql://app:${word}@db/app"\n`)
      expect(out.anonymized, word).toMatch(/^const __REDACTED_[A-Z_]+_\d+__ = 1\n/)
    })
  }
  const compose =
    'services:\n  postgres:\n    image: postgres:16\n    depends_on:\n      - postgres\n' +
    '    environment:\n      POSTGRES_USER: postgres\n      POSTGRES_PASSWORD: postgres\n' +
    '      DATABASE_URL: postgres://postgres:postgres@db/app\n'
  it('a default word stays in an image name, a URL scheme, a URL user, a user field and a service name', () => {
    const out = scanSecrets(compose).code
    const spread = anonymize(compose).anonymized
    expect(spread).toMatch(/: postgres:16\n/) // image
    expect(spread).toMatch(/ postgres:\/\/postgres:__REDACTED_[A-Z_]+_\d+__@/) // scheme, user
    expect(spread).toMatch(/USER: postgres\n/) // user field
    expect(spread).toMatch(/\n {2}postgres:\n/) // service name
    expect(spread).toMatch(/- postgres\n/) // service reference
    expect(spread).toMatch(/PASSWORD: __REDACTED_[A-Z_]+_\d+__\n/)
    expect(out).toMatch(/PASSWORD: __REDACTED_[A-Z_]+_\d+__\n/)
  })
  it('a password that is not a default word is redacted even in an image or user position', () => {
    const code =
      'POSTGRES_PASSWORD: Kx9prodpw\nimage: Kx9prodpw\nPOSTGRES_USER: Kx9prodpw\nurl: Kx9prodpw://h\n'
    const out = anonymize(code).anonymized
    expect(out).not.toContain('Kx9prodpw')
  })
  it('two credentials, one inside the other, are both redacted whole: no fragment stays', () => {
    const code =
      'PGPASSWORD=Kx9prod psql\nMYSQL_PWD=Kx9prodpw9 mysql\nconst note = "use Kx9prodpw9 or Kx9prod"\n'
    const result = anonymize(code)
    expect(result.anonymized).not.toContain('Kx9prod')
    expect(result.anonymized).not.toContain('pw9')
    // No fragment of either reached the map through masking.
    expect(Object.values(result.map).filter((v) => /Kx9|pw9/.test(v))).toEqual([])
  })
  it('a credential of 4+ characters is redacted inside larger names, URLs and strings', () => {
    const code =
      'PGPASSWORD=Xk9!p psql\nconst a = "Xk9!pSuffix"\nfetch("https://h/?t=Xk9!p&x=1")\n' +
      'const body = \'{"key":"Xk9!p"}\'\nconst Xk9pName = 1\n'
    const result = anonymize(code)
    expect(result.anonymized).not.toContain('Xk9!p')
    // Replaced before masking, so no fragment (Xk9, pSuffix) reaches the map.
    expect(Object.values(result.map).filter((v) => /^Xk9$|pSuffix|^p$/.test(v))).toEqual([])
    // A different name that merely shares letters is untouched by the spread.
    expect(scanSecrets(code).code).toContain('Xk9pName')
  })
  it('a credential shorter than 4 characters is redacted only as a whole word', () => {
    const code = 'PGPASSWORD=ab1 psql\nconst tab1 = "ab1"\n'
    const result = anonymize(code)
    expect(result.anonymized).not.toMatch(/"ab1"/)
    expect(Object.values(result.map)).toContain('tab1')
  })
  it('a default word is redacted only as a whole word, never inside a longer name', () => {
    const code = 'PGPASSWORD=postgres psql\nconst postgresClient = connect("postgresql")\n'
    const result = anonymize(code)
    expect(Object.values(result.map)).toContain('postgresClient')
    expect(scanSecrets(code).code).toContain('"postgresql"')
    expect(result.anonymized).not.toMatch(/__REDACTED_[A-Z_]+_\d+__(?:Client|ql)/)
  })
  describe('credentials that touch in the text', () => {
    const tokenAt = (out: string, key: string) =>
      new RegExp(`${key}=(__REDACTED_[A-Z_]+_\\d+__)`).exec(out)?.[1]
    const line = (out: string) => /const s = "([^"]*)"/.exec(out)?.[1]
    it('overlapping: one generic token covers both, no character left', () => {
      const code = 'PGPASSWORD=abcXYZ1 a\nMYSQL_PWD=XYZ1def2 b\nconst s = "abcXYZ1def2"\n'
      const out = anonymize(code).anonymized
      const covered = line(out)!
      expect(covered).toMatch(/^__REDACTED_CREDENTIAL_\d+__$/)
      expect(covered).not.toBe(tokenAt(out, 'PGPASSWORD'))
      expect(covered).not.toBe(tokenAt(out, 'MYSQL_PWD'))
    })
    it('nested: the token of the longer credential', () => {
      const code = 'PGPASSWORD=Kx9prod a\nMYSQL_PWD=Kx9prodpw9 b\nconst s = "Kx9prodpw9"\n'
      const out = anonymize(code).anonymized
      expect(line(out)).toBe(tokenAt(out, 'MYSQL_PWD'))
    })
    it('adjacent: one generic token covers both', () => {
      const code = 'PGPASSWORD=abc12 a\nMYSQL_PWD=xyz34 b\nconst s = "abc12xyz34"\n'
      const out = anonymize(code).anonymized
      const covered = line(out)!
      expect(covered).toMatch(/^__REDACTED_CREDENTIAL_\d+__$/)
      expect(covered).not.toBe(tokenAt(out, 'PGPASSWORD'))
    })
    it('separate: each keeps its own token', () => {
      const code = 'PGPASSWORD=abc12 a\nMYSQL_PWD=xyz34 b\nconst s = "abc12, xyz34"\n'
      const out = anonymize(code).anonymized
      expect(line(out)).toBe(`${tokenAt(out, 'PGPASSWORD')}, ${tokenAt(out, 'MYSQL_PWD')}`)
    })
    it('the generic token is new: it repeats no token already in the text', () => {
      const code =
        'x = "__REDACTED_CREDENTIAL_7__"\nPGPASSWORD=abcXYZ1 a\nMYSQL_PWD=XYZ1def2 b\nconst s = "abcXYZ1def2"\n'
      const out = anonymize(code).anonymized
      expect(line(out)).toBe('__REDACTED_CREDENTIAL_8__')
    })
  })
  it('a default word anywhere else beside it is redacted', () => {
    const out = anonymize('POSTGRES_PASSWORD: postgres\ncommand: echo postgres\n').anonymized
    expect(out).not.toMatch(/\bpostgres\b/)
  })
  it('a fixture left in a test file is not spread', () => {
    const code = 'const postgres = 1\nconst url = "mysql://app:postgres@db/app"\n'
    const out = anonymize(code, { path: 'tests/db.test.ts' }).anonymized
    expect(out).toContain(':postgres@')
    expect(out).toMatch(/^const postgres = 1\n/)
  })
})

describe('spreading stays linear', () => {
  it('many overlapping occurrences of one credential', () => {
    const code = `PGPASSWORD=abab psql\nconst s = "${'ab'.repeat(100_000)}"\n`
    const t = performance.now()
    const out = anonymize(code).anonymized
    expect(performance.now() - t).toBeLessThan(5000)
    expect(out).not.toMatch(/abab/)
  })
})

// Cost fixes before the review of #172.
describe('common weak passwords are default words', () => {
  for (const word of [
    'pass',
    'pwd',
    'qwerty',
    'letmein',
    'welcome',
    'abc123',
    '123456',
    'passw0rd',
    'password1',
  ]) {
    it(`"${word}" is redacted where it stands and as a whole word elsewhere, never inside a longer name`, () => {
      const code = `PGPASSWORD=${word} psql\nconst x${word}y = 1\nconst ${/^\d/.test(word) ? 'n' : ''}${word} = 2\n`
      const result = anonymize(code)
      expect(result.anonymized, word).toMatch(/^PGPASSWORD=__REDACTED_[A-Z_]+_\d+__ /)
      // The longer name is masked and mapped whole, not cut by the spread.
      expect(Object.values(result.map), word).toContain(`x${word}y`)
    })
  }
  it('pass inside passport and compass is left alone; --password pass is redacted', () => {
    const code = 'PGPASSWORD=pass psql\nconst passport = compass\n$ deploy --password pass\n'
    const scanned = scanSecrets(code).code
    expect(scanned).toMatch(/^PGPASSWORD=__REDACTED_[A-Z_]+_\d+__ psql\n/)
    expect(scanned).toMatch(/--password __REDACTED_[A-Z_]+_\d+__\n$/)
    const result = anonymize(code)
    expect(Object.values(result.map)).toEqual(expect.arrayContaining(['passport', 'compass']))
  })
  it('P@ssw0rd keeps its word boundaries', () => {
    const code = 'PGPASSWORD=P@ssw0rd psql\nconst note = "xP@ssw0rdx"\n'
    const note = /= "([^"]*)"\n$/.exec(anonymize(code).anonymized)?.[1]
    expect(note).toBeDefined()
    expect(note).not.toMatch(/__REDACTED_/)
  })
})

describe('a URL host is a non-secret position for a default word', () => {
  it('postgres://app:postgres@postgres:5432/db keeps the scheme and the host', () => {
    const out = anonymize('DATABASE_URL=postgres://app:postgres@postgres:5432/db\n').anonymized
    expect(out).toMatch(/postgres:\/\/app:__REDACTED_[A-Z_]+_\d+__@postgres:5432\/db/)
  })
  it('a non-default password as the host is still redacted', () => {
    const out = anonymize('DATABASE_URL=postgres://app:Kx9prodpw@Kx9prodpw:5432/db\n').anonymized
    expect(out).not.toContain('Kx9prodpw')
  })
})

// Security review of #172: a weak password gets no position exemption, and a
// URL host is read the way a URL parser reads it.
describe('weak passwords are never exempt by position', () => {
  for (const [label, code] of [
    ['a key on its own line', 'PGPASSWORD=qwerty psql\nservices:\n  qwerty:\n'],
    ['a list item', 'PGPASSWORD=qwerty psql\ndepends_on:\n  - qwerty\n'],
    ['an image', 'PGPASSWORD=qwerty psql\nimage: qwerty\n'],
    ['a URL host', 'PGPASSWORD=qwerty psql\nURL=https://u@qwerty:5432/x\n'],
  ] as const) {
    it(`qwerty as ${label} is redacted`, () => {
      expect(anonymize(code).anonymized).not.toMatch(/\bqwerty\b/)
    })
  }
})

describe('the URL host is the part after the last @ of the authority', () => {
  it('a default word between two @ is not taken for the host', () => {
    const out = anonymize('PGPASSWORD=postgres psql\nURL=https://u:postgres@x@db:5432/a\n').anonymized
    expect(out).not.toMatch(/u:postgres@/)
  })
  it('a default word inside the userinfo before the last @ is not the host', () => {
    const out = anonymize('PGPASSWORD=postgres psql\nURL=https://u@postgres:pw@db/x\n').anonymized
    expect(out).not.toMatch(/u@postgres:/)
  })
  it('a default word after the last @ is the host and stays', () => {
    const out = anonymize('PGPASSWORD=postgres psql\nURL=https://u:pw@postgres:5432/a\n').anonymized
    expect(out).toContain('@postgres:5432/a')
  })
})
