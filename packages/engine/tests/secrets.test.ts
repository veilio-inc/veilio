import { describe, it, expect } from 'vitest'
import {
  detectSecrets,
  hasBlockingSecrets,
  previewSecret,
  scanSecrets,
  shannonEntropy,
  summarizeSecrets,
  type SecretType,
} from '../src/secrets.js'
import { anonymize, restore } from '../src/engine.js'

// One live-shaped sample per pattern. Values are synthetic but structurally
// identical to the real thing — that is the whole point of the detector.
const SAMPLES: { type: SecretType; code: string; secret: string }[] = [
  {
    type: 'aws-access-key',
    code: 'const id = "AKIAIOSFODNN7EXAMPLE"',
    secret: 'AKIAIOSFODNN7EXAMPLE',
  },
  {
    type: 'aws-secret-key',
    code: 'aws_secret_access_key = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY123"',
    secret: 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12',
  },
  {
    type: 'private-key',
    code: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7k9\n-----END RSA PRIVATE KEY-----',
    secret: 'MIIEowIBAAKCAQEA7k9',
  },
  {
    type: 'stripe-key',
    code: 'const key = "sk_live_51H8xQ2ABCDEFGHIJKLMNOP"',
    secret: 'sk_live_51H8xQ2ABCDEFGHIJKLMNOP',
  },
  {
    type: 'github-token',
    code: 'const t = "ghp_016C7e42F292c6912E7710c838347Ae178B4a"',
    secret: 'ghp_016C7e42F292c6912E7710c838347Ae178B4a',
  },
  {
    type: 'slack-token',
    code: 'const t = "xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx"',
    secret: 'xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx',
  },
  {
    type: 'openai-key',
    code: 'const k = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"',
    secret: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
  },
  {
    type: 'anthropic-key',
    code: 'const k = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123"',
    secret: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
  },
  {
    // Real Google keys are `AIza` plus exactly 35 characters.
    type: 'google-api-key',
    code: 'const k = "AIzaSyD-1234567890abcdefghijklmnopqrstu"',
    secret: 'AIzaSyD-1234567890abcdefghijklmnopqrstu',
  },
  {
    type: 'npm-token',
    code: 'const t = "npm_abcdefghijklmnopqrstuvwxyz0123456789"',
    secret: 'npm_abcdefghijklmnopqrstuvwxyz0123456789',
  },
  {
    type: 'jwt',
    code: 'const t = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"',
    secret: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  },
  {
    type: 'bearer-token',
    code: 'headers: { Authorization: "Bearer a1b2c3d4e5f6g7h8i9j0klmnop" }',
    secret: 'a1b2c3d4e5f6g7h8i9j0klmnop',
  },
  {
    type: 'connection-string',
    code: 'const url = "postgres://admin:Tr0ub4dor3xz@db.internal:5432/prod"',
    secret: 'Tr0ub4dor3xz',
  },
  {
    type: 'password-assignment',
    code: 'const client_secret = "Xq7#mK92pLzR4vBn"',
    secret: 'Xq7#mK92pLzR4vBn',
  },
  {
    type: 'private-ip',
    code: 'const host = "10.0.3.14"',
    secret: '10.0.3.14',
  },
  {
    type: 'email',
    code: 'const owner = "a.person@acme.com"',
    secret: 'a.person@acme.com',
  },
]

describe('detectSecrets — one case per pattern', () => {
  for (const { type, code } of SAMPLES) {
    it(`detects ${type}`, () => {
      const findings = detectSecrets(code)
      expect(findings.map((f) => f.type)).toContain(type)
    })
  }

  it('finds nothing in ordinary code', () => {
    expect(detectSecrets('const total = subtotal * (1 - discountRate)')).toEqual([])
  })

  it('reports 1-based line and column', () => {
    const findings = detectSecrets('const a = 1\nconst id = "AKIAIOSFODNN7EXAMPLE"')
    expect(findings[0].line).toBe(2)
    expect(findings[0].column).toBe(13)
  })

  it('reports positions on the first line correctly', () => {
    const findings = detectSecrets('AKIAIOSFODNN7EXAMPLE')
    expect(findings[0].line).toBe(1)
    expect(findings[0].column).toBe(1)
  })

  it('reports the true length of the secret', () => {
    const findings = detectSecrets('const id = "AKIAIOSFODNN7EXAMPLE"')
    expect(findings[0].length).toBe(20)
  })
})

