// Credential detection and irreversible redaction.
//
// Identifier masking protects a domain model. It does nothing for the leak that
// actually costs money: a live key pasted into a model's context window. Worse,
// a credential that happens to be identifier-shaped was previously masked
// *reversibly* — stored as a value in a SymbolMap that Cloud then syncs. That
// is strictly worse than not masking it, because it persists the secret.
//
// So credentials are handled before identifier masking, and their replacement
// is one-way: the token is never written to the map, so restore() cannot bring
// the secret back. A developer who sees __REDACTED_AWS_KEY_1__ in their restored
// code has been told, unmistakably, that a live key was in the payload.

export type SecretSeverity = 'critical' | 'high' | 'medium'

export type SecretType =
  | 'aws-access-key'
  | 'aws-secret-key'
  | 'private-key'
  | 'stripe-key'
  | 'github-token'
  | 'gitlab-token'
  | 'slack-token'
  | 'slack-webhook'
  | 'discord-token'
  | 'openai-key'
  | 'anthropic-key'
  | 'google-api-key'
  | 'gcp-service-account'
  | 'azure-key'
  | 'npm-token'
  | 'pypi-token'
  | 'sendgrid-key'
  | 'twilio-key'
  | 'mailgun-key'
  | 'datadog-key'
  | 'hugging-face-token'
  | 'supabase-key'
  | 'square-token'
  | 'shopify-token'
  | 'cloudflare-token'
  | 'jwt'
  | 'bearer-token'
  | 'basic-auth'
  | 'connection-string'
  | 'password-assignment'
  | 'high-entropy-string'
  | 'email'
  | 'private-ip'

export interface SecretFinding {
  type: SecretType
  severity: SecretSeverity
  /** Human-readable label for UI. */
  label: string
  /** 1-based line number of the match. */
  line: number
  /** 1-based column of the match within its line. */
  column: number
  /** Character length of the matched secret. */
  length: number
  /** Truncated `abcd…wxyz` form. Never the full secret — findings are rendered
   *  in the UI and may end up in logs; a finding carrying the whole value would
   *  re-create the leak it exists to warn about. */
  preview: string
  /** Whether this finding was redacted under the active policy. */
  redacted: boolean
}

/** How `anonymize` treats detected credentials. */
export type SecretPolicy = 'redact' | 'warn' | 'off'

interface Pattern {
  type: SecretType
  severity: SecretSeverity
  label: string
  re: RegExp
  /** When set, only this capture group is redacted — used for connection
   *  strings and assignments, where blanking the whole match would destroy
   *  structure the model needs (the scheme, host, and variable name). */
  group?: number
}

