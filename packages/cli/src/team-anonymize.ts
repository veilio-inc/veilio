// Anonymizing from the team's namespace - one composition, used by
// `veilio scrub` and by the MCP server's anonymize tools (spec 030, F11 of the
// 2026-09-30 walk). It lived in the MCP server, so the CLI numbered from the
// project's own map only and gave a member's terminal placeholders that meant
// something else in the team.

import { anonymize, type AnonymizeOptions } from '@veilio-inc/engine'

/**
 * The map handed to the engine to anonymize: this project's store and the
 * team's namespace, reconciled so that nothing emitted can mean something else
 * to a teammate (spec 028 R5; this replaced spec 005's "the local placeholder
 * wins", which after a lapse emitted staging's `createInvoice` as __FN__1 - the
 * team's `chargeCustomer`).
 *
 * The two placeholder spaces are numbered independently, so a shared key is
 * coincidence, not identity:
 *
 *   - An identifier the team knows takes the TEAM's placeholder. The project's
 *     own placeholder for it is left out (it stays in the store, for restoring
 *     text already sent) - one placeholder per identifier, always.
 *   - A placeholder the project's store and the team use for DIFFERENT
 *     identifiers is used for neither: the store must keep its meaning (text was
 *     sent with it; `saveMap` refuses to lose it), and emitting it would mean the
 *     team's identifier to every teammate. Both identifiers get fresh numbers.
 *   - Everything else - a local entry the team does not contradict, a team entry
 *     the store does not contradict - is used as it is.
 */
export function mergeNamespace(
  local: Record<string, string>,
  team: Record<string, string>
): Record<string, string> {
  const merged: Record<string, string> = {}
  const placed = new Set<string>()
  for (const [placeholder, identifier] of Object.entries(team)) {
    if (placeholder in local && local[placeholder] !== identifier) continue
    if (placed.has(identifier)) continue
    merged[placeholder] = identifier
    placed.add(identifier)
  }
  for (const [placeholder, identifier] of Object.entries(local)) {
    if (placeholder in team && team[placeholder] !== identifier) continue
    if (placed.has(identifier)) continue
    merged[placeholder] = identifier
    placed.add(identifier)
  }
  return merged
}

/** Whether `placeholder` appears in `text` as a whole token, not as a prefix of
 *  a longer one — `__CLS__1` must not match inside `__CLS__10`. Used to decide
 *  which team-namespace entries a masking result actually leaned on. */
export function appearsAsToken(text: string, placeholder: string): boolean {
  const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).test(text)
}

const NUMBERED = /^(__[A-Z][A-Z0-9_]*__)(\d+)$/
const FLOOR_MARKER = '\u0000floor:'

/**
 * Anonymize with every NEW number above `floors[base]` (spec 017).
 *
 * The engine numbers above the highest number in the map it is given, so a
 * marker entry at the floor moves the counter there. Markers hold a NUL no
 * identifier contains, match nothing in the text, and are stripped from the
 * returned map. Only added above the map's own highest, where they cannot
 * overwrite a real entry. Same technique as the Cloud web app.
 */
/** The team's highest number per base, raised to this project's own where higher. */
export function floorsWith(
  highest: Record<string, number>,
  local: Record<string, string>
): Record<string, number> {
  const floors = { ...highest }
  for (const placeholder of Object.keys(local)) {
    const m = NUMBERED.exec(placeholder)
    if (m && Number(m[2]) > (floors[m[1]] ?? 0)) floors[m[1]] = Number(m[2])
  }
  return floors
}

export function anonymizeAbove(
  source: string,
  options: AnonymizeOptions & { existingMap: Record<string, string> },
  floors: Record<string, number>
): ReturnType<typeof anonymize> {
  const inMap: Record<string, number> = {}
  for (const p of Object.keys(options.existingMap)) {
    const m = NUMBERED.exec(p)
    if (m && Number(m[2]) > (inMap[m[1]] ?? 0)) inMap[m[1]] = Number(m[2])
  }
  const seeded = { ...options.existingMap }
  for (const [base, floor] of Object.entries(floors)) {
    if (floor > (inMap[base] ?? 0)) seeded[`${base}${floor}`] = `${FLOOR_MARKER}${base}`
  }
  const result = anonymize(source, { ...options, existingMap: seeded })
  const map = Object.fromEntries(
    Object.entries(result.map).filter(([, identifier]) => !identifier.startsWith(FLOOR_MARKER))
  )
  return { ...result, map }
}

/**
 * Anonymize `source` over this project's map and the team's namespace, and say
 * what to keep in the project map: everything it held, whatever this call
 * minted, and only the team entries the output uses - never the rest of the
 * team's namespace (spec 005 US4: those would outlive the entitlement that
 * fetched them).
 */
export function anonymizeOverTeam(
  source: string,
  local: Record<string, string>,
  team: {
    namespace: Record<string, string>
    highest: Record<string, number>
    /** Placeholders the team's maps give different names: never emitted (spec 028). */
    conflicts?: Record<string, number>
  },
  options: Omit<AnonymizeOptions, 'existingMap'>
): { result: ReturnType<typeof anonymize>; toPersist: Record<string, string> } {
  // A disputed placeholder keeps its first meaning in the engine's namespace
  // (for numbering); it is never emitted - the name gets a fresh number above
  // it (code review, spec 030: scrub emitted it, the MCP never did).
  const settled = Object.fromEntries(
    Object.entries(team.namespace).filter(([p]) => !(p in (team.conflicts ?? {})))
  )
  const existingMap = mergeNamespace(local, settled)
  const result = anonymizeAbove(
    source,
    { ...options, existingMap },
    floorsWith(team.highest, local)
  )
  const toPersist = {
    ...local,
    ...Object.fromEntries(
      Object.entries(result.map).filter(
        ([placeholder]) =>
          !(placeholder in settled) ||
          placeholder in local ||
          appearsAsToken(result.anonymized, placeholder)
      )
    ),
  }
  return { result, toPersist }
}
