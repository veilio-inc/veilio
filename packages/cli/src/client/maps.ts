// The map operations, once, for the CLI and the MCP server (spec 052 §3).
//
// Moved out of `cloud-commands.ts` so the MCP server's map tools are the CLI's
// map commands rather than a second copy of them: the same checks in the same
// order, the same refusals in the same words (FR-007, FR-019). Each operation
// answers an `Outcome` - `{ ok: true, value }` or `{ ok: false, refusal }` -
// and prints nothing. The terminal renders a refusal to stderr; the MCP server
// returns it as a tool error.
//
// Two orderings hold everywhere below, and they are the controls:
//
//   - REFUSE, THEN WRITE. Every check - keys, ownership, clashes, dropped
//     entries - happens before the first byte is sealed or sent, so a refusal
//     costs nothing and changes nothing (Constitution IV).
//   - DECRYPT, THEN SAVE. A pull writes the local store only after the map has
//     opened. The store is the one thing that can restore text already masked,
//     and a half-written one is text nobody reads back.
//
// Which key opens a personal map (research §8): this machine's personal-maps
// key when `veilio vault unlock` left one - and then ONLY that key, so an
// agent's tool call and a terminal command behave alike - otherwise, where a
// person is present to type it (the CLI), the vault passphrase.

import {
  decryptMapFromVault,
  decryptTeamMapWithAny,
  encryptMapForVault,
  encryptTeamMap,
  importTeamKey,
  parseVaultEnvelope,
  type CryptoKeyLike,
  type SymbolMap,
  type TeamMapEnvelope,
} from '@veilio-inc/engine'
import {
  CloudError,
  createMap,
  deleteMap,
  getMap,
  getPersonalMapsKeyWrap,
  listMaps,
  listProjects,
  updateMapContent,
  type CloudMap,
  type CloudMapList,
} from '../cloud.js'
import { readCredential, type Credential } from '../credential.js'
import { loadMap, loadRemote, saveMap } from '../store.js'
import { readTeamUnlock } from '../team-unlock.js'
import { describeMaps, resolveTeamNamespace } from '../team-namespace.js'
import {
  importPersonalMapsKey,
  readPersonalMapsKey,
  unwrapPersonalMapsKey,
} from './personal-maps-key.js'
import { vaultKeyFor } from './vault-key.js'
import {
  projectLabel,
  refusalScope,
  scopeCredential,
  type Env,
  type ScopedCredential,
} from './project-scope.js'
import { refuse, refusalFromCloudError, type Outcome, type Refusal } from './wording.js'

export interface ClientContext {
  /** Home directory the credential and unlocked keys live under. */
  home?: string
  /**
   * Ask for the vault passphrase. The CLI passes its hidden prompt; the MCP
   * server passes nothing, and a passphrase is then never asked for - it
   * opens personal maps with the personal-maps key or not at all (FR-011).
   */
  passphrase?: () => Promise<string>
  /**
   * Where `VEILIO_PROJECT` is read from (FR-012a). Undefined: this process's
   * environment. The MCP server passes its own; tests pass theirs.
   */
  env?: Env
}

const DEFAULT_NAME = 'from the terminal'

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

function signedIn(ctx: ClientContext): Credential | null {
  return readCredential(ctx.home)
}

function cloudRefusal(err: unknown, credential: ScopedCredential): { ok: false; refusal: Refusal } {
  return { ok: false, refusal: refusalFromCloudError(err, refusalScope(credential)) }
}

/** Five placeholders, then a count. Placeholders only - never what they mean. */
function shortList(items: readonly string[]): string {
  return items.slice(0, 5).join(', ') + (items.length > 5 ? ` and ${items.length - 5} more` : '')
}

// ─── list ────────────────────────────────────────────────────────────────────

export interface ListedMap {
  id: string
  name: string
  scope: 'personal' | 'team'
  count: number | null
  /** Whether this account published it. A team map that is not is a
   *  teammate's: readable, not ours to update or remove. */
  mine: boolean
  updatedAt: string
}