// Patterns are written to be linear-time: no nested quantifiers over the same
// character class, and bounded repetition wherever the input is attacker-shaped.
const PATTERNS: Pattern[] = [
  {
    type: 'private-key',
    severity: 'critical',
    label: 'Private key block',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,8000}?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    type: 'aws-access-key',
    severity: 'critical',
    label: 'AWS access key ID',
    re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  },
  {
    type: 'aws-secret-key',
    severity: 'critical',
    label: 'AWS secret access key',
    re: /(?:aws_secret_access_key|aws_secret_key|awsSecretKey)["'\s:=]{1,10}([A-Za-z0-9/+=]{40})/gi,
    group: 1,
  },
  {
    type: 'stripe-key',
    severity: 'critical',
    label: 'Stripe secret key',
    re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,247}\b/g,
  },
  {
    type: 'github-token',
    severity: 'critical',
    label: 'GitHub token',
    re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  },
  {
    type: 'slack-token',
    severity: 'critical',
    label: 'Slack token',
    re: /\bxox[baprse]-[A-Za-z0-9-]{10,250}\b/g,
  },
  {
    type: 'anthropic-key',
    severity: 'critical',
    label: 'Anthropic API key',
    re: /\bsk-ant-[A-Za-z0-9_-]{20,250}\b/g,
  },
  {
    // `sk-ant-` is excluded so an Anthropic key is reported as one rather than
    // racing the OpenAI pattern for the identical span.
    type: 'openai-key',
    severity: 'critical',
    label: 'OpenAI API key',
    re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,250}\b/g,
  },
  {
    type: 'google-api-key',
    severity: 'critical',
    label: 'Google API key',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    type: 'npm-token',
    severity: 'critical',
    label: 'npm access token',
    re: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    type: 'gitlab-token',
    severity: 'critical',
    label: 'GitLab token',
    re: /\bglpat-[A-Za-z0-9_-]{20,50}\b/g,
  },
  {
    type: 'slack-webhook',
    severity: 'critical',
    label: 'Slack webhook URL',
    re: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_-]{6,20}\/B[A-Za-z0-9_-]{6,20}\/[A-Za-z0-9_-]{20,30}/g,
  },
  {
    type: 'discord-token',
    severity: 'critical',
    label: 'Discord bot token',
    re: /\b[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}\b/g,
  },
  {
    type: 'gcp-service-account',
    severity: 'critical',
    label: 'GCP service-account key',
    re: /"type"\s*:\s*"service_account"[\s\S]{0,400}?"private_key_id"\s*:\s*"([a-f0-9]{40})"/g,
    group: 1,
  },
  {
    type: 'azure-key',
    severity: 'critical',
    label: 'Azure storage key',
    re: /\bAccountKey\s*=\s*([A-Za-z0-9+/]{86}==)/g,
    group: 1,
  },
  {
    type: 'pypi-token',
    severity: 'critical',
    label: 'PyPI upload token',
    re: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}\b/g,
  },
  {
    type: 'sendgrid-key',
    severity: 'critical',
    label: 'SendGrid API key',
    re: /\bSG\.[A-Za-z0-9_-]{20,24}\.[A-Za-z0-9_-]{39,50}\b/g,
  },
  {
    type: 'twilio-key',
    severity: 'critical',
    label: 'Twilio account SID',
    re: /\bAC[a-f0-9]{32}\b/g,
  },
  {
    type: 'mailgun-key',
    severity: 'critical',
    label: 'Mailgun API key',
    re: /\bkey-[a-f0-9]{32}\b/g,
  },
  {
    type: 'datadog-key',
    severity: 'critical',
    label: 'Datadog API key',
    re: /(?:datadog|dd)[_-]?api[_-]?key["'\s:=]{1,10}([a-f0-9]{32})\b/gi,
    group: 1,
  },
  {
    type: 'hugging-face-token',
    severity: 'critical',
    label: 'Hugging Face token',
    re: /\bhf_[A-Za-z0-9]{34,40}\b/g,
  },
  {
    type: 'supabase-key',
    severity: 'critical',
    label: 'Supabase service key',
    re: /\bsbp_[a-f0-9]{40}\b/g,
  },
  {
    type: 'square-token',
    severity: 'critical',
    label: 'Square access token',
    re: /\b(?:sq0atp|sq0csp|EAAA)[A-Za-z0-9_-]{22,60}\b/g,
  },
  {
    type: 'shopify-token',
    severity: 'critical',
    label: 'Shopify access token',
    re: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g,
  },
  {
    type: 'cloudflare-token',
    severity: 'critical',
    label: 'Cloudflare API token',
    re: /(?:cloudflare|cf)[_-]?api[_-]?(?:token|key)["'\s:=]{1,10}([A-Za-z0-9_-]{37,45})\b/gi,
    group: 1,
  },
  {
    type: 'basic-auth',
    severity: 'high',
    label: 'HTTP Basic credentials',
    re: /\bBasic\s+([A-Za-z0-9+/]{16,400}={0,2})/g,
    group: 1,
  },
  {
    type: 'jwt',
    severity: 'high',
    label: 'JSON Web Token',
    re: /\beyJ[A-Za-z0-9_-]{8,2000}\.eyJ[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{0,2000}/g,
  },
  {
    type: 'bearer-token',
    severity: 'high',
    label: 'Bearer / Authorization token',
    re: /(?:Authorization["'\s:=]{1,10})?\bBearer\s+([A-Za-z0-9._~+/-]{16,500}=*)/g,
    group: 1,
  },
  {
    type: 'connection-string',
    severity: 'high',
    label: 'Connection string password',
    re: /\b[a-z][a-z0-9+.-]{2,20}:\/\/[^\s:@/]{1,128}:([^\s:@/]{1,256})@/gi,
    group: 1,
  },
  {
    type: 'password-assignment',
    severity: 'high',
    label: 'Hardcoded credential',
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?token|encryption[_-]?key)\b["'\s]{0,6}[:=]{1,2}[>\s]{0,3}["'`]([^"'`\n]{6,256})["'`]/gi,
    group: 1,
  },
  {
    // Catch-all for providers with no dedicated pattern above. Restricted to
    // *assignment* context and gated on entropy, because a bare long token in
    // prose is far more often a hash, a UUID or a base64 blob than a live
    // credential — and a detector that cries wolf gets switched off.
    type: 'high-entropy-string',
    severity: 'high',
    label: 'High-entropy credential',
    re: /\b(?:[a-z0-9_]*(?:key|token|secret|credential|auth|pass)[a-z0-9_]*)\b["'\s:=]{1,10}["'`]([A-Za-z0-9+/_-]{24,200}={0,2})["'`]/gi,
    group: 1,
  },
  {
    type: 'private-ip',
    severity: 'medium',
    label: 'Private IP address',
    re: /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
  },
  {
    type: 'email',
    severity: 'medium',
    label: 'Email address',
    re: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}\b/g,
  },
]

/** Placeholder values that look like credentials but carry no secret. Redacting
 *  these is pure noise, and noisy warnings are the fastest way to teach a user
 *  to ignore the panel that matters. */
const KNOWN_DUMMY = new Set([
  'password',
  'changeme',
  'secret',
  'example',
  'placeholder',
  'your-api-key',
  'yourapikey',
  'xxxxxxxx',
  'redacted',
  'todo',
  'none',
  'null',
  'undefined',
  'test',
  'dummy',
  'sample',
  'foobar',
  'hunter2',
  '********',
  '<password>',
  'your_password_here',
  'my-secret',
  'supersecret',
  'notarealkey',
])

function isDummy(value: string): boolean {
  const trimmed = value.trim()
  if (KNOWN_DUMMY.has(trimmed.toLowerCase())) return true
  // Templating placeholders: ${VAR}, {{var}}, %s, $VAR, <VALUE>. Matched
  // case-insensitively against the ORIGINAL — lowercasing first would stop
  // `$DB_PASSWORD` matching an upper-case-only shell-variable pattern.
  if (/^\$\{[^}]*\}$|^\{\{[^}]*\}\}$|^%[sdv]$|^\$[a-z_][a-z0-9_]*$|^<[^>]*>$/i.test(trimmed)) {
    return true
  }
  // A run of one repeated character conveys nothing.
  if (/^(.)\1{3,}$/.test(trimmed)) return true
  return false
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0
  const counts = new Map<string, number>()
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / value.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

/** Below this, an assignment value is more likely a sentence or a path than a
 *  credential. Real tokens are near-uniform over their alphabet. */
const ENTROPY_FLOOR = 2.6

/** Show enough of the value to be recognisable, never enough to be usable. */
export function previewSecret(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  if (clean.length <= 12) return `${clean.slice(0, 2)}${'•'.repeat(Math.max(clean.length - 2, 1))}`
  return `${clean.slice(0, 4)}…${clean.slice(-4)} (${clean.length} chars)`
}

interface RawMatch {
  pattern: Pattern
  start: number
  end: number
  value: string
}

/** Byte offset → 1-based line/column, computed once per scan. */
function lineIndex(code: string): number[] {
  const starts = [0]
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '\n') starts.push(i + 1)
  }
  return starts
}

function positionOf(starts: number[], offset: number): { line: number; column: number } {
  // Binary search for the last line start at or before `offset`.
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 }
}

function collectMatches(code: string): RawMatch[] {
  const found: RawMatch[] = []
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pattern.re.exec(code)) !== null) {
      // Guarantee forward progress. No pattern above can match the empty string
      // — each has a mandatory literal or a {min≥1} quantifier — but a future
      // one that could would otherwise spin here forever, hanging the caller.
      if (pattern.re.lastIndex <= m.index) pattern.re.lastIndex = m.index + 1
      let start = m.index
      let value = m[0]
      if (pattern.group !== undefined) {
        const captured = m[pattern.group]
        if (captured === undefined) continue
        // Locate the group inside the match. Groups here are always the trailing
        // credential portion, so a lastIndexOf is exact.
        const offset = m[0].lastIndexOf(captured)
        if (offset < 0) continue
        start = m.index + offset
        value = captured
      }
      if (isDummy(value)) continue
      // Assignment-shaped findings need an entropy check: `password: "the user's
      // password"` in prose is not a credential, and flagging it trains the user
      // to dismiss the panel.
      if (
        (pattern.type === 'password-assignment' || pattern.type === 'high-entropy-string') &&
        shannonEntropy(value) < ENTROPY_FLOOR
      ) {
        continue
      }
      found.push({ pattern, start, end: start + value.length, value })
    }
    pattern.re.lastIndex = 0
  }
  return found
}

const SEVERITY_RANK: Record<SecretSeverity, number> = { critical: 3, high: 2, medium: 1 }

/** Drop matches contained in, or overlapping, a higher-priority match. A Stripe
 *  key inside a connection string should be reported once, as the Stripe key. */
function dropOverlaps(matches: RawMatch[]): RawMatch[] {
  const sorted = [...matches].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.pattern.severity] - SEVERITY_RANK[a.pattern.severity]
    if (bySeverity !== 0) return bySeverity
    const byLength = b.end - b.start - (a.end - a.start)
    if (byLength !== 0) return byLength
    return a.start - b.start
  })
  const kept: RawMatch[] = []
  for (const m of sorted) {
    const overlaps = kept.some((k) => m.start < k.end && k.start < m.end)
    if (!overlaps) kept.push(m)
  }
  return kept.sort((a, b) => a.start - b.start)
}

