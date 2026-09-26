// The team's shared placeholder namespace — fetched once per MCP session, with
// a fallback that is never silent (spec 005 US4, contracts/shared-namespace.md).
//
// A coding agent must keep working when Cloud is down, when the user never
// signed in, or when the plan does not include shared dictionaries. All three
// fall back to the local namespace identically. What must never happen is a
// SILENT fallback: two teammates' agents quietly disagreeing about placeholder
// names is indistinguishable from success until someone tries to share a map,
// which is exactly the failure Constitution V exists to prevent.
//
// Session lifetime here is process lifetime — an MCP server is spawned per
// client session — so the fetch happens once, at startup (`primeNamespace`,
// called from index.ts before stdin is wired up), and every tool handler reads
// the already-resolved result synchronously (`getNamespace`). This keeps the
// whole JSON-RPC pipeline (server.ts, tools.ts) synchronous rather than
// threading a Promise through 78 existing call sites for one network call that
// happens once per process.

import { readCredential, type Credential } from '@veilio-inc/cli/credential'
import { listMaps, getMap, type CloudMapSummary, type CloudMapList } from '@veilio-inc/cli/cloud'
import { readTeamUnlock } from '@veilio-inc/cli/team-unlock'
import {
  importTeamKey,
  decryptTeamMapWithAny,
  mergeTeamNamespace,
  type CryptoKeyLike,
  type TeamMapEntry,
  type TeamMapEnvelope,
} from '@veilio-inc/engine'

export type NamespaceSource = 'team' | 'local'

export interface ResolvedNamespace {
  source: NamespaceSource
  /** Placeholder -> identifier. Empty for 'local' — there is nothing to merge. */
  namespace: Record<string, string>
  /**
   * Placeholders the team's saved maps give DIFFERENT identifiers (maps saved
   * before Cloud reserved numbers - spec 017). Left out of `namespace`, so this
   * server never emits one, and `restore_text` refuses to guess them.
   */
  conflicts: string[]
  /**
   * Highest number per placeholder base in ANY readable team map, conflicts
   * included. New names are numbered above it, so this server never hands a
   * new identifier a number the team already uses for something else.
   */
  highest: Record<string, number>
}

const LOCAL: ResolvedNamespace = { source: 'local', namespace: {}, conflicts: [], highest: {} }

const NUMBERED = /^(__[A-Z][A-Z0-9_]*__)(\d+)$/

/** Highest number per base across every readable map. */
export function highestAcross(entries: readonly TeamMapEntry[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const entry of entries) {
    for (const placeholder of Object.keys(entry.map ?? {})) {
      const m = NUMBERED.exec(placeholder)
      if (m && Number(m[2]) > (out[m[1]] ?? 0)) out[m[1]] = Number(m[2])
    }
  }
  return out
}

/** Placeholders that readable maps give more than one identifier. */
export function findConflicts(entries: readonly TeamMapEntry[]): string[] {
  const meanings = new Map<string, Set<string>>()
  for (const entry of entries) {
    for (const [placeholder, identifier] of Object.entries(entry.map ?? {})) {
      const seen = meanings.get(placeholder) ?? new Set<string>()
      seen.add(identifier)
      meanings.set(placeholder, seen)
    }
  }
  return [...meanings].filter(([, seen]) => seen.size > 1).map(([p]) => p)
}

let current: ResolvedNamespace = LOCAL
let priming: Promise<ResolvedNamespace> | null = null

/**
 * Build the team namespace from maps this member can actually open.
 *
 * Cloud used to merge these server-side and send the result. It stopped,
 * because merging meant decrypting every team map, and that was the only reason
 * it held a key that could read them. So the merge happens here now, over maps
 * only this member can decrypt, and the server holds nothing that would let it
 * do the same (spec 010).
 *
 * Entitlement is still not decided here, and still does not need to be. Cloud
 * serves team maps only for teams in `access.teams`, and refuses a non-member's
 * request for a team key outright. A user outside a paid team gets neither, so
 * there is nothing to merge — the gate is the data, not a flag this code reads.
 */
