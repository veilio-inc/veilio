import type { AnonymizeOptions, AnonymizeResult, CommentExposure, IdentifierRole, RestoreOptions, RestoreResult, StrippedItemType, SymbolMap } from './types.js';
import { type Language, type LanguageOption } from './languages.js';
import type { SecretType } from './secrets.js';
export declare const AI_PREAMBLE: string;
/** Human/AI-readable summary of what the placeholder bases in `map` mean.
 *  Derived purely from placeholder KEYS — real names never appear.
 *  Pass `snippet` to scope the legend to the placeholders actually present
 *  in it (used by withAiPreamble and the UI legend toggle). */
export declare function buildLegend(map: SymbolMap, snippet?: string): string;
/** Prepend the downstream-AI preamble (and, when a map is given, a placeholder
 *  legend) to anonymized code, ready to paste. The legend is scoped to the
 *  placeholders actually present in `anonymized` — not the whole map — so a
 *  one-line snippet doesn't advertise the full size (or namespace) of a
 *  larger (e.g. team-shared) map it happens to be a subset of. */
export declare function withAiPreamble(anonymized: string, map?: SymbolMap): string;
/**
 * How much comment prose this source would send unmasked.
 *
 * `anonymize` returns the same measurement for the text it produced, which is
 * the number to prefer. This entry point exists for the moments after that,
 * when a manual mark has just moved a name out of a comment — or an unmark has
 * put one back — and the figure on screen would otherwise describe the previous
 * version of the text.
 */
export declare function measureCommentExposure(code: string, language?: LanguageOption): CommentExposure;
/** Base for spans the author marked by hand. Not an IdentifierRole: a manual
 *  mark is frequently not an identifier at all — a surname in a comment, a bare
 *  account number — which is the entire reason the feature exists. */
export declare const MANUAL_BASE = "__MANUAL__";
/** Raised when a manual mark is refused. Carries the offending term so a caller
 *  can point at it rather than re-deriving which one failed. */
export declare class ManualMaskError extends Error {
    readonly term: string;
    constructor(term: string, message: string);
}
/** Placeholder base per regulated format.
 *
 *  Their own roles rather than a shared one, because the output's job is to be
 *  worked on by a model: "this is a bank account number" is information it can
 *  use, where "this is a redacted something" is not.
 *
 *  Deliberately NOT members of `IdentifierRole`. That union is for roles derived
 *  from a language's grammar and `ROLE_PRIORITY` is keyed by it — extending it
 *  would force entries ranking a card number against a function name, a
 *  comparison with no meaning. These ride beside `__MANUAL__`, which is in the
 *  same position for the same reason: masked reversibly, but not an identifier
 *  the grammar produced. */
export declare const REGULATED_BASES: Partial<Record<SecretType, string>>;
/** Terms already masked by hand in a prior pass, recovered from the map.
 *
 *  Re-derived rather than stored alongside it: the map is the only artifact
 *  that survives a reload, a `.veilio` export and a sync, so anything kept
 *  beside it would be the thing that goes missing. */
export declare function manualTermsIn(map: SymbolMap): string[];
/** Placeholder base per role — these ride the same named-counter machinery
 *  as custom replace rules (__CLS__1, __FN__2, ...). */
export declare const ROLE_BASES: Record<IdentifierRole, string>;
/** Classify every identifier-shaped token (keywords excluded in code context) by
 *  its strongest observed role. `language` selects the keyword and role-hint
 *  sets; it defaults to TypeScript so standalone callers keep prior behavior. */
export declare function classifyIdentifiers(code: string, language?: Language): Record<string, IdentifierRole>;
/** Whether a token is one of our placeholders.
 *
 *  Exported because a symbol map read back from a `.veilio` file is untrusted
 *  input, and the only way to check its keys are placeholders is to ask the
 *  thing that mints them. A copy of this pattern elsewhere would drift, and the
 *  shape has to keep admitting the legacy `__P1__` style or importing an old
 *  map would fail.
 *
 *  The requirement for an uppercase first character does double duty: it refuses
 *  `__proto__`, `constructor` and `prototype`, so a map validated with this
 *  cannot carry a prototype-pollution key. */
export declare function isPlaceholder(token: string): boolean;
/**
 * Extract qualifying identifiers from source code, sorted longest-first.
 * Filters out keywords, ALL_CAPS constants, placeholder-shaped tokens, and names ≤ 2 chars.
 * `language` selects the keyword set; it defaults to TypeScript so standalone
 * callers keep prior behavior.
 */
export declare function extractIdentifiers(code: string, language?: Language): string[];
/**
 * Anonymize source code, replacing real identifiers with role-typed
 * placeholders (__CLS__1, __FN__2, ...). Pass an existing map to continue
 * numbering from a previous session.
 *
 * Custom rules:
 * - Whitelist rules (type='whitelist'): identifiers matching the pattern are
 *   left alone, no placeholder assigned.
 * - Replace rules (type='replace'): identifiers matching the pattern get a
 *   named placeholder (e.g., __APIKEY__1, __APIKEY__2) instead of a role base.
 * Precedence: whitelist → replace (first match by sort_order) → default.
 *
 * Credentials are handled before identifier masking. Under the default
 * `secrets: 'redact'` policy, critical/high findings are replaced with
 * `__REDACTED_*__` tokens that are never written to the map — so `restore()`
 * cannot bring a live key back, and a synced map can never carry one.
 */
export declare function anonymize(code: string, options?: AnonymizeOptions | SymbolMap): AnonymizeResult;
/** Every category `restore` knows how to remove. */
export declare const STRIPPABLE_TYPES: readonly StrippedItemType[];
/**
 * Restore an AI response: strip AI-generated noise, then swap placeholders back.
 *
 * `options.strip` selects what counts as noise. It matters most for `'jsdoc'`:
 * when the model was asked to document its output, removing the docs is
 * destroying requested work, not cleaning up after it.
 */
export declare function restore(aiResponse: string, map: SymbolMap, options?: RestoreOptions): RestoreResult;
/**
 * Placeholders whose shape the model changed - case or underscores (`__fn__1`,
 * `_FN__1`) - found in `text`, each once, in order of first appearance.
 *
 * Not placeholders to the engine, so no map can restore them and `unresolved`
 * does not see them: until spec 029 every surface passed them through without a
 * word. Anchored on the kinds the engine mints and a number, so an ordinary name
 * (`tmp_fn_1`), a dunder (`__init__`), an unknown kind (`__FOO__1`) and a
 * redacted credential never match; an exact placeholder is `resolved` or
 * `unresolved`, never this.
 *
 * Given the map, a token that is one of its real names is not altered: the
 * user's own `_str_1` was masked and restored exactly (code review - without
 * this, --strict refused correct output). `restore()` always passes it; a
 * model-introduced name of that shape, in new code, is still named.
 */
export declare function alteredPlaceholders(text: string, map?: SymbolMap): string[];
