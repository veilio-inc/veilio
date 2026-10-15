/** A half-open [start, end) range of text to leave exactly as written. */
export type Span = readonly [number, number];
export interface TraceSpans {
    /** Node's text: neither extracted nor substituted. */
    verbatim: Span[];
    /** Not extracted, so it adds no name to the map, but a known name in it is
     *  still masked: the function part of a `node:` frame. */
    unextracted: Span[];
}
/** What Node wrote in `text`. Each list is in order and non-overlapping, and
 *  the two never overlap each other. */
export declare function traceSpans(text: string): TraceSpans;
/** `text` with every span replaced by spaces: offsets and lines are kept, and
 *  nothing inside a span can be extracted as an identifier. */
export declare function blankSpans(text: string, spans: readonly Span[]): string;
/** True when `offset` falls inside one of `spans` (sorted, non-overlapping). */
export declare function inSpan(spans: readonly Span[], offset: number): boolean;
