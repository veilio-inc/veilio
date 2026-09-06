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

import { readCredential } from '@veilio-inc/cli/credential'
import { listMaps } from '@veilio-inc/cli/cloud'

export type NamespaceSource = 'team' | 'local'

export interface ResolvedNamespace {
  source: NamespaceSource
  /** Placeholder -> identifier. Empty for 'local' — there is nothing to merge. */
  namespace: Record<string, string>
}

const LOCAL: ResolvedNamespace = { source: 'local', namespace: {} }

let current: ResolvedNamespace = LOCAL
let priming: Promise<ResolvedNamespace> | null = null

async function fetchNamespace(home: string | undefined): Promise<ResolvedNamespace> {
  const credential = readCredential(home)
  // Not signed in. No request — a signed-out terminal has nothing to ask Cloud.
  if (!credential) return LOCAL

  try {
    const { teamNamespace } = await listMaps(credential)
    // No active team, or the plan lacks shared dictionaries — the server's
    // entitlement answer (getEffectiveAccess), not a decision made here.
    if (!teamNamespace) return LOCAL
    return { source: 'team', namespace: teamNamespace }
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
