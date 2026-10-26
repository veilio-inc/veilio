// Where this sign-in stands: the state `veilio whoami` and `team unlock`
// report, in one answer, for the MCP server's `team_status` (spec 052 FR-008).
//
// It says whether keys are unlocked HERE and until when - never the keys. And
// whether the team owes a key rotation, read from the team's key status; the
// rest of that answer names teammates, and stays out of this one.

import { getTeamKeyPending, listMaps, listProjects } from '../cloud.js'
import { readCredential } from '../credential.js'
import { readTeamUnlock } from '../team-unlock.js'
import { personalMapsKeyExpiry } from './personal-maps-key.js'
import { refuse, refusalFromCloudError, type Outcome } from './wording.js'
import type { ClientContext } from './maps.js'

export interface TeamStatus {
  account: string
  instance: string
  teamId: string | null
  /** The chosen project, with its name when the server could say it. */
  project: { id: string; name: string | null } | null
  teamKeyUntil: string | null
  personalKeyUntil: string | null
  /** Since when a rotation is owed; null when none is; undefined when the
   *  server did not say (an older instance, or no team). */
  rotationOwedSince: string | null | undefined
}

export async function teamStatus(ctx: ClientContext): Promise<Outcome<TeamStatus>> {
  const credential = readCredential(ctx.home)
  if (!credential) return refuse('not_signed_in')
  let teamId: string | null
  try {
    teamId = (await listMaps(credential)).team?.id ?? null
  } catch (err) {
    return { ok: false, refusal: refusalFromCloudError(err, { project: credential.project }) }
  }

  let project: TeamStatus['project'] = null
  if (credential.project) {
    let name: string | null = null
    try {
      name =
        (await listProjects(credential)).projects.find((p) => p.id === credential.project)?.name ??
        null
    } catch {
      // The id alone is still the answer to "which project".
    }
    project = { id: credential.project, name }
  }

  const binding = { instance: credential.instance, account: credential.account }
  const unlock = readTeamUnlock(binding, ctx.home)
  let rotationOwedSince: TeamStatus['rotationOwedSince']
  if (teamId) {
    try {
      const pending = await getTeamKeyPending(credential, teamId)
      rotationOwedSince =
        typeof pending?.rotationNeededSince === 'string' ? pending.rotationNeededSince : null
    } catch {
      rotationOwedSince = undefined
    }
  }
  return {
    ok: true,
    value: {
      account: credential.account,
      instance: credential.instance,
      teamId,
      project,
      teamKeyUntil: unlock && teamId && unlock.teamId === teamId ? unlock.expiresAt : null,
      personalKeyUntil: personalMapsKeyExpiry(binding, ctx.home),
      rotationOwedSince,
    },
  }
}
