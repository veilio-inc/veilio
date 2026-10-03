export type Language = 'typescript' | 'python' | 'go' | 'java' | 'csharp' | 'rust' | 'ruby' | 'php' | 'c' | 'sql';
/** Languages the engine can be pointed at, plus `auto` for detection. */
export type LanguageOption = Language | 'auto';
export declare const LANGUAGES: readonly Language[];
/** Display names for UI surfaces. */
export declare const LANGUAGE_LABELS: Record<Language, string>;
/** Words the engine must never mask for `language`: COMMON plus that language's
 *  reserved words, built-in types, and ubiquitous stdlib names. */
export declare function keywordsFor(language: Language): ReadonlySet<string>;
/** True when `name` is a keyword in `language`. Handles SQL's case-insensitivity. */
export declare function isKeyword(name: string, language: Language): boolean;
/** Words that, immediately before an identifier, mark it as a type name. */
export declare function classKeywordsFor(language: Language): ReadonlySet<string>;
/** Words that, immediately before an identifier, mark it as a function name. */
export declare function fnKeywordsFor(language: Language): ReadonlySet<string>;
export interface CommentSyntax {
    /** Line-comment openers, longest-first so `--` wins over a hypothetical `-`. */
    line: readonly string[];
    /** Block-comment delimiter pairs. */
    block: readonly (readonly [string, string])[];
    /** Triple-quoted prose (Python docstrings), treated as comments. */
    docstring: readonly string[];
    /** Quote characters that open a string literal. */
    quotes: readonly string[];
}
export declare function commentSyntaxFor(language: Language): CommentSyntax;
export interface LanguageGuess {
    language: Language;
    /** Raw marker score. 0 means nothing matched and the fallback was used. */
    score: number;
    /** True when no marker matched and `language` is the TypeScript fallback. */
    fallback: boolean;
}
/** Score every language's markers against `code` and return the best guess.
 *  Ties and empty input resolve to TypeScript, preserving the pre-multi-language
 *  behavior for JS/TS callers exactly. */
export declare function guessLanguage(code: string): LanguageGuess;
/** Convenience wrapper returning just the detected language. */
export declare function detectLanguage(code: string): Language;
/** Resolve a caller's `language` option to a concrete language. */
export declare function resolveLanguage(code: string, option: LanguageOption | undefined): Language;
/**
 * Resolve the language AND say whether we actually recognised it.
 *
 * `resolveLanguage` answers only "which rules do I tokenise with", and every
 * caller then discarded the more important half: that nothing matched and
 * TypeScript was assumed. A file in an unsupported language is tokenised with
 * TypeScript's grammar, so identifiers it does not recognise are simply not
 * masked — and the output looks exactly as confident as a real one. For a
 * privacy tool that is the worst available failure mode.
 *
 * `fallback` is deliberately narrower than `guessLanguage().fallback`:
 *
 *  - An explicit language is never a fallback. The caller told us; detection is
 *    not consulted at all, which is the existing contract.
 *  - Trivial input is never a fallback. Empty and near-empty buffers score zero
 *    for every language, and warning about them would train the user to dismiss
 *    the warning that matters — the same way an over-alarmed secret panel does.
 */
export declare function describeLanguage(code: string, option: LanguageOption | undefined): {
    language: Language;
    fallback: boolean;
};
