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
import {
  listMaps,
  getMap,
  getUserKeys,
  getTeamKeyWraps,
  type CloudMapSummary,
  type CloudMapList,
} from '@veilio-inc/cli/cloud'
import {
  unwrapPrivateKey,
  unwrapTeamKey,
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
}

const LOCAL: ResolvedNamespace = { source: 'local', namespace: {} }

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
  vaultKey: CryptoKeyLike,
  list: CloudMapList
): Promise<Record<string, string> | null> {
  const teamId = list.team?.id
  if (!teamId) return null

  const keys = await readUserKeys(credential, vaultKey, teamId)
  if (keys.length === 0) return null

  // A member's OWN team maps arrive under personalMaps — the listing splits by
  // ownership, not by scope — so both lists have to be considered or this
  // member's own placeholders drop out of the shared namespace.
  const teamScoped = [...list.personalMaps, ...list.teamMaps].filter((m) => m.scope === 'team')

  const entries = await Promise.all(teamScoped.map((m) => openTeamMap(credential, m, keys)))
  const namespace = mergeTeamNamespace(entries)
  // Every map unreadable is not a team namespace, it is a failed one. Saying
  // `local` is honest; an empty `team` would claim agreement that is not there.
  return Object.keys(namespace).length > 0 ? namespace : null
}

/** This member's team keys, newest version first. */
async function readUserKeys(
  credential: Credential,
  vaultKey: CryptoKeyLike,
  teamId: string
): Promise<{ version: number; key: CryptoKeyLike }[]> {
  const mine = await getUserKeys(credential)
  // No keypair means this account has never opened the web app, so no teammate
  // could ever have wrapped a key to it. Nothing to wait for and nothing wrong.
  if (!mine.initialized) return []

  const privateKey = await unwrapPrivateKey(vaultKey, mine.privateKeyEncrypted)
  const { wraps } = await getTeamKeyWraps(credential, teamId)

  const keys: { version: number; key: CryptoKeyLike }[] = []
  for (const wrap of wraps) {
    try {
      keys.push({
        version: wrap.version,
        key: await unwrapTeamKey(wrap.wrapped_key, privateKey, {
          teamId,
          version: wrap.version,
          myPublicKey: mine.publicKey,
        }),
      })
    } catch {
      // A wrap from a granter whose key has since changed, or one this account
      // cannot open. Skipped rather than fatal: another version may still open
      // most of the team's maps, and holding none of them is already handled.
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

async function fetchNamespace(
  home: string | undefined,
  vaultKey: CryptoKeyLike | null
): Promise<ResolvedNamespace> {
  const credential = readCredential(home)
  // Not signed in. No request — a signed-out terminal has nothing to ask Cloud.
  if (!credential) return LOCAL

  try {
    const list = await listMaps(credential)

    // An older self-hosted Cloud may still merge server-side, and that answer
    // needs no key at all. Checked before the vault key so such a deployment
    // keeps working for a member who has not unlocked one.
    if (list.teamNamespace) return { source: 'team', namespace: list.teamNamespace }

    // Past here everything must be decrypted locally, so without a vault key
    // there is nothing further to try.
    if (!vaultKey) return LOCAL

    const namespace = await buildTeamNamespace(credential, vaultKey, list)
    if (!namespace) return LOCAL
    return { source: 'team', namespace }
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
export function primeNamespace(
  home?: string,
  vaultKey: CryptoKeyLike | null = null
): Promise<ResolvedNamespace> {
  if (!priming) {
    priming = fetchNamespace(home, vaultKey).then((resolved) => {
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