describe('previews never carry the secret', () => {
  for (const { type, code, secret } of SAMPLES) {
    it(`truncates the ${type} preview`, () => {
      const finding = detectSecrets(code).find((f) => f.type === type)
      expect(finding).toBeDefined()
      // The whole point: a finding is rendered in UI and may be logged, so it
      // must not be sufficient to reconstruct the credential.
      expect(finding!.preview).not.toContain(secret)
    })
  }

  it('masks all but the first two characters of a short value', () => {
    expect(previewSecret('abcdef')).toBe('ab••••')
  })

  it('handles a one-character value without producing an empty mask', () => {
    expect(previewSecret('a')).toBe('a•')
  })

  it('shows head, tail and length for a long value', () => {
    expect(previewSecret('abcdefghijklmnop')).toBe('abcd…mnop (16 chars)')
  })

  it('collapses whitespace so multi-line keys preview on one line', () => {
    expect(previewSecret('abcd\n  efgh\nijkl')).not.toContain('\n')
  })
})

describe('redaction policy', () => {
  const code = [
    'const stripe = "sk_live_51H8xQ2ABCDEFGHIJKLMNOP"',
    'const owner = "a.person@acme.com"',
  ].join('\n')

  it('redacts critical findings by default', () => {
    const scan = scanSecrets(code)
    expect(scan.code).toContain('__REDACTED_STRIPE_KEY_1__')
    expect(scan.code).not.toContain('sk_live_51H8xQ2ABCDEFGHIJKLMNOP')
  })

  it('leaves medium findings in place but still reports them', () => {
    const scan = scanSecrets(code)
    expect(scan.code).toContain('a.person@acme.com')
    const email = scan.findings.find((f) => f.type === 'email')
    expect(email?.redacted).toBe(false)
  })

  it('warn reports without modifying the code', () => {
    const scan = scanSecrets(code, 'warn')
    expect(scan.code).toBe(code)
    expect(scan.findings.length).toBeGreaterThan(0)
    expect(scan.findings.every((f) => !f.redacted)).toBe(true)
  })

  it('off skips the scan entirely', () => {
    const scan = scanSecrets(code, 'off')
    expect(scan.code).toBe(code)
    expect(scan.findings).toEqual([])
  })

  it('numbers multiple findings of the same type', () => {
    const two = 'a = "AKIAIOSFODNN7EXAMPLE"\nb = "AKIAJ2E5RSTUVWXY7ABC"'
    const scan = scanSecrets(two)
    expect(scan.code).toContain('__REDACTED_AWS_KEY_1__')
    expect(scan.code).toContain('__REDACTED_AWS_KEY_2__')
  })

  it('redacts only the credential inside a connection string', () => {
    const scan = scanSecrets('"postgres://admin:Tr0ub4dor3xz@db.internal:5432/prod"')
    // Scheme, user and host survive — the model needs that structure to help.
    expect(scan.code).toContain('postgres://admin:')
    expect(scan.code).toContain('@db.internal:5432/prod')
    expect(scan.code).not.toContain('Tr0ub4dor3xz')
  })

  it('returns the input unchanged when nothing is found', () => {
    const clean = 'const total = 1'
    expect(scanSecrets(clean).code).toBe(clean)
  })
})

describe('false-positive suppression', () => {
  const dummies = [
    'const password = "changeme"',
    'const password = "password"',
    'const api_key = "your-api-key"',
    'const secret = "${VAULT_SECRET}"',
    'const secret = "{{ secret_value }}"',
    'const password = "$DB_PASSWORD"',
    'const password = "<password>"',
    'const password = "xxxxxxxx"',
  ]

  for (const code of dummies) {
    it(`ignores the placeholder in ${code}`, () => {
      expect(detectSecrets(code)).toEqual([])
    })
  }

  it('ignores an all-identical-character value', () => {
    expect(detectSecrets('password: "aaaaaaaaaaaaaaaaa"')).toEqual([])
  })

  it('never redacts or blocks on a low-entropy value in a credential assignment', () => {
    // Not a repeated single character, so it clears the placeholder check — the
    // entropy floor is what demotes it. Real tokens are near-uniform over their
    // alphabet, so patterned filler is reported at `medium` and goes no
    // further: the code is returned untouched and CI still passes.
    const scan = scanSecrets('password: "abababababab"')
    expect(scan.findings.map((f) => f.severity)).toEqual(['medium'])
    expect(scan.findings[0]?.redacted).toBe(false)
    expect(hasBlockingSecrets(scan.findings)).toBe(false)
    expect(scan.code).toBe('password: "abababababab"')
  })

  it('still flags a genuine high-entropy assignment', () => {
    expect(detectSecrets('password: "Xq7#mK92pLzR4vBn"').length).toBe(1)
  })
})