export interface SecretScan {
  findings: SecretFinding[]
  /** Input with redactable findings replaced. Identical to the input under the
   *  `warn` and `off` policies. */
  code: string
}

/** Severities redacted under the `redact` policy. `medium` is report-only:
 *  false positives on emails are common and the risk is materially lower, while
 *  a wrongly-blanked email would corrupt code for no safety gain. */
const REDACTED_SEVERITIES: ReadonlySet<SecretSeverity> = new Set<SecretSeverity>([
  'critical',
  'high',
])

const TYPE_TOKENS: Record<SecretType, string> = {
  'aws-access-key': 'AWS_KEY',
  'aws-secret-key': 'AWS_SECRET',
  'private-key': 'PRIVATE_KEY',

  'stripe-key': 'STRIPE_KEY',
  'github-token': 'GITHUB_TOKEN',
  'gitlab-token': 'GITLAB_TOKEN',
  'slack-token': 'SLACK_TOKEN',
  'slack-webhook': 'SLACK_WEBHOOK',
  'discord-token': 'DISCORD_TOKEN',
  'openai-key': 'OPENAI_KEY',
  'anthropic-key': 'ANTHROPIC_KEY',
  'google-api-key': 'GOOGLE_KEY',
  'gcp-service-account': 'GCP_SERVICE_ACCOUNT',
  'azure-key': 'AZURE_KEY',
  'npm-token': 'NPM_TOKEN',
  'pypi-token': 'PYPI_TOKEN',
  'sendgrid-key': 'SENDGRID_KEY',
  'twilio-key': 'TWILIO_SID',
  'mailgun-key': 'MAILGUN_KEY',
  'datadog-key': 'DATADOG_KEY',
  'hugging-face-token': 'HF_TOKEN',
  'supabase-key': 'SUPABASE_KEY',
  'square-token': 'SQUARE_TOKEN',
  'shopify-token': 'SHOPIFY_TOKEN',
  'cloudflare-token': 'CLOUDFLARE_TOKEN',
  jwt: 'JWT',
  'bearer-token': 'BEARER_TOKEN',
  'basic-auth': 'BASIC_AUTH',
  'connection-string': 'DB_PASSWORD',
  'password-assignment': 'CREDENTIAL',
  'high-entropy-string': 'SECRET',
  email: 'EMAIL',
  'private-ip': 'PRIVATE_IP',
}

