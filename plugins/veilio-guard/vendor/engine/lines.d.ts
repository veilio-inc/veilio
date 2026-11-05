/** The offset where each line starts; the first is always 0. */
export declare function lineIndex(code: string): number[];
/** The 1-based line and column of `offset`, from `lineIndex`'s starts. */
export declare function positionOf(starts: number[], offset: number): {
    line: number;
    column: number;
};
