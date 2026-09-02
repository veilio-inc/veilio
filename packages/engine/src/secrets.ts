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

export type SecretSeverity = 'critical' | 'high' | 'medium' | 'low'

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
  | 'possible-credential'
  | 'high-entropy-string'
  | 'email'
  | 'private-ip'
  | 'iban'
  | 'payment-card'
  | 'pesel'

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
  /**
   * Structural confirmation, run on the matched value before it is reported.
   *
   * Regulated identifiers are digit runs, and a digit run is the single most
   * common shape in source code — versions, timestamps, ports, hashes. A regex
   * alone would report all of them. The checksum is what makes the difference
   * between detection and noise, so it is part of the rule rather than a filter
   * somebody remembers to apply.
   */
  validate?: (value: string) => boolean
}

// ─── Structural validators ───────────────────────────────────────────────────
//
// Every one of these is arithmetic over the value itself. Nothing here infers,
// models, or consults a list of real-world numbers — which is what lets the
// engine keep its zero-dependency promise while still catching the material the
// tool is most often reached for.

/** Digits only, separators removed. */
function digitsOf(value: string): string {
  return value.replace(/[^0-9]/g, '')
}

/** Luhn (mod-10). Payment cards, and a good many national IDs. */
export function luhnValid(value: string): boolean {
  const digits = digitsOf(value)
  if (digits.length < 12) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/**
 * IBAN mod-97 (ISO 13616). Move the first four characters to the end, map
 * letters to two-digit numbers, and the whole thing mod 97 must be 1.
 *
 * Computed in chunks because the expanded number can exceed 2^53 — doing it in
 * one `Number()` silently loses precision and starts accepting invalid IBANs,
 * which is worse than not checking at all.
 */
export function ibanValid(value: string): boolean {
  const compact = value.replace(/[\s-]/g, '').toUpperCase()
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(compact)) return false
  const rearranged = compact.slice(4) + compact.slice(0, 4)
  let remainder = 0
  for (const ch of rearranged) {
    const mapped = /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55)
    for (const digit of mapped) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97
    }
  }
  return remainder === 1
}

/**
 * PESEL — the Polish national identification number.
 *
 * Eleven digits: a date, a serial, and a weighted check digit. The date is
 * checked as well as the checksum, because eleven digits is a common enough
 * shape in source that the check digit alone leaves too many coincidences.
 */
export function peselValid(value: string): boolean {
  const digits = digitsOf(value)
  if (digits.length !== 11) return false
  const weights = [9, 7, 3, 1, 9, 7, 3, 1, 9, 7]
  let sum = 0
  for (let i = 0; i < 10; i++) sum += (digits.charCodeAt(i) - 48) * weights[i]
  if (sum % 10 !== digits.charCodeAt(10) - 48) return false

  // Century is encoded in the month field, which is what makes an arbitrary
  // eleven-digit run overwhelmingly likely to fail here even when the checksum
  // happens to pass.
  const monthField = Number(digits.slice(2, 4))
  const century = Math.floor(monthField / 20)
  const month = monthField % 20
  if (century > 4 || month < 1 || month > 12) return false
  const day = Number(digits.slice(4, 6))
  if (day < 1 || day > 31) return false
  return true
}

/**
 * Card numbers that appear in every payments fixture and documentation page.
 *
 * Luhn-valid by construction, so the checksum cannot separate them from a real
 * card. Reporting them on every file is the crying-wolf failure the advisory
 * panel work exists to remove — the finding that mattered ends up in the same
 * grey list as ninety that did not.
 */
const KNOWN_TEST_PANS: ReadonlySet<string> = new Set([
  '4111111111111111',
  '4012888888881881',
  '4222222222222',
  '4242424242424242',
  '4000056655665556',
  '5555555555554444',
  '5105105105105100',
  '2223003122003222',
  '378282246310005',
  '371449635398431',
  '6011111111111117',
  '6011000990139424',
  '3056930009020004',
  '3566002020360505',
])

/** Issuer prefixes we recognise. A Luhn-valid digit run that begins with none
 *  of these is far more likely to be an identifier than a card. */