export async function listCloudMaps(
  ctx: ClientContext
): Promise<Outcome<{ maps: ListedMap[]; teamId: string | null; project: string | null }>> {
  const stored = signedIn(ctx)
  if (!stored) return refuse('not_signed_in')
  const scoped = await scopeCredential(stored, ctx.env)
  if (!scoped.ok) return scoped
  const credential = scoped.value
  let list: CloudMapList
  try {
    list = await listMaps(credential)
  } catch (err) {
    return cloudRefusal(err, credential)
  }
  const shape = (mine: boolean) => (m: CloudMapList['personalMaps'][number]) => ({
    id: m.id,
    name: m.name,
    scope: m.scope,
    count: m.identifier_count,
    mine,
    updatedAt: m.updated_at,
  })
  return ok({
    maps: [...list.personalMaps.map(shape(true)), ...list.teamMaps.map(shape(false))],
    teamId: list.team?.id ?? null,
    project: projectLabel(credential),
  })
}

// ─── keys ────────────────────────────────────────────────────────────────────

interface PersonalKeys {
  /** The personal-maps key, when there is one to use. */
  pmk: CryptoKeyLike | null
  /** The vault key, only when a passphrase was typed for this run. */
  vault: CryptoKeyLike | null
}

/**
 * The keys this run may use for personal maps.
 *
 * The personal-maps key on disk wins, and then nothing else is asked for.
 * Without it, a run with nobody to ask (the MCP server) is refused, naming the
 * command that unlocks it; a terminal asks for the passphrase, checks it
 * against the verifier BEFORE anything is opened or sealed, and unwraps the
 * account's personal-maps key with it where the server holds one.
 */
async function personalKeys(
  credential: Credential,
  ctx: ClientContext
): Promise<Outcome<PersonalKeys>> {
  const stored = readPersonalMapsKey(credential, ctx.home)
  if (stored) return ok({ pmk: await importPersonalMapsKey(stored), vault: null })
  if (!ctx.passphrase) return refuse('vault_locked')

  const derived = await vaultKeyFor(credential, ctx.passphrase)
  if (!derived.ok) return derived
  const vaultKey = derived.value

  // The account's personal-maps key, if the server holds one. An instance
  // that predates spec 052 has no such route; that is "no key yet", and
  // personal maps then stay under the vault key as they always were.
  let wrapped: string | null
  try {
    const answer = await getPersonalMapsKeyWrap(credential)
    wrapped = typeof answer?.wrapped === 'string' && answer.wrapped !== '' ? answer.wrapped : null
  } catch (err) {
    // Only the route being absent means "no key": anything else - a 503, a
    // dropped connection - says nothing about the account, and treating it as
    // "none" would seal a new map where the MCP server cannot open it, or
    // tell somebody their key does not exist (code review).
    if (!(err instanceof CloudError && err.status === 404)) return cloudRefusal(err, credential)
    wrapped = null
  }
  if (wrapped === null) return ok({ pmk: null, vault: vaultKey })
  try {
    return ok({
      pmk: await importPersonalMapsKey(await unwrapPersonalMapsKey(vaultKey, wrapped)),
      vault: vaultKey,
    })
  } catch {
    // The passphrase was RIGHT (the verifier said so), so this is a damaged
    // wrap. Sealing anything now could only make it worse.
    return refuse('pmk_unopenable')
  }
}

/** Open a personal envelope with whichever key sealed it: the personal-maps
 *  key first, then the vault key if this run holds it. */
