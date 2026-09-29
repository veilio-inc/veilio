import type { SymbolMap } from './types.js'

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
  namespace: Record<string, string>
  aliases: Record<string, string>
  /** Placeholder -> how many identifiers the maps give it. */
  conflicts: Record<string, number>
}

export interface RestoreLayers {
  map: SymbolMap
  /** Disputed in the team's maps, in the text, not settled by the own map. */
  disputedIn(text: string): string[]
  /** Own entries the team layer contradicts - locally numbered - in the text. */
  locallyNumberedIn(text: string): string[]
}

export function restoreLayers(input: { own: SymbolMap; team: TeamLayer | null }): RestoreLayers {
  const { own, team } = input
  if (!team) return { map: { ...own }, disputedIn: () => [], locallyNumberedIn: () => [] }

  const layer: SymbolMap = { ...team.aliases, ...team.namespace }
  for (const placeholder of Object.keys(team.conflicts)) delete layer[placeholder]

  // The own map wins only where it is provably in the team's numbering (spec 028
  // R5): the team gives that placeholder the same identifier, the team does not
  // know the placeholder at all, or the team's maps dispute it and the own map
  // settles which meaning was used. An own entry the team CONTRADICTS was
  // numbered locally - signed out, during a lapse, before `veilio team unlock` -
  // and its number means something else in the team's maps. Neither meaning is
  // safe for this text, so the placeholder is left and named. (The web app's own
  // map is numbered from the team's reservations, so for it this never fires.)
  const contradicted = Object.keys(own).filter(
    (p) => !(p in team.conflicts) && p in layer && layer[p] !== own[p]
  )
  const map: SymbolMap = { ...layer, ...own }
  for (const p of contradicted) delete map[p]

  const unsettled = Object.keys(team.conflicts).filter((p) => !(p in own))
  return {
    map,
    disputedIn: (text) => unsettled.filter((p) => appearsAsToken(text, p)),
    locallyNumberedIn: (text) => contradicted.filter((p) => appearsAsToken(text, p)),
  }
}

/** A whole placeholder token - not a piece of a longer identifier or number. */
function appearsAsToken(text: string, placeholder: string): boolean {
  const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).test(text)
}

/** How the CLI and the MCP name the disputed placeholders they left - one wording. */
export function disputedNote(placeholders: readonly string[]): string {
  return (
    `left as is: ${placeholders.join(', ')}. The team's saved maps give ` +
    `${placeholders.length === 1 ? 'this placeholder' : 'these placeholders'} different identifiers, ` +
    'so restoring would be a guess.'
  )
}

/** How the CLI and the MCP name a locally numbered placeholder they left. */
export function locallyNumberedNote(placeholders: readonly string[]): string {
  return (
    `left as is: ${placeholders.join(', ')}. This project's map numbered ` +
    `${placeholders.length === 1 ? 'it' : 'them'} locally (signed out, during a lapse, or before ` +
    "`veilio team unlock`), and the team's maps use the same number for a different identifier, " +
    'so restoring would be a guess.'
  )
}
