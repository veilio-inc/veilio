import { describe, it, expect } from 'vitest'
import { SECRET_DISPOSITIONS, detectSecrets, scanSecrets } from '../src/secrets.js'

/**
 * Veilio's own tokens are not credentials (guard follow-up d03a).
 *
 * The guard redacts a result, then scans it once more and withholds it if a
 * credential is left. The second scan read the redaction token itself as a
 * hardcoded credential (`'api-key': '__REDACTED_CREDENTIAL_1__'`), so every
 * result from a file of sample credentials was withheld, although nothing
 * real was left in it. Redaction must be idempotent, and a real credential
 * must still be found wherever it sits next to a token.
 */

/** The findings that make the guard withhold a result. */
function blocking(text: string): string[] {
  return detectSecrets(text)
    .filter((f) => SECRET_DISPOSITIONS[f.type] !== 'report')
    .map((f) => f.type)
}

describe('a value made only of Veilio tokens is not a credential', () => {
  it('a redaction token assigned to a key-like name', () => {
    expect(blocking(`const kinds = { 'google-api-key': '__REDACTED_CREDENTIAL_1__' }`)).toEqual([])
  })

  it('a redaction token assigned to a password', () => {
    expect(blocking(`password = "__REDACTED_DB_PASSWORD_12__"`)).toEqual([])
  })

  it('a regulated-number token the guard writes, with no number', () => {
    expect(blocking(`secret: '__REDACTED_PAYMENT_CARD__'`)).toEqual([])
  })

  it('a map placeholder assigned to a password', () => {
    expect(blocking(`const client_secret = "__VAR__1290"`)).toEqual([])
  })

  it('two tokens in one value', () => {
    expect(blocking(`api_key = '__STR__4__REDACTED_CREDENTIAL_2__'`)).toEqual([])
  })

  it('a token in a high-entropy assignment', () => {
    expect(blocking(`auth_token: "__REDACTED_SECRET_3__"`)).toEqual([])
  })

  it('a token followed by a residue too short to be a credential', () => {
    // A rule took 40 of a fixture's 41 characters: one is left after the token.
    expect(blocking(`aws_secret_access_key = "__REDACTED_AWS_SECRET_1__3"`)).toEqual([])
  })

  it('a token as a connection string password', () => {
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

  it('scanning the redacted text again finds nothing', () => {
    const once = scanSecrets(sample, 'redact').code
    expect(blocking(once)).toEqual([])
    expect(scanSecrets(once, 'redact').code).toBe(once)
  })
})

describe('a real credential beside a token is still caught', () => {
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

  it('a made-up kind that is not one of Veilio tokens', () => {
    expect(blocking(`password = "__REDACTED_HUNTER2XYZ_1__"`)).toEqual(['password-assignment'])
  })

  it('a token with a long real secret after it', () => {
    expect(blocking(`password = "__VAR__3Tr0ub4dor3xzQ"`)).toEqual(['password-assignment'])
  })

  it('a token inside a long real secret', () => {
    expect(blocking(`api_key = "Tr0ub4__VAR__7dor3xzQ"`)).toEqual(['password-assignment'])
  })

  it('a token with a short real password after it, in a connection string', () => {
    // The structural rules have no minimum worth trusting: anything left is a password.
    expect(blocking(`const url = "postgres://admin:__VAR__2pw9@db:5432/x"`)).toEqual([
      'connection-string',
    ])
  })

  it('a high-entropy value with a token and enough key material after it', () => {
    // Both assignment rules read it; whichever wins, it is still a credential.
    expect(blocking(`auth_token: "__VAR__1aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1v"`)).toHaveLength(1)
  })
})
