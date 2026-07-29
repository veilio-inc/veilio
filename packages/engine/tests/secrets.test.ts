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
    code: 'const owner = "igor.dlugosh@acme.com"',
    secret: 'igor.dlugosh@acme.com',
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
    'const owner = "igor.dlugosh@acme.com"',
  ].join('\n')

  it('redacts critical findings by default', () => {
    const scan = scanSecrets(code)
    expect(scan.code).toContain('__REDACTED_STRIPE_KEY_1__')
    expect(scan.code).not.toContain('sk_live_51H8xQ2ABCDEFGHIJKLMNOP')
  })

  it('leaves medium findings in place but still reports them', () => {
    const scan = scanSecrets(code)
    expect(scan.code).toContain('igor.dlugosh@acme.com')
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

  it('ignores a low-entropy value in a credential-shaped assignment', () => {
    // Not a repeated single character, so it clears the dummy check — the
    // entropy floor is what rejects it. Real tokens are near-uniform over
    // their alphabet; flagging patterned filler trains users to dismiss the
    // panel that matters.
    expect(detectSecrets('password: "abababababab"')).toEqual([])
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

  it('keeps findings sorted by position', () => {
    const scan = scanSecrets(
      'a = "AKIAIOSFODNN7EXAMPLE"\nb = "x@y.com"\nc = "sk_live_51H8xQ2ABCDEFGHIJKLMNOP"'
    )
    const lines = scan.findings.map((f) => f.line)
    expect(lines).toEqual([...lines].sort((x, y) => x - y))
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
  it('counts findings by severity', () => {
    const findings = detectSecrets(
      'a = "AKIAIOSFODNN7EXAMPLE"\nb = "x@y.com"\nc = "10.0.3.14"'
    )
    const summary = summarizeSecrets(findings)
    expect(summary.critical).toBe(1)
    expect(summary.medium).toBe(2)
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
  { type: 'sendgrid-key', code: 'const k = "SG.abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuvwxyz0123456789ABC"' },
  { type: 'twilio-key', code: 'const sid = "AC0123456789abcdef0123456789abcdef"' },
  { type: 'mailgun-key', code: 'const k = "key-0123456789abcdef0123456789abcdef"' },
  { type: 'hugging-face-token', code: 'const t = "hf_abcdefghijklmnopqrstuvwxyz01234567"' },
  { type: 'supabase-key', code: 'const k = "sbp_0123456789abcdef0123456789abcdef01234567"' },
  { type: 'shopify-token', code: 'const t = "shpat_0123456789abcdef0123456789abcdef"' },
  { type: 'square-token', code: 'const t = "sq0atp-abcdefghijklmnopqrstuv"' },
  { type: 'pypi-token', code: 'const t = "pypi-AgEIcHlwaS5vcmc' + 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP' + '"' },
  { type: 'discord-token', code: 'const t = "MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.abcdefghijklmnopqrstuvwxyz01234"' },
  { type: 'azure-key', code: 'AccountKey=' + 'a'.repeat(43) + 'bC9/' + 'd'.repeat(39) + '==' },
  { type: 'datadog-key', code: 'dd_api_key = "0123456789abcdef0123456789abcdef"' },
  { type: 'cloudflare-token', code: 'cloudflare_api_token = "abcdefghij1234567890ABCDEFGHIJ1234567890"' },
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
