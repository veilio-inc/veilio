import { describe, it, expect } from 'vitest'
import {
  detectSecrets,
  hasBlockingSecrets,
  previewSecret,
  scanSecrets,
  shannonEntropy,
  summarizeSecrets,
  SECRET_DISPOSITIONS,
  type SecretType,
} from '../src/secrets.js'
import { anonymize, detectCredentials, restore } from '../src/engine.js'
import { CREDENTIAL as LIVE_STRIPE_KEY } from './fixtures/regulated.js'

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

  // Spec 078 FR-017 (strings.md #18, #19): no leading characters, ever.
  it('shows only the length of a value of 12 characters or fewer', () => {
    expect(previewSecret('abcdef')).toBe('•••• (6 chars)')
    expect(previewSecret('abcdefghijkl')).toBe('•••• (12 chars)')
  })

  it('handles a one-character value without producing an empty mask', () => {
    expect(previewSecret('a')).toBe('•••• (1 chars)')
  })

  it('shows the last four characters and the length for a long value', () => {
    expect(previewSecret('abcdefghijklmnop')).toBe('…mnop (16 chars)')
    expect(previewSecret('abcdefghijklm')).toBe('…jklm (13 chars)')
  })

  it('shows no leading character in any finding of the credential corpus', () => {
    for (const { type, code } of SAMPLES) {
      const finding = detectSecrets(code).find((f) => f.type === type)!
      expect(`${type}: ${finding.preview}`).toMatch(/: (…\S{4}|••••) \(\d+ chars\)$/)
    }
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
    // It used to be masked reversibly, into the map. A credential never goes
    // into the map in any mode (founder decision 2026-10-26): with the guard
    // off it is left in the text as written.
    expect(Object.values(map)).not.toContain('sk_live_51H8xQ2ABCDEFGHIJKLMNOP')
    expect(anonymized).toContain('sk_live_51H8xQ2ABCDEFGHIJKLMNOP')
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

// ─────────────────────────────────────────────────────────────────────────────
// Spec 009 — the classification lattice, and the guarantee it protects.

describe('a credential cannot be recovered, however the classification moves', () => {
  it('writes no credential value into the map, for any destroyed type (V2)', () => {
    // Built from the RUNNING disposition table, not a hand-written list of
    // credentials. A type added tomorrow is covered on the day it appears, and
    // a type quietly reclassified shows up here rather than in production.
    const destroyed = (Object.keys(SECRET_DISPOSITIONS) as SecretType[]).filter(
      (t) => SECRET_DISPOSITIONS[t] === 'destroy'
    )
    expect(destroyed.length, 'no destroyed types — the table is not being read').toBeGreaterThan(10)

    // One real value per destroyed type would need a fixture per rule; the
    // property under test is about the MAP, so one well-formed credential
    // through the full pipeline exercises it. The totality case below is what
    // covers the rest of the table.
    const source = `const key = "${LIVE_STRIPE_KEY}"`
    const result = anonymize(source, {})

    expect(result.anonymized).not.toContain(LIVE_STRIPE_KEY)
    expect(
      Object.values(result.map),
      'a credential value reached the SymbolMap — Cloud syncs this'
    ).not.toContain(LIVE_STRIPE_KEY)

    // Values, not keys. Asserting on keys passes whether or not the secret is
    // in there, which is the shape of test this codebase keeps finding.
    const { restored } = restore(result.anonymized, result.map)
    expect(restored).not.toContain(LIVE_STRIPE_KEY)
    expect(restored).toMatch(/__REDACTED_[A-Z_]+_\d+__/)
  })
})

describe('every detected type has exactly one disposition (V3)', () => {
  const types = Object.keys(SECRET_DISPOSITIONS) as SecretType[]

  it('reads a non-trivial table, so the cases below cannot pass vacuously', () => {
    expect(types.length).toBeGreaterThan(30)
  })

  it.each(types)('%s has a disposition drawn from the three', (type) => {
    expect(['destroy', 'mask', 'report']).toContain(SECRET_DISPOSITIONS[type])
  })

  it('classifies no type as both destroyed and reversibly masked', () => {
    // Unrepresentable by construction — one field, not two booleans — so this
    // is a guard on the construction rather than on a list. It goes red if
    // somebody reintroduces parallel sets.
    const destroyed = types.filter((t) => SECRET_DISPOSITIONS[t] === 'destroy')
    const masked = types.filter((t) => SECRET_DISPOSITIONS[t] === 'mask')
    expect(destroyed.filter((t) => masked.includes(t))).toEqual([])
  })

  it('keeps the ambiguous verdict out of the map', () => {
    // `possible-credential` might BE a live credential — that is what ambiguous
    // means. Masking it reversibly would persist a possible secret, and the
    // ambiguity is exactly why we could not know which one we just wrote.
    expect(SECRET_DISPOSITIONS['possible-credential']).toBe('report')
  })

  it('holds the invariant redacted === (disposition === destroy)', () => {
    const source = [
      `const key = "${LIVE_STRIPE_KEY}"`,
      `const acct = "GB29NWBK60161331926819"`,
      `const mail = "someone@example.com"`,
    ].join('\n')

    const { findings } = scanSecrets(source, 'redact')
    expect(findings.length).toBeGreaterThanOrEqual(3)
    for (const f of findings) {
      expect(f.redacted, `${f.type} disagrees with its disposition`).toBe(
        f.disposition === 'destroy'
      )
    }
  })
})

describe('blocking is about credentials, not about how alarming something looks (V5)', () => {
  const IBAN = 'GB29NWBK60161331926819'

  it('does not block a file whose only finding is the user’s own identifier', () => {
    expect(hasBlockingSecrets(detectSecrets(`const acct = "${IBAN}"`))).toBe(false)
  })

  it('does block once a live credential is present', () => {
    // The control. Without it the case above passes when blocking is simply
    // broken, rather than because it is credential-only.
    const both = `const acct = "${IBAN}"\nconst key = "${LIVE_STRIPE_KEY}"`
    expect(hasBlockingSecrets(detectSecrets(both))).toBe(true)
  })

  it('does not consult severity — an IBAN is graded high and still does not block', () => {
    // `iban` carries severity 'high', above the credential-ish 'medium' grades.
    // If blocking ever reads the grade again, this is the case that catches it:
    // a high-severity non-blocking finding is only possible while the two
    // questions stay separate.
    const findings = detectSecrets(`const acct = "${IBAN}"`)
    expect(findings[0].severity).toBe('high')
    expect(hasBlockingSecrets(findings)).toBe(false)
  })
})

// Spec 094: key material is redacted from its BEGIN line on, with or without
// an END line and whatever its length; and every value of a Kubernetes Secret
// manifest. None of it is ever a map value.
describe('private-key lines and Secret manifests never reach the map', () => {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  // Made-up text, the same for the same seed: nothing key-shaped is written here.
  const made = (seed: number, length: number): string => {
    let s = seed * 2654435761 + 1
    let out = ''
    for (let i = 0; i < length; i++) {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      out += ALPHABET[(s >>> 0) % ALPHABET.length]
    }
    return out
  }
  const lines = (count: number, seed = 500): string[] =>
    Array.from({ length: count }, (_, i) => made(seed + i, 64))
  const BEGIN = '-----BEGIN PRIVATE KEY-----'
  const END = '-----END PRIVATE KEY-----'
  const BEGIN_SSH = '-----BEGIN OPENSSH PRIVATE KEY-----'

  /** No run of eight characters of any of `secrets` is in the output or the map. */
  const gone = (code: string, secrets: string[], options = {}) => {
    const result = anonymize(code, options)
    const seen = result.anonymized + '\n' + Object.values(result.map).join('\n')
    for (const secret of secrets)
      for (let i = 0; i + 8 <= secret.length || i === 0; i += 4)
        expect(seen.includes(secret.slice(i, i + 8)), secret.slice(i, i + 8)).toBe(false)
    return result
  }

  it('a BEGIN line and two body lines, no END line', () => {
    const body = [made(1, 52), made(2, 64).toLowerCase()]
    const { anonymized, map } = gone(`${BEGIN_SSH}\n${body.join('\n')}\n`, body)
    expect(anonymized).toBe('__REDACTED_PRIVATE_KEY_1__\n')
    expect(map).toEqual({})
  })

  it('a BEGIN line with nothing after it is no key', () => {
    expect(scanSecrets(`${BEGIN_SSH}\n`).findings.map((f) => f.type)).not.toContain('private-key')
  })

  it.each([
    ['with its END line', `\n${END}\n`],
    ['without one', '\n'],
  ])('a body of 12,000 characters %s', (_, tail) => {
    const body = lines(190)
    const { anonymized } = gone(`${BEGIN}\n${body.join('\n')}${tail}`, body)
    expect(anonymized).toBe('__REDACTED_PRIVATE_KEY_1__\n')
  })

  it('a complete block is redacted as it always was', () => {
    const body = lines(4)
    const code = `${BEGIN}\n${body.join('\n')}\n${END}\nexport LEDGER_MODE=production\n`
    const scan = scanSecrets(code)
    expect(scan.code).toBe('__REDACTED_PRIVATE_KEY_1__\nexport LEDGER_MODE=production\n')
    expect(scan.findings.map((f) => f.type)).toEqual(['private-key'])
  })

  it('a short line after the body is key material too', () => {
    const body = [...lines(3), made(9, 12)]
    const { anonymized } = gone(`${BEGIN}\n${body.join('\n')}\n\nexport LEDGER_MODE=on\n`, body)
    expect(anonymized).toMatch(/^__REDACTED_PRIVATE_KEY_1__\n\nexport /)
  })

  it('indented body lines, CRLF and PEM headers are key material', () => {
    const body = lines(3)
    const code = `key: |\r\n  -----BEGIN RSA PRIVATE KEY-----\r\n  Proc-Type: 4,ENCRYPTED\r\n\r\n  ${body.join('\r\n  ')}\r\nnext: value\r\n`
    const { anonymized } = gone(code, body, { fileKind: 'yaml' })
    expect(anonymized).toContain('__REDACTED_PRIVATE_KEY_1__\r\n')
    expect(anonymized).toMatch(/\r\nnext: \S+\r\n$/)
  })

  it.each([
    ['CR', '\r'],
    ['U+2028', '\u2028'],
    ['CR and LF mixed', '\r', '\n'],
  ])('lines that end in %s only, no END line', (_, eol, second = eol) => {
    const body = lines(3)
    const code = `mode=on${eol}${BEGIN}${eol}${body[0]}${second}${body[1]}${eol}${body[2]}${eol}`
    const { anonymized, map } = gone(code, body)
    expect(anonymized).toBe(`mode=on${eol}__REDACTED_PRIVATE_KEY_1__${eol}`)
    expect(Object.values(map).join(' ')).not.toMatch(/[A-Za-z0-9]{12}/)
  })

  it('CR line ends behind a prefix, with a line after the key', () => {
    const body = [...lines(3), made(9, 12)]
    const code = `# ${BEGIN}\r${body.map((l) => '# ' + l).join('\r')}\r#\rnext line\r`
    const { anonymized } = gone(code, body)
    expect(anonymized).toContain('# __REDACTED_PRIVATE_KEY_1__\r')
    expect(anonymized).toMatch(/\rnext line\r$/)
  })

  it.each([
    ['without an END line', ''],
    ['with its END line', '-----END ENCRYPTED PRIVATE KEY-----\n'],
  ])('an encrypted key (PKCS#8) %s', (_, tail) => {
    const body = lines(3)
    const code = `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${body.join('\n')}\n${tail}`
    const { anonymized, map } = gone(code, body)
    expect(anonymized).toBe('__REDACTED_PRIVATE_KEY_1__\n')
    expect(map).toEqual({})
  })

  it('a complete encrypted key in one string, its line ends written as escapes', () => {
    const body = lines(3)
    const code = `const pem = "-----BEGIN ENCRYPTED PRIVATE KEY-----\\n${body.join('\\n')}\\n-----END ENCRYPTED PRIVATE KEY-----"\n`
    const { anonymized } = gone(code, body, { language: 'typescript' })
    expect(anonymized).toMatch(/= "__REDACTED_PRIVATE_KEY_1__"\n$/)
  })

  it('a BEGIN line inside a line of code starts no key', () => {
    const code = `if (pem.startsWith("${BEGIN}")) {\n  return true\n}\n`
    expect(scanSecrets(code).findings).toEqual([])
  })

  const VALUE = made(40, 52) + '=='
  const TEXT = made(41, 20)
  // What makes a text a document: the YAML kind, or a YAML or JSON path.
  const DOCUMENT = [{ fileKind: 'yaml' }, { path: 'deploy/secret.yaml' }] as const
  const manifest = (kind: string, section: string): string =>
    `apiVersion: v1\nkind: ${kind}\nmetadata:\n  name: ledger\n${section}`

  it.each([[{ fileKind: 'yaml' }], [{ path: 'deploy/secret.yaml' }]] as const)(
    'every value under data of a Secret is redacted (%j)',
    (options) => {
      const code = manifest('Secret', `data:\n  db: ${VALUE}\n  note: ${TEXT}\ntype: Opaque\n`)
      const { anonymized } = gone(code, [VALUE, TEXT], options)
      expect(anonymized).toMatch(/db: __REDACTED_CREDENTIAL_\d+__\n/)
      expect(anonymized).toMatch(/note: __REDACTED_CREDENTIAL_\d+__\n/)
    }
  )

  it('stringData, a quoted value and a block scalar', () => {
    const body = lines(2, 700)
    const code = manifest(
      'Secret',
      `stringData:\n  note: "${TEXT}"\n  id_ledger: |-\n    ${body.join('\n    ')}\ntype: Opaque\n`
    )
    const { anonymized } = gone(code, [TEXT, ...body], { fileKind: 'yaml' })
    expect(anonymized).toMatch(/type: \S+\n$/)
  })

  it('only the Secret among three documents', () => {
    const code = [
      manifest('ConfigMap', 'data:\n  ledgerMode: production\n'),
      manifest('Secret', `data:\n  db: ${VALUE}\n`),
      manifest('Service', 'spec:\n  data: none\n'),
    ].join('---\n')
    const { anonymized, map } = gone(code, [VALUE], { fileKind: 'yaml' })
    expect(anonymized.match(/__REDACTED_/g)).toHaveLength(1)
    expect(Object.values(map)).toContain('production')
  })

  // One rule for a document that names a Secret: every `data` value in it,
  // the other items' too. Redacting more is the safe side.
  it('a Secret inside a List: every data value of the document', () => {
    const code = `apiVersion: v1\nkind: List\nitems:\n  - apiVersion: v1\n    kind: ConfigMap\n    data:\n      ledgerMode: production\n  - apiVersion: v1\n    data:\n      db: ${VALUE}\n    kind: Secret\n`
    const { anonymized, map } = gone(code, [VALUE], { fileKind: 'yaml' })
    expect(anonymized.match(/__REDACTED_/g)).toHaveLength(2)
    expect(Object.values(map)).not.toContain('production')
  })

  it('a ConfigMap is masked as it always was', () => {
    const code = manifest('ConfigMap', 'data:\n  ledgerMode: production\n  gateway: AcmeLedger\n')
    const { anonymized, map } = anonymize(code, { fileKind: 'yaml' })
    expect(anonymized).not.toContain('__REDACTED_')
    expect(restore(anonymized, map).restored).toBe(code)
  })

  it.each([
    [
      'a quoted key',
      (v: string) =>
        manifest('Secret', `data:\n  db: ${v}\n  note: ${TEXT}\n`).replace('kind:', '"kind":'),
    ],
    [
      'JSON over several lines',
      (v: string) =>
        `{\n  "apiVersion": "v1",\n  "kind": "Secret",\n  "data": {\n    "db": "${v}",\n    "note": "${TEXT}"\n  },\n  "type": "Opaque"\n}\n`,
    ],
    [
      'JSON on one line',
      (v: string) => `{"apiVersion":"v1","kind":"Secret","data":{"db":"${v}","note":"${TEXT}"}}\n`,
    ],
    ['a flow mapping', (v: string) => `{kind: Secret, stringData: {db: ${v}, note: '${TEXT}'}}\n`],
    ['data in flow form', (v: string) => manifest('Secret', `data: {db: ${v}, note: ${TEXT}}\n`)],
  ])('a Secret written with %s', (_, write) => {
    const code = write(VALUE)
    for (const options of DOCUMENT) {
      const { anonymized } = gone(code, [VALUE, TEXT], options)
      // (A key that follows a redacted value on one line is redacted too, as before.)
      expect(anonymized).toContain('__REDACTED_CREDENTIAL_2__')
    }
  })

  it.each([
    [
      "a single-quoted value holding ''",
      (v: string) => `{kind: Secret, stringData: {db: 'it''s ${v}', note: '${TEXT}'}}\n`,
    ],
    [
      'a single-quoted value ending in a backslash',
      (v: string) => `{kind: Secret, stringData: {db: '${v}\\', note: '${TEXT}'}}\n`,
    ],
    [
      'a quote that never closes',
      (v: string) => `{kind: Secret, stringData: {db: "${v}, note: ${TEXT}}}\n`,
    ],
    [
      'JSON without spaces, data on a later line',
      (v: string) => `{"kind":"Secret",\n"data":{\n"db":"${v}",\n"note":"${TEXT}"}}\n`,
    ],
    [
      'JSON with spaces around the colon',
      (v: string) =>
        `{\n  "kind" : "Secret" ,\n  "data" : {\n    "db" : "${v}" ,\n    "note" : "${TEXT}"\n  }\n}\n`,
    ],
    [
      'JSON inside a string, its quotes escaped',
      (v: string) =>
        `const m = "{\\"kind\\":\\"Secret\\",\\"data\\":{\\"db\\":\\"${v}\\",\\"note\\":\\"${TEXT}\\"}}";\n`,
    ],
    [
      'kind after data',
      (v: string) => `data:\n  db: ${v}\n  note: ${TEXT}\napiVersion: v1\nkind: Secret\n`,
    ],
  ])('a Secret written with %s', (_, write) => {
    const code = write(VALUE)
    for (const options of DOCUMENT) gone(code, [VALUE, TEXT], options)
  })

  it.each([
    [
      'an anchor after the key',
      (v: string) => manifest('Secret', `data: &values\n  db: ${v}\n  note: ${TEXT}\n`),
    ],
    [
      'a tag and a comment after the key',
      (v: string) =>
        manifest('Secret', `stringData: !!map # values\n  db: ${v}\n  note: ${TEXT}\n`),
    ],
    [
      'a quoted flow value over two lines',
      (v: string) => `{kind: Secret, stringData: {db: "${v}\n  ${TEXT}", mode: plain}}\n`,
    ],
    [
      'a flow value continued on the next line',
      (v: string) => `{kind: Secret, stringData: {db: ${v}\n  ${TEXT}, mode: plain}}\n`,
    ],
    [
      'a quote that never closes where a key stands',
      (v: string) => `{kind: Secret, stringData: {"db: ${v}, note: ${TEXT}}}\n`,
    ],
    [
      'values in a flow sequence',
      (v: string) => `{kind: Secret, data: {all: [${v}, "${TEXT}"]}}\n`,
    ],
  ])('a Secret written with %s', (_, write) => {
    const code = write(VALUE)
    for (const options of DOCUMENT) gone(code, [VALUE, TEXT], options)
  })

  const BLOCK = (v: string): string => `data:\n  db: ${v}\n  note: ${TEXT}\n`
  it.each([
    ['a tag before the kind', (v: string) => `kind: !!str Secret\n${BLOCK(v)}`],
    ['an anchor before the kind', (v: string) => `kind: &k Secret\n${BLOCK(v)}`],
    ['an anchor and a tag', (v: string) => `kind: &k !!str "Secret"\n${BLOCK(v)}`],
    ['the kind on the next line', (v: string) => `kind:\n  Secret\n${BLOCK(v)}`],
    ['a tag, a comment, the kind below', (v: string) => `kind: !!str # c\r\n  Secret\n${BLOCK(v)}`],
    [
      'a block indented by a tab',
      (v: string) => `kind: Secret\ndata:\n\tdb: ${v}\n\tnote: ${TEXT}\n`,
    ],
    [
      'tabs before the key and its block',
      (v: string) =>
        `kind: Secret\nitem:\n\tstringData:\n\t\tdb: |\n\t\t\t${v}\n\t\tnote: ${TEXT}\n`,
    ],
  ])('a Secret written with %s', (_, write) => {
    const code = write(VALUE)
    for (const options of DOCUMENT) {
      const { anonymized } = gone(code, [VALUE, TEXT], options)
      expect(anonymized.match(/__REDACTED_CREDENTIAL_/g)).toHaveLength(2)
    }
  })

  it.each([
    ['a tagged ConfigMap', `kind: !!str ConfigMap\ndata:\n  ledgerMode: production\n`],
    ['an anchored SecretStore', `kind: &k SecretStore\ndata:\n  ledgerMode: production\n`],
    ['a word on the line below another kind', `kind: List\nSecret:\n  data:\n    a: production\n`],
  ])('no manifest: %s', (_, code) => {
    const { anonymized, map } = anonymize(code, { fileKind: 'yaml' })
    expect(anonymized).not.toContain('__REDACTED_')
    expect(restore(anonymized, map).restored).toBe(code)
  })

  it('a quote that never closes on a line of a block runs to the end of the line', () => {
    const tail = made(63, 16)
    const code = manifest('Secret', `stringData:\n  db: "${VALUE} {${TEXT}} ${tail}\n`)
    gone(code, [VALUE, TEXT, tail], { fileKind: 'yaml' })
  })

  it('the keys of a flow mapping stay readable', () => {
    const code = `{"kind":"Secret","data":{"db":"${VALUE}","note":"${TEXT}"}}\n`
    expect(scanSecrets(code).code).toBe(
      '{"kind":"Secret","data":{"db":"__REDACTED_CREDENTIAL_1__","note":"__REDACTED_CREDENTIAL_2__"}}\n'
    )
  })

  it('a key that starts in a Secret value and runs past it is redacted to its end', () => {
    const body = lines(3)
    const code = manifest(
      'Secret',
      `stringData:\n  id_ledger: ${BEGIN}\n${body.join('\n')}\n${END}\n`
    )
    gone(code, body, { fileKind: 'yaml' })
  })

  it('a Secret value is redacted whole, whatever else is found inside it', () => {
    const key = ['gh', 'p_', made(60, 36)].join('')
    const [before, after] = [made(61, 14), made(62, 14)]
    const code = manifest('Secret', `stringData:\n  note: ${before} ${key} ${after}\n`)
    const { anonymized } = gone(code, [before, key, after], { fileKind: 'yaml' })
    expect(anonymized).toMatch(/note: __REDACTED_CREDENTIAL_1__\n$/)
  })

  it.each([['-'], ['+'], ['> '], ['# '], ['// '], ['    + ']])(
    'key lines behind the prefix %j of their BEGIN line',
    (prefix) => {
      const body = [...lines(3), made(9, 12)]
      const code = `${prefix}${BEGIN}\n${body.map((l) => prefix + l).join('\n')}\n${prefix.trimEnd()}\nnext line\n`
      const { anonymized } = gone(code, body)
      expect(anonymized).toContain(`${prefix}__REDACTED_PRIVATE_KEY_1__\n`)
      expect(anonymized).toMatch(/\nnext line\n$/)
    }
  )

  it('a complete block behind a prefix is redacted as it always was', () => {
    const body = lines(3)
    const code = `> ${BEGIN}\n${body.map((l) => '> ' + l).join('\n')}\n> ${END}\n> done\n`
    expect(scanSecrets(code).code).toBe('> __REDACTED_PRIVATE_KEY_1__\n> done\n')
  })

  // A key of a mapping stands at the start of its line, or after `{` or `,`.
  it.each([
    [
      'python',
      'SPEC = {"kind": "Secret"}\n\ndef handle(data):\n    if data:\n        ledgerTotal = computeTotal(data)\n        return ledgerTotal\n',
    ],
    [
      'typescript',
      'const spec = { kind: "Secret" }\nstream.on("data", (data: Buffer) => {\n  ledgerTotal += data.length\n})\nfunction read(data: Buffer, stringData: string) {\n  return ledgerTotal\n}\n',
    ],
  ] as const)('the word data elsewhere in %s code opens nothing', (language, code) => {
    // Also where the text is read as a document (a script kept in a YAML file).
    for (const options of [{ language }, { language, fileKind: 'yaml' }] as const) {
      const { anonymized, map } = anonymize(code, options)
      expect(anonymized).not.toContain('__REDACTED_')
      expect(restore(anonymized, map).restored).toBe(code)
    }
  })

  it('a short Secret value is not redacted where the same letters stand elsewhere', () => {
    const code =
      'kind: Secret\nstringData:\n  enabled: "true"\n  port: "5432"\n---\nkind: ConfigMap\ndata:\n  verbose: "true"\n  dbPort: "5432"\n  note: untrue story 15432\n'
    const { anonymized } = anonymize(code, { fileKind: 'yaml' })
    expect(anonymized.match(/__REDACTED_/g)).toHaveLength(2)
    expect(anonymized).toContain('verbose: "true"')
    expect(anonymized).toContain(': "5432"')
  })

  it('a long Secret value is redacted wherever it stands again', () => {
    const code = manifest('Secret', `data:\n  db: ${VALUE}\n`) + `---\nnote: copy of ${VALUE}\n`
    gone(code, [VALUE], { fileKind: 'yaml' })
  })

  // The reader is for YAML and JSON documents. Code that names the kind is
  // code: its names are masked and come back.
  const API =
    "type Kind = { kind: 'Secret' | 'ConfigMap' }\nfunction loadUsers(username: string, pageSize: number) {\n  return post(url, {\n    data: { username, pageSize, retries: maxRetries },\n  })\n}\nconst maxRetries = 3\nlog(username, maxRetries)\n"
  const OBJECT = "const item = {\n  kind: 'Secret',\n  data: {\n    db: ledgerName,\n  },\n}\n"
  it.each([
    ['a type and an object named data', API, { path: 'src/api.ts' }, ['loadUsers', 'maxRetries']],
    ['the same, its language stated', API, { language: 'typescript' }, ['loadUsers', 'maxRetries']],
    ['the same, pasted', API, {}, ['loadUsers', 'maxRetries']],
    ['an object that names the kind', OBJECT, { language: 'typescript' }, ['ledgerName']],
    ['the same, pasted', OBJECT, {}, ['ledgerName']],
  ] as const)('code is no manifest: %s', (_, code, options, names) => {
    const { anonymized, map } = anonymize(code, options)
    for (const name of names) {
      expect(anonymized).not.toContain(name)
      expect(Object.values(map)).toContain(name)
    }
    // (The quoted word beside 'Secret' is redacted by an older rule, as before.)
    expect(restore(anonymized, map).restored).toBe(
      code.replace("'ConfigMap'", "'__REDACTED_CREDENTIAL_1__'")
    )
    expect(scanSecrets(code, 'redact', 'path' in options ? options : {}).findings).toEqual([])
  })

  // With no path, no kind and no language nothing says the text is a
  // document, unless it is JSON as a whole, which no code is, or it reads as
  // a Secret from the first column: an unquoted `kind:` that names Secret
  // and an unquoted `data:` or `stringData:`, both unindented, in one
  // document. Only those unindented keys are read then.
  const PASTED = `data:\n  db: ${VALUE}\n  note: ${TEXT}\ntype: Opaque\n`
  it.each([
    ['data', manifest('Secret', PASTED)],
    [
      'stringData and a block scalar',
      manifest('Secret', `stringData:\n  db: ${VALUE}\n  pem: |\n    ${TEXT}\n    ${TEXT}\n`),
    ],
    ['the kind quoted', manifest('"Secret"', PASTED)],
    ['the kind behind a tag', manifest('!!str Secret', PASTED)],
    ['the kind behind an anchor', manifest('&k Secret', PASTED)],
    ['the kind on the next line', manifest('\n  Secret', PASTED)],
    ['lines that end in CR and LF', manifest('Secret', PASTED).replace(/\n/g, '\r\n')],
    [
      'the second of two documents',
      `kind: ConfigMap\ndata:\n  level: verbose\n---\n${manifest('Secret', PASTED)}`,
    ],
    ['spaces after the kind', manifest('Secret  ', PASTED)],
    ['a comment after the kind', manifest('Secret # the ledger', PASTED)],
    ['a comment after the quoted kind', manifest('"Secret" # the ledger', PASTED)],
    [
      'a comment after data that ends in a comma',
      manifest('Secret', PASTED.replace('data:', 'data: # db, note,')),
    ],
  ] as const)('a pasted Secret is read: %s', (_, code) => {
    for (const options of [{}, { language: 'auto' }] as const) {
      const { anonymized } = gone(code, [VALUE, TEXT], options)
      expect(anonymized.match(/__REDACTED_/g)).toHaveLength(2)
    }
    expect(scanSecrets(code).findings).toHaveLength(2)
    expect(
      detectCredentials(code).filter((f) => f.label === 'Value of a Kubernetes Secret')
    ).toHaveLength(2)
  })

  const NESTED = `  data:\n    db: ${VALUE}\n`
  // Keyword arguments written from the first column: code, not a manifest.
  const KEYWORDS =
    'def make\n  create_thing(\nkind: Secret,\nname: userName,\ndata: payloadValue,\nretries: maxRetries\n  )\nend\n'
  it.each([
    ['a language is stated', manifest('Secret', PASTED), { language: 'python' }],
    ['another kind that starts the same', manifest('SecretStore', PASTED), {}],
    ['the kind is indented, in a List', `kind: List\nitems:\n  - kind: Secret\n  ${NESTED}`, {}],
    ['the kind key is quoted', `"kind": Secret\n${PASTED}`, {}],
    ['only an indented kind names Secret', `metadata:\n  kind: Secret\n${PASTED}`, {}],
    ['data is indented only', `kind: Secret\nspec:\n${NESTED}`, {}],
    ['data is quoted', `kind: Secret\n"data":\n  db: ${VALUE}\n`, {}],
    ['the kind and data stand in two documents', `kind: Secret\n---\n${PASTED}`, {}],
    ['the kind line goes on after the word', `kind: Secret, name: ledger\n${PASTED}`, {}],
    ['more stands after the kind', `kind: Secret/v1\n${PASTED}`, {}],
    ['the kind line ends in a comma', KEYWORDS, {}],
    [
      'the data line holds a value that ends in a comma',
      'kind: Secret\ndata: payloadValue,\nretries: maxRetries\n',
      {},
    ],
    [
      'the data line holds braces that end in a comma',
      'kind: Secret\nstringData: { db: payloadValue },\nretries: maxRetries\n',
      {},
    ],
  ] as const)('pasted text is no Secret when %s', (_, code, options) => {
    const { anonymized, map } = anonymize(code, options)
    expect(anonymized).not.toContain('__REDACTED_')
    expect(restore(anonymized, map).restored).toBe(code)
    expect(scanSecrets(code, 'redact', options).findings).toEqual([])
  })

  // To the byte what it gave before a pasted manifest was read.
  it('keyword arguments that name the kind are unchanged', () => {
    const { anonymized, map } = anonymize(KEYWORDS)
    expect(anonymized).toBe(
      'def make\n  __FN__1(\nkind: Secret,\nname: __VAR__3,\ndata: __VAR__1,\nretries: __VAR__2\n  )\nend\n'
    )
    expect(map).toEqual({
      __FN__1: 'create_thing',
      __VAR__1: 'payloadValue',
      __VAR__2: 'maxRetries',
      __VAR__3: 'userName',
    })
  })

  // Code that carries a manifest in a literal: the manifest's own values are
  // a Secret's, and the object named `data` below it stays code.
  it('a manifest in a pasted literal opens no indented data key', () => {
    const code =
      'const doc = `\nkind: Secret\ndata:\n  db: ' +
      VALUE +
      '\n`\nfunction send(ledgerUser: string) {\n  return post(url, {\n    data: { ledgerUser, retries: maxRetries },\n  })\n}\n'
    const { anonymized, map } = gone(code, [VALUE])
    expect(anonymized.match(/__REDACTED_/g)).toHaveLength(1)
    expect(Object.values(map)).toEqual(expect.arrayContaining(['ledgerUser', 'maxRetries']))
  })

  // The text of the first rows above, to the byte: what it gave before a
  // pasted manifest was read, with its path and without one.
  it.each([[{ path: 'api.ts' }], [{}]] as const)(
    'code that names the kind is unchanged (%j)',
    (options) => {
      const { anonymized, map } = anonymize(API, options)
      expect(anonymized).toBe(
        "type Kind = { kind: '__STR__1' | '__REDACTED_CREDENTIAL_1__' }\nfunction __FN__1(__VAR__2: string, __VAR__3: number) {\n  return post(url, {\n    data: { __VAR__2, __VAR__3, retries: __VAR__1 },\n  })\n}\nconst __VAR__1 = 3\nlog(__VAR__2, __VAR__1)\n"
      )
      expect(map).toEqual({
        __VAR__1: 'maxRetries',
        __FN__1: 'loadUsers',
        __VAR__2: 'username',
        __VAR__3: 'pageSize',
        __STR__1: 'Secret',
      })
    }
  )

  it.each([[{}], [{ path: 'deploy/secret.json' }], [{ fileKind: 'yaml' }]] as const)(
    'a JSON Secret is read with %j',
    (options) => {
      const code = `{\n  "kind": "Secret",\n  "data": {\n    "db": "${VALUE}",\n    "note": "${TEXT}"\n  }\n}\n`
      const { anonymized } = gone(code, [VALUE, TEXT], options)
      expect(anonymized).toContain('"db": "__REDACTED_CREDENTIAL_1__"')
      expect(anonymized).toContain('": "__REDACTED_CREDENTIAL_2__"')
    }
  )

  it('a JSON path makes a document of JSON with a comment in it', () => {
    const code = `// staging\n{"kind": "Secret", "data": {"db": "${VALUE}"}}\n`
    gone(code, [VALUE], { path: 'deploy/secret.json' })
  })

  // A byte-order mark before the first key is not part of the key: the
  // manifest is read as without it, and the mark stays where it was.
  const BOM = '﻿'
  it.each([
    ['pasted, kind first', `kind: Secret\ndata:\n  db: ${VALUE}\n`, {}],
    ['pasted, data first', `data:\n  db: ${VALUE}\nkind: Secret\n`, {}],
    ['pasted, data first, one space deep', `data:\n db: ${VALUE}\nkind: Secret\n`, {}],
    ['a YAML path, kind first', `kind: Secret\ndata:\n  db: ${VALUE}\n`, { path: 'a.yaml' }],
    ['a YAML path, data first', `data:\n db: ${VALUE}\nkind: Secret\n`, { path: 'a.yaml' }],
    ['JSON, pasted', `{"kind": "Secret", "data": {"db": "${VALUE}"}}`, {}],
    ['JSON, by its path', `{"kind": "Secret", "data": {"db": "${VALUE}"}}`, { path: 'a.json' }],
  ] as const)('a Secret after a byte-order mark is read: %s', (_, code, options) => {
    const { anonymized } = gone(BOM + code, [VALUE], options)
    expect(anonymized.startsWith(BOM)).toBe(true)
    expect(anonymized).toMatch(/db"?: "?__REDACTED_CREDENTIAL_\d+__/)
    // The scan reads the same with the mark as without it.
    const plain = scanSecrets(code, 'redact', options)
    const marked = scanSecrets(BOM + code, 'redact', options)
    expect(marked.code).toBe(BOM + plain.code)
    expect(marked.findings.map((f) => f.label)).toEqual(plain.findings.map((f) => f.label))
    expect(plain.findings.map((f) => f.label)).toContain('Value of a Kubernetes Secret')
  })

  it.each([[{}], [{ path: 'a.yaml' }]] as const)(
    'text after a byte-order mark that is no Secret comes back whole (%j)',
    (options) => {
      const code = `${BOM}kind: ConfigMap\ndata:\n  db: ledgerName\n`
      const { anonymized, map } = anonymize(code, options)
      expect(anonymized.startsWith(BOM)).toBe(true)
      expect(anonymized).not.toContain('__REDACTED_')
      expect(restore(anonymized, map).restored).toBe(code)
    }
  )

  it.each([
    [
      'a compose file with a comment that says Secret',
      '# deploys the Secret\nservices:\n  web:\n    environment:\n      data:\n        region: eu-central-1\n        replicas: 3\n',
    ],
    [
      'a ConfigMap whose annotation says Secret',
      'kind: ConfigMap\nmetadata:\n  annotations:\n    note: replaces the old Secret\ndata:\n  LOG_LEVEL: debug\n  FEATURE_FLAGS: billing,reports\n',
    ],
  ])('no manifest: %s', (_, code) => {
    const { anonymized, map } = anonymize(code, { path: 'deploy/app.yaml' })
    expect(anonymized).not.toContain('__REDACTED_')
    expect(restore(anonymized, map).restored).toBe(code)
  })
})

// Spec 094: a provider key written as adjacent string literals on one
// statement is read as the one string it becomes.
describe('a provider key joined from adjacent literals', () => {
  const BODY = ['a1B2c3D4e5', 'F6g7H8i9J0', 'k1L2m3N4o5', 'P6q7R8'].join('')
  // Each key is put together here, piece by piece.
  const KEYS: [string, string[]][] = [
    ['GitHub', ['gh', 'p_', BODY]],
    ['Stripe', ['sk_', 'live_', BODY.slice(0, 24)]],
    ['Slack', ['xo', 'xb-', '120045007890-', BODY.slice(0, 24)]],
  ]
  const cut = (parts: string[], count: number): string[] => {
    const text = parts.join('')
    const size = Math.floor(text.length / count)
    return Array.from({ length: count }, (_, i) =>
      text.slice(i * size, i === count - 1 ? text.length : (i + 1) * size)
    )
  }
  const written = (parts: string[], by: string, quote = '"'): string =>
    parts.map((p) => quote + p + quote).join(by)
  const gone = (code: string, key: string, language: 'typescript' | 'python' | 'c') => {
    const result = anonymize(code, { language })
    const seen = result.anonymized + '\n' + Object.values(result.map).join('\n')
    // The provider's prefix alone (`gh`, `sk_`) tells nothing; the rest must be gone.
    for (let i = 8; i + 8 <= key.length; i += 2)
      expect(seen.includes(key.slice(i, i + 8)), key.slice(i, i + 8)).toBe(false)
    expect(result.anonymized).toContain('__REDACTED_')
    return result
  }

  for (const [provider, parts] of KEYS)
    for (const count of [2, 3, 8])
      it(`a ${provider} key in ${count} literals joined by +`, () => {
        gone(`const t = ${written(cut(parts, count), ' + ')};\n`, parts.join(''), 'typescript')
      })

  it('joined by + across lines, in single quotes', () => {
    const [, parts] = KEYS[0]!
    gone(`const t =\n  ${written(parts, ' +\n  ', "'")}\n`, parts.join(''), 'typescript')
  })

  it.each(KEYS)('a %s key as adjacent literals in Python', (_, parts) => {
    gone(`token = (${written(cut(parts, 3), ' ')})\n`, parts.join(''), 'python')
  })

  it.each(KEYS)('a %s key as adjacent literals in C', (_, parts) => {
    gone(`const char *t = ${written(cut(parts, 3), '\n    ')};\n`, parts.join(''), 'c')
  })

  it('leaves the text around the key in its literals', () => {
    const [, parts] = KEYS[0]!
    const code = `const t = "token " + ${written(parts, ' + ')} + " end";\n`
    expect(gone(code, parts.join(''), 'typescript').anonymized).toMatch(/^const t = "\S+ " \+ "/)
  })

  it('adjacent literals that join to no key are masked as before', () => {
    const code = 'const t = "invoice " + "ledger" + " total";\n'
    const { anonymized, map } = anonymize(code, { language: 'typescript' })
    expect(anonymized).not.toContain('__REDACTED_')
    expect(restore(anonymized, map).restored).toBe(code)
  })

  // The stated limit: no text transform can follow a value through variables.
  it('pieces held in variables are not joined', () => {
    const [, parts] = KEYS[0]!
    const code = `const a = "${parts[0]}";\nconst b = "${parts[1]}";\nconst c = a + b + rest;\n`
    expect(anonymize(code, { language: 'typescript' }).anonymized).not.toContain('__REDACTED_')
  })

  it('a piece that is redacted does not redact the same letters elsewhere', () => {
    const [, parts] = KEYS[1]!
    const code = `const t = ${written(parts, ' + ')};\nconst is_live_mode = true;\n`
    const { anonymized } = gone(code, parts.join(''), 'typescript')
    expect(anonymized.match(/__REDACTED_/g)).toHaveLength(3)
  })
})
