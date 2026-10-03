import type { SymbolMap } from './types.js';
/**
 * The restore rule, defined once for the web app, the CLI and the MCP server
 * (spec 028). Until it existed each surface had its own, and the same text
 * restored three different ways: only the web app used the team's maps, so a
 * member could not restore a teammate's placeholders from a terminal or an agent.
 *
 * - The team layer: the namespace and its aliases (a second number a map kept
 *   for an identifier that already had one), WITHOUT the placeholders the team's
 *   saved maps disagree about - restoring one of those would be a guess, and a
 *   wrong guess reads exactly like a right one (spec 017).
 * - The caller's own map on top, and it wins: it records the meaning this person
 *   actually used, which also settles a disputed placeholder for them.
 * - `disputedIn(text)`: the disputed placeholders the text holds that the own
 *   map does not settle - left unrestored, and named by every surface.
 */
export interface TeamLayer {
    namespace: Record<string, string>;
    aliases: Record<string, string>;
    /** Placeholder -> how many identifiers the maps give it. */
    conflicts: Record<string, number>;
}
export interface RestoreLayers {
    map: SymbolMap;
    /** Disputed in the team's maps, in the text, not settled by the own map. */
    disputedIn(text: string): string[];
    /** Own entries the team layer contradicts - locally numbered - in the text. */
    locallyNumberedIn(text: string): string[];
}
export declare function restoreLayers(input: {
    own: SymbolMap;
    team: TeamLayer | null;
}): RestoreLayers;
/** How the CLI and the MCP name the disputed placeholders they left - one wording. */
export declare function disputedNote(placeholders: readonly string[]): string;
/**
 * How the CLI and the MCP name a placeholder they left because this project's
 * map and the team's maps disagree on it. It states the disagreement, which is
 * known, and gives the causes only as examples: a map pulled from Cloud
 * disagrees just as one numbered while signed out does (staging walk,
 * 2026-10-01).
 */
export declare function locallyNumberedNote(placeholders: readonly string[]): string;
/** How the CLI and the MCP name the altered placeholders they left (spec 029). */
export declare function alteredNote(placeholders: readonly string[]): string;