async function buildTeamNamespace(
  credential: Credential,
  keys: readonly { version: number; key: CryptoKeyLike }[],
  list: CloudMapList
): Promise<{
  namespace: Record<string, string>
  conflicts: string[]
  highest: Record<string, number>
} | null> {
  // A member's OWN team maps arrive under personalMaps — the listing splits by
  // ownership, not by scope — so both lists have to be considered or this
  // member's own placeholders drop out of the shared namespace.
  const teamScoped = [...list.personalMaps, ...list.teamMaps].filter((m) => m.scope === 'team')

  const entries = await Promise.all(teamScoped.map((m) => openTeamMap(credential, m, keys)))
  const merged = mergeTeamNamespace(entries)
  // Every map unreadable is not a team namespace, it is a failed one. Saying
  // `local` is honest; an empty `team` would claim agreement that is not there.
  if (Object.keys(merged).length === 0) return null
  const conflicts = findConflicts(entries)
  const namespace = Object.fromEntries(
    Object.entries(merged).filter(([p]) => !conflicts.includes(p))
  )
  return { namespace, conflicts, highest: highestAcross(entries) }
}

/**
 * The team keys this machine has unlocked, if any.
 *
 * Read from disk rather than derived, because an MCP server starts inside a
 * coding agent with nobody present to type a vault passphrase. `veilio team
 * unlock` is the interactive run that puts them there; see the CLI's
 * `team-unlock.ts` for what is stored and what it costs.
 *
 * Absent, expired, or belonging to another account all read the same way —
 * nothing unlocked — because all three mean the same thing here.
 */
async function heldTeamKeys(
  credential: Credential,
  home: string | undefined,
  teamId: string
): Promise<{ version: number; key: CryptoKeyLike }[]> {
  const unlock = readTeamUnlock(
    { instance: credential.instance, account: credential.account },
    home
  )
  if (!unlock) return []
  // Unlocked for a different team than the one this account is currently in.
  // Possible after leaving one team and joining another without re-unlocking.
  if (unlock.teamId !== teamId) return []

  const keys: { version: number; key: CryptoKeyLike }[] = []
  for (const stored of unlock.keys) {
    try {
      keys.push({ version: stored.version, key: await importTeamKey(stored.key) })
    } catch {
      // A damaged entry. Skipped rather than fatal, for the same reason an
      // unopenable map is: the others may still carry the team's namespace.
      continue
    }
  }
  return keys
}

/** One team map, opened if any held key fits. */
async function openTeamMap(
  credential: Credential,
  summary: CloudMapSummary,
  keys: readonly { version: number; key: CryptoKeyLike }[]
): Promise<TeamMapEntry> {
  const miss: TeamMapEntry = { createdAt: summary.created_at, map: null }
  try {
    const full = await getMap(credential, summary.id)
    // A server-decrypted map arrives as an object. Nothing to open, and nothing
    // that should be here — but reading it is safe and losing it would drop a
    // teammate's placeholders for no reason.
    if (typeof full.map_data !== 'string') {
      return { createdAt: summary.created_at, map: full.map_data }
    }
    const envelope = JSON.parse(full.map_data) as TeamMapEnvelope
    return {
      createdAt: summary.created_at,
      map: await decryptTeamMapWithAny(keys, envelope),
    }
  } catch {
    // One unreadable map must never cost the team its namespace. `null` is how
    // mergeTeamNamespace is told to skip it.
    return miss
  }
}