async function openPersonal(
  keys: PersonalKeys,
  mapData: string,
  label: { id: string; name: string }
): Promise<Outcome<SymbolMap>> {
  let envelope
  try {
    envelope = parseVaultEnvelope(mapData)
  } catch {
    return refuse('not_envelope')
  }
  if (keys.pmk) {
    try {
      return ok(await decryptMapFromVault(keys.pmk, envelope))
    } catch {
      // AES-GCM authenticates: the wrong key fails cleanly. Try the next.
    }
  }
  if (keys.vault) {
    try {
      return ok(await decryptMapFromVault(keys.vault, envelope))
    } catch (err) {
      return refuse('personal_unopenable', {
        ...label,
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }
  // Only the personal-maps key here, and it did not open: an older map,
  // still under the vault key. `vault unlock` re-seals those.
  return refuse('personal_old_seal', label)
}

interface TeamKeys {
  /** The team these keys were unlocked for. */
  teamId: string
  all: { version: number; key: CryptoKeyLike }[]
  newest: { version: number; key: CryptoKeyLike }
}

/** The team keys `veilio team unlock` left. Read, never derived: nobody's
 *  passphrase produces a team key. */
async function teamKeys(credential: Credential, ctx: ClientContext): Promise<Outcome<TeamKeys>> {
  const unlock = readTeamUnlock(
    { instance: credential.instance, account: credential.account },
    ctx.home
  )
  if (!unlock || unlock.keys.length === 0) return refuse('team_locked')
  // Newest first: a team mid-rotation holds two, and new content belongs
  // under the newer one. Declared on upload so the server can refuse a write
  // under a key a departed member knew (spec 014).
  const newestStored = [...unlock.keys].sort((a, b) => b.version - a.version)[0]!
  let newest: CryptoKeyLike
  try {
    newest = await importTeamKey(newestStored.key)
  } catch (err) {
    return refuse('team_key_unreadable', {
      detail: err instanceof Error ? err.message : String(err),
    })
  }
  const all: TeamKeys['all'] = []
  for (const stored of unlock.keys) {
    try {
      all.push({ version: stored.version, key: await importTeamKey(stored.key) })
    } catch {
      // A damaged entry; the others may still open the map.
      continue
    }
  }
  return ok({ teamId: unlock.teamId, all, newest: { version: newestStored.version, key: newest } })
}

async function openTeam(
  keys: TeamKeys,
  mapData: string,
  label: { id: string; name: string }
): Promise<Outcome<SymbolMap>> {
  try {
    return ok(await decryptTeamMapWithAny(keys.all, JSON.parse(mapData) as TeamMapEnvelope))
  } catch (err) {
    return refuse('team_map_unopenable', {
      ...label,
      detail: err instanceof Error ? err.message : String(err),
    })
  }
}

function isTeamEnvelope(mapData: string): boolean | null {
  try {
    return (JSON.parse(mapData) as { alg?: unknown }).alg === 'AES-256-GCM-TEAM'
  } catch {
    return null
  }
}

/** The listing, for a team write: which team this account acts for, and the
 *  maps the namespace read then reuses. */
async function listingForTeam(credential: Credential): Promise<Outcome<CloudMapList>> {
  try {
    return ok(await listMaps(credential))
  } catch (err) {
    // Not knowing the team is not knowing whether this map is safe to publish.
    const detail =
      err instanceof CloudError
        ? `${err.message}${err.status ? ` (HTTP ${err.status})` : ''}`
        : String(err)
    return refuse('team_maps_unreadable', { detail })
  }
}

// ─── pull ────────────────────────────────────────────────────────────────────

export async function pullCloudMap(
  ctx: ClientContext,
  id: string | null,
  opts: { mapPath: string; force?: boolean }
): Promise<Outcome<{ id: string; name: string; count: number; path: string }>> {
  const credential = signedIn(ctx)
  if (!credential) return refuse('not_signed_in')
  if (!id) return refuse('which_map')

  let remote: CloudMap
  try {
    remote = await getMap(credential, id)
  } catch (err) {
    if (err instanceof CloudError && err.status === 404 && !/project/i.test(err.message))
      return refuse('map_not_found', { id })
    return cloudRefusal(err, credential)
  }
  // Every map is an envelope the server cannot open: a personal map under the
  // owner's keys, a team map under the team key. Which one is written on the
  // envelope itself.
  if (typeof remote.map_data !== 'string') return refuse('not_envelope')
  const team = isTeamEnvelope(remote.map_data)
  if (team === null) return refuse('not_envelope')
  const label = { id: remote.id, name: remote.name }

  let opened: Outcome<SymbolMap>
  if (team) {
    const keys = await teamKeys(credential, ctx)
    if (!keys.ok) return keys
    opened = await openTeam(keys.value, remote.map_data, label)
  } else {
    const keys = await personalKeys(credential, ctx)
    if (!keys.ok) return keys
    opened = await openPersonal(keys.value, remote.map_data, label)
  }
  if (!opened.ok) return opened
  const map = opened.value

  // Only now is anything read from, let alone written to, disk.
  const existing = loadRemote(opts.mapPath)
  const local = loadMap(opts.mapPath)
  const hasLocal = Object.keys(local).length > 0
  const diverged =
    hasLocal &&
    existing !== undefined &&
    existing.id === remote.id &&
    existing.updatedAt !== remote.updated_at &&
    JSON.stringify(local) !== JSON.stringify(map)
  // Reported, not resolved. Overwriting either side silently loses entries
  // that some text out there still depends on.
  if (diverged && opts.force !== true) {
    return refuse('diverged', { from: existing!.updatedAt, to: remote.updated_at })
  }
  // Whether or not the Cloud copy changed: a local entry the pulled map lacks,
  // or gives another name, is a placeholder some masked text still depends on
  // (staging walk, 2026-10-01).
  const dropped = Object.keys(local).filter((p) => map[p] !== local[p])
  if (dropped.length > 0 && opts.force !== true) {
    return refuse('pull_would_drop', {
      name: remote.name,
      count: dropped.length,
      list: shortList(dropped),
    })
  }

  saveMap(opts.mapPath, map, {
    force: true,
    remote: { id: remote.id, updatedAt: remote.updated_at, pulledAt: new Date().toISOString() },
  })
  return ok({
    id: remote.id,
    name: remote.name,
    count: Object.keys(map).length,
    path: opts.mapPath,
  })
}

// ─── the team checks, shared by create and update ───────────────────────────

/**
 * Placeholders the local map and the team's namespace use for DIFFERENT names.
 *
 * Publishing one creates a DISPUTED placeholder, which then restores for no
 * member of the team until somebody deletes a map. One person's push, a cost
 * paid by everyone, and nothing errors at the time - so it is checked before
 * anything is sealed. An identifier the team holds under a DIFFERENT
 * placeholder is an alias, not a conflict: both still restore (spec 017).
 */
export function conflictsWithTeam(
  local: Record<string, string>,
  teamNamespace: Record<string, string>
): { placeholder: string; mine: string; theirs: string }[] {
  const out: { placeholder: string; mine: string; theirs: string }[] = []
  for (const [placeholder, mine] of Object.entries(local)) {
    const theirs = teamNamespace[placeholder]
    if (theirs !== undefined && theirs !== mine) out.push({ placeholder, mine, theirs })
  }
  return out
}

interface TeamCheck {
  namespace: Record<string, string>
  disputed: number
  notes: string[]
}

/**
 * Establish that writing `map` to the team is safe. A failure to read the
 * team's maps is NOT fallback-to-local: publishing blind is what the check is
 * for. `excludeMapId` leaves the map being updated out of its own check.
 */
type TeamFound = Extract<Awaited<ReturnType<typeof resolveTeamNamespace>>, { status: 'team' }>

/** The team's namespace for a write, read once - from the listing this
 *  command already holds (spec 052: one listing per command). Anything but a
 *  readable team namespace is a refusal: publishing blind is what the clash
 *  check exists to prevent. */
async function teamForWrite(
  ctx: ClientContext,
  credential: ScopedCredential,
  list: CloudMapList,
  excludeMapId?: string
): Promise<Outcome<TeamFound>> {
  // The credential this command already scoped: resolving VEILIO_PROJECT a
  // second time would be a second listing for the same answer.
  const found = await resolveTeamNamespace(ctx.home, { excludeMapId, list, credential })
  if (found.status === 'local') return refuse('not_in_team')
  if (found.status === 'locked') return refuse('team_key_mismatch')
  if (found.status === 'unavailable') {
    if (/project not found/i.test(found.reason)) {
      const scope = refusalScope(credential)
      return refuse('project_gone', { ...scope, project: scope.project ?? 'the default' })
    }
    return refuse('team_maps_unreadable', { detail: found.reason })
  }
  return ok(found)
}

function checkAgainstTeam(found: TeamFound, map: Record<string, string>): Outcome<TeamCheck> {
  const clashes = conflictsWithTeam(map, found.analysis.namespace)
  if (clashes.length > 0) {
    return refuse(
      'clash',
      { count: clashes.length, list: shortList(clashes.map((c) => c.placeholder)) },
      [
        ...clashes
          .slice(0, 10)
          .map(
            ({ placeholder, mine, theirs }) =>
              `${placeholder}: this map says ${mine}, the team says ${theirs}`
          ),
        ...(clashes.length > 10 ? [`… and ${clashes.length - 10} more`] : []),
      ]
    )
  }
  // Some maps opened and some did not: the check ran against the readable
  // ones. Said, naming them, rather than passed off as a full check (FR-018).
  const notes =
    found.unreadable.length > 0
      ? [
          `${found.unreadable.length} team map${found.unreadable.length === 1 ? '' : 's'} could not be opened and ` +
            `${found.unreadable.length === 1 ? 'was' : 'were'} not checked for clashes: ${describeMaps(found.unreadable)}. ` +
            'Run `veilio team unlock` again, or ask the publisher to remove a damaged one.',
        ]
      : []
  return ok({
    namespace: found.analysis.namespace,
    disputed: Object.keys(found.analysis.conflicts).length,
    notes,
  })
}

/** A refused team write, said in terms of what happened and who can fix it. */
function teamWriteRefusal(
  err: unknown,
  credential: Credential,
  verb: 'create' | 'update',
  label: { id: string; name: string }
): { ok: false; refusal: Refusal } {
  if (err instanceof CloudError) {
    // POST answers an owed rotation with 409; PATCH uses 409 for a stale
    // version and 423 for the rotation (contracts/api.md).
    if (verb === 'create' && err.status === 409) return refuse('rotation_owed')
    if (err.status === 423) return refuse('rotation_owed')
    if (verb === 'update' && err.status === 409) {
      const now = err.body?.current_updated_at
      return refuse('stale', { ...label, to: typeof now === 'string' ? now : 'a newer version' })
    }
    if (err.status === 413) return refuse('too_large')
    if (verb === 'update' && err.status === 404 && !/project/i.test(err.message))
      return refuse('map_not_found', label)
    if (
      verb === 'update' &&
      err.status === 403 &&
      err.kind === 'forbidden' &&
      !/limit/i.test(err.message)
    )
      return refuse('not_yours_update', label)
  }
  return cloudRefusal(err, credential)
}

// ─── create ──────────────────────────────────────────────────────────────────

export interface Created {
  id: string
  name: string
  scope: 'personal' | 'team'
  count: number
  /** Team only: identifiers in the team's shared set after this one. */
  teamTotal?: number
  /** Team only: placeholders the team's maps disagree on. */
  disputed?: number
  /** Things worth saying that are not refusals. */
  notes: string[]
}

/** Seal the local map and upload it as a new map, personal or the team's. */
export async function createCloudMap(
  ctx: ClientContext,
  opts: { name: string | null; scope: 'personal' | 'team'; mapPath: string }
): Promise<Outcome<Created>> {
  const stored = signedIn(ctx)
  if (!stored) return refuse('not_signed_in')
  const map = loadMap(opts.mapPath)
  if (Object.keys(map).length === 0) return refuse('no_local_map', { path: opts.mapPath })
  // A team map lands in a project; a personal map has none, so only a team
  // push resolves VEILIO_PROJECT (and pays for the listing that takes).
  let credential: ScopedCredential = stored
  if (opts.scope === 'team') {
    const scoped = await scopeCredential(stored, ctx.env)
    if (!scoped.ok) return scoped
    credential = scoped.value
  }
  const name = opts.name ?? DEFAULT_NAME
  const count = Object.keys(map).length

  if (opts.scope === 'team') {
    const keys = await teamKeys(credential, ctx)
    if (!keys.ok) return keys
    // Keys unlocked for a team this account has since left - or another
    // team entirely - must never seal a map for this one: the team could not
    // read it, and whoever holds that other key could. Checked HERE, at the
    // key, the way the namespace read checks it - not left to the namespace
    // read, which an older instance answers with no key at all (code review).
    const listed = await listingForTeam(credential)
    if (!listed.ok) return listed
    const teamId = listed.value.team?.id ?? null
    if (teamId === null) return refuse('not_in_team')
    if (teamId !== keys.value.teamId) return refuse('team_key_mismatch')
    const found = await teamForWrite(ctx, credential, listed.value)
    if (!found.ok) return found
    const check = checkAgainstTeam(found.value, map)
    if (!check.ok) return check
    // Nothing above this line has sent anything.
    const envelope = await encryptTeamMap(keys.value.newest.key, map)
    let created: { id: string }
    try {
      created = await createMap(credential, {
        name,
        map_data: JSON.stringify(envelope),
        identifier_count: count,
        scope: 'team',
        key_version: keys.value.newest.version,
      })
    } catch (err) {
      return teamWriteRefusal(err, credential, 'create', { id: '', name })
    }
    // The local map is NOT given a remote id: a team map is not this
    // project's copy of anything, and recording it would make the next
    // `maps pull` treat the team's map as this project's own. A union, not a
    // sum: an identifier both hold is one identifier (spec 011 T030).
    return ok({
      id: created.id,
      name,
      scope: 'team',
      count,
      teamTotal: new Set([...Object.keys(check.value.namespace), ...Object.keys(map)]).size,
      disputed: check.value.disputed,
      notes: check.value.notes,
    })
  }

  const keys = await personalKeys(credential, ctx)
  if (!keys.ok) return keys
  // New personal maps go under the personal-maps key wherever there is one
  // (research §1), so the MCP server can open them; under the vault key only
  // for an account that has none yet, as every personal map was before.
  const sealKey = keys.value.pmk ?? keys.value.vault!
  const envelope = await encryptMapForVault(sealKey, map)
  let created: { id: string }
  try {
    created = await createMap(credential, {
      name,
      map_data: JSON.stringify(envelope),
      identifier_count: count,
      scope: 'personal',
    })
  } catch (err) {
    return cloudRefusal(err, credential)
  }
  const now = new Date().toISOString()
  saveMap(opts.mapPath, map, {
    force: true,
    remote: { id: created.id, updatedAt: now, pushedAt: now },
  })
  return ok({ id: created.id, name, scope: 'personal', count, notes: [] })
}

// ─── update ──────────────────────────────────────────────────────────────────

export interface Updated {
  id: string
  name: string
  scope: 'personal' | 'team'
  count: number
  /** Entries the Cloud map held that it no longer does - only with allowDrop. */
  dropped: number
  updatedAt: string
  notes: string[]
}

/**
 * Replace a Cloud map's entries with the local map's, in place: same id, name
 * and project (spec 052 US1).
 *
 * The server cannot read names, so the two checks that need them are made
 * here, before anything is sealed: the entries the update would drop (FR-005),
 * and - for a team map - clashes with the project's OTHER team maps (FR-003).
 * The server decides the rest: owner or publisher, the rotation lock, and the
 * version this read (`if_updated_at`), so a teammate's write in between is
 * reported rather than overwritten.
 */
export async function updateCloudMap(
  ctx: ClientContext,
  id: string | null,
  opts: { mapPath: string; allowDrop?: boolean }
): Promise<Outcome<Updated>> {
  const stored = signedIn(ctx)
  if (!stored) return refuse('not_signed_in')
  if (!id) return refuse('which_map')
  const local = loadMap(opts.mapPath)
  if (Object.keys(local).length === 0) return refuse('no_local_map', { path: opts.mapPath })
  const scoped = await scopeCredential(stored, ctx.env)
  if (!scoped.ok) return scoped
  const credential = scoped.value

  // Whose it is, before reading it: a teammate's map is refused without
  // opening anything (FR-006, the same rule as removing it).
  let list: CloudMapList
  try {
    list = await listMaps(credential)
  } catch (err) {
    return cloudRefusal(err, credential)
  }
  const theirs = list.teamMaps.find((m) => m.id === id)
  if (theirs) return refuse('not_yours_update', { id, name: theirs.name })
  if (!list.personalMaps.some((m) => m.id === id)) {
    // With a project chosen the listing is that project's, so "not here" may
    // well mean "in another project": said, with the way to switch.
    if (credential.project) {
      return refuse('map_not_in_project', {
        id,
        project: await projectName(credential),
        ...(credential.projectFrom ? { override: true } : {}),
      })
    }
    return refuse('map_not_found', { id })
  }

  // A team map: the keys on this machine must be THIS team's before the map
  // is even read (security review) - a key from a team this account has left
  // must never seal or open anything for this one.
  const summary = list.personalMaps.find((m) => m.id === id)!
  if (summary.scope === 'team') {
    const keys = await teamKeys(credential, ctx)
    if (!keys.ok) return keys
    if (list.team?.id !== keys.value.teamId) return refuse('team_key_mismatch')
  }

  const team = summary.scope === 'team'
  const label = { id, name: summary.name }
  // The version this update replaces: the one the listing read. A write that
  // landed since is refused by the server (409), never overwritten.
  const ifUpdatedAt = summary.updated_at

  let sealed: { map_data: string; key_version?: number }
  let current: SymbolMap
  let notes: string[] = []
  if (team) {
    const keys = await teamKeys(credential, ctx)
    if (!keys.ok) return keys
    // The team's maps, read once, with this one among them: its current
    // content comes from the same request as the clash check, not from a
    // second download (spec 052, the staging rate limit).
    const found = await teamForWrite(ctx, credential, list, id)
    if (!found.ok) return found
    let opened: Outcome<SymbolMap>
    if (found.value.excluded) {
      opened =
        found.value.excluded.map === null
          ? refuse('team_map_unopenable', {
              ...label,
              detail: 'it did not open with the unlocked team keys',
            })
          : ok(found.value.excluded.map)
    } else {
      // Not in the bulk read (an older instance, or one the server itself
      // could not read): fetched on its own.
      const fetched = await fetchEnvelope(credential, id)
      if (!fetched.ok) return fetched
      opened = await openTeam(keys.value, fetched.value.map_data, label)
    }
    if (!opened.ok) return opened
    current = opened.value
    const dropped = droppedBy(current, local)
    if (dropped.length > 0 && opts.allowDrop !== true)
      return refuse('would_drop', { ...label, count: dropped.length, list: shortList(dropped) })
    const check = checkAgainstTeam(found.value, local)
    if (!check.ok) return check
    notes = check.value.notes
    sealed = {
      map_data: JSON.stringify(await encryptTeamMap(keys.value.newest.key, local)),
      key_version: keys.value.newest.version,
    }
  } else {
    const fetched = await fetchEnvelope(credential, id)
    if (!fetched.ok) return fetched
    if (isTeamEnvelope(fetched.value.map_data) !== false) return refuse('not_envelope')
    const keys = await personalKeys(credential, ctx)
    if (!keys.ok) return keys
    const opened = await openPersonal(keys.value, fetched.value.map_data, label)
    if (!opened.ok) return opened
    current = opened.value
    const dropped = droppedBy(current, local)
    if (dropped.length > 0 && opts.allowDrop !== true)
      return refuse('would_drop', { ...label, count: dropped.length, list: shortList(dropped) })
    // An updated personal map is sealed under the personal-maps key - never
    // left under the vault key, or the MCP server could not open it (FR-011).
    if (!keys.value.pmk) return refuse('no_pmk_yet')
    sealed = { map_data: JSON.stringify(await encryptMapForVault(keys.value.pmk, local)) }
  }

  let answer: { id: string; updated_at: string }
  try {
    answer = await updateMapContent(credential, id, {
      ...sealed,
      identifier_count: Object.keys(local).length,
      if_updated_at: ifUpdatedAt,
    })
  } catch (err) {
    return teamWriteRefusal(err, credential, 'update', label)
  }
  const updatedAt =
    typeof answer?.updated_at === 'string' ? answer.updated_at : new Date().toISOString()
  // A personal map is this project's copy: its remote marker moves with it,
  // so the next pull does not read the update as a divergence.
  if (!team) {
    const prior = loadRemote(opts.mapPath)
    if (prior?.id === id) {
      saveMap(opts.mapPath, local, {
        force: true,
        remote: { ...prior, updatedAt, pushedAt: new Date().toISOString() },
      })
    }
  }
  return ok({
    id,
    name: summary.name,
    scope: team ? 'team' : 'personal',
    count: Object.keys(local).length,
    dropped: droppedBy(current, local).length,
    updatedAt,
    notes,
  })
}

/** One map's envelope, by id. */
async function fetchEnvelope(
  credential: Credential,
  id: string
): Promise<Outcome<{ map_data: string; updated_at: string }>> {
  let remote: CloudMap
  try {
    remote = await getMap(credential, id)
  } catch (err) {
    if (err instanceof CloudError && err.status === 404 && !/project/i.test(err.message))
      return refuse('map_not_found', { id })
    return cloudRefusal(err, credential)
  }
  if (typeof remote.map_data !== 'string') return refuse('not_envelope')
  return ok({ map_data: remote.map_data, updated_at: remote.updated_at })
}

/** The chosen project's name, or its id when the server cannot say. */
async function projectName(credential: ScopedCredential): Promise<string> {
  // VEILIO_PROJECT was resolved from a listing already: no second one.
  // Bare: the refusal's own wording says the variable chose it.
  if (credential.projectFrom) return credential.projectName ?? credential.project!
  try {
    const found = (await listProjects(credential)).projects.find((p) => p.id === credential.project)
    return found?.name ?? credential.project!
  } catch {
    return credential.project!
  }
}

/** What the Cloud copy holds that the update would lose: a placeholder the
 *  local map lacks, or gives another name - the same rule a pull applies. */
function droppedBy(cloud: SymbolMap, local: SymbolMap): string[] {
  return Object.keys(cloud).filter((p) => local[p] !== cloud[p])
}

// ─── remove ──────────────────────────────────────────────────────────────────

/**
 * Remove a map from Cloud. Who may remove a team map is the server's decision;
 * this says what each refusal means and changes nothing locally either way.
 *
 * `confirmName`, when given (the MCP server, FR-010), must equal the map's
 * exact name, and is checked before the removal is sent. Without it the name
 * is read only so the confirmation can say WHICH map went.
 */
export async function removeCloudMap(
  ctx: ClientContext,
  id: string | null,
  opts: { confirmName?: string } = {}
): Promise<Outcome<{ id: string; name: string | null }>> {
  const stored = signedIn(ctx)
  if (!stored) return refuse('not_signed_in')
  if (!id) return refuse('which_map')
  const scoped = await scopeCredential(stored, ctx.env)
  if (!scoped.ok) return scoped
  const credential = scoped.value

  // The name from the listing, not from the map: downloading a whole
  // envelope to read one label was a round trip and a server-side decrypt
  // for nothing (code review). Not listed - another project's team map, or
  // the listing failing - leaves the id as all there is to report.
  let name: string | null
  try {
    const list = await listMaps(credential)
    name = [...list.personalMaps, ...list.teamMaps].find((m) => m.id === id)?.name || null
  } catch {
    name = null
  }
  if (opts.confirmName !== undefined) {
    if (name === null) return refuse('confirm_unknown', { id })
    if (opts.confirmName !== name) return refuse('confirm_name', { id, name })
  }

  try {
    await deleteMap(credential, id)
  } catch (err) {
    if (err instanceof CloudError && err.status === 404) return refuse('map_not_found', { id })
    if (err instanceof CloudError && err.status === 403)
      return refuse('not_yours_remove', name ? { id, name } : { id })
    return cloudRefusal(err, credential)
  }
  return ok({ id, name })
}