/** Detect credentials in `code` without modifying it. */
export function detectSecrets(code: string): SecretFinding[] {
  return scanSecrets(code, 'warn').findings
}

/**
 * Detect credentials and, under the `redact` policy, replace critical/high
 * findings with `__REDACTED_<TYPE>_<n>__` tokens.
 *
 * The replacement is placeholder-shaped, so the engine's existing
 * PLACEHOLDER_TOKEN guard keeps it out of identifier extraction. Because it is
 * never written to the SymbolMap, `restore()` leaves it in place — the redaction
 * is one-way by construction, not by convention.
 */
export function scanSecrets(code: string, policy: SecretPolicy = 'redact'): SecretScan {
  if (policy === 'off') return { findings: [], code }

  const matches = dropOverlaps(collectMatches(code))
  if (matches.length === 0) return { findings: [], code }

  const starts = lineIndex(code)
  const findings: SecretFinding[] = []
  const counters: Record<string, number> = {}
  // Replace back-to-front so earlier offsets stay valid.
  const replacements: { start: number; end: number; token: string }[] = []

  for (const m of matches) {
    const willRedact = policy === 'redact' && REDACTED_SEVERITIES.has(m.pattern.severity)
    const { line, column } = positionOf(starts, m.start)
    findings.push({
      type: m.pattern.type,
      severity: m.pattern.severity,
      label: m.pattern.label,
      line,
      column,
      length: m.value.length,
      preview: previewSecret(m.value),
      redacted: willRedact,
    })
    if (willRedact) {
      const base = TYPE_TOKENS[m.pattern.type]
      const n = (counters[base] ?? 0) + 1
      counters[base] = n
      replacements.push({ start: m.start, end: m.end, token: `__REDACTED_${base}_${n}__` })
    }
  }

  let redacted = code
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i]
    redacted = redacted.slice(0, r.start) + r.token + redacted.slice(r.end)
  }

  return { findings, code: redacted }
}

/** True when the scan found anything that should stop a user from pasting. */
export function hasBlockingSecrets(findings: readonly SecretFinding[]): boolean {
  return findings.some((f) => f.severity === 'critical' || f.severity === 'high')
}

/** Count findings by severity, for badges and audit records. */
export function summarizeSecrets(
  findings: readonly SecretFinding[]
): Record<SecretSeverity, number> {
  const summary: Record<SecretSeverity, number> = { critical: 0, high: 0, medium: 0 }
  for (const f of findings) summary[f.severity]++
  return summary
}
