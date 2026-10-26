// Every refusal the Cloud commands and the MCP map tools can give, in one table
// (spec 052 FR-019).
//
// WHY ONE TABLE
//
// The CLI and the MCP server do the same things to the same maps, and a person
// who meets a refusal in an agent's reply will often go and try the command
// themselves. If the two said different things for the same reason, the second
// reads as a second problem. So both renderers take their words from here, and
// a test checks the table as a table: one entry per code, each naming its
// reason AND what resolves it. "Not permitted" alone leaves somebody exactly
// where they were (Constitution V).
//
// The words never carry the `veilio:` prefix. That belongs to the renderer -
// the terminal prints `veilio: ...` and the MCP server `Veilio: ...` - so the
// sentence itself is the same everywhere.
//
// Real identifiers never go in `message` or `resolve`. A clash names the
// placeholders; the names behind them go in `details`, which only the terminal
// prints, because the MCP server's reader is the model whose context the names
// must stay out of (spec 052, founder decision 2026-10-25).

import { CloudError } from '../cloud.js'

export const REFUSAL_CODES = [
  'not_signed_in',
  'which_map',
  'map_not_found',
  'map_not_in_project',
  'not_yours_remove',
  'not_yours_update',
  'no_local_map',
  'no_vault',
  'no_passphrase',
  'wrong_passphrase',
  'vault_locked',
  'no_pmk_yet',
  'pmk_unopenable',
  'keys_not_set_up',
  'team_key_waiting',
  'own_public_key_mismatch',
  'team_key_readback_mismatch',
  'team_key_not_startable',
  'team_key_solo_unavailable',
  'personal_old_seal',
  'personal_unopenable',
  'not_envelope',
  'team_locked',
  'team_key_unreadable',
  'team_key_mismatch',
  'not_in_team',
  'team_maps_unreadable',
  'team_map_unopenable',
  'clash',
  'would_drop',
  'pull_would_drop',
  'diverged',
  'stale',
  'rotation_owed',
  'too_large',
  'abuse_limit',
  'which_project',
  'project_not_found',
  'project_ambiguous',
  'project_gone',
  'no_projects',
  'destructive_off',
  'confirm_name',
  'confirm_unknown',
  'session_rejected',
  'unentitled',
  'suspended',
  'forbidden',
  'unreachable',
  'server',
] as const

export type RefusalCode = (typeof REFUSAL_CODES)[number]

/** What a sentence may be filled with. Every field is optional; each entry
 *  uses the ones it needs. */
export interface WordingParams {
  id?: string
  name?: string
  count?: number
  detail?: string
  path?: string
  from?: string
  to?: string
  /** A short, already-joined list - placeholders, map names, ids. */
  list?: string
  project?: string
}

export interface Refusal {
  code: RefusalCode
  /** The reason, as a sentence. */
  message: string
  /** What resolves it, as a sentence that names something a person can do. */
  resolve: string
  /** Extra lines for the terminal only - they may hold real identifiers, so the
   *  MCP server never renders them. */
  details?: string[]
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; refusal: Refusal }

/** A trailing full stop, unless the text already ends a sentence. Server
 *  messages arrive both ways. */
function sentence(text: string | undefined): string {
  const t = (text ?? '').trim()
  return /[.!?…]$/.test(t) ? t : `${t}.`
}

function plural(n: number | undefined, one: string, many: string): string {
  return n === 1 ? one : many
}

type Words = (p: WordingParams) => { message: string; resolve: string }

const label = (p: WordingParams): string => (p.name ? `"${p.name}" (${p.id})` : `${p.id}`)

