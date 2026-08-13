// Public engine types for @veilio-inc/engine. Keep this engine-only — product
// types (plans, billing, teams, SSO) belong to the consuming app, not here.

import type { Language, LanguageOption } from './languages.js'
import type { SecretFinding, SecretPolicy } from './secrets.js'

// ─── Engine types ────────────────────────────────────────────────────────────

export type SymbolMap = Record<string, string> // { "__P1__": "UserAuthService" }

export type IdentifierRole = 'class' | 'function' | 'package' | 'variable' | 'string'

export interface AnonymizeResult {
  anonymized: string
  map: SymbolMap
  identifierCount: number
  /** Language the masking ran under — detected, or forced via options. */
  language: Language
  /** Every credential detected, whatever the active policy. Findings whose
   *  `redacted` flag is true were replaced irreversibly and are absent from
   *  `map`; nothing here ever contains a full secret value. */
  secrets: SecretFinding[]
}

export type StrippedItemType =
  | 'jsdoc'
  | 'todo'
  | 'step-marker'
  | 'narration'
  | 'separator'
  | 'section-header'
  | 'inline-annotation'

export interface StrippedItem {
  type: StrippedItemType
  content: string
  lineNumber: number
}

/** What survived the round trip, and what did not.
 *
 *  A model is asked to echo placeholders verbatim and is under no obligation to
 *  comply. When it renames `__FN__1` to something readable, `restore()` finds
 *  nothing to substitute and returns confident-looking code with the model's
 *  invention where a real name belonged. Nothing about that is visible in the
 *  restored text, which is why it is reported here instead. */
export interface RestoreReport {
  /** Map placeholders that were found in the response and substituted. */
  resolved: string[]
  /** Map placeholders that never appeared in the response.
   *
   *  Not inherently an error: a model answering about one function legitimately
   *  omits the rest of the file. It *is* the only signal available when a model
   *  renames or re-cases a placeholder, since neither leaves anything
   *  placeholder-shaped behind to detect. Present it as information, not as a
   *  failure. */
  missing: string[]
  /** Placeholder-shaped tokens left in the output that no map entry explains —
   *  the model invented or mangled them. Unlike `missing`, these are always
   *  worth surfacing: the text now contains a token that means nothing.
   *
   *  `__REDACTED_*__` tokens are excluded. Those are credentials the engine
   *  deliberately never wrote to the map, so remaining is exactly correct. */
  unresolved: string[]
}

export interface RestoreResult {
  restored: string
  strippedCount: number
  strippedItems: StrippedItem[]
  report: RestoreReport
}

export interface RestoreOptions {
  /** Which AI-artifact categories to remove.
   *  - `'all'` (default) — every category below.
   *  - `'none'` — restore placeholders only, touch nothing else.
   *  - an explicit list — remove exactly those.
   *
   *  Worth setting: `'all'` deletes JSDoc, and when a model was *asked* to
   *  document its output that is destroying requested work rather than removing
   *  noise. Pass a list without `'jsdoc'` to keep documentation. */
  strip?: StrippedItemType[] | 'all' | 'none'
}

// ─── Custom rules ─────────────────────────────────────────────────────────────

export type CustomRuleScope = 'personal' | 'team'

export interface CustomRuleReplace {
  id: string
  scope: CustomRuleScope
  team_id: string | null
  type: 'replace'
  name: string
  pattern: string
  placeholder: string
  enabled: boolean
  sort_order: number
}

export interface CustomRuleWhitelist {
  id: string
  scope: CustomRuleScope
  team_id: string | null
  type: 'whitelist'
  name: string
  pattern: string
  enabled: boolean
  sort_order: number
}

export type CustomRule = CustomRuleReplace | CustomRuleWhitelist

// ─── Anonymize options (sub-project #4a) ─────────────────────────────────────

export interface AnonymizeOptions {
  existingMap?: SymbolMap
  rules?: CustomRule[]
  /** Literal strings the author marked sensitive by hand.
   *
   *  Custom rules can only rename what the extractor already found, which
   *  leaves the two things people most often need masked out of reach: a name
   *  inside a comment, and a bare account or case number. Both are prose to the
   *  extractor. These terms are matched as literal text instead, so they reach
   *  anywhere in the source.
   *
   *  Matching is literal, case-sensitive and longest-first: marking both
   *  `acct_88412037` and `88412037` masks the longer span. Marks are recorded in
   *  the map under `__MANUAL__n`, so `restore()` reverses them unchanged and
   *  they survive export, import and sync without a separate store. */
  manual?: string[]
  /** Language whose keywords and comment syntax to honour. 'auto' (default)
   *  detects from the source and falls back to TypeScript when unsure. */
  language?: LanguageOption
  /** How to treat detected credentials. 'redact' (default) replaces critical
   *  and high findings irreversibly; 'warn' reports without changing the code;
   *  'off' skips the scan entirely. */
  secrets?: SecretPolicy
}
