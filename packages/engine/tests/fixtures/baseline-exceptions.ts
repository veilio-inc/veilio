// The rows of baseline-corpus.ts whose answer may differ from the published
// 1.19.2 (baseline-1.19.2.json), one entry per row and option set, each with
// the fix that changes it. Written row by row, never as a pattern: a
// difference nobody listed must fail the test.
import type { AnonymizeOptions } from '../../src/types.js'

export const REASONS = [
  'provider-format',
  'credential-context',
  'credential-name-language',
  'multi-line-credential',
  'login-command',
] as const

export interface BaselineException {
  row: string
  options: AnonymizeOptions
  reason: (typeof REASONS)[number]
  why: string
}

export const EXCEPTIONS: BaselineException[] = [
  {
    row: 'format: GitHub fine-grained token, assigned',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: GitHub fine-grained token, assigned',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: GitHub fine-grained token, an argument',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: GitHub fine-grained token, an argument',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: GitHub fine-grained token, a shell word',
    options: { fileKind: 'shell' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: DigitalOcean token, assigned',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: DigitalOcean token, assigned',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: DigitalOcean token, an argument',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: DigitalOcean token, an argument',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: DigitalOcean token, a shell word',
    options: { fileKind: 'shell' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: DigitalOcean OAuth token, assigned',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: DigitalOcean OAuth token, assigned',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: DigitalOcean OAuth token, an argument',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: DigitalOcean OAuth token, an argument',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: DigitalOcean OAuth token, a shell word',
    options: { fileKind: 'shell' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Twilio API key, assigned',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Twilio API key, assigned',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Twilio API key, an argument',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Twilio API key, an argument',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Twilio API key, a shell word',
    options: { fileKind: 'shell' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Stripe webhook secret, assigned',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Stripe webhook secret, assigned',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Stripe webhook secret, an argument',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Stripe webhook secret, an argument',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Stripe webhook secret, a shell word',
    options: { fileKind: 'shell' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Google OAuth access token, assigned',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Google OAuth access token, assigned',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Google OAuth access token, an argument',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Google OAuth access token, an argument',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Google OAuth access token, a shell word',
    options: { fileKind: 'shell' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Sentry personal token, assigned',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Sentry personal token, assigned',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Sentry personal token, an argument',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Sentry personal token, an argument',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Sentry personal token, a shell word',
    options: { fileKind: 'shell' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Sentry organisation token, assigned',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Sentry organisation token, assigned',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Sentry organisation token, an argument',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Sentry organisation token, an argument',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Sentry organisation token, a shell word',
    options: { fileKind: 'shell' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Linear API key, assigned',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Linear API key, assigned',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Linear API key, an argument',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Linear API key, an argument',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Linear API key, a shell word',
    options: { fileKind: 'shell' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Vault token, assigned',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Vault token, assigned',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Vault token, an argument',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Vault token, an argument',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Vault token, a shell word',
    options: { fileKind: 'shell' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: age secret key, assigned',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: age secret key, assigned',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: age secret key, an argument',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: age secret key, an argument',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: age secret key, a shell word',
    options: { fileKind: 'shell' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Heroku token, assigned',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Heroku token, assigned',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Heroku token, an argument',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Heroku token, an argument',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Heroku token, a shell word',
    options: { fileKind: 'shell' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Slack app-level token, assigned',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Slack app-level token, assigned',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Slack app-level token, an argument',
    options: { language: 'typescript' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Slack app-level token, an argument',
    options: {},
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
  {
    row: 'format: Slack app-level token, a shell word',
    options: { fileKind: 'shell' },
    reason: 'provider-format',
    why: "a key in a provider's documented format is redacted wherever it stands",
  },
]

/** Tracked files of this repository that hold more redaction tokens than the
 *  published 1.19.2 left in them (baseline-1.19.2.repo.json), by path: how
 *  many more, and the fix that adds them. */
export const REPOSITORY_EXCEPTIONS: Record<
  string,
  { more: number; reason: (typeof REASONS)[number] }
> = {}