describe('overlap resolution', () => {
  it('reports a credential inside a connection string once, at the higher severity', () => {
    const scan = scanSecrets('"https://user:ghp_016C7e42F292c6912E7710c838347Ae178B4a@github.com"')
    const types = scan.findings.map((f) => f.type)
    expect(types).toContain('github-token')
    expect(types).not.toContain('connection-string')
  })

  it('does not double-report the same span', () => {
    const scan = scanSecrets('const k = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123"')
    expect(scan.findings.length).toBe(1)
  })

  it('orders findings by what the reader should act on first', () => {
    // This used to assert source order. It now asserts actionability order,
    // deliberately: a panel that lists an email above a live AWS key because the
    // email appeared on an earlier line teaches people to skim, and the one
    // finding that mattered arrives in the same grey list as ninety that did not.
    const scan = scanSecrets('a = "x@y.com"\nb = "AKIAIOSFODNN7EXAMPLE"\nc = "10.0.3.14"')
    expect(scan.findings[0].type).toBe('aws-access-key')
    expect(scan.findings[0].severity).toBe('critical')
    expect(scan.findings.at(-1)!.severity).toBe('low')
  })

  it('breaks ties within a severity by position, so the order is stable', () => {
    const scan = scanSecrets('a = "x@y.com"\nb = "z@w.com"')
    expect(scan.findings.map((f) => f.line)).toEqual([1, 2])
  })
})

describe('entropy helper', () => {
  it('is zero for an empty string', () => {
    expect(shannonEntropy('')).toBe(0)
  })

  it('is zero for a single repeated character', () => {
    expect(shannonEntropy('aaaaaaaa')).toBe(0)
  })

  it('is 1 bit for two equally frequent characters', () => {
    expect(shannonEntropy('abab')).toBeCloseTo(1)
  })

  it('is higher for a random-looking token than for a word', () => {
    expect(shannonEntropy('Xq7#mK92pLzR4vBn')).toBeGreaterThan(shannonEntropy('passwordpassword'))
  })
})

describe('summary helpers', () => {
  it('counts findings by severity, including the low grade', () => {
    const findings = detectSecrets('a = "AKIAIOSFODNN7EXAMPLE"\nb = "x@y.com"\nc = "10.0.3.14"')
    const summary = summarizeSecrets(findings)
    expect(summary.critical).toBe(1)
    // Emails and private IPs were `medium`; they are now `low`, which is what
    // lets the panel de-emphasise them instead of listing them like credentials.
    expect(summary.low).toBe(2)
    expect(summary.medium).toBe(0)
  })

  it('flags blocking findings', () => {
    expect(hasBlockingSecrets(detectSecrets('a = "AKIAIOSFODNN7EXAMPLE"'))).toBe(true)
  })

  it('does not treat medium-only findings as blocking', () => {
    expect(hasBlockingSecrets(detectSecrets('const owner = "x@y.com"'))).toBe(false)
  })

  it('treats an empty finding list as non-blocking', () => {
    expect(hasBlockingSecrets([])).toBe(false)
  })
})

