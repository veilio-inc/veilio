import { type Language } from './languages.js';
import type { CustomRuleWhitelist } from './types.js';
export interface ImportEntry {
    specifier: string;
    /** Names the file takes from the package and uses under the package's own
     *  spelling. A local alias the project chose is not included. */
    names: string[];
}
/** What decides that a specifier points inside the project. */
export interface ProjectShape {
    /** Workspace package names (TS/JS), matched whole or as `name/…`. */
    workspaces?: readonly string[];
    /** `tsconfig` path-alias prefixes such as `@/` (TS/JS). */
    pathAliases?: readonly string[];
    /** Top-level directories of the project, and of its `tsconfig` `baseUrl`
     *  (TS/JS): a bare specifier whose first segment is one of them is the
     *  project's own (`src/billing/ledger`). */
    baseDirs?: readonly string[];
    /** Top-level module and package names found in the project (Python). The
     *  caller must list every one: a missing name makes the project's own
     *  modules read as external. */
    pythonModules?: readonly string[];
    /** The `module` path from `go.mod` (Go). */
    goModule?: string;
}
/** The import statements of `text`, in order. Languages other than
 *  TypeScript/JavaScript, Python and Go return none. */
export declare function parseImports(text: string, language: Language): ImportEntry[];
/** The names `text` declares: functions, classes, types, module variables and,
 *  for TypeScript, class members. Keywords are left out. */
export declare function parseDeclarations(text: string, language: Language): string[];
/** True when `specifier` names something outside the project. Unsupported
 *  languages answer false: nothing of theirs is exempted. */
export declare function isExternalSpecifier(specifier: string, language: Language, project: ProjectShape): boolean;
/** Everything in `text` that comes from outside the project: each external
 *  specifier, its path segments, and the names imported from it - less any name
 *  the same text declares. */
export declare function externalNames(text: string, language: Language, project: ProjectShape): Set<string>;
/** The engine's languages, by file extension. An extension is the author's
 *  own statement of the language; a guess from content misreads a file that
 *  holds other languages' code in strings (spec 050 R2). */
export declare const LANGUAGE_BY_EXTENSION: Readonly<Record<string, Language>>;
/** The language a path's extension names, or null. */
export declare function languageOfPath(path: string): Language | null;
/** The names a shell or PowerShell script may declare: every word shaped
 *  like an identifier in it (`$name`, `name=`, `function Verb-Noun`). Shell
 *  syntax has too many ways to bind a name (`typeset`, `name+=`, `read`,
 *  `for x in`, after `;` or `&&`) to read it precisely, and every word counted
 *  here only stays masked, which is the safe side (security review of 70c6475). */
export declare function parseShellDeclarations(text: string): string[];
/** One whitelist rule leaving `names` as written, matched whole. One rule for
 *  all of them: the engine matches each identifier against each rule, so a
 *  rule per name is slow on a large file. Shared by the guard and the CLI so
 *  the two cannot drift. */
export declare function keepRule(names: Iterable<string>, id: string, label: string): CustomRuleWhitelist[];
