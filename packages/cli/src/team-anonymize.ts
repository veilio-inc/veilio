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
  return { result, toPersist: persisted(local, result, settled) }
}

// ─── reserved numbering ──────────────────────────────────────────────────────
//
// `anonymizeOverTeam` above numbers above a FLOOR: the team's highest, raised
// to this project's own. That is enough to stop a terminal re-using a number
// the team has already written, and it is not enough to stop two terminals
// minting the same number at the same moment — both compute the same floor and
// both number from it. On staging two members each got `__FN__6`, and one
// member's restore named the other's function (spec 017).
//
// So numbers for a map that will be PUBLISHED come out of the team's shared
// allocation instead. The server hands out runs; this picks within them.
//
// Deliberately a separate entry point rather than a flag on
// `anonymizeOverTeam`: that function is shared with the MCP server, which never
// publishes a shared map (FR-009) and so must never reach the network to
// reserve. An agent that reserved numbers it then discarded would consume the
// team's allocation on every tool call.

/** Highest number per base in a map. */
export function highestPerBase(map: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const placeholder of Object.keys(map)) {
    const m = NUMBERED.exec(placeholder)
    if (m && Number(m[2]) > (out[m[1]] ?? 0)) out[m[1]] = Number(m[2])
  }
  return out
}

const TOKEN = /(?<![A-Za-z0-9_$])(__[A-Z][A-Z0-9_]*__)(\d+)(?![A-Za-z0-9_$])/g

/**
 * Highest number per base among placeholders ALREADY IN the text.
 *
 * The engine numbers above those too, so a floor that ignored them would
 * reserve a run the engine then numbers past — producing placeholders nobody
 * reserved, which is the failure this whole path exists to prevent. Reached
 * when already-masked text is scrubbed again, which is ordinary: a partially
 * masked file, or output piped back through.
 */
export function highestInText(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of text.matchAll(TOKEN)) {
    if (Number(m[2]) > (out[m[1]] ?? 0)) out[m[1]] = Number(m[2])
  }
  return out
}

/** The reservation call, injected so this stays testable and offline-safe. */
export type Reserve = (
  requests: { base: string; count: number; floor: number }[]
) => Promise<{ base: string; start: number; end: number }[]>

/** A placeholder was minted outside the run reserved for it. */
export class ReservationMismatch extends Error {
  constructor(placeholder: string) {
    super(`${placeholder} is outside the numbers reserved for it`)
    this.name = 'ReservationMismatch'
  }
}

/** The reservation itself did not happen: refused, unreachable, plan lapsed. */
export class ReservationFailed extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'ReservationFailed'
  }
}

/**
 * `anonymizeOverTeam`, with every NEW number taken from the team's allocation.
 *
 * Two passes, because only this machine can read the identifiers and so only
 * this machine can know how many new names there are — but it may not choose
 * their numbers:
 *
 *   1. anonymize once to learn which new placeholders the text needs, per base.
 *      Which numbers this pass picks does not matter and is thrown away.
 *   2. reserve that many per base, declaring the floor this machine has seen.
 *   3. anonymize again, seeded so numbering continues from each reserved start.
 *      The engine numbers above the highest number it is given and numbers the
 *      same input the same way twice, so the second pass is deterministic.
 *   4. verify every new placeholder landed inside its run, and fail rather than
 *      return output carrying numbers nobody reserved.
 *
 * Step 4 is not belt-and-braces. If it ever fires, the alternative is a map
 * that looks correct, publishes, and collides with a teammate's — the exact
 * failure that is invisible until someone restores the wrong name.
 */
export async function reservedAnonymizeOverTeam(
  source: string,
  local: Record<string, string>,
  team: {
    namespace: Record<string, string>
    highest: Record<string, number>
    conflicts?: Record<string, number>
  },
  options: Omit<AnonymizeOptions, 'existingMap'>,
  reserve: Reserve
): Promise<{ result: ReturnType<typeof anonymize>; toPersist: Record<string, string> }> {
  const settled = Object.fromEntries(
    Object.entries(team.namespace).filter(([p]) => !(p in (team.conflicts ?? {})))
  )
  const existingMap = mergeNamespace(local, settled)

  // Pass 1: count the new names per base. No floor needed — the numbers this
  // pass chooses are discarded.
  const first = anonymize(source, { ...options, existingMap })
  const fresh = Object.keys(first.map).filter((p) => !(p in existingMap))
  if (fresh.length === 0) {
    // Nothing new, so nothing to reserve. Returning the first pass is correct
    // AND is the only way to avoid a reservation of zero numbers, which the
    // server would answer with an empty run the verification below rejects.
    return { result: first, toPersist: persisted(local, first, settled) }
  }

  const counts = new Map<string, number>()
  for (const p of fresh) {
    const m = NUMBERED.exec(p)
    if (!m) throw new ReservationMismatch(p)
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
  }

  const inMap = highestPerBase(existingMap)
  const inText = highestInText(source)
  const requests = [...counts].map(([base, count]) => ({
    base,
    count,
    floor: Math.max(team.highest[base] ?? 0, inMap[base] ?? 0, inText[base] ?? 0),
  }))

  let ranges: { base: string; start: number; end: number }[]
  try {
    ranges = await reserve(requests)
  } catch (err) {
    throw new ReservationFailed(err)
  }
  const byBase = new Map(ranges.map((r) => [r.base, r]))

  // Pass 2: `start - 1` as the floor, so the first new number IS `start`.
  const floors: Record<string, number> = {}
  for (const { base } of requests) {
    const range = byBase.get(base)
    if (!range) throw new ReservationMismatch(`${base}*`)
    floors[base] = range.start - 1
  }
  const second = anonymizeAbove(source, { ...options, existingMap }, floors)

  for (const placeholder of Object.keys(second.map)) {
    if (placeholder in existingMap) continue
    const m = NUMBERED.exec(placeholder)
    const range = m ? byBase.get(m[1]) : undefined
    const n = m ? Number(m[2]) : NaN
    if (!range || n < range.start || n > range.end) throw new ReservationMismatch(placeholder)
  }

  return { result: second, toPersist: persisted(local, second, settled) }
}

/** What the project's store keeps: everything it held, whatever was minted, and
 *  only the team entries the output actually used (spec 005 US4). Shared with
 *  `anonymizeOverTeam`, whose rule this is. */
function persisted(
  local: Record<string, string>,
  result: ReturnType<typeof anonymize>,
  settled: Record<string, string>
): Record<string, string> {
  return {
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
}
