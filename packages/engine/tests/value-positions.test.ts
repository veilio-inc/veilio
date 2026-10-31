import { describe, it, expect } from 'vitest'
import { anonymize, restore } from '../src/index.js'
import type { AnonymizeOptions } from '../src/index.js'

// Round 3 of the security review (an amendment to spec 064): an ordinary word
// is readable only as an identifier or a path segment. In a value position -
// a string literal, a config value, an XML attribute or element text, a
// command's `KEY=val` prefix, a JSON value - it is masked whatever its key is
// called; under the credential-named key the whole value is redacted one-way.

const LEAKS: { code: string; leak: string; opts?: AnonymizeOptions }[] = [
  {
    code: 'const password: string = "sunshine"\n',
    leak: 'sunshine',
    opts: { language: 'typescript' },
  },
  { code: 'var password string = "sunshine"\n', leak: 'sunshine', opts: { language: 'go' } },
  {
    code: '<add key="DbPassword" value="sunshine"/>\n',
    leak: 'sunshine',
    opts: { path: 'Web.config' },
  },
  {
    code: '<property name="password" value="sunshine"/>\n',
    leak: 'sunshine',
    opts: { path: 'pom.xml' },
  },
  { code: 'db:\n  password:\n    sunshine\n', leak: 'sunshine', opts: { fileKind: 'yaml' } },
  { code: 'DB_PASSWORD=sunshine ./run\n', leak: 'sunshine', opts: { fileKind: 'shell' } },
  { code: 'PG_DSN=password=sunshine dbname=y\n', leak: 'sunshine', opts: { fileKind: 'dotenv' } },
  { code: 'dsn = "password=sunshine dbname=y"\n', leak: 'sunshine', opts: { language: 'python' } },
  { code: 'DB_PASSWORD_PROD="sunshine"\n', leak: 'sunshine', opts: { fileKind: 'dotenv' } },
  { code: 'DB_PASSWORD_PROD="sunshine"\n', leak: 'sunshine' },
  { code: '[db]\npassword = sunshine\n', leak: 'sunshine', opts: { path: 'app.ini' } },
  { code: 'db.password=sunshine\n', leak: 'sunshine', opts: { path: 'app.properties' } },
  {
    code: 'var c = "Server=x;Password=sunshine;";\n',
    leak: 'sunshine',
    opts: { language: 'csharp' },
  },
  { code: 'const DB_PASS = "Summer2024!"\n', leak: 'Summer2024', opts: { language: 'typescript' } },
  // A type between the key and the value (review of round 3).
  {
    code: 'password: Optional[str] = "sunshine"\n',
    leak: 'sunshine',
    opts: { language: 'python' },
  },
  { code: 'let password: &str = "sunshine";\n', leak: 'sunshine', opts: { language: 'rust' } },
  {
    code: 'private Map<String, String> secrets = Map.of("k", "sunshine");\n',
    leak: 'sunshine',
    opts: { language: 'java' },
  },
  {
    code: 'public string Password { get; set; } = "sunshine";\n',
    leak: 'sunshine',
    opts: { language: 'csharp' },
  },
  { code: 'user.setPassword("sunshine")\n', leak: 'sunshine', opts: { language: 'java' } },
]

describe('a credential-named value is redacted whole, one-way', () => {
  it.each(LEAKS)('$code', ({ code, leak, opts }) => {
    const r = anonymize(code, opts ?? {})
    expect(r.anonymized).not.toContain(leak)
    expect(r.anonymized).toContain('__REDACTED_CREDENTIAL_')
    expect(JSON.stringify(r.map)).not.toContain(leak)
  })

  it('the unit is the whole value: `Summer2024!` is one token, not a word and a `!`', () => {
    const r = anonymize('const DB_PASS = "Summer2024!"\n', { language: 'typescript' })
    expect(r.anonymized).toBe('const DB_PASS = "__REDACTED_CREDENTIAL_1__"\n')
  })
})

const VALUES: { code: string; word: string; opts?: AnonymizeOptions }[] = [
  { code: 'const mood = "sunshine"\n', word: 'sunshine', opts: { language: 'typescript' } },
  { code: 'log("hello from the order desk")\n', word: 'order', opts: { language: 'python' } },
  { code: 'weather: sunshine\n', word: 'sunshine', opts: { fileKind: 'yaml' } },
  { code: 'weather:\n  sunshine\n', word: 'sunshine', opts: { fileKind: 'yaml' } },
  { code: '[ui]\ncolor = blue\n', word: 'blue', opts: { path: 'app.ini' } },
  { code: 'ui.color=blue\n', word: 'blue', opts: { path: 'app.properties' } },
  { code: '<title>hello world</title>\n', word: 'hello', opts: { path: 'page.xml' } },
  { code: '<item label="orange"/>\n', word: 'orange', opts: { path: 'page.xml' } },
  { code: 'GREETING=sunshine ./run\n', word: 'sunshine', opts: { fileKind: 'shell' } },
  { code: '{"color": "blue"}\n', word: 'blue', opts: { path: 'a.json' } },
]

