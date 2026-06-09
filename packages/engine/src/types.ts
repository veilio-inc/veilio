// Public engine types for @veilio/shared. Keep this engine-only — Cloud product
// types (plans, billing, teams, SSO) live in ./app.ts and are NOT published.

// ─── Engine types ────────────────────────────────────────────────────────────

export type SymbolMap = Record<string, string> // { "__P1__": "UserAuthService" }

export interface AnonymizeResult {
  anonymized: string
  map: SymbolMap
  identifierCount: number
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

// ─── Custom rules (Pro tier, with team scope for #5c) ─────────────────────────

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
}
