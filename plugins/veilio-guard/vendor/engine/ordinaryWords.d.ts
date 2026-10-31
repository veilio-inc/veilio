/** A single dictionary word, written lower-case, Capitalised or in capitals. */
export declare function isOrdinaryWord(name: string): boolean;
/** Where `text` holds a word as the value of a credential-named key. Such a
 *  word is never left readable as an ordinary word: the engine masks it
 *  there, and the guard writes its map's entry over it. Sorted, and never
 *  overlapping. `literal`: written as a value - quoted, or in a shape only
 *  configuration has; a bare `key = word` may be code naming a variable. */
export declare function credentialValueSpans(text: string): {
    start: number;
    end: number;
    value: string;
    literal: boolean;
}[];
