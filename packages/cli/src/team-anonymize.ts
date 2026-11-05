// Anonymizing from the team's namespace - one composition, used by
// `veilio scrub` and by the MCP server's anonymize tools (spec 030, F11 of the
// 2026-09-30 walk). It lived in the MCP server, so the CLI numbered from the
// project's own map only and gave a member's terminal placeholders that meant
// something else in the team.

import {
  anonymize,
  isSaneBlock,
  MAX_PLACEHOLDER_NUMBER,
  type AnonymizeOptions,
} from '@veilio-inc/engine'

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
    if (m && counted(m[2]) > (floors[m[1]] ?? 0)) floors[m[1]] = counted(m[2])
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
    if (m && counted(m[2]) > (inMap[m[1]] ?? 0)) inMap[m[1]] = counted(m[2])
  }
  const seeded = { ...options.existingMap }
  for (const [base, floor] of Object.entries(floors)) {
    // Never above 1e8 (the engine ignores it there) and never over an entry
    // the map holds: the marker is dropped from the result, and the entry with it.
    if (
      floor > (inMap[base] ?? 0) &&
      floor <= MAX_PLACEHOLDER_NUMBER &&
      !(`${base}${floor}` in options.existingMap)
    )
      seeded[`${base}${floor}`] = `${FLOOR_MARKER}${base}`
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
  options: Omit<AnonymizeOptions, 'existingMap' | 'team'>,
  /**
   * This checkout's blocks and local tag (spec 066 R3, from `teamNumbering`):
   * new names go inside a usable block, else into the local family - never
   * above the team's highest, which is where the next teammate's block starts.
   * Absent: no team numbering applies, and new names go above the floor.
   */
  numbering?: {
    blocks: Record<string, { start: number; end: number }>
    tag: string
    /** Placeholders a publish retired (aliases.json): never minted again. */
    retired?: readonly string[]
  }
): { result: ReturnType<typeof anonymize>; toPersist: Record<string, string> } {
  // A disputed placeholder keeps its first meaning in the engine's namespace
  // (for numbering); it is never emitted - the name gets a fresh number above
  // it (code review, spec 030: scrub emitted it, the MCP never did).
  const settled = Object.fromEntries(
    Object.entries(team.namespace).filter(([p]) => !(p in (team.conflicts ?? {})))
  )
  const existingMap = mergeNamespace(local, settled)
  const result = numbering
    ? anonymize(source, {
        ...options,
        existingMap,
        team: {
          blocks: numbering.blocks,
          tag: numbering.tag,
          ...(numbering.retired?.length ? { retired: numbering.retired } : {}),
        },
      })
    : anonymizeAbove(source, { ...options, existingMap }, floorsWith(team.highest, local))
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

/** A placeholder's number as a floor: one above 1e8 (planted) counts as none. */
function counted(digits: string): number {
  const n = Number(digits)
  return n <= MAX_PLACEHOLDER_NUMBER ? n : 0
}

/** Highest number per base in a map. */
export function highestPerBase(map: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const placeholder of Object.keys(map)) {
    const m = NUMBERED.exec(placeholder)
    if (m && counted(m[2]) > (out[m[1]] ?? 0)) out[m[1]] = counted(m[2])
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
    if (counted(m[2]) > (out[m[1]] ?? 0)) out[m[1]] = counted(m[2])
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

/** Cloud's reserve route refuses more numbers per base, or more bases, in one request. */
export const RESERVE_MAX_COUNT = 5000
export const RESERVE_MAX_BASES = 32

/**
 * `anonymizeOverTeam` for the files of one call, with every NEW number taken
 * from the team's allocation.
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
 *
 * Every file of one call goes through these steps together, with one
 * reservation for all of them (e40: a 164-file project made 164 reservations
 * and met Cloud's rate limit) - or one per group of files when they need more
 * than one request may ask. Pass 1 carries each file's names into the next, so
 * a name several files share is counted once; pass 2 numbers file after file
 * inside the reserved runs. A mismatch in any file fails the whole call - no
 * file comes back with numbers nobody reserved.
 */
export async function reservedAnonymizeFilesOverTeam(
  files: ReadonlyArray<{ source: string; options: Omit<AnonymizeOptions, 'existingMap'> }>,
  local: Record<string, string>,
  team: {
    namespace: Record<string, string>
    highest: Record<string, number>
    conflicts?: Record<string, number>
  },
  reserve: Reserve
): Promise<{
  results: ReturnType<typeof anonymize>[]
  /** How many entries each file added to the store. */
  added: number[]
  toPersist: Record<string, string>
}> {
  const settled = Object.fromEntries(
    Object.entries(team.namespace).filter(([p]) => !(p in (team.conflicts ?? {})))
  )
  const existingMap = mergeNamespace(local, settled)

  // Pass 1: each file over the names the earlier ones minted, so a name several
  // files share is counted once, for the first file that has it. The numbers
  // this pass chooses are discarded. The engine copies the map it is given.
  const seen = { ...existingMap }
  const firsts: ReturnType<typeof anonymize>[] = []
  const newIn: Map<string, number>[] = []
  for (const { source, options } of files) {
    const result = anonymize(source, { ...options, existingMap: seen })
    const counts = new Map<string, number>()
    for (const p of Object.keys(result.map)) {
      if (p in seen) continue
      const m = NUMBERED.exec(p)
      if (!m) throw new ReservationMismatch(p)
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
    }
    Object.assign(seen, result.map)
    firsts.push(result)
    newIn.push(counts)
  }

  /** The store after each result, and how many entries each added. */
  const keep = (results: ReturnType<typeof anonymize>[]) => {
    let toPersist = local
    const added = results.map((result) => {
      const before = Object.keys(toPersist).length
      toPersist = persisted(toPersist, result, settled)
      return Object.keys(toPersist).length - before
    })
    return { results, added, toPersist }
  }

  // Nothing new, so nothing to reserve. Returning the first pass is correct AND
  // is the only way to avoid a reservation of zero numbers, which the server
  // would answer with an empty run the verification below rejects.
  if (newIn.every((c) => c.size === 0)) return keep(firsts)

  // Files in groups, each within one request's limits - one group, one
  // reservation, for any project short of thousands of new names per base.
  // A single file over a limit cannot be split: it fails here, with the reason.
  const groups: Array<{ from: number; to: number; counts: Map<string, number> }> = []
  newIn.forEach((counts, i) => {
    const over = [...counts].find(([, n]) => n > RESERVE_MAX_COUNT)
    if (over || counts.size > RESERVE_MAX_BASES)
      throw new ReservationFailed(
        new Error(
          over
            ? `one file needs ${over[1]} new ${over[0]} names, more than the ${RESERVE_MAX_COUNT} one reservation may ask - scrub it in parts`
            : `one file needs new names in ${counts.size} kinds, more than the ${RESERVE_MAX_BASES} one reservation may ask - scrub it in parts`
        )
      )
    const last = groups.at(-1)
    const fits =
      last !== undefined &&
      [...counts].every(([base, n]) => (last.counts.get(base) ?? 0) + n <= RESERVE_MAX_COUNT) &&
      new Set([...last.counts.keys(), ...counts.keys()]).size <= RESERVE_MAX_BASES
    if (last && fits) {
      for (const [base, n] of counts) last.counts.set(base, (last.counts.get(base) ?? 0) + n)
      last.to = i + 1
    } else groups.push({ from: i, to: i + 1, counts: new Map(counts) })
  })

  // A number already taken - in this project's store (also one the merge with
  // the team's namespace left out), or in any file's text - is below every floor.
  const taken = highestPerBase(local)
  for (const { source } of files)
    for (const [base, n] of Object.entries(highestInText(source)))
      if (n > (taken[base] ?? 0)) taken[base] = n

  const map = { ...existingMap }
  const results: ReturnType<typeof anonymize>[] = []
  for (const group of groups) {
    const inMap = highestPerBase(map)
    const requests = [...group.counts].map(([base, count]) => ({
      base,
      count,
      floor: Math.max(team.highest[base] ?? 0, inMap[base] ?? 0, taken[base] ?? 0),
    }))
    let ranges: { base: string; start: number; end: number }[] = []
    if (requests.length > 0) {
      try {
        ranges = await reserve(requests)
      } catch (err) {
        throw new ReservationFailed(err)
      }
    }
    const byBase = new Map(ranges.map((r) => [r.base, r]))

    // Pass 2: `start - 1` as the floor, so the first new number IS `start`;
    // each later file of the group numbers above the earlier ones, inside the run.
    const floors: Record<string, number> = {}
    for (const { base } of requests) {
      const range = byBase.get(base)
      if (!range || !isSaneBlock(range)) throw new ReservationMismatch(`${base}*`)
      floors[base] = range.start - 1
    }
    const before = new Set(Object.keys(map))
    for (let i = group.from; i < group.to; i++) {
      const result = anonymizeAbove(
        files[i]!.source,
        { ...files[i]!.options, existingMap: map },
        floors
      )
      Object.assign(map, result.map)
      results.push(result)
    }

    // Every new placeholder of the group - none expected where nothing was reserved.
    for (const placeholder of Object.keys(map)) {
      if (before.has(placeholder)) continue
      const m = NUMBERED.exec(placeholder)
      const range = m ? byBase.get(m[1]) : undefined
      const n = m ? Number(m[2]) : NaN
      if (!range || n < range.start || n > range.end) throw new ReservationMismatch(placeholder)
    }
  }

  return keep(results)
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