export const WORDING: Record<RefusalCode, Words> = {
  not_signed_in: () => ({
    message: 'not signed in.',
    resolve: 'Run `veilio login` first.',
  }),
  which_map: () => ({
    message: 'which map? No id was given, so nothing was done.',
    resolve: 'Run `veilio maps list` for the ids.',
  }),
  map_not_found: (p) => ({
    message: `there is no map ${p.id} on this account.`,
    resolve: 'Run `veilio maps list` for the ids.',
  }),
  map_not_in_project: (p) => ({
    message: `No map ${p.id} in project ${p.project} (the project in use).`,
    resolve: '`veilio projects use <other>` to work in another one.',
  }),
  not_yours_remove: (p) => ({
    message: `${label(p)} belongs to someone else on your team, so it is theirs to remove.`,
    resolve: 'Ask whoever published it to remove it.',
  }),
  not_yours_update: (p) => ({
    message: `${label(p)} belongs to someone else on your team, so only they can update it. Nothing was written.`,
    resolve:
      'Ask whoever published it to update it, or publish your own with `veilio maps push --team`.',
  }),
  no_local_map: (p) => ({
    message: `there is no local map at ${p.path}, so there is nothing to send.`,
    resolve: 'Run `veilio scrub` on the project first, or pass --map with the map to use.',
  }),
  no_vault: () => ({
    message: 'this account has no vault, so there is no key to open or seal its personal maps.',
    resolve:
      'Create one in the web app first — it is the passphrase your maps are encrypted under.',
  }),
  no_passphrase: () => ({
    message: 'no passphrase given, so nothing was changed.',
    resolve: 'Run the command again and type the vault passphrase you use in the web app.',
  }),
  wrong_passphrase: () => ({
    message: 'that vault passphrase is not right. Nothing was written or uploaded.',
    resolve: 'Run the command again with the passphrase you use in the web app.',
  }),
  vault_locked: () => ({
    message:
      'the personal-maps key is not unlocked on this machine, so personal maps cannot be opened or sealed here. Nothing was changed.',
    resolve: 'Run `veilio vault unlock` in a terminal first.',
  }),
  no_pmk_yet: () => ({
    message:
      'this account has no personal-maps key yet, so a personal map cannot be sealed for it.',
    resolve: 'Run `veilio vault unlock`, which creates it.',
  }),
  pmk_unopenable: () => ({
    message:
      "the account's personal-maps key could not be opened with this vault key, so it looks damaged. Nothing was changed.",
    resolve: 'Contact Veilio support with the account email; do not create a new vault.',
  }),
  keys_not_set_up: () => ({
    message: "this account's keys are not set up yet (it has no keypair), so nothing was changed.",
    resolve:
      'Open the web app and unlock your vault once to set up your keys, then run the command again.',
  }),
  own_public_key_mismatch: () => ({
    message:
      'the public key Cloud returned for this account does not belong to its private key, so no team key was made, wrapped or unlocked.',
    resolve:
      'Contact Veilio support, and do not grant or unlock team keys for this account until it is explained.',
  }),
  team_key_readback_mismatch: () => ({
    message:
      'the team key Cloud handed back (read back after it was set up) is not the one made here, so nothing was unlocked and nothing will be sealed under it.',
    resolve: 'Contact Veilio support, and do not publish team maps until it is explained.',
  }),
  team_key_waiting: () => ({
    message:
      'no one in the team has granted this account the team key yet, so nothing was unlocked.',
    resolve:
      'Ask a team member who holds it to open the web app, which performs the grant, then run `veilio team unlock` again.',
  }),
  team_key_not_startable: (p) => ({
    message: `the team has no key yet, and this account may not set one up: ${sentence(p.detail)}`,
    resolve:
      'Ask the team owner or an admin to open Veilio once, then run `veilio team unlock` again.',
  }),
  team_key_solo_unavailable: (p) => ({
    message: `this account is the team's only member, and its key could not be set up from here (${p.detail}). Nothing was unlocked.`,
    resolve:
      'Open the team page in the web app, which sets the key up, then run `veilio team unlock` again.',
  }),
  personal_old_seal: (p) => ({
    message: `${label(p)} is still sealed with the vault key, which this machine does not hold. Nothing was written.`,
    resolve: 'Run `veilio vault unlock`, which re-seals it under the personal-maps key.',
  }),
  personal_unopenable: (p) => ({
    message: `${label(p)} could not be opened — ${sentence(p.detail)} Nothing was written.`,
    resolve:
      'Check whether it opens in the web app; if it does not, it is damaged and `veilio maps rm` removes it.',
  }),
  not_envelope: () => ({
    message: 'that map is not an encrypted envelope, so it was not written.',
    resolve: 'Open it in the web app and save it again, which seals it.',
  }),
  team_locked: () => ({
    message:
      'no team key is unlocked on this machine, so team maps cannot be opened or sealed here. Nothing was written or uploaded.',
    resolve: 'Run `veilio team unlock` first.',
  }),
  team_key_unreadable: (p) => ({
    message: `the unlocked team key could not be read (${p.detail}). Nothing was written or uploaded.`,
    resolve: 'Run `veilio team unlock` again.',
  }),
  team_key_mismatch: () => ({
    message:
      'the team key on this machine does not match this team. Nothing was written or uploaded.',
    resolve: 'Run `veilio team unlock` again.',
  }),
  not_in_team: () => ({
    message:
      'this account is not in a team, so there is no shared map to publish to. Nothing was uploaded.',
    resolve: "Open the team page in the web app, where the account's team is set up.",
  }),
  team_maps_unreadable: (p) => ({
    message: `could not read the team's maps (${p.detail}), so whether this map conflicts with the team cannot be known. Nothing was uploaded.`,
    resolve:
      'Run `veilio team unlock` again; a named map that still does not open can be removed by its publisher with `veilio maps rm <id>`.',
  }),
  team_map_unopenable: (p) => ({
    message: `that team map, ${label(p)}, could not be opened with the unlocked team keys — ${sentence(p.detail)} Nothing was written.`,
    resolve: 'If the team key was rotated since, run `veilio team unlock` again.',
  }),
  clash: (p) => ({
    message:
      `${p.count} ${plural(p.count, 'placeholder', 'placeholders')} in this map already ` +
      `${plural(p.count, 'means', 'mean')} something else to the team (${p.list}). Publishing would leave ` +
      `${plural(p.count, 'it', 'them')} unrestorable for every member, so nothing was uploaded.`,
    resolve:
      'Re-run `veilio scrub --team` to number this project out of the team’s own allocation, then push the result.',
  }),
  would_drop: (p) => ({
    message: `updating ${label(p)} would drop ${p.count} ${plural(p.count, 'entry', 'entries')} the Cloud map holds and this project's map does not (${p.list}). Nothing was written.`,
    resolve:
      'Pass --allow-drop (for the MCP tool, allowDrop: true) to drop them deliberately, or pull the map first with `veilio maps pull <id>`.',
  }),
  pull_would_drop: (p) => ({
    message: `pulling "${p.name}" would drop ${p.count} placeholder(s) this project's map has: ${p.list}. Nothing was written.`,
    resolve:
      'Push this map first (`veilio maps push`), pass --force to replace it, or export it with `veilio map --json`.',
  }),
  diverged: (p) => ({
    message: `this map changed in Cloud (${p.from} → ${p.to}) and locally since it was pulled. Neither copy has been touched.`,
    resolve:
      'Pass --force to overwrite the local copy, or export it first with `veilio map --json`.',
  }),
  stale: (p) => ({
    message: `${label(p)} changed in Cloud since it was read (now ${p.to}), so this update was not written over it.`,
    resolve: 'Pull it (`veilio maps pull <id>`), check the change, then update again.',
  }),
  rotation_owed: () => ({
    message:
      'a teammate left while holding the team key, so no new team content may be written until the key is changed. Nothing was uploaded.',
    resolve:
      'A member who holds the current key has to change it in the web app — it cannot be done from here. Ask one of them.',
  }),
  too_large: () => ({
    message: 'this map is too large for Cloud to accept, so nothing was stored.',
    resolve: 'Split it, or remove entries you no longer need.',
  }),
  abuse_limit: (p) => ({
    message: `${sentence(p.detail)} This ceiling is the same on every paid plan, so upgrading will not raise it. Nothing was uploaded.`,
    resolve: 'Remove maps you no longer need with `veilio maps rm <id>`.',
  }),
  which_project: () => ({
    message: 'which project? None was named, so nothing was changed.',
    resolve: 'Run `veilio projects` for their names, then `veilio projects use <name>`.',
  }),
  project_not_found: (p) => ({
    message: `"${p.project}" is not a project your team works in, so nothing was changed.`,
    resolve: 'Run `veilio projects` to see the ones it does.',
  }),
  project_ambiguous: (p) => ({
    message: `${p.count} projects are called "${p.project}", so nothing was changed.`,
    resolve: 'Choose one by its id: `veilio projects` lists them.',
  }),
  project_gone: (p) => ({
    message: `the project chosen for this sign-in (${p.project}) is not one your team works in any more, so nothing was done. No other project was used instead.`,
    resolve: 'Run `veilio projects`, then `veilio projects use <name>`.',
  }),
  no_projects: () => ({
    message: "this account's team works in no project yet, so there is none to choose.",
    resolve:
      'Share a first team map with `veilio maps push --team`, which creates the default project, or make one in the web app.',
  }),
  destructive_off: () => ({
    message:
      'removing a map, or an update that drops entries, is turned off for this MCP server, so nothing was removed or dropped.',
    resolve:
      'The person running it can allow it by starting the server with VEILIO_MCP_DESTRUCTIVE=1, or do it in a terminal with `veilio maps rm` or `veilio maps update --allow-drop`.',
  }),
  confirm_name: (p) => ({
    message: `confirmName must repeat the map's exact name ("${p.name}"), so nothing was removed.`,
    resolve: 'Ask the person to confirm which map, then call again with its exact name.',
  }),
  confirm_unknown: (p) => ({
    message: `the name of ${p.id} could not be read to check confirmName against, so nothing was removed.`,
    resolve: 'Check the id with maps_list, then call again.',
  }),
  session_rejected: () => ({
    message: 'not signed in, or the session was revoked or expired.',
    resolve: 'Run `veilio login` again.',
  }),
  unentitled: (p) => ({
    message: `this account’s plan does not include that — ${sentence(p.detail)}`,
    resolve: 'Change the plan in the web app to use it from here.',
  }),
  suspended: (p) => ({
    message: sentence(p.detail),
    resolve:
      'Export and deletion still work in the web app; nothing else will until the review ends. Contact Veilio support about the review.',
  }),
  forbidden: (p) => ({
    message: sentence(p.detail),
    resolve: 'Ask a team owner or admin for the access this needs.',
  }),
  unreachable: (p) => ({
    message: sentence(p.detail),
    resolve: 'Check the network and the instance address, then run the command again.',
  }),
  server: (p) => ({
    message: `the instance reported an error — ${sentence(p.detail)}`,
    resolve:
      'Run the command again in a minute; if it keeps failing, contact the instance’s support.',
  }),
}

