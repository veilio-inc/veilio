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
import { matchProject, projectOverride } from './project-scope.js'

/**
 * VEILIO_PROJECT, when it is set, as this listing resolves it (FR-012a). The
 * listing is the one command that does not refuse a value that matches
 * nothing: it is how somebody finds the value to set instead.
 */
export type ProjectOverride =
  | { value: string; id: string }
  | { value: string; id: null; reason: 'not_found' }
  | { value: string; id: null; reason: 'ambiguous'; count: number }

export interface ListedProject {
  id: string
  name: string
  /** The team's own maps in it. */
  maps: number | null
  /** The one in use: VEILIO_PROJECT's when it is set, else the one chosen. */
  inUse: boolean
  /** Where a new team map lands when none is chosen. */
  isDefault: boolean
}

export async function listTeamProjects(
  ctx: ClientContext
): Promise<
  Outcome<{ projects: ListedProject[]; chosen: string | null; override: ProjectOverride | null }>
> {
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
  // Resolved against THIS listing - the server's answer, just read - so the
  // mark costs no second request.
  const value = projectOverride(ctx.env)
  let override: ProjectOverride | null = null
  if (value !== null) {
    const found = matchProject(rows, value)
    override = found.ok
      ? { value, id: found.project.id }
      : found.reason === 'ambiguous'
        ? { value, id: null, reason: 'ambiguous', count: found.count }
        : { value, id: null, reason: 'not_found' }
  }
  const inUse = override ? override.id : (credential.project ?? null)
  return {
    ok: true,
    value: {
      chosen: credential.project ?? null,
      override,
      projects: rows.map((p) => ({
        id: p.id,
        name: p.name,
        maps: typeof p.maps === 'number' ? p.maps : null,
        inUse: p.id === inUse,
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
): Promise<Outcome<{ id: string; name: string; overriddenBy: string | null }>> {
  const credential = readCredential(ctx.home)
  if (!credential) return refuse('not_signed_in')
  if (!ref) return refuse('which_project')
  // The project list is asked without the current choice, so a chosen
  // project that is gone never stops somebody choosing another.
  const listed = await listTeamProjects(ctx)
  if (!listed.ok) return listed
  const found = matchProject(listed.value.projects, ref)
  if (!found.ok) {
    return found.reason === 'ambiguous'
      ? refuse('project_ambiguous', { project: ref, count: found.count })
      : refuse('project_not_found', { project: ref })
  }
  const chosen = found.project
  writeCredential({ ...credential, project: chosen.id }, ctx.home)
  // Stored all the same - it is what applies once the variable is unset - but
  // whoever chose it must hear that this shell goes on using the variable's.
  return {
    ok: true,
    value: { id: chosen.id, name: chosen.name, overriddenBy: listed.value.override?.value ?? null },
  }
}
