// Public engine types for @dlgshi/engine. Keep this engine-only — product
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

export interface RestoreResult {
  restored: string
  strippedCount: number
  strippedItems: StrippedItem[]
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
  /** 'roles' (default): __CLS__1/__FN__2/... role-typed placeholders.
   *  'plain': legacy __P<n>__ numbering. */
  style?: 'roles' | 'plain'
  /** Language whose keywords and comment syntax to honour. 'auto' (default)
   *  detects from the source and falls back to TypeScript when unsure. */
  language?: LanguageOption
  /** How to treat detected credentials. 'redact' (default) replaces critical
   *  and high findings irreversibly; 'warn' reports without changing the code;
   *  'off' skips the scan entirely. */
  secrets?: SecretPolicy
}
