import { describe, it, expect } from 'vitest'
import { anonymize, restore, valuePositions } from '../src/index.js'
import type { AnonymizeOptions } from '../src/index.js'

// Security review, round 4 (B): a credential keyword net, fail closed, on
// every line of every file that is not code. A name holding a credential word
// (by segment: dbPw, userPW, DBPW, --db-password), any separator, then the
// value up to its delimiter: redacted one-way under `redact`, never readable
// in any mode.

const CASES: [string, AnonymizeOptions][] = [
  ['password sunshine\n', { path: 'app.properties' }],
  ['db.password = \\\n    sunshine\n', { path: 'app.properties' }],
  ["password = '''sunshine'''\n", { path: 'app.toml' }],
  ['<password><![CDATA[sunshine]]></password>\n', { path: 'app.xml' }],
  ['PASSWORD := sunshine\n', { path: 'Makefile' }],
  ['machine h login u password sunshine\n', { path: '.netrc' }],
  ['//registry.npmjs.org/:_authToken=sunshine\n', { path: '.npmrc' }],
  ['app --db-password=sunshine\n', { path: 'run.sh' }],
  ['args: ["--db-password=sunshine"]\n', { path: 'k8s.yml' }],
  ['dbPw: sunshine\n', {}],
  ['userPW = sunshine\n', {}],
  ['DBPW=sunshine\n', {}],
  ['DB_PIN: sunshine\n', {}],
  ['WALLET_MNEMONIC="sunshine"\n', {}],
  ['localhost:5432:app:admin:sunshine\n', { path: '.pgpass' }],
  ['*:*:*:postgres:sunshine\n', { path: 'home/.pgpass' }],
]

describe('the credential net', () => {
  it.each(CASES)('%j %j: redacted one-way, never in the map', (code, opts) => {
    const r = anonymize(code, opts)
    expect(r.anonymized).not.toContain('sunshine')
    expect(r.anonymized).toContain('__REDACTED_CREDENTIAL_')
    expect(JSON.stringify(r.map)).not.toContain('sunshine')
  })

  // Founder ruling (round 4): a value the credential words find is redacted
  // one-way in every mode - it never enters the map (decision 2026-10-26).
  it.each(['warn', 'off'] as const)('under %s too: redacted, never in the map', (secrets) => {
    for (const [code, opts] of CASES) {
      const r = anonymize(code, { ...opts, secrets })
      expect(r.anonymized, code).not.toContain('sunshine')
      expect(JSON.stringify(r.map), code).not.toContain('sunshine')
    }
  })

  it('Makefile `:=` keeps its line: only the value is replaced', () => {
    expect(anonymize('PASSWORD := sunshine\n', { path: 'Makefile' }).anonymized).toBe(
      'PASSWORD := __REDACTED_CREDENTIAL_1__\n'
    )
  })

  it('TOML triple quotes are kept whole', () => {
    expect(anonymize("password = '''sunshine'''\n", { path: 'app.toml' }).anonymized).toBe(
      "password = '''__REDACTED_CREDENTIAL_1__'''\n"
    )
  })

  it('a .pgpass line keeps host, port, database and user readable', () => {
    const r = anonymize('localhost:5432:app:admin:sunshine\n', { path: '.pgpass' })
    expect(r.anonymized).toMatch(/:__REDACTED_CREDENTIAL_1__\n$/)
    expect(restore(r.anonymized, r.map).restored).toMatch(/^localhost:5432:app:admin:/)
  })
})

describe('provable non-values are left', () => {
  it.each([
    ['password: null\n', 'null'],
    ['password: true\n', 'true'],
    ['password = None\n', 'None'],
    ['pin: 42\n', '42'],
    ['the key is in the vault\n', 'is'],
  ])('%j keeps %s', (code, kept) => {
    expect(anonymize(code).anonymized).toContain(kept)
  })

  it.each(['PASSWORD=$DB_PASSWORD\n', 'PASSWORD=${DB_PASSWORD}\n'])(
    '%j: a reference is not redacted',
    (code) => {
      const r = anonymize(code)
      expect(r.anonymized).not.toContain('__REDACTED_')
      expect(restore(r.anonymized, r.map).restored).toBe(code)
    }
  )

  // Review of round 4: a call or member access is exempt only in code, and
  // only as the whole value - in configuration `Xk9m.Q2v` is a password.
  it.each([
    ['DB_PASSWORD=Xk9m.Q2v\n', '.env', 'Xk9m'],
    ['password=a.b\n', '.env', 'a.b'],
    ['token: settings.token\n', 'app.yml', 'settings'],
    ['DB_PASSWORD=getPassword()\n', '.env', 'getPassword'],
  ])('%j in %s: fails closed', (code, path, word) => {
    const r = anonymize(code, { path })
    expect(r.anonymized).toContain('__REDACTED_CREDENTIAL_')
    expect(r.anonymized).not.toContain(word)
  })

  it('code is read by its strings, not by the net', () => {
    for (const code of [
      'const [token, setToken] = useState("")\n',
      'setToken(newToken)\n',
      'const apiKey = key\n',
    ]) {
      const r = anonymize(code, { path: 'a.ts' })
      expect(r.anonymized, code).not.toContain('__REDACTED_')
    }
  })
})

