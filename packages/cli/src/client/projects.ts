// Projects: which one this sign-in works in (spec 052 US3, research §4).
//
// The choice is a field on the credential, not a file in the project
// directory: a project is something the ACCOUNT's team works in, and the MCP
// server started later for the same sign-in must find the same answer without
// being told (FR-012). A second sign-in, to another instance, has its own.
//
// Choosing one the team does not work in is refused here, against the server's
// own list, and changes nothing (FR-014). The server refuses it as well - 404
// on every map call that names it - so a client that skipped this check would
// still not reach another team's maps; this is about saying so up front.

import { listProjects } from '../cloud.js'
import { readCredential, writeCredential } from '../credential.js'
import { refuse, refusalFromCloudError, type Outcome } from './wording.js'
import type { ClientContext } from './maps.js'

export interface ListedProject {
  id: string
  name: string
  /** The team's own maps in it. */
  maps: number | null
  /** The one this sign-in chose. */
  inUse: boolean
  /** Where a new team map lands when none is chosen. */
  isDefault: boolean
}

export async function listTeamProjects(
  ctx: ClientContext
): Promise<Outcome<{ projects: ListedProject[]; chosen: string | null }>> {
  const credential = readCredential(ctx.home)
  if (!credential) return refuse('not_signed_in')
  let answer: Awaited<ReturnType<typeof listProjects>>
  try {
    answer = await listProjects(credential)
  } catch (err) {
    return { ok: false, refusal: refusalFromCloudError(err, { project: credential.project }) }
  }
  const rows = Array.isArray(answer?.projects) ? answer.projects : []
  if (rows.length === 0) return refuse('no_projects')
  const fallback = answer.defaultProjectId ?? rows[0]!.id
  return {
    ok: true,
    value: {
      chosen: credential.project ?? null,
      projects: rows.map((p) => ({
        id: p.id,
        name: p.name,
        maps: typeof p.maps === 'number' ? p.maps : null,
        inUse: p.id === credential.project,
        isDefault: p.id === fallback,
      })),
    },
  }
}

/** Choose a project by its id or its name. A name two projects share is
 *  refused rather than guessed: guessing is how two projects' maps meet. */
export async function useProject(
  ctx: ClientContext,
  ref: string | null
): Promise<Outcome<{ id: string; name: string }>> {
  const credential = readCredential(ctx.home)
  if (!credential) return refuse('not_signed_in')
  if (!ref) return refuse('which_project')
  const listed = await listTeamProjects(ctx)
  if (!listed.ok) {
    // The CURRENT choice being gone must not stop somebody choosing another.
    if (listed.refusal.code !== 'project_gone') return listed
  }
  const projects = listed.ok ? listed.value.projects : []
  const byId = projects.find((p) => p.id === ref)
  const byName = projects.filter((p) => p.name === ref)
  if (!byId && byName.length > 1)
    return refuse('project_ambiguous', { project: ref, count: byName.length })
  const chosen = byId ?? byName[0]
  if (!chosen) return refuse('project_not_found', { project: ref })
  writeCredential({ ...credential, project: chosen.id }, ctx.home)
  return { ok: true, value: { id: chosen.id, name: chosen.name } }
}
