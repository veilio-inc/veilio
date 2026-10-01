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

import { resolveTeamNamespace, type TeamNamespaceResult } from '@veilio-inc/cli/team-namespace'
import { readCredential } from '@veilio-inc/cli/credential'
import { readTeamUnlock } from '@veilio-inc/cli/team-unlock'

export type NamespaceSource = 'team' | 'local'

export interface ResolvedNamespace {
  source: NamespaceSource
  /** Placeholder -> identifier, WITHOUT the disputed placeholders - so this
   *  server never emits one. Empty for 'local'. */
  namespace: Record<string, string>
  /** A second number a team map kept for an identifier that already had one
   *  (spec 017): text sent with it must restore too (spec 028). */
  aliases: Record<string, string>
  /** Placeholders the team's saved maps give DIFFERENT identifiers -> how many.
   *  Never emitted, never guessed back (spec 017). */
  conflicts: Record<string, number>
  /** Highest number per placeholder base in any readable team map, conflicts
   *  included: new names are numbered above it. */
  highest: Record<string, number>
  /** What the CLI's resolver found - including why it is 'local' when the team
   *  exists but its maps were not read (locked, unavailable). Never silent. */
  found: TeamNamespaceResult
  /** False for an older instance's server-merged namespace: usable to anonymize,
   *  never to restore - it cannot tell a disputed placeholder (spec 028). */
  conflictDetection: boolean
}

function localFrom(found: TeamNamespaceResult): ResolvedNamespace {
  return {
    source: 'local',
    namespace: {},
    aliases: {},
    conflicts: {},
    highest: {},
    found,
    conflictDetection: true,
  }
}

const LOCAL: ResolvedNamespace = localFrom({ status: 'local' })

let current: ResolvedNamespace = LOCAL
let priming: Promise<ResolvedNamespace> | null = null

/** The CLI's resolver, shaped for this server (spec 028: one resolver for both). */
async function fetchNamespace(
  home: string | undefined,
  opts: { retryDelayMs?: number; deadlineMs?: number }
): Promise<ResolvedNamespace> {
  const found = await resolveTeamNamespace(home, opts)
  if (found.status !== 'team') return localFrom(found)
  const { namespace, aliases, conflicts, highest } = found.analysis
  // A team with no maps yet has no namespace to share: 'local', as before. (A
  // team whose maps exist but none opened is 'unavailable', from the resolver.)
  if (Object.keys(namespace).length === 0 && Object.keys(conflicts).length === 0) {
    return localFrom({ status: 'local' })
  }
  return {
    source: 'team',
    namespace: Object.fromEntries(Object.entries(namespace).filter(([p]) => !(p in conflicts))),
    aliases,
    conflicts,
    highest,
    found,
    conflictDetection: found.conflictDetection,
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
  opts: { retryDelayMs?: number } = {}
): Promise<ResolvedNamespace> {
  primedWith = { home, opts }
  lastAttemptAt = Date.now()
  if (!priming) {
    priming = fetchNamespace(home, { deadlineMs: STARTUP_DEADLINE_MS, ...opts }).then(
      (resolved) => {
        current = resolved
        return resolved
      }
    )
  }
  return priming
}

/** A hung instance must not hold the agent's first tool call for 30 s. */
const STARTUP_DEADLINE_MS = 10_000
/** How often an 'unavailable' team is asked again, from a tool call. */
const UNAVAILABLE_RECHECK_MS = 30_000

let primedWith: { home?: string; opts: { retryDelayMs?: number } } = { opts: {} }
let lastAttemptAt = 0

/**
 * The cache must not outlive the reason it was cached (review): `veilio team
 * unlock` run after this server started said "restore again" and every retry
 * met the same cached `locked`. Called at the start of each tool call. Cheap
 * and synchronous - a local file read - and never waits: when there is
 * something new to fetch it starts the fetch and says 'loading'; the next call
 * sees the result. A settled `team` or `local` is kept for the process.
 */
export function refreshNamespaceIfStale(): 'unlocked' | 'retrying' | null {
  const status = current.found.status
  if (status !== 'locked' && status !== 'unavailable') return null
  if (priming && !settledFlag) return status === 'locked' ? 'unlocked' : 'retrying'
  const now = Date.now()
  const credential = status === 'locked' ? readCredential(primedWith.home) : null
  const due =
    status === 'locked'
      ? credential !== null &&
        readTeamUnlock(
          { instance: credential.instance, account: credential.account },
          primedWith.home
        ) !== null
      : now - lastAttemptAt >= UNAVAILABLE_RECHECK_MS
  if (!due) return null
  priming = null
  settledFlag = false
  void primeNamespace(primedWith.home, primedWith.opts).then(() => {
    settledFlag = true
  })
  return status === 'locked' ? 'unlocked' : 'retrying'
}
let settledFlag = true

/** Test support and callers that can wait: the in-flight (or last) resolution. */
export function namespaceSettled(): Promise<ResolvedNamespace> {
  return priming ?? Promise.resolve(current)
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
  settledFlag = true
  lastAttemptAt = 0
  primedWith = { opts: {} }
}

/**
 * The namespace line every anonymize result carries, with the reason when the
 * team exists but was not used - so a fallback is never mistaken for agreement.
 */
export function namespaceLine(resolved: ResolvedNamespace): string {
  if (resolved.source === 'team') return 'Namespace: team'
  const { found } = resolved
  if (found.status === 'locked')
    return 'Namespace: local (the team key is locked on this machine - run `veilio team unlock`)'
  if (found.status === 'unavailable')
    return `Namespace: local (could not read the team's maps: ${found.reason})`
  return 'Namespace: local'
}

export { mergeNamespace } from '@veilio-inc/cli/team-anonymize'
