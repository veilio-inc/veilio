import { describe, it, expect } from 'vitest'
import { anonymize, credentialValueSpans, detectSecrets, restore } from '../src/index.js'
import type { FileKind, Language } from '../src/index.js'

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
  it.each([
    ['const password_hint = "sunshine is a word"\n', 'sunshine'],
    ['const mood = "sunshine"\n', 'sunshine'],
    ['weather: sunshine\n', 'sunshine'],
    ['const monkey = ledger\n', 'ledger'],
    ['interface Env {\n  DB_PASSWORD: string\n}\n', 'string'],
    ['REQUIRE_PASSWORD=true\n', 'true'],
    ['enum Kind {\n  PASSWORD = "PASSWORD",\n}\n', '"PASSWORD"'],
  ])('%j keeps %s', (code, word) => {
    expect(anonymize(code).anonymized).toContain(word)
  })

  it('an ordinary word used both as a password and elsewhere is masked only as the password', () => {
    const r = anonymize('password: sunshine\ngreeting: sunshine\n', { fileKind: 'yaml' })
    expect(r.anonymized).toBe('password: __VAR__1\ngreeting: sunshine\n')
    expect(restore(r.anonymized, r.map).restored).toBe('password: sunshine\ngreeting: sunshine\n')
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
    ['const password_hint = "sunshine"\n', 'sunshine'],
    ['author: sunshine\n', 'sunshine'],
    ['<author>sunshine</author>\n', 'sunshine'],
    ['<entry key="password_hint">sunshine</entry>\n', 'sunshine'],
    ['ENV AUTHOR sunshine\n', 'sunshine'],
    ["define('AUTHOR','sunshine');\n", 'sunshine'],
    ['env:\n  - name: AUTHOR\n    value: sunshine\n', 'sunshine'],
    ['const monkey = "monkey"\nconst animal = monkey\n', 'monkey'],
    ['PRIMARY_KEY=id\n', 'id'],
  ])('the control %j keeps %s', (code, word) => {
    expect(anonymize(code).anonymized).toMatch(new RegExp(`\\b${word}\\b`))
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