/** A refusal outcome, worded from the table. */
export function refuse(
  code: RefusalCode,
  params: WordingParams = {},
  details?: string[]
): { ok: false; refusal: Refusal } {
  return { ok: false, refusal: refusal(code, params, details) }
}

export function refusal(
  code: RefusalCode,
  params: WordingParams = {},
  details?: string[]
): Refusal {
  const words = WORDING[code](params)
  return details && details.length > 0 ? { code, ...words, details } : { code, ...words }
}

/** How the terminal prints one. The MCP server has its own (no details). */
export function renderRefusal(r: Refusal): string {
  const lines = (r.details ?? []).map((d) => `  ${d}\n`).join('')
  return `veilio: ${r.message} ${r.resolve}\n${lines}`
}

/**
 * A failed request, as a refusal with the remedy that fits it.
 *
 * `project` is the project the call carried. The server answers a project that
 * is not the team's - or no longer is - with 404 "Project not found", and that
 * must be said as such, never as "the instance reported an error", or nobody
 * thinks to choose another (spec 052 edge case: the chosen project removed).
 */
export function refusalFromCloudError(err: unknown, ctx: { project?: string } = {}): Refusal {
  if (!(err instanceof CloudError)) {
    return refusal('server', { detail: err instanceof Error ? err.message : String(err) })
  }
  if (err.status === 404 && /project not found/i.test(err.message)) {
    return refusal('project_gone', { project: ctx.project ?? 'the default' })
  }
  switch (err.kind) {
    case 'unauthenticated':
      return refusal('session_rejected')
    case 'unentitled':
      return refusal('unentitled', { detail: err.message })
    case 'suspended':
      return refusal('suspended', { detail: err.message })
    case 'forbidden':
      // The ceiling is an abuse limit, not a plan feature. Saying "upgrade"
      // here would take money for a change that does nothing.
      if (/limit/i.test(err.message)) return refusal('abuse_limit', { detail: err.message })
      return refusal('forbidden', { detail: err.message })
    case 'unreachable':
      return refusal('unreachable', { detail: err.message })
    case 'server':
      return refusal('server', { detail: err.message })
  }
}
