import { describe, it, expect } from 'vitest'
import { anonymize, credentialsAmong, detectSecrets, restore, valueSpans } from '../src/index.js'
import type { FileKind, Language } from '../src/index.js'

// The credential values in text of no known kind, as the guard reads output.
const credentialValueSpans = (text: string) => credentialsAmong(valueSpans(text))

// Security audit (spec 064 regression): a dictionary-word password is a
// single ordinary word, and 064 leaves those as written. As the value of a
// credential-named key it is a password, not vocabulary: it never reaches the
// model as written. One the scanner does not flag at all is masked like any
// name (as before 064); one it flags as a possible credential is redacted,
// because a credential never enters the map.

const CASES: { code: string; word: string; fileKind?: FileKind; language?: 'python' }[] = [
  { code: 'password: sunshine\n', word: 'sunshine', fileKind: 'yaml' },
  { code: 'password: sunshine\n', word: 'sunshine' },
  { code: 'db:\n  password: dragon\n', word: 'dragon', fileKind: 'yaml' },
  { code: 'const c = { password: "dragon" }\n', word: 'dragon' },
  { code: 'const auth = { passwd: "dragon" }\n', word: 'dragon' },
  {
    code: 'DATABASES = {"default": {"PASSWORD": "monkey"}}\n',
    word: 'monkey',
    language: 'python',
  },
  { code: 'SECRET_KEY = "phoenix"\n', word: 'phoenix', language: 'python' },
  { code: 'SECRET_KEY = "phoenix"\n', word: 'phoenix' },
  { code: 'DB_PASSWORD=sunshine\n', word: 'sunshine' },
  { code: 'DB_PASSWORD=sunshine\n', word: 'sunshine', fileKind: 'dotenv' },
  { code: 'DB_PASSWORD="sunshine"\n', word: 'sunshine', fileKind: 'dotenv' },
  { code: 'DB_PASSWORD: sunshine\n', word: 'sunshine', fileKind: 'yaml' },
  { code: 'export DB_PASSWORD=sunshine\n', word: 'sunshine', fileKind: 'shell' },
  { code: 'api_key: "falcon"\n', word: 'falcon' },
  { code: 'apiKey = "falcon";\n', word: 'falcon' },
  { code: 'spring.datasource.password=sunshine\n', word: 'sunshine' },
]

describe('a dictionary word as the value of a credential-named key', () => {
  it.each(CASES)('$code ($fileKind$language) does not reach the model', (c) => {
    const opts = {
      ...(c.fileKind ? { fileKind: c.fileKind } : {}),
      ...(c.language ? { language: c.language } : {}),
    }
    const r = anonymize(c.code, opts)
    expect(r.anonymized).not.toMatch(new RegExp(`\\b${c.word}\\b`))
    // A value the scanner flags is a credential, and never enters the map.
    if (detectSecrets(c.code, c.fileKind ? { fileKind: c.fileKind } : {}).length > 0)
      expect(Object.values(r.map)).not.toContain(c.word)
  })

  it('under warn the user asked for credentials to be left: a flagged one stays, an unflagged one is masked', () => {
    const flagged = anonymize('DB_PASSWORD=sunshine\n', { fileKind: 'dotenv', secrets: 'warn' })
    expect(flagged.anonymized).toBe('DB_PASSWORD=sunshine\n')
    const plain = anonymize('password: sunshine\n', { fileKind: 'yaml', secrets: 'warn' })
    expect(plain.anonymized).not.toContain('sunshine')
  })
})

describe('controls: 064 still leaves ordinary words readable elsewhere', () => {
  // Round 3: a string's contents are a value - `const mood = "sunshine"` and
  // `password_hint = "..."` no longer keep their words (value-positions.test.ts).
  it.each([
    ['weather: sunshine\n', 'sunshine'],
    ['const monkey = ledger\n', 'ledger'],
    ['interface Env {\n  DB_PASSWORD: string\n}\n', 'string'],
    ['REQUIRE_PASSWORD=true\n', 'true'],
    ['enum Kind {\n  PASSWORD = "PASSWORD",\n}\n', 'PASSWORD = '],
  ])('%j keeps %s', (code, word) => {
    expect(anonymize(code).anonymized).toContain(word)
  })

  // Round 3: in another value it would be minted into the map, so it is the
  // credential's token there too; as a name it stays readable.
  it('an ordinary word used both as a password and elsewhere is redacted in values only', () => {
    const r = anonymize('password: sunshine\ngreeting: sunshine\n', { fileKind: 'yaml' })
    expect(r.anonymized).toBe(
      'password: __REDACTED_CREDENTIAL_1__\ngreeting: __REDACTED_CREDENTIAL_1__\n'
    )
    expect(Object.values(r.map)).not.toContain('sunshine')
    const code = anonymize('const password = "sunshine"\nlet sunshine = 1\n', {
      language: 'typescript',
    })
    expect(code.anonymized).toBe('const password = "__REDACTED_CREDENTIAL_1__"\nlet sunshine = 1\n')
  })
})