// The security property the whole module exists for.
describe('integration — a credential can never round-trip', () => {
  const code = [
    'const stripe = "sk_live_51H8xQ2ABCDEFGHIJKLMNOP"',
    'const aws = "AKIAIOSFODNN7EXAMPLE"',
    'const db = "postgres://admin:Tr0ub4dor3xz@10.0.3.14:5432/prod"',
  ].join('\n')

  it('keeps every redacted secret out of the symbol map', () => {
    const { map } = anonymize(code)
    const values = Object.values(map).join('\n')
    expect(values).not.toContain('sk_live_51H8xQ2ABCDEFGHIJKLMNOP')
    expect(values).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(values).not.toContain('Tr0ub4dor3xz')
  })

  it('does not resurrect a secret on restore', () => {
    const { anonymized, map } = anonymize(code)
    const { restored } = restore(anonymized, map)
    expect(restored).not.toContain('sk_live_51H8xQ2ABCDEFGHIJKLMNOP')
    expect(restored).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(restored).toContain('__REDACTED_STRIPE_KEY_1__')
  })

  it('reports the findings on the anonymize result', () => {
    const { secrets } = anonymize(code)
    expect(secrets.length).toBeGreaterThanOrEqual(3)
    expect(secrets.some((f) => f.type === 'stripe-key' && f.redacted)).toBe(true)
  })

  it('never masks a redaction token into the map', () => {
    // Redaction tokens are placeholder-shaped, so the idempotency guard must
    // skip them — otherwise the token itself becomes a restorable identifier.
    const { map } = anonymize(code)
    expect(Object.keys(map).some((k) => k.startsWith('__REDACTED_'))).toBe(false)
    expect(Object.values(map).some((v) => v.startsWith('__REDACTED_'))).toBe(false)
  })

  it('honours secrets: off so existing callers can opt out', () => {
    const { anonymized, map } = anonymize(code, { secrets: 'off' })
    expect(anonymized).not.toContain('__REDACTED_')
    // With the guard off the key is masked reversibly — the old behavior, and
    // exactly why 'redact' is the default.
    expect(Object.values(map)).toContain('sk_live_51H8xQ2ABCDEFGHIJKLMNOP')
  })

  it('honours secrets: warn — reports without altering the output', () => {
    const { secrets, anonymized } = anonymize(code, { secrets: 'warn' })
    expect(secrets.length).toBeGreaterThan(0)
    expect(anonymized).not.toContain('__REDACTED_')
  })

  it('redacts a private key spanning multiple lines', () => {
    const pem =
      'const k = `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\nhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----`'
    const { anonymized, map } = anonymize(pem)
    expect(anonymized).toContain('__REDACTED_PRIVATE_KEY_1__')
    expect(Object.values(map).join('')).not.toContain('MIIEvQIBADANBgkq')
  })
})

// ─── Expanded provider coverage ─────────────────────────────────────────────

const MORE_SAMPLES: { type: SecretType; code: string }[] = [
  { type: 'gitlab-token', code: 'const t = "glpat-abcdefghij1234567890"' },
  {
    type: 'slack-webhook',
    code: 'const u = "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX"',
  },
  {
    type: 'sendgrid-key',
    code: 'const k = "SG.abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuvwxyz0123456789ABC"',
  },
  { type: 'twilio-key', code: 'const sid = "AC0123456789abcdef0123456789abcdef"' },
  { type: 'mailgun-key', code: 'const k = "key-0123456789abcdef0123456789abcdef"' },
  { type: 'hugging-face-token', code: 'const t = "hf_abcdefghijklmnopqrstuvwxyz01234567"' },
  { type: 'supabase-key', code: 'const k = "sbp_0123456789abcdef0123456789abcdef01234567"' },
  { type: 'shopify-token', code: 'const t = "shpat_0123456789abcdef0123456789abcdef"' },
  { type: 'square-token', code: 'const t = "sq0atp-abcdefghijklmnopqrstuv"' },
  {
    type: 'pypi-token',
    code:
      'const t = "pypi-AgEIcHlwaS5vcmc' +
      'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP' +
      '"',
  },
  {
    type: 'discord-token',
    code: 'const t = "MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.abcdefghijklmnopqrstuvwxyz01234"',
  },
  { type: 'azure-key', code: 'AccountKey=' + 'a'.repeat(43) + 'bC9/' + 'd'.repeat(39) + '==' },
  { type: 'datadog-key', code: 'dd_api_key = "0123456789abcdef0123456789abcdef"' },
  {
    type: 'cloudflare-token',
    code: 'cloudflare_api_token = "abcdefghij1234567890ABCDEFGHIJ1234567890"',
  },
  { type: 'basic-auth', code: 'headers: { Authorization: "Basic dXNlcjpzM2NyM3RwYXNzdzByZA==" }' },
]

describe('detectSecrets — expanded provider coverage', () => {
  for (const { type, code } of MORE_SAMPLES) {
    it(`detects ${type}`, () => {
      expect(detectSecrets(code).map((f) => f.type)).toContain(type)
    })
  }

  it('redacts every expanded provider irreversibly', () => {
    for (const { code } of MORE_SAMPLES) {
      const scan = scanSecrets(code)
      expect(scan.code).toContain('__REDACTED_')
    }
  })
})

