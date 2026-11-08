export declare const DEFAULT_RAW_ONLY: readonly string[];
/** A path no name match can judge on Windows: a segment holding a stream
 *  (`a:b`, past a drive letter) or shaped like an 8.3 short name (`ENV~1`),
 *  which may stand for any long name. Callers that read files refuse it. */
export declare function windowsAlias(path: string): boolean;
/** A segment shaped like an 8.3 short name (`ENV~1`): the part of
 *  windowsAlias that also holds for a shell word, where a colon is common. */
export declare function shortNameAlias(path: string): boolean;
export declare function isRawOnly(path: string, extra: readonly string[]): boolean;