// Security review of round 1: syntaxes the first credential-value rule missed.
// A credential-named key, then a separator or a call-argument boundary, then
// the value; in XML and a k8s env entry, the nearest key in the same element.
const MORE: { code: string; word: string; fileKind?: FileKind; language?: Language }[] = [
  { code: 'app.config["SECRET_KEY"] = "phoenix"\n', word: 'phoenix', language: 'python' },
  { code: 'os.environ["PGPASSWORD"] = "sunshine"\n', word: 'sunshine', language: 'python' },
  { code: "config[:password] = 'sunshine'\n", word: 'sunshine', language: 'ruby' },
  { code: "<?php\n$password = 'sunshine';\n", word: 'sunshine', language: 'php' },
  { code: 'PASSWORD=SUNSHINE\n', word: 'SUNSHINE' },
  { code: 'PASSWORD=SUNSHINE\n', word: 'SUNSHINE', fileKind: 'dotenv' },
  { code: 'password: `sunshine`\n', word: 'sunshine' },
  { code: 'const password = `sunshine`;\n', word: 'sunshine', language: 'typescript' },
  { code: '<password>sunshine</password>\n', word: 'sunshine' },
  { code: '<entry key="password">sunshine</entry>\n', word: 'sunshine', language: 'java' },
  {
    code: 'env:\n  - name: DB_PASSWORD\n    value: sunshine\n',
    word: 'sunshine',
    fileKind: 'yaml',
  },
  { code: 'ENV PASSWORD sunshine\n', word: 'sunshine', fileKind: 'shell' },
  { code: "<?php\ndefine('DB_PASSWORD','sunshine');\n", word: 'sunshine', language: 'php' },
  { code: 'os.Setenv("DB_PASSWORD","sunshine")\n', word: 'sunshine', language: 'go' },
  { code: 'pw = "sunshine"\n', word: 'sunshine', language: 'python' },
  { code: 'passwords: sunshine\n', word: 'sunshine', fileKind: 'yaml' },
  // A quoted `$` value is a value, not a reference (security review).
  { code: 'password: "$unshine"\n', word: 'unshine' },
  { code: "PASSWORD='$ecret123'\n", word: 'ecret123' },
]

describe('more credential syntaxes (security review of round 1)', () => {
  it.each(MORE)('$code does not reach the model', (c) => {
    const r = anonymize(c.code, {
      ...(c.fileKind ? { fileKind: c.fileKind } : {}),
      ...(c.language ? { language: c.language } : {}),
    })
    expect(r.anonymized).not.toMatch(new RegExp(`\\b${c.word}\\b`))
  })

  it.each([
    ['ENV AUTHOR sunshine\n', 'sunshine'],
    ['env:\n  - name: AUTHOR\n    value: sunshine\n', 'sunshine'],
    ['const monkey = "monkey"\nconst animal = monkey\n', 'monkey'],
    ['PRIMARY_KEY=id\n', 'id'],
  ])('the control %j keeps %s', (code, word) => {
    expect(anonymize(code).anonymized).toMatch(new RegExp(`\\b${word}\\b`))
  })

  // Round 3: a key CONTAINS a credential word (`password_hint`, `author`), and
  // a string or an element's text is a value: these controls no longer hold.
  it.each([
    ['const password_hint = "sunshine"\n', 'sunshine'],
    ['author: sunshine\n', 'sunshine'],
    ['<author>sunshine</author>\n', 'sunshine'],
    ['<entry key="password_hint">sunshine</entry>\n', 'sunshine'],
    ["define('AUTHOR','sunshine');\n", 'sunshine'],
  ])('the former control %j hides %s', (code, word) => {
    expect(anonymize(code).anonymized).not.toMatch(new RegExp(`\\b${word}\\b`))
  })
})

describe('a `$` value (security review)', () => {
  it('quoted, or not variable-shaped, it is a value', () => {
    for (const [text, value] of [
      ['password: "$unshine"', '$unshine'],
      ["PASSWORD='$ecret123'", '$ecret123'],
      ['password: `$unshine`', '$unshine'],
    ])
      expect(credentialValueSpans(text).map((s) => s.value)).toEqual([value])
  })
  it('unquoted and variable-shaped, it is a reference', () => {
    for (const text of ['export DB_PASSWORD=$DB_PASSWORD', 'password: $secret_value'])
      expect(credentialValueSpans(text)).toEqual([])
  })
})