describe('prose over-masking is accepted', () => {
  // A name holding a credential word followed by a space reads as a key and
  // its value: "password reset" masks "reset". The cost of failing closed.
  it('"password reset" masks "reset"', () => {
    const r = anonymize('Click the password reset link.\n', { path: 'README.md' })
    expect(r.anonymized).not.toContain('reset')
  })
})

describe('the net is linear on adversarial lines', () => {
  const time = (text: string): number => {
    let best = Infinity
    for (let i = 0; i < 5; i++) {
      const t = performance.now()
      valuePositions(text)
      best = Math.min(best, performance.now() - t)
    }
    return best
  }
  const lines = (n: number): string[] =>
    [
      `${'password '.repeat(n / 9)}\n`,
      `password${' '.repeat(n)}x\n`,
      `password${' := '.repeat(n / 4)}x\n`,
      `password<![CDATA[${'a'.repeat(n)}]\n`,
      `password '''${"'".repeat(n)}\n`,
      `${'dbPw'.repeat(n / 4)}=x\n`,
      `${'a:'.repeat(n / 2)}\n`,
      `password \\\n${' \\\n'.repeat(n / 3)}x\n`,
      `{"a": "${'password=x,'.repeat(n / 11)}"}\n`,
      `{${'password=x '.repeat(n / 11)}}\n`,
      `password=${'a'.repeat(n)}\n`,
      `${'a:1:b:c:'.repeat(n / 8)}\n`,
      `${'x.ts:1: password=a '.repeat(n / 20)}\n`,
      `${'password=<'.repeat(n / 10)}\n`,
      `${'password=$('.repeat(n / 11)}\n`,
    ].map((line) => line.repeat(4))
  it('4000, 8000 and 16000 characters grow linearly', () => {
    const [a, b, c] = [4000, 8000, 16000].map((n) => lines(n).map(time))
    for (let i = 0; i < a!.length; i++) {
      // Linear is 2x and 4x; quadratic 4x and 16x.
      const base = Math.max(a![i]!, 2)
      expect(b![i]! / base, `line ${i} at 8000`).toBeLessThan(8)
      expect(c![i]! / base, `line ${i} at 16000`).toBeLessThan(11)
    }
  }, 60_000)
})

// Founder ruling (round 4), each mode by each source: a value the credential
// words find is redacted in every mode; one a scanner rule finds keeps main's
// behaviour - redacted under `redact`, left as written under `warn` and `off`
// by the user's choice. Neither is ever in the map.
describe('mode by source', () => {
  const NET = { code: 'password sunshine\n', path: 'app.properties', value: 'sunshine' }
  const RULE = {
    code: 'const password = "Xk9mQ2vL8pR4wZ7t"\n',
    path: 'a.ts',
    value: 'Xk9mQ2vL8pR4wZ7t',
  }
  it.each([
    ['redact', NET, false],
    ['warn', NET, false],
    ['off', NET, false],
    ['redact', RULE, false],
    ['warn', RULE, true],
    ['off', RULE, true],
  ] as const)('%s, %j: readable %s, never in the map', (secrets, c, readable) => {
    const r = anonymize(c.code, { path: c.path, secrets })
    expect(r.anonymized.includes(c.value)).toBe(readable)
    expect(JSON.stringify(r.map)).not.toContain(c.value)
  })
})

// Review of round 4: a path of no kind is code only if its text reads as
// code; a `.ts` holding configuration text keeps every grammar.
it('a .ts file holding configuration text is read by every grammar', () => {
  const r = anonymize('DB_PASSWORD=Summer2024!\n', { path: 'config.ts' })
  expect(r.anonymized).not.toContain('Summer2024')
  expect(r.anonymized).toContain('__REDACTED_CREDENTIAL_')
})