describe('high-entropy catch-all', () => {
  it('flags a credential-named assignment from an unknown provider', () => {
    const code = 'const acmeWidgetApiToken = "Zk3n8QpL2vX9mB4tR7wY1cF6hJ0sD5gA"'
    expect(detectSecrets(code).map((f) => f.type)).toContain('high-entropy-string')
  })

  it('does not flag a long low-entropy value', () => {
    expect(detectSecrets('const token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"')).toEqual([])
  })

  it('does not flag a long value in a non-credential variable', () => {
    // Restricted to credential-named assignments on purpose: a bare long token
    // is more often a hash or a UUID than a live key, and a detector that cries
    // wolf gets switched off.
    expect(detectSecrets('const commitSha = "Zk3n8QpL2vX9mB4tR7wY1cF6hJ0sD5gA"')).toEqual([])
  })

  it('yields to a specific provider pattern for the same span', () => {
    const findings = detectSecrets('const apiKey = "sk_live_51H8xQ2ABCDEFGHIJKLMNOP"')
    expect(findings.map((f) => f.type)).toContain('stripe-key')
    expect(findings).toHaveLength(1)
  })
})

// ─── Prose and HTML-spec values are not credentials ──────────────────────────
//
// The assignment pattern reads `<keyword> <sep> "<value>"`, which a ternary
// satisfies by accident: in
//   autoComplete={x ? 'new-password' : 'current-password'}
// the `" : "` between the branches is the separator and the second branch is
// read as the secret. That is a `high` finding, so it is both redacted and
// blocking — a login form would corrupt on scrub and fail `veilio scan` in CI.
//
// These fixes originated in the Veilio Cloud copy of the engine and are ported
// here so the published package does not regress a consumer that adopts it.

describe('false positives that would train users to ignore the panel', () => {
  it('ignores HTML autocomplete tokens in a ternary', () => {
    const code = `autoComplete={isRegister ? "new-password" : "current-password"}`
    expect(detectSecrets(code)).toHaveLength(0)
  })

  it('ignores each HTML autocomplete token on its own', () => {
    for (const token of ['current-password', 'new-password', 'one-time-code']) {
      expect(detectSecrets(`password: "${token}"`)).toHaveLength(0)
    }
  })

  it('never redacts or blocks on an ordinary lowercase word in a credential field', () => {
    // These read as configuration, not secrets. Nothing in the syntax separates
    // them from a weak-but-real password, so they are reported at `medium` —
    // which is the tier that neither rewrites the code nor fails a scan.
    for (const code of ['client_secret: "disabled"', 'const password = "inherited"']) {
      const scan = scanSecrets(code)
      expect(scan.findings.map((f) => f.type)).toEqual(['possible-credential'])
      expect(hasBlockingSecrets(scan.findings)).toBe(false)
      expect(scan.code).toBe(code)
    }
  })

  // The suppressions must not blunt the detector: anything carrying mixed case,
  // digits or symbols is still reported.
  it('still reports real credentials', () => {
    expect(detectSecrets('const password = "S3cr3tP@ss!"')).not.toHaveLength(0)
    expect(detectSecrets('client_secret: "9f8e7d6c5b4a3210"')).not.toHaveLength(0)
    expect(detectSecrets('api_key: "abc123def456ghi789"')).not.toHaveLength(0)
  })
})

// ─── Prefixed credential keywords ────────────────────────────────────────────
//
// The assignment pattern anchored its keyword with a leading \b, which does not
// exist after an underscore or inside camelCase — `_` and letters are both word
// characters. So `DB_PASSWORD=`, `MY_API_KEY=` and `userPassword=` were all
// missed while the bare `password=` was caught: a false negative in the
// security-critical path, and those prefixed forms are the common ones in real
// code and .env-style config.
//
// The TRAILING \b is what keeps this honest — it requires the keyword to end at
// a non-word character, so `passwordless`, `passwordHash` and `secretary` still
// do not match.

describe('credential keywords carrying a prefix', () => {
  it('detects SCREAMING_SNAKE_CASE credential assignments', () => {
    expect(detectSecrets('DB_PASSWORD="Tr0ub4dor&3"')).not.toHaveLength(0)
    expect(detectSecrets('MY_SECRET="9f8e7D6c5b4a"')).not.toHaveLength(0)
    expect(detectSecrets('const DATABASE_PASSWORD = "P@ssw0rd123"')).not.toHaveLength(0)
  })

  it('detects camelCase credential assignments', () => {
    expect(detectSecrets('userPassword = "S3cr3tP@ss"')).not.toHaveLength(0)
    expect(detectSecrets('dbPassword: "Xy9$kL2mNp"')).not.toHaveLength(0)
  })

  it('detects a prefixed api key', () => {
    expect(detectSecrets('MY_API_KEY = "abc123def456ghi789"')).not.toHaveLength(0)
  })

  // Relaxing the leading boundary must not let the keyword match a longer word
  // that merely starts with it — the trailing boundary is what prevents that.
  it('does not fire when the keyword is only a prefix of a longer word', () => {
    expect(detectSecrets('passwordless = "Enabled123"')).toHaveLength(0)
    expect(detectSecrets('passwordHash = "a1b2c3d4e5"')).toHaveLength(0)
    expect(detectSecrets('secretary = "Jane Smith"')).toHaveLength(0)
  })
})