function looksLikePan(value: string): boolean {
  const digits = digitsOf(value)
  if (digits.length < 13 || digits.length > 19) return false
  if (KNOWN_TEST_PANS.has(digits)) return false
  const iin =
    /^4/.test(digits) ||
    /^5[1-5]/.test(digits) ||
    /^2[2-7]/.test(digits) ||
    /^3[47]/.test(digits) ||
    /^6(?:011|5)/.test(digits) ||
    /^3(?:0[0-5]|[68])/.test(digits)
  return iin && luhnValid(digits)
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
    severity: 'high',
    label: 'GitHub token',
    re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  },
  {
    type: 'slack-token',
    severity: 'high',
    label: 'Slack token',
    re: /\bxox[baprse]-[A-Za-z0-9-]{10,250}\b/g,
  },
  {
    type: 'anthropic-key',
    severity: 'high',
    label: 'Anthropic API key',
    re: /\bsk-ant-[A-Za-z0-9_-]{20,250}\b/g,
  },
  {
    // `sk-ant-` is excluded so an Anthropic key is reported as one rather than
    // racing the OpenAI pattern for the identical span.
    type: 'openai-key',
    severity: 'high',
    label: 'OpenAI API key',
    re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,250}\b/g,
  },
  {
    type: 'google-api-key',
    severity: 'high',
    label: 'Google API key',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    type: 'npm-token',
    severity: 'high',
    label: 'npm access token',
    re: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    type: 'gitlab-token',
    severity: 'high',
    label: 'GitLab token',
    re: /\bglpat-[A-Za-z0-9_-]{20,50}\b/g,
  },
  {
    type: 'slack-webhook',
    severity: 'medium',
    label: 'Slack webhook URL',
    re: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_-]{6,20}\/B[A-Za-z0-9_-]{6,20}\/[A-Za-z0-9_-]{20,30}/g,
  },
  {
    type: 'discord-token',
    severity: 'high',
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
    severity: 'high',
    label: 'PyPI upload token',
    re: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}\b/g,
  },
  {
    type: 'sendgrid-key',
    severity: 'high',
    label: 'SendGrid API key',
    re: /\bSG\.[A-Za-z0-9_-]{20,24}\.[A-Za-z0-9_-]{39,50}\b/g,
  },
  {
    type: 'twilio-key',
    severity: 'high',
    label: 'Twilio account SID',
    re: /\bAC[a-f0-9]{32}\b/g,
  },
  {
    type: 'mailgun-key',
    severity: 'high',
    label: 'Mailgun API key',
    re: /\bkey-[a-f0-9]{32}\b/g,
  },
  {
    type: 'datadog-key',
    severity: 'medium',
    label: 'Datadog API key',
    re: /(?:datadog|dd)[_-]?api[_-]?key["'\s:=]{1,10}([a-f0-9]{32})\b/gi,
    group: 1,
  },
  {
    type: 'hugging-face-token',
    severity: 'high',
    label: 'Hugging Face token',
    re: /\bhf_[A-Za-z0-9]{34,40}\b/g,
  },
  {
    type: 'supabase-key',
    severity: 'high',
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
    severity: 'high',
    label: 'Shopify access token',
    re: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g,
  },
  {
    type: 'cloudflare-token',
    severity: 'high',
    label: 'Cloudflare API token',
    re: /(?:cloudflare|cf)[_-]?api[_-]?(?:token|key)["'\s:=]{1,10}([A-Za-z0-9_-]{37,45})\b/gi,
    group: 1,
  },
  {
    type: 'basic-auth',
    severity: 'medium',
    label: 'HTTP Basic credentials',
    re: /\bBasic\s+([A-Za-z0-9+/]{16,400}={0,2})/g,
    group: 1,
  },
  {
    type: 'jwt',
    severity: 'medium',
    label: 'JSON Web Token',
    re: /\beyJ[A-Za-z0-9_-]{8,2000}\.eyJ[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{0,2000}/g,
  },
  {
    type: 'bearer-token',
    severity: 'medium',
    label: 'Bearer / Authorization token',
    re: /(?:Authorization["'\s:=]{1,10})?\bBearer\s+([A-Za-z0-9._~+/-]{16,500}=*)/g,
    group: 1,
  },
  {
    type: 'connection-string',
    severity: 'critical',
    label: 'Connection string password',
    re: /\b[a-z][a-z0-9+.-]{2,20}:\/\/[^\s:@/]{1,128}:([^\s:@/]{1,256})@/gi,
    group: 1,
  },
  {
    type: 'password-assignment',
    severity: 'medium',
    label: 'Hardcoded credential',
    // No LEADING \b: underscores and letters are both word characters, so a
    // leading boundary never exists after a prefix. Assignments to
    // DB_PASSWORD, MY_API_KEY and userPassword were all missed while a bare
    // password assignment was caught. Those prefixed forms are the common ones
    // in application code and in .env-style config, so the boundary was
    // excluding the majority case.
    //
    // (Written without backtick-quoted examples on purpose: this rule reads a
    // backtick as a value delimiter, so the illustration would flag itself.)
    //
    // The TRAILING \b is what keeps this from over-matching: the keyword must
    // end at a non-word character, so `passwordless`, `passwordHash` and
    // `secretary` still do not match. An identifier that *ends* in `password`
    // or `secret` and is assigned a 6+ character literal is a credential
    // whatever precedes it.
    re: /(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?token|encryption[_-]?key)\b["'\s]{0,6}[:=]{1,2}[>\s]{0,3}["'`]([^"'`\n]{6,256})["'`]/gi,
    group: 1,
  },
  {
    // Catch-all for providers with no dedicated pattern above. Restricted to
    // *assignment* context and gated on entropy, because a bare long token in
    // prose is far more often a hash, a UUID or a base64 blob than a live
    // credential — and a detector that cries wolf gets switched off.
    type: 'high-entropy-string',
    severity: 'medium',
    label: 'High-entropy credential',
    re: /\b(?:[a-z0-9_]*(?:key|token|secret|credential|auth|pass)[a-z0-9_]*)\b["'\s:=]{1,10}["'`]([A-Za-z0-9+/_-]{24,200}={0,2})["'`]/gi,
    group: 1,
  },
  {
    type: 'private-ip',
    severity: 'low',
    label: 'Private IP address',
    re: /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
  },
  {
    type: 'email',
    severity: 'low',
    label: 'Email address',
    re: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}\b/g,
  },
  // ─── Regulated identifiers ────────────────────────────────────────────────
  //
  // Not credentials: material a regulation cares about. The engine masks
  // identifiers bound by a language's grammar, so `const iban = "GB29..."` had
  // its NAME masked and its VALUE passed through untouched — and this is the
  // material the tool is most often reached for.
  //
  // Structural only. Every one is confirmed by arithmetic over the value, never
  // by inference, because an ML dependency would cost the zero-dependency
  // guarantee that is the whole argument for pasting the output into a model.
  {
    type: 'iban',
    severity: 'high',
    label: 'Bank account number (IBAN)',
    // Country, check digits, then the account portion, tolerating the spacing
    // IBANs are conventionally printed with. Bounded repetition: linear.
    re: /\b[A-Z]{2}[0-9]{2}(?:[ -]?[A-Z0-9]){11,30}\b/g,
    validate: ibanValid,
  },
  {
    type: 'payment-card',
    severity: 'medium',
    label: 'Payment card number',
    // Deliberately loose, because the validator is the real rule: an issuer
    // prefix, a plausible length, and Luhn. Encoding that in a regex makes it
    // unreadable and no more correct.
    re: /\b[0-9](?:[ -]?[0-9]){11,18}\b/g,
    validate: looksLikePan,
  },
  {
    type: 'pesel',
    severity: 'medium',
    label: 'National identification number (PESEL)',
    re: /\b[0-9]{11}\b/g,
    validate: peselValid,
  },
]

/**
 * The grade each rule carries, derived from the table above rather than
 * restated. A second hand-written copy is one that drifts.
 *
 * Exported because a caller that renders findings has to rank and style them,
 * and the alternative is every caller hardcoding its own idea of which types
 * are alarming — which is how the grades stopped meaning anything the first time.
 */
export const SECRET_SEVERITIES: Readonly<Record<SecretType, SecretSeverity>> = Object.freeze(
  PATTERNS.reduce(
    (acc, p) => {
      acc[p.type] = p.severity
      return acc
    },
    // The ambiguous verdict has no pattern of its own: it is what a pattern
    // becomes when the value could be prose.
    { 'possible-credential': 'medium' } as Record<SecretType, SecretSeverity>
  )
)

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
  // HTML `autocomplete` tokens. `autoComplete={... ? 'new-password' :
  // 'current-password'}` appears in essentially every login form, and the
  // assignment pattern reads the attribute value as a credential. Fixed strings
  // from the HTML spec, so suppressing them costs no detection.
  'current-password',
  'new-password',
  'one-time-code',
])

/**
 * How confident we are that a matched value is a live credential.
 *
 * `placeholder` is dropped. `credential` is reported at the pattern's own
 * severity, which means redacted and blocking. `ambiguous` is reported at
 * `medium` — visible in the panel, but neither redacted nor blocking.
 *
 * That middle tier exists because the two mistakes are not symmetrical.
 * Redaction is irreversible by design: the value never enters the SymbolMap, so
 * blanking `client_secret: "disabled"` corrupts code that `restore()` can never
 * repair. Staying silent on `password = "correcthorse"` leaks a live password.
 * Nothing in the syntax separates those two, so the engine reports the
 * ambiguity instead of guessing which one it is.
 */
type ValueVerdict = 'placeholder' | 'ambiguous' | 'credential'

function classifyValue(value: string, assignmentShaped: boolean): ValueVerdict {
  const trimmed = value.trim()
  if (KNOWN_DUMMY.has(trimmed.toLowerCase())) return 'placeholder'
  // Templating placeholders: ${VAR}, {{var}}, %s, $VAR, <VALUE>. Matched
  // case-insensitively against the ORIGINAL — lowercasing first would stop
  // `$DB_PASSWORD` matching an upper-case-only shell-variable pattern.
  if (/^\$\{[^}]*\}$|^\{\{[^}]*\}\}$|^%[sdv]$|^\$[a-z_][a-z0-9_]*$|^<[^>]*>$/i.test(trimmed)) {
    return 'placeholder'
  }
  // A run of one repeated character conveys nothing.
  if (/^(.)\1{3,}$/.test(trimmed)) return 'placeholder'

  // Everything below is a guess about prose, and prose is only a plausible
  // reading where the value could have been an enum or a mode. A connection
  // string or an Authorization header puts its value in a slot that is
  // structurally a credential: nothing but a password can legitimately sit
  // between the colon and the @ of a database URL. Those keep the pattern's own
  // severity — applying the prose heuristic to them silently dropped real
  // database passwords and bearer tokens for no reason beyond their being
  // lower-case. (Spelled out rather than illustrated: a working example URL in
  // this comment would match the rule it describes.)
  if (!assignmentShaped) return 'credential'

  // A single run of lowercase letters is usually a word: `client_secret:
  // "disabled"` is configuration, not a secret. But `password = "correcthorse"`
  // has the identical shape, so this reports rather than decides.
  if (/^[a-z]+$/.test(trimmed)) return 'ambiguous'
  return 'credential'
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

/** A match with its verdict already applied, so `type`, `severity` and `label`
 *  may differ from the pattern that produced it. */
interface RawMatch {
  type: SecretType
  severity: SecretSeverity
  label: string
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
    // The only two patterns that read their value out of an assignment, and so
    // the only two where an ordinary configuration word is a plausible reading
    // of what matched.
    const assignmentShaped =
      pattern.type === 'password-assignment' || pattern.type === 'high-entropy-string'
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
      // Structural confirmation first. A rule carrying a validator is declaring
      // its regex to be only a candidate generator — a digit run is the most
      // common shape in source code, and without the checksum this reports every
      // timestamp, version and port in the file. An unconfirmed candidate is not
      // a finding at all: it never reaches the panel, the policy, or the map.
      if (pattern.validate !== undefined && !pattern.validate(value)) continue
      let verdict = classifyValue(value, assignmentShaped)
      if (verdict === 'placeholder') continue
      // Assignment-shaped findings also get an entropy check: `password: "the
      // user's password"` in prose is not a credential. Patterned filler such as
      // `password: "abababababab"` is the same judgement call as a lowercase
      // word — weak-but-real and enum-value are indistinguishable here — so it
      // lands in the same tier: surfaced, not acted on.
      if (assignmentShaped && shannonEntropy(value) < ENTROPY_FLOOR) verdict = 'ambiguous'
      const ambiguous = verdict === 'ambiguous'
      found.push({
        type: ambiguous ? 'possible-credential' : pattern.type,
        severity: ambiguous ? 'medium' : pattern.severity,
        label: ambiguous ? 'Possible hardcoded credential' : pattern.label,
        start,
        end: start + value.length,
        value,
      })
    }
    pattern.re.lastIndex = 0
  }
  return found
}

const SEVERITY_RANK: Record<SecretSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1 }

/**
 * How specifically a rule identified what it matched.
 *
 * Overlap resolution is about SPECIFICITY, not alarm. It used to rank by
 * severity, which worked only while the two happened to coincide — the moment
 * `connection-string` was graded critical to reflect what a leaked database URL
 * actually costs, the container started swallowing the GitHub token inside it
 * and the report got less useful for being more alarmed.
 *
 * A named provider format beats a generic container, which beats a low-value
 * match, which beats the catch-all. Nothing here reads `severity`.
 */
const GENERIC_MATCHERS: ReadonlySet<SecretType> = new Set<SecretType>([
  'connection-string',
  'basic-auth',
  'bearer-token',
  'jwt',
  'password-assignment',
  'high-entropy-string',
])

function detectionPriority(type: SecretType): number {
  if (type === 'possible-credential') return 0
  if (type === 'email' || type === 'private-ip') return 1
  if (GENERIC_MATCHERS.has(type)) return 2
  return 3
}

/** Drop matches contained in, or overlapping, a more specific match. A Stripe
 *  key inside a connection string should be reported once, as the Stripe key. */
function dropOverlaps(matches: RawMatch[]): RawMatch[] {
  const sorted = [...matches].sort((a, b) => {
    const byPriority = detectionPriority(b.type) - detectionPriority(a.type)
    if (byPriority !== 0) return byPriority
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

/**
 * Finding types that are reported but never redacted or blocked.
 *
 * Keyed on TYPE, not on severity, and that distinction is the point. Severity
 * used to decide this, which quietly welded two unrelated questions together:
 * "how alarming should this look?" and "should we destroy this value?". A
 * presentation change then became a security change — dropping a token's grade
 * to calm the panel would also stop redacting it, in a diff that looks
 * cosmetic.
 *
 * Stated as a DENY-list so the default is safe: a detection rule added tomorrow
 * redacts because it exists, not because somebody remembered to opt it in. The
 * failure mode of an allow-list here is a live credential silently passing
 * through.
 *
 * The three exemptions, and why:
 *  - `email` and `private-ip`: common, low-risk, and blanking one corrupts code
 *    for no safety gain.
 *  - `possible-credential`: the ambiguous verdict. Redaction is irreversible —
 *    the value never enters the SymbolMap — so blanking `client_secret:
 *    "disabled"` corrupts code that restore() can never repair.
 */
const REPORT_ONLY_TYPES: ReadonlySet<SecretType> = new Set<SecretType>([
  'email',
  'private-ip',
  'possible-credential',
])

/** Does this finding warrant destroying the value and stopping the paste? */
function isActionable(type: SecretType): boolean {
  return !REPORT_ONLY_TYPES.has(type)
}

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
  // Unreachable while `medium` stays out of REDACTED_SEVERITIES, but present so
  // that widening the policy cannot produce an undefined token.
  'possible-credential': 'CREDENTIAL',
  'high-entropy-string': 'SECRET',
  email: 'EMAIL',
  'private-ip': 'PRIVATE_IP',
  iban: 'IBAN',
  'payment-card': 'CARD_NUMBER',
  pesel: 'PESEL',
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
    const willRedact = policy === 'redact' && isActionable(m.type)
    const { line, column } = positionOf(starts, m.start)
    findings.push({
      type: m.type,
      severity: m.severity,
      label: m.label,
      line,
      column,
      length: m.value.length,
      preview: previewSecret(m.value),
      redacted: willRedact,
    })
    if (willRedact) {
      const base = TYPE_TOKENS[m.type]
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

  // FR-001: ordered by what the reader should act on first, not by the order
  // the rule table happens to be written in. `replacements` is deliberately not
  // reordered — it is applied back-to-front by offset and must stay in source
  // order.
  findings.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    if (bySeverity !== 0) return bySeverity
    if (a.line !== b.line) return a.line - b.line
    return a.column - b.column
  })

  return { findings, code: redacted }
}

/** True when the scan found anything that should stop a user from pasting. */
export function hasBlockingSecrets(findings: readonly SecretFinding[]): boolean {
  // Also by type, for the same reason redaction is. Blocking is what stops a
  // paste; tying it to a display grade means re-grading can silently unblock a
  // live credential.
  return findings.some((f) => isActionable(f.type))
}

/** Count findings by severity, for badges and audit records. */
export function summarizeSecrets(
  findings: readonly SecretFinding[]
): Record<SecretSeverity, number> {
  const summary: Record<SecretSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const f of findings) summary[f.severity]++
  return summary
}
