import { describe, it, expect } from 'vitest'
import { SECRET_DISPOSITIONS, detectSecrets, scanSecrets } from '../src/secrets.js'

/**
 * A redaction token is not a credential (guard follow-up d03a).
 *
 * The guard redacts a result, then scans it once more and withholds it if a
 * credential is left. The second scan read the redaction token itself as a
 * hardcoded credential (`'api-key': '__REDACTED_CREDENTIAL_1__'`), so every
 * result from a file of sample credentials was withheld, although nothing
 * real was left in it. Redaction must be idempotent, and anything beside a
 * token - a residue of a longer secret, a symbol-map placeholder that may
 * stand for part of a credential - is judged as before.
 */

/** The findings that make the guard withhold a result. */
function blocking(text: string): string[] {
  return detectSecrets(text)
    .filter((f) => SECRET_DISPOSITIONS[f.type] !== 'report')
    .map((f) => f.type)
}

describe('a value that is only redaction tokens is not a credential', () => {
  it('a redaction token assigned to a key-like name', () => {
    expect(blocking(`const kinds = { 'google-api-key': '__REDACTED_CREDENTIAL_1__' }`)).toEqual([])
  })

  it('a redaction token assigned to a password', () => {
    expect(blocking(`password = "__REDACTED_DB_PASSWORD_12__"`)).toEqual([])
  })

  it('the token the guard writes for a regulated number', () => {
    expect(blocking(`secret: '__REDACTED_PAYMENT_CARD__'`)).toEqual([])
  })

  it('two redaction tokens in one value', () => {
    expect(blocking(`api_key = '__REDACTED_CREDENTIAL_1____REDACTED_SECRET_2__'`)).toEqual([])
  })

  it('a redaction token in a high-entropy assignment', () => {
    expect(blocking(`auth_token: "__REDACTED_SECRET_3__"`)).toEqual([])
  })

  it('a redaction token as a connection string password', () => {
    expect(blocking(`const url = "postgres://admin:__REDACTED_DB_PASSWORD_1__@db:5432/x"`)).toEqual(
      []
    )
  })
})

describe('redaction is idempotent', () => {
  const sample = [
    `password = "Tr0ub4dor3xzQ"`,
    `const client_secret = "Xq7#mK92pLzR4vBn"`,
    `const url = "postgres://admin:Tr0ub4dor3xz@db.internal:5432/prod"`,
    `auth_token: "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1v"`,
  ].join('\n')

  it('the first scan redacts every credential', () => {
    const once = scanSecrets(sample, 'redact')
    expect(once.findings.filter((f) => f.redacted)).toHaveLength(4)
  })

  it('scanning the redacted text again finds nothing and changes nothing', () => {
    const once = scanSecrets(sample, 'redact').code
    expect(blocking(once)).toEqual([])
    expect(scanSecrets(once, 'redact').code).toBe(once)
  })
})

describe('anything beside a token is still judged', () => {
  it('a real password with no token', () => {
    expect(blocking(`password = "Tr0ub4dor3xzQ"`)).toEqual(['password-assignment'])
  })

  it('a real password on the same line as a token', () => {
    expect(
      blocking(`login('__REDACTED_CREDENTIAL_1__'); const password = "Tr0ub4dor3xzQ"`)
    ).toEqual(['password-assignment'])
  })

  it('a value that only starts like a redaction token', () => {
    expect(blocking(`password = "__REDACTED_x9kQ7mZ2pL"`)).toEqual(['password-assignment'])
  })

  it('a made-up kind that is not one of the redaction tokens', () => {
    expect(blocking(`password = "__REDACTED_HUNTER2XYZ_1__"`)).toEqual(['password-assignment'])
  })

  it('a short residue of a longer secret after a token', () => {
    // A rule took most of a longer secret: what is left is real key material.
    expect(blocking(`aws_secret_access_key = "__REDACTED_AWS_SECRET_1__Zx9Q7"`)).not.toEqual([])
  })

  it('a one-character residue after a token', () => {
    expect(blocking(`aws_secret_access_key = "__REDACTED_AWS_SECRET_1__3"`)).not.toEqual([])
  })

  it('a token with a long real secret after it', () => {
    expect(blocking(`password = "__REDACTED_CREDENTIAL_1__Tr0ub4dor3xzQ"`)).toEqual([
      'password-assignment',
    ])
  })

  it('a symbol-map placeholder may stand for part of a credential', () => {
    // `Acme!9xQz` with the project name `Acme` already replaced (review of 9d3f6d0).
    expect(blocking(`DB_PASSWORD = "__CLS__1!9xQz"`)).toEqual(['password-assignment'])
  })

  it('a symbol-map placeholder followed by digits', () => {
    expect(blocking(`password = "__MANUAL__1839201"`)).not.toEqual([])
  })

  it('a real password after a token in a connection string', () => {
    expect(
      blocking(`const url = "postgres://admin:__REDACTED_DB_PASSWORD_1__pw9@db:5432/x"`)
    ).toEqual(['connection-string'])
  })
})