// ─── Lower-case credentials ──────────────────────────────────────────────────
//
// A value made only of lower-case letters was treated as prose and dropped
// outright, for every pattern. Two separate holes came out of that:
//
//   1. It was applied to patterns where prose is not a possible reading. The
//      password slot of a connection string and the value of an Authorization
//      header are structurally credentials, so a lower-case password there was
//      silently unprotected — the leak the redactor exists to prevent.
//   2. Where prose IS a possible reading — an assignment — dropping the finding
//      resolved a genuine ambiguity by guessing. `client_secret: "disabled"`
//      and `password = "correcthorse"` are the same shape; the first is config,
//      the second is a live password.
//
// Hole 1 is fixed by scoping the heuristic to assignments. Hole 2 is fixed by
// reporting at `medium` instead of dropping: the user sees it, and because
// `medium` is neither redacted nor blocking, a wrong guess cannot corrupt code
// through a redaction that `restore()` is designed never to undo.

describe('lower-case credentials outside an assignment', () => {
  it('detects a lower-case password in a connection string', () => {
    const scan = scanSecrets('postgresql://admin:mypassword@db.internal:5432/prod')
    expect(scan.findings.map((f) => f.type)).toEqual(['connection-string'])
    expect(hasBlockingSecrets(scan.findings)).toBe(true)
    expect(scan.code).not.toContain('mypassword')
  })

  it('detects a lower-case password in a redis URL', () => {
    const scan = scanSecrets('REDIS_URL=redis://default:supersecure@cache:6379')
    expect(hasBlockingSecrets(scan.findings)).toBe(true)
    expect(scan.code).not.toContain('supersecure')
  })

  it('detects a lower-case bearer token', () => {
    const scan = scanSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwx')
    expect(scan.findings.map((f) => f.type)).toEqual(['bearer-token'])
    expect(scan.code).not.toContain('abcdefghijklmnopqrstuvwx')
  })

  // The placeholder list still applies everywhere — a documented example
  // connection string must not start failing anyone's CI.
  it('still ignores a placeholder password in a connection string', () => {
    expect(detectSecrets('postgresql://admin:changeme@localhost:5432/dev')).toHaveLength(0)
  })
})

describe('lower-case credentials inside an assignment', () => {
  it('surfaces a weak but real password instead of dropping it', () => {
    for (const code of ['const password = "correcthorse"', 'const password = "letmein"']) {
      const findings = detectSecrets(code)
      expect(findings.map((f) => f.type)).toEqual(['possible-credential'])
      expect(findings[0]?.severity).toBe('medium')
    }
  })

  // The whole point of the `medium` tier: visible, but it can neither rewrite
  // the user's code nor fail their build on a guess.
  it('never redacts or blocks a possible credential', () => {
    const code = 'const password = "correcthorse"'
    const scan = scanSecrets(code, 'redact')
    expect(scan.findings[0]?.redacted).toBe(false)
    expect(hasBlockingSecrets(scan.findings)).toBe(false)
    expect(scan.code).toBe(code)
  })

  it('leaves a confident credential at full severity', () => {
    const scan = scanSecrets('const password = "S3cr3tP@ss!"')
    expect(scan.findings.map((f) => f.type)).toEqual(['password-assignment'])
    expect(hasBlockingSecrets(scan.findings)).toBe(true)
    expect(scan.code).not.toContain('S3cr3tP@ss!')
  })

  // A value a concrete pattern can name is reported as that thing, not as the
  // catch-all — both are `medium`, so only the tie-break in dropOverlaps
  // decides which label the user is shown.
  it('prefers a concrete type over the catch-all on an identical span', () => {
    expect(detectSecrets('secret: "10.0.3.14"').map((f) => f.type)).toEqual(['private-ip'])
  })
})
