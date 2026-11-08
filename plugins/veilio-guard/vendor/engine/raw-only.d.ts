export declare const DEFAULT_RAW_ONLY: readonly string[];
/** A path no name match can judge on Windows: a segment holding a stream
 *  (`a:b`, past a drive letter) or shaped like an 8.3 short name (`ENV~1`),
 *  which may stand for any long name. Callers that read files refuse it. */
export declare function windowsAlias(path: string): boolean;
/** A segment shaped like an 8.3 short name (`ENV~1`): the part of
 *  windowsAlias that also holds for a shell word, where a colon is common.
 *  On Windows only (review round 2 of spec 078): elsewhere `HEAD~1` and
 *  `main~3` are git's. `windows`: the platform, when the caller knows it. */
export declare function shortNameAlias(path: string, windows?: boolean): boolean;
export declare function isRawOnly(path: string, extra: readonly string[]): boolean;
/** The project's own raw-only patterns in `.veilio/guard.json` (`rawOnly`):
 *  its strings, as written. One reader for the Claude Code guard and the MCP
 *  server (spec 078 review round 2), so both refuse the same files. Throws a
 *  SyntaxError when the file is not JSON; the caller fails closed. */
export declare function guardJsonRawOnly(text: string): string[];
/** `rawOnly` of an already parsed guard.json. */
export declare function rawOnlyOf(settings: unknown): string[];
/** guardJsonRawOnly per project root, read again only when the file's mtime
 *  changes. `mtimeMs` undefined: there is no file, and no patterns. */
export declare class GuardJsonCache {
    private byRoot;
    get(root: string, mtimeMs: number | undefined, read: () => string): string[];
}
