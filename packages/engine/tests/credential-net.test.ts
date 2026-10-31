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
  const lines = (n: number): string[] => [
    `${'password '.repeat(n / 9)}\n`.repeat(4),
    `password${' '.repeat(n)}x\n`.repeat(4),
    `password${' := '.repeat(n / 4)}x\n`.repeat(4),
    `password<![CDATA[${'a'.repeat(n)}]\n`.repeat(4),
    `password '''${"'".repeat(n)}\n`.repeat(4),
    `${'dbPw'.repeat(n / 4)}=x\n`.repeat(4),
    `${'a:'.repeat(n / 2)}\n`.repeat(4),
    `password \\\n${' \\\n'.repeat(n / 3)}x\n`,
  ]
  it('4000, 8000 and 16000 characters grow linearly', () => {
    const [a, b, c] = [4000, 8000, 16000].map((n) => lines(n).map(time))
    for (let i = 0; i < a!.length; i++) {
      const base = Math.max(a![i]!, 2)
      expect(b![i]! / base, `line ${i} at 8000`).toBeLessThan(6)
      expect(c![i]! / base, `line ${i} at 16000`).toBeLessThan(10)
    }
  })
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

it('a quoted CI expression is not a value, and its words stay masked', () => {
  const r = anonymize('PGPASSWORD="${{ secrets.PG }}" psql\n', { path: 'run.sh' })
  expect(r.anonymized).not.toContain('__REDACTED_')
  expect(r.anonymized).not.toMatch(/\bsecrets\b/)
})