it("a search result's path and line number are not a key and its value", () => {
  const text = 'src/secrets.ts:3:export function verify(value: string) {}\n'
  expect(anonymize(text).anonymized).not.toContain('__REDACTED_')
})

// Ruling, round 4: a CI expression is no exemption - it is redacted.
it('a quoted CI expression under a credential key is redacted', () => {
  const r = anonymize('PGPASSWORD="${{ secrets.PG }}" psql\n', { path: 'run.sh' })
  expect(r.anonymized).toContain('__REDACTED_CREDENTIAL_')
  expect(r.anonymized).not.toMatch(/\bsecrets\b/)
})

// Review of round 4: no skip on the value's shape alone, and an unquoted
// value runs to the next whitespace.
describe('the net does not fail open on a value shape', () => {
  it.each([
    ['password=12:sunshine\n', '12:sunshine'],
    ['password=--sunshine\n', 'sunshine'],
    ['password=sun,shine\n', 'shine'],
    ['password=sun;shine\n', 'shine'],
  ])('%j hides %s', (text, word) => {
    for (const opts of [{}, { path: 'notes.txt' }, { path: '.env' }]) {
      const r = anonymize(text, opts)
      expect(r.anonymized, JSON.stringify(opts)).not.toContain(word)
      expect(JSON.stringify(r.map)).not.toContain('shine')
    }
  })

  // Ruling, round 4: an option word after the name is no exemption either.
  it('an option word after the name is redacted as its value', () => {
    expect(anonymize('mysql --password --verbose\n', { path: 'run.sh' }).anonymized).not.toContain(
      '--verbose'
    )
  })
})

// Ruling, round 4: the net fails closed. Its only exemptions are a $NAME
// reference, a code-only call or member access, a language keyword, one or two
// characters and a type annotation (and text already masked). Each shape
// below was once exempt and is now redacted.
describe('removed exemptions: now redacted', () => {
  it.each([
    ['src/secrets.ts:3:sunshine\n', 'sunshine'],
    ['db.password:12:sunshine\n', 'sunshine'],
    ['password=/run/secrets/sunshine\n', 'sunshine'],
    ['TOKEN_URL=https://auth.example.com/sunshine\n', 'sunshine'],
    ['password=$(cat sunshine)\n', 'cat'],
    ['password: ${{ secrets.sunshine }}\n', '${{'],
    ['password=`cat sunshine`\n', 'cat'],
    ['password --sunshine\n', 'sunshine'],
    ['password: !sunshine\n', 'sunshine'],
    ['password=1234\n', '1234'],
  ])('%j', (text, word) => {
    const r = anonymize(text, { path: 'notes.txt' })
    expect(r.anonymized).toContain('__REDACTED_CREDENTIAL_')
    expect(r.anonymized).not.toContain(word)
  })

  it.each([
    ['x "a" password=sun"shine\n', 'shine'],
    ['f(a) password=sun)shine\n', 'shine'],
    ['{a} password=sun}shine\n', 'shine'],
  ])('a stop character not opened before the key does not end the value: %j', (text, word) => {
    expect(anonymize(text, { path: 'notes.txt' }).anonymized).not.toContain(word)
  })

  it('a quote opened before the key ends the value: the reference is not redacted', () => {
    const r = anonymize('run("PGPASSWORD=$PGPASS")\n', { path: 'notes.txt' })
    expect(r.anonymized).not.toContain('__REDACTED_')
    expect(r.anonymized).toMatch(/"\)\n$/)
  })

  it("a brace opened before the key ends the value at its pair's comma", () => {
    expect(anonymize('x = { password: sun, y: 1 }\n', { path: 'notes.txt' }).anonymized).toContain(
      'y: 1'
    )
  })
})

it('a command or placeholder under a credential word is redacted to its close', () => {
  for (const [text, word] of [
    ['password=$(cat sunshine)\n', 'sunshine'],
    ['DB_PASSWORD=<your password>\n', 'your'],
    ['PASSWORD="$(openssl rand | tr -d "=+/" | cut -c1-25)"\n', 'cut'],
    ['password: ${{ secrets.PG }}\n', 'secrets'],
  ])
    expect(anonymize(text, { path: 'notes.txt' }).anonymized, text).not.toContain(word)
})
