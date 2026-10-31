import type { SymbolMap } from './types.js';
/** A range of team numbers reserved for this checkout, inclusive (spec 063). */
export type Block = {
    start: number;
    end: number;
};
export declare const LOCAL_PREFIX = "__LOCAL_";
/** The highest placeholder number anything mints or trusts (security audit):
 *  near 2^53 adding one stops changing a number, and two names would share a
 *  placeholder; the server caps its numbers here too (Cloud 450a93ce). A number above it - a planted key, a server's answer - is
 *  ignored for the highest, and never numbered after. */
export declare const MAX_PLACEHOLDER_NUMBER = 100000000;
/** The most numbers one reservation may span (the server asks at most 5000). */
export declare const MAX_BLOCK_SPAN = 10000;
/** A run of numbers safe to number in: whole, in [1, 1e8], in order, short. */
export declare function isSaneBlock(b: unknown): b is Block;
/** A numbered placeholder of the local family. */
export declare function isLocalPlaceholder(token: string): boolean;
/** Whether a tag can name a checkout: six of `A-Z0-9`. */
export declare function isLocalTag(tag: unknown): tag is string;
/** `__VAR__`, `K7Q2XA` -> `__LOCAL_K7Q2XA_VAR__`. Throws on a bad tag, on
 *  something that is not a base, and on a base already local. */
export declare function localBaseOf(base: string, tag: string): string;
/** The team base a local base stands in for, or null for anything else. */
export declare function teamBaseOf(localBase: string): string | null;
/** A role-typed name (`__CLS__n` and the like) in either family. */
export declare function isRolePlaceholder(token: string): boolean;
/** Highest number per base in a map. */
export declare function highestPerKind(map: SymbolMap): Record<string, number>;
/** A block is usable while nothing in the map sits at or above its end. */
export declare function usableBlocks(map: SymbolMap, blocks: Record<string, Block>): Record<string, Block>;
/** Reserved numbers still free, over every usable block. */
export declare function numbersLeft(map: SymbolMap, blocks: Record<string, Block>): number;
