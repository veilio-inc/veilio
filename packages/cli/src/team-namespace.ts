// The team's shared placeholder namespace, read from Cloud and opened with the
// team keys `veilio team unlock` left on disk.
//
// Moved here from the MCP server (spec 028) so that `veilio restore` reads the
// team's maps exactly as the MCP does - until then only the web app restored a
// teammate's placeholders. The MCP imports it, as it already imports `cloud`
// and `team-unlock`.
//
// It never falls back quietly. What it found is one of four states, and the
// caller says which: a coding agent or a terminal that silently used the local
// namespace looked exactly like one that used the team's, until a teammate's
// placeholders came back unrestored (Constitution V).

import {
  analyzeTeamNamespace,
  decryptTeamMapWithAny,
  importTeamKey,
  type CryptoKeyLike,
  type TeamMapEntry,
  type TeamMapEnvelope,
  type TeamNamespaceAnalysis,
} from '@veilio-inc/engine'
import { readCredential, type Credential } from './credential.js'
import {
  CloudError,
  getMap,
  getTeamEnvelopes,
  listMaps,
  type CloudMapList,
  type CloudMapSummary,
} from './cloud.js'
import { readTeamUnlock } from './team-unlock.js'

export type TeamNamespaceResult =
  /**
   * The team's maps, read and analyzed (namespace, aliases, conflicts, highest).
   * `conflictDetection: false`: an older instance merged them server-side, with
   * no way to tell a disputed placeholder from a first-written one - fine for
   * anonymizing, never used to restore (spec 028, review).
   */
  | { status: 'team'; analysis: TeamNamespaceAnalysis; conflictDetection: boolean }
  /** Nothing to read: signed out, or not in a team. The local namespace is right. */
  | { status: 'local' }
  /** In a team, but no team key on this machine: `veilio team unlock`. */
  | { status: 'locked' }
  /** In a team, and the maps could not be read. `reason` says why. */
  | { status: 'unavailable'; reason: string }

/**
 * Worth one more try: the network, or the server. Not a 401/402/403 - a lapsed
 * or revoked account does not come back in a second, and it is not a team
 * failure either (review): there is no team to speak of.
 */
function transient(err: unknown): boolean {
  return err instanceof CloudError && (err.kind === 'unreachable' || err.kind === 'server')
}

function noTeamToSpeakOf(err: unknown): boolean {
  return (
    err instanceof CloudError &&
    (err.kind === 'unauthenticated' ||
      err.kind === 'unentitled' ||
      err.kind === 'forbidden' ||
      err.kind === 'suspended')
  )
}

const RETRY_DELAY_MS = 1500

