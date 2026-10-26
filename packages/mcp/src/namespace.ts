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

// The namespace read is the MCP server's request too.
import './identity.js'
import { resolveTeamNamespace, type TeamNamespaceResult } from '@veilio-inc/cli/team-namespace'
import { readCredential } from '@veilio-inc/cli/credential'
import { readTeamUnlock } from '@veilio-inc/cli/team-unlock'
import { projectOverride, resolveOverride, type Env } from '@veilio-inc/cli/client'
type PrimeOptions = { retryDelayMs?: number; env?: Env }

/**
 * The project the namespace is for, as a cache key: VEILIO_PROJECT's value
 * when the server's environment sets it (spec 052 FR-012a), else the choice
 * kept with the sign-in. With the variable set, a `projects use` in a
 * terminal changes nothing here - the variable wins - so it must not throw
 * away a namespace the variable pinned.
 */
function scopeKey(home: string | undefined, env: Env | undefined): string | null {
  const override = projectOverride(env)
  if (override !== null) return `env:${override}`
  const stored = readCredential(home)?.project
  return stored ? `stored:${stored}` : null
}

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
  opts: {
    retryDelayMs?: number
    deadlineMs?: number
    env?: Env
    onProject?: (project: string | null) => void
  }
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
export function primeNamespace(home?: string, opts: PrimeOptions = {}): Promise<ResolvedNamespace> {
  primedWith = { home, opts }
  primed = true
  lastAttemptAt = Date.now()
  if (!priming) {
    // The project is read when the fetch STARTS, and the fetch is for that
    // project only. Its answer is kept only if it is still the newest fetch
    // and the credential still names that project: a prime that finishes
    // after the project changed holds the OLD project's maps, and assigning
    // it would put that project's placeholders into this one's work - the
    // cross-project leak FR-013 forbids (security review).
    const project = scopeKey(home, opts.env)
    const generation = ++primeGeneration
    primedProject = project
    settledFlag = false
    // The id the fetch resolved the project to: what the cache is FOR.
    let resolvedId: string | null = null
    priming = fetchNamespace(home, {
      deadlineMs: STARTUP_DEADLINE_MS,
      ...opts,
      onProject: (id) => (resolvedId = id),
    }).then((resolved) => {
      const still = scopeKey(home, opts.env) === project
      if (generation === primeGeneration && still) {
        current = resolved
        primedProjectId = resolvedId
        settledFlag = true
      }
      return current
    })
  }
  return priming
}

/** Which fetch is the newest; an older one's answer is discarded. */
let primeGeneration = 0

/** A hung instance must not hold the agent's first tool call for 30 s. */
const STARTUP_DEADLINE_MS = 10_000
/** How often an 'unavailable' team is asked again, from a tool call. */
const UNAVAILABLE_RECHECK_MS = 30_000

let primedWith: { home?: string; opts: PrimeOptions } = { opts: {} }
let lastAttemptAt = 0
let primed = false
/** The project the cached namespace is for (spec 052 FR-013). */
let primedProject: string | null = null
/**
 * The project ID the cached namespace was read for. VEILIO_PROJECT's value is
 * only a name, and a name can move: the project renamed, another one given the
 * old name, the value unchanged. The value says when to ASK again
 * (`confirmProject`); the id says whether the answer changed.
 */
let primedProjectId: string | null = null
/** Set by a team write through this server: the cache no longer matches. */
let invalidated = false

/**
 * The team's maps just changed through this server - a team map created,
 * updated or removed, or another project chosen - so the cached namespace is
 * out of date. The next tool call starts loading it again.
 */
export function invalidateNamespace(): void {
  invalidated = true
}

/**
 * The cache must not outlive the reason it was cached (review): `veilio team
 * unlock` run after this server started said "restore again" and every retry
 * met the same cached `locked`. Called at the start of each tool call. Cheap
 * and synchronous - a local file read - and never waits: when there is
 * something new to fetch it starts the fetch and says 'loading'; the next call
 * sees the result. A settled `team` or `local` is kept for the process.
 */
export function refreshNamespaceIfStale(): 'unlocked' | 'retrying' | 'changed' | null {
  // Another project chosen - by `veilio projects use` in a terminal while this
  // server runs, or by projects_use here - or a team write made here: the
  // namespace cached for the old state must not go on numbering the new one
  // (spec 052 edge case: the next call uses the new state).
  if (primed) {
    // Checked FIRST, whatever is in flight: a fetch already running is for the
    // project it started with, and is dropped (security review).
    const project = scopeKey(primedWith.home, primedWith.opts.env)
    if (project !== primedProject) {
      // The cached namespace is the OLD project's (FR-013): see
      // reloadForAnotherProject. Until the new project's maps load there is no
      // team namespace, and that is said.
      void reloadForAnotherProject()
      return 'changed'
    }
    // The same project, changed by a write made here: reload when nothing is
    // already loading, keeping the current (same-project) namespace meanwhile.
    if (invalidated && (!priming || settledFlag)) {
      invalidated = false
      priming = null
      void primeNamespace(primedWith.home, primedWith.opts)
      return 'changed'
    }
  }
  const status = current.found.status
  // 'refused' is asked again like 'unavailable': the variable cannot change in
  // this process, but the server's projects can - one created, or a shared
  // name made unique - and only the server's listing says which.
  if (status !== 'locked' && status !== 'unavailable' && status !== 'refused') return null
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
  void primeNamespace(primedWith.home, primedWith.opts)
  return status === 'locked' ? 'unlocked' : 'retrying'
}
let settledFlag = true

/** Drop what is cached and load again, saying so: the old answer was for
 *  another project, and numbering with it - even once - would put that
 *  project's placeholders into this one's store (FR-013). */
function reloadForAnotherProject(): Promise<ResolvedNamespace> {
  current = localFrom({
    status: 'unavailable',
    reason: "the team's maps for the project now in use are still loading",
  })
  invalidated = false
  priming = null
  return primeNamespace(primedWith.home, primedWith.opts)
}

/**
 * With VEILIO_PROJECT set, ask the server which project the value names NOW
 * (one project listing) and compare its ID with the one the cache was read
 * for. A different id - or a value that names nothing any more - drops the
 * cache and waits for the reload, so the call that follows numbers from the
 * right project. Without the variable, and before the first prime, it asks
 * nothing: the stored choice is checked by `refreshNamespaceIfStale`.
 *
 * Run before a tool that reserves numbers (anonymize) and by the tools that
 * write to the team's maps. A listing that fails changes nothing: Cloud being
 * down is not a reason to throw a good namespace away.
 */
export async function confirmProject(): Promise<void> {
  if (!primed) return
  const { home, opts } = primedWith
  const value = projectOverride(opts.env)
  if (value === null) return
  if (priming && !settledFlag) await priming
  const credential = readCredential(home)
  if (!credential) return
  let now: string | null
  try {
    const scoped = await resolveOverride(credential, value)
    now = scoped.ok ? (scoped.value.project ?? null) : null
  } catch {
    return
  }
  const refusedAlready = current.found.status === 'refused'
  if (now === null ? refusedAlready : now === primedProjectId) return
  await reloadForAnotherProject()
}

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
  primed = false
  primedProject = null
  primedProjectId = null
  invalidated = false
  primeGeneration++
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
  if (found.status === 'refused') return `Namespace: none (${found.refusal.message})`
  return 'Namespace: local'
}