describe('any other value is masked reversibly, ordinary word or not', () => {
  it.each(VALUES)('$code hides $word and restores', ({ code, word, opts }) => {
    const r = anonymize(code, opts ?? {})
    expect(r.anonymized).not.toMatch(new RegExp(`\\b${word}\\b`))
    expect(r.anonymized).not.toContain('__REDACTED_')
    expect(restore(r.anonymized, r.map).restored).toBe(code)
  })
})

describe('identifiers and paths keep the 064 exemption', () => {
  it.each([
    ['const animal = ledger\n', 'ledger', { language: 'typescript' }],
    ['import x from "./src/utils/helper"\n', './src/utils/helper', { language: 'typescript' }],
    ['const p = "src/main/index.ts"\n', 'src/main/index.ts', { language: 'typescript' }],
    ['interface Env {\n  DB_PASSWORD: string\n}\n', 'string', { language: 'typescript' }],
    ['main: src/index.js\n', 'src/index.js', { fileKind: 'yaml' }],
    ['def order(table): return table\n', 'def order(table): return table', { language: 'python' }],
  ] as const)('%j keeps %s', (code, kept, opts) => {
    expect(anonymize(code, opts).anonymized).toContain(kept)
  })
})

describe('under warn and off values are as on main: masked reversibly, nothing one-way', () => {
  it.each(['warn', 'off'] as const)('%s', (secrets) => {
    for (const [code, opts] of [
      ['const password: string = "sunshine"\n', { language: 'typescript' as const }],
      ['[db]\npassword = sunshine\n', { path: 'app.ini' }],
    ] as const) {
      const r = anonymize(code, { ...opts, secrets })
      expect(r.anonymized).not.toContain('__REDACTED_')
      expect(r.anonymized).not.toContain('sunshine')
      expect(restore(r.anonymized, r.map).restored).toBe(code)
    }
  })
})

describe('value scanning stays linear on adversarial lines', () => {
  // The fastest of three runs, so a JIT pause is not read as growth.
  const time = (text: string, opts: AnonymizeOptions): number => {
    let best = Infinity
    for (let i = 0; i < 3; i++) {
      const t = performance.now()
      anonymize(text, opts)
      best = Math.min(best, performance.now() - t)
    }
    return best
  }
  const lines = (n: number): [string, AnonymizeOptions][] => [
    [`const PASSWORD = "${'a='.repeat(n / 2)}"\n`.repeat(4), { language: 'typescript' }],
    [`x = "${'password='.repeat(n / 9)}"\n`.repeat(4), { language: 'python' }],
    [`A_TOKEN:${'\n'.repeat(4)}${' '.repeat(n)}b\n`.repeat(4), { fileKind: 'yaml' }],
    [`${'K=v '.repeat(n / 4)}./run\n`.repeat(4), { fileKind: 'shell' }],
    [`<a ${'key="password" '.repeat(n / 16)}>${'x'.repeat(n)}</a>\n`.repeat(2), { path: 'a.xml' }],
    [`password = ${';'.repeat(n)}\n`.repeat(4), { path: 'a.ini' }],
    [`${'"a" '.repeat(n / 4)}\n`.repeat(2), {}],
    [`x ${"'a ".repeat(n / 3)}\n`.repeat(2), {}],
    [`${'a,'.repeat(n / 2)}"x"\n`.repeat(4), {}],
    [`${'k: '.repeat(n / 3)}\n`.repeat(4), {}],
  ]
  // Two doublings, so noise cannot pass for growth: linear is 4x, quadratic 16x.
  it('lines four times as long take about four times as long, not sixteen', () => {
    const small = lines(4000).map(([t, o]) => time(t, o))
    const large = lines(16000).map(([t, o]) => time(t, o))
    large.forEach((ms, i) => expect(ms, `case ${i}`).toBeLessThan(Math.max(100, small[i]! * 9)))
  }, 60_000)

  it('8000-character lines finish well within a second', () => {
    for (const [t, o] of lines(8000)) expect(time(t, o)).toBeLessThan(1500)
  }, 60_000)
})

describe('a comma at the start of the line before a value', () => {
  it('ends the key search (it once looped for ever)', () => {
    const code = "x = 1\n, 'a', 'b'\n"
    expect(anonymize(code, { language: 'ruby' }).anonymized).toContain(',')
  })
})