export async function resolveTeamNamespace(
  home?: string,
  opts: {
    retryDelayMs?: number
    /** Give up after this long in total (the CLI's pipeline cap). */
    deadlineMs?: number
  } = {}
): Promise<TeamNamespaceResult> {
  const credential = readCredential(home)
  // Not signed in: no request - a signed-out terminal has nothing to ask Cloud.
  if (!credential) return { status: 'local' }

  const giveUp = new AbortController()
  const timer =
    opts.deadlineMs === undefined ? null : setTimeout(() => giveUp.abort(), opts.deadlineMs)
  const gaveUp = (): TeamNamespaceResult => ({
    status: 'unavailable',
    reason: `did not wait for Cloud longer than ${Math.round((opts.deadlineMs ?? 0) / 1000)} s`,
  })
  try {
    try {
      return await attempt(credential, home, giveUp.signal)
    } catch (err) {
      if (giveUp.signal.aborted) return gaveUp()
      if (noTeamToSpeakOf(err)) return { status: 'local' }
      if (!transient(err)) return { status: 'unavailable', reason: describe(err) }
    }
    await new Promise((resolve) => setTimeout(resolve, opts.retryDelayMs ?? RETRY_DELAY_MS))
    if (giveUp.signal.aborted) return gaveUp()
    try {
      return await attempt(credential, home, giveUp.signal)
    } catch (again) {
      if (giveUp.signal.aborted) return gaveUp()
      if (noTeamToSpeakOf(again)) return { status: 'local' }
      return { status: 'unavailable', reason: describe(again) }
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function describe(err: unknown): string {
  if (err instanceof CloudError) return `${err.message}${err.status ? ` (HTTP ${err.status})` : ''}`
  return err instanceof Error ? err.message : String(err)
}

async function attempt(
  credential: Credential,
  home: string | undefined,
  signal: AbortSignal
): Promise<TeamNamespaceResult> {
  const list = await listMaps(credential, signal)

  // An older self-hosted Cloud may still merge server-side; that answer needs no
  // key. It carries no aliases or conflicts - it predates both.
  if (list.teamNamespace) {
    return {
      status: 'team',
      analysis: { namespace: list.teamNamespace, aliases: {}, conflicts: {}, highest: {} },
      conflictDetection: false,
    }
  }

  const teamId = list.team?.id
  if (!teamId) return { status: 'local' }
  const keys = await heldTeamKeys(credential, home, teamId)
  if (keys.length === 0) return { status: 'locked' }

  const entries = await readTeamEntries(credential, keys, teamScopedMaps(list), signal)
  // Every map unreadable is not a team namespace, it is a failed one.
  if (entries.every((e) => e.map === null) && entries.length > 0) {
    return { status: 'unavailable', reason: 'none of the team maps opened with the unlocked key' }
  }
  return { status: 'team', analysis: analyzeTeamNamespace(entries), conflictDetection: true }
}

/** A member's OWN team maps arrive under personalMaps - the listing splits by
 *  ownership, not by scope - so both lists are read. */
function teamScopedMaps(list: CloudMapList): CloudMapSummary[] {
  return [...list.personalMaps, ...list.teamMaps].filter((m) => m.scope === 'team')
}

/**
 * The team keys this machine has unlocked. Absent, expired, for another
 * account or another team all read the same way: none.
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
  if (!unlock || unlock.teamId !== teamId) return []
  const keys: { version: number; key: CryptoKeyLike }[] = []
  for (const stored of unlock.keys) {
    try {
      keys.push({ version: stored.version, key: await importTeamKey(stored.key) })
    } catch {
      // A damaged entry is skipped: the others may still open the team's maps.
      continue
    }
  }
  return keys
}

/**
 * Every team map, opened with the held keys. One request where Cloud offers it;
 * one per map only for an instance that predates it (404). A failure of the
 * single request throws - a namespace missing a teammate's newest map restores
 * their placeholders wrong - and the caller reports it.
 */
async function readTeamEntries(
  credential: Credential,
  keys: readonly { version: number; key: CryptoKeyLike }[],
  teamScoped: readonly CloudMapSummary[],
  signal: AbortSignal
): Promise<TeamMapEntry[]> {
  let bulk: Awaited<ReturnType<typeof getTeamEnvelopes>>
  try {
    bulk = await getTeamEnvelopes(credential, signal)
  } catch (err) {
    if (err instanceof CloudError && err.status === 404) {
      return Promise.all(teamScoped.map((m) => openTeamMap(credential, m, keys, signal)))
    }
    throw err
  }
  return Promise.all(
    bulk.maps.map(async (row): Promise<TeamMapEntry> => {
      try {
        const envelope = JSON.parse(row.map_data) as TeamMapEnvelope
        return { createdAt: row.created_at, map: await decryptTeamMapWithAny(keys, envelope) }
      } catch {
        // A version this member was never granted: skipped, not fatal.
        return { createdAt: row.created_at, map: null }
      }
    })
  )
}

async function openTeamMap(
  credential: Credential,
  summary: CloudMapSummary,
  keys: readonly { version: number; key: CryptoKeyLike }[],
  signal: AbortSignal
): Promise<TeamMapEntry> {
  try {
    const full = await getMap(credential, summary.id, signal)
    if (typeof full.map_data !== 'string')
      return { createdAt: summary.created_at, map: full.map_data }
    const envelope = JSON.parse(full.map_data) as TeamMapEnvelope
    return { createdAt: summary.created_at, map: await decryptTeamMapWithAny(keys, envelope) }
  } catch {
    return { createdAt: summary.created_at, map: null }
  }
}

/**
 * What a restore says when it needed the team's maps and did not get them -
 * the same words from `veilio restore` and the MCP's `restore_text`.
 * `missing`: the placeholders the own map could not explain.
 */
export function teamLayerNote(
  result: TeamNamespaceResult,
  missing: readonly string[]
): string | null {
  if (missing.length === 0) return null
  if (result.status === 'team' && !result.conflictDetection)
    return (
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in this project's map, and this ` +
      'Cloud instance predates conflict detection, so its team namespace is not used to restore. ' +
      "Restored from this project's map only."
    )
  const which = `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in this project's map`
  if (result.status === 'locked')
    return `${which}, and the team key is locked on this machine. Run \`veilio team unlock\`, then restore again.`
  if (result.status === 'unavailable')
    return `${which}, and could not read the team's maps: ${result.reason}. Restored from this project's map only.`
  return null
}