async function fetchNamespace(home: string | undefined): Promise<ResolvedNamespace> {
  const credential = readCredential(home)
  // Not signed in. No request — a signed-out terminal has nothing to ask Cloud.
  if (!credential) return LOCAL

  try {
    const list = await listMaps(credential)

    // An older self-hosted Cloud may still merge server-side, and that answer
    // needs no key at all. Checked before the vault key so such a deployment
    // keeps working for a member who has not unlocked one.
    if (list.teamNamespace) {
      return { source: 'team', namespace: list.teamNamespace, conflicts: [], highest: {} }
    }

    // Past here everything must be decrypted locally, so without keys on disk
    // there is nothing further to try. That is the state until somebody has run
    // `veilio team unlock` in a terminal.
    const teamId = list.team?.id
    if (!teamId) return LOCAL
    const keys = await heldTeamKeys(credential, home, teamId)
    if (keys.length === 0) return LOCAL

    const built = await buildTeamNamespace(credential, keys, list)
    if (!built) return LOCAL
    return { source: 'team', ...built }
  } catch {
    // Unreachable, revoked session, timed out — every network or auth failure
    // degrades the same way. A coding agent must keep working when Cloud is
    // down; the fallback itself is what gets reported, not this failure.
    return LOCAL
  }
}

/**
 * Resolve the namespace once and cache it for the rest of the process.
 *
 * Concurrent callers share one in-flight fetch (R-007) rather than each firing
 * their own request. `home` is injectable for tests; production leaves it
 * undefined and `readCredential` falls back to the real home directory.
 */
export function primeNamespace(home?: string): Promise<ResolvedNamespace> {
  if (!priming) {
    priming = fetchNamespace(home).then((resolved) => {
      current = resolved
      return resolved
    })
  }
  return priming
}

/** The already-resolved namespace. `local` (with an empty namespace) until
 *  `primeNamespace` has been called and settled — the safe default for any
 *  caller that never primes, including every existing offline-only test. */
export function getNamespace(): ResolvedNamespace {
  return current
}

/** Test-only: forget the cached result so the next `primeNamespace` refetches. */
export function resetNamespaceCache(): void {
  current = LOCAL
  priming = null
}

/**
 * Overlay a team namespace onto a local map, safely.
 *
 * Both are `Record<placeholder, identifier>`, and that similarity is a trap: the
 * two placeholder spaces are numbered independently — the local map by this
 * project's own engine, the team's by `mergeTeamNamespace` walking every
 * member's own maps — so `__CLS__1` in one has no relation to `__CLS__1` in the
 * other beyond coincidence. A blind `{ ...local, ...team }` merge treats that
 * coincidence as identity: two different identifiers that happen to land on the
 * same key collide, `saveMap` then refuses the write as data loss (or, worse,
 * silently drops one identifier's real mapping if the guard is bypassed), and
 * text already restored under the shadowed placeholder now resolves to the
 * wrong name.
 *
 * So this reconciles by IDENTIFIER, which is the thing two teammates actually
 * want to agree on, and it only ever ADDS to `local` — never overwrites an
 * existing key, never introduces a second placeholder for an identifier `local`
 * already has under a different one:
 *
 *   - an identifier already known locally (under any placeholder) keeps its
 *     local placeholder — converging it to the team's would relabel every
 *     already-anonymized reference to it, which is not this call's to decide
 *   - a team entry whose placeholder KEY is already taken locally by a
 *     DIFFERENT identifier is dropped rather than forced in; that one
 *     identifier just doesn't converge with the team this round and gets a
 *     fresh local placeholder from the engine instead, which is a safe
 *     degradation, not a corruption
 *   - everything else — a team identifier neither known locally nor colliding
 *     on key — is added under the team's placeholder, which is the case two
 *     fresh sessions (T044) actually converge through
 */
export function mergeNamespace(
  local: Record<string, string>,
  team: Record<string, string>
): Record<string, string> {
  const merged = { ...local }
  const knownIdentifiers = new Set(Object.values(local))
  for (const [placeholder, identifier] of Object.entries(team)) {
    if (knownIdentifiers.has(identifier)) continue
    if (placeholder in merged) continue
    merged[placeholder] = identifier
    knownIdentifiers.add(identifier)
  }
  return merged
}