describe('exemptions fail closed (security review of round 2)', () => {
  it.each([
    'key: sunshine',
    'KEY=sunshine',
    'AZURE_STORAGE_KEY=sunshine',
    'ALGOLIA_SEARCH_KEY=sunshine',
    'HASH_KEY=sunshine',
    'S3_OBJECT_KEY=sunshine',
    'DB_PRIMARY_KEY=sunshine',
    'password: password',
  ])('%j is a credential value', (text) => {
    const value = /[=:] ?(\w+)$/.exec(text)![1]
    expect(credentialValueSpans(text).map((s) => s.value)).toEqual([value])
  })

  // Round 3: the key is matched by CONTAINS - `password_hint`, a `key`
  // attribute and `SORT_KEY` name credentials now. A value of two characters
  // is no secret (`PRIMARY_KEY=id`).
  it.each([
    ['<entry key="password_hint">sunshine</entry>', 'sunshine'],
    ['<Item key="sunshine" />', 'sunshine'],
    ['<li key="sunshine">x</li>', 'sunshine'],
    ['SORT_KEY=createdAt', 'createdAt'],
  ])('%j is one now', (text, value) => {
    expect(credentialValueSpans(text).map((s) => s.value)).toContain(value)
  })

  it('PRIMARY_KEY=id is not', () => {
    expect(credentialValueSpans('PRIMARY_KEY=id')).toEqual([])
  })

  it('a value equal to its key is masked, and the key stays readable', () => {
    const r = anonymize('password: password\n', { fileKind: 'yaml' })
    expect(r.anonymized).toMatch(/^password: __[A-Z_]+\d*__\d*\n$/)
  })
})

// Security review of round 1: under `redact`, the value of a credential-named
// key is a secret - replaced one-way, as a detected secret is, so the map
// never holds it. Under `warn` and `off` it keeps a reversible placeholder.
const VALUES: { code: string; word: string; fileKind?: FileKind; language?: Language }[] = [
  { code: 'const db = { password: "sunshine" }\n', word: 'sunshine' },
  { code: 'SECRET_KEY = "phoenix"\n', word: 'phoenix', language: 'python' },
  { code: 'password: sunshine\n', word: 'sunshine', fileKind: 'yaml' },
  { code: 'PASSWORD=SUNSHINE\n', word: 'SUNSHINE', fileKind: 'dotenv' },
  { code: 'api_key: "zorblaxquint"\nconst zorblaxquint = 1\n', word: 'zorblaxquint' },
  { code: '<password>sunshine</password>\n', word: 'sunshine' },
  { code: 'os.Setenv("DB_PASSWORD","sunshine")\n', word: 'sunshine', language: 'go' },
]

describe('a credential value is a secret under redact (security review)', () => {
  it.each(VALUES)('$code: redacted one-way, never in the map', (c) => {
    const opts = {
      ...(c.fileKind ? { fileKind: c.fileKind } : {}),
      ...(c.language ? { language: c.language } : {}),
    }
    const r = anonymize(c.code, opts)
    expect(r.anonymized).toContain('__REDACTED_CREDENTIAL_')
    expect(r.anonymized).not.toMatch(new RegExp(`\\b${c.word}\\b`))
    expect(Object.values(r.map)).not.toContain(c.word)
  })

  it('under warn and off nothing is redacted one-way: as on main, a value is masked reversibly or left as asked', () => {
    for (const secrets of ['warn', 'off'] as const) {
      for (const [code, opts] of [
        ['password: sunshine\n', { fileKind: 'yaml' as const }],
        ['const db = { password: "sunshine" }\n', {}],
      ] as const) {
        const r = anonymize(code, { ...opts, secrets })
        expect(r.anonymized).not.toContain('__REDACTED_')
        expect(restore(r.anonymized, r.map).restored).toBe(code)
      }
      // One the scanner does not flag is never shown: a reversible placeholder.
      const plain = anonymize('password: sunshine\n', { fileKind: 'yaml', secrets })
      expect(plain.anonymized).toMatch(/^password: __[A-Z]+__\d+\n$/)
    }
  })

  it('a bare name in code is a variable, not a value: it stays reversible', () => {
    const code = 'const apiKey = key;\nfunction f(key: string) { return key }\n'
    const r = anonymize(code, { language: 'typescript' })
    expect(r.anonymized).not.toContain('__REDACTED_')
    expect(restore(r.anonymized, r.map).restored).toBe(code)
  })
})
