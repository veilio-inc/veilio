// Which project a command or tool call works in (spec 052 FR-012a).
//
// `VEILIO_PROJECT`, then the choice kept with the sign-in, then none - in that
// order, for the CLI and the MCP server alike. The variable exists for the two
// places a stored `projects use` cannot reach: a CI runner, which starts clean,
// and a repository's `.mcp.json`, which pins ITS project through `env` so an
// agent in repository A never masks against repository B's names.
//
// Three rules hold here, and each has a test and a mutant:
//
//   - The value is resolved through the SERVER's project listing, every time.
//     No client-side list, no cache: the server is the authority on which
//     projects the team works in, and a cached answer is how a removed project
//     goes on being used.
//   - A value that names no project, or a name two projects share, is REFUSED,
//     naming the value and the variable. It never falls back to the stored
//     choice or the default: somebody typed it on purpose, and quietly using
//     another project is the cross-project mix FR-013 forbids. The listing is
//     the only request made before the refusal, and it carries no project.
//   - Nothing here writes the credential. The resolved project lives on an
//     in-memory copy, so it cannot outlive the process, leak into another
//     shell, or be persisted by a later `writeCredential({ ...credential })`.

import { listProjects } from '../cloud.js'
import { readCredential, type Credential } from '../credential.js'
import { refuse, refusalFromCloudError, type Outcome } from './wording.js'

/** The variable's name, as people type it and as every message names it. */
export const PROJECT_ENV = 'VEILIO_PROJECT'

export type Env = Readonly<Record<string, string | undefined>>

/** A credential as one command uses it: `project` is the effective one. */
export interface ScopedCredential extends Credential {
  /** Set when `VEILIO_PROJECT` chose `project`. Never written to disk. */
  projectFrom?: typeof PROJECT_ENV
  /** The project's name, from the listing that resolved the variable. */
  projectName?: string
}

/** The variable's value, or null when it is unset, empty or spaces only. */
export function projectOverride(env: Env = process.env): string | null {
  const value = env[PROJECT_ENV]?.trim()
  return value ? value : null
}

export type ProjectMatch<P> =
  | { ok: true; project: P }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'ambiguous'; count: number }

/**
 * A project by its id, or by a name exactly one project has. The one rule
 * `projects use` and `VEILIO_PROJECT` share, so the two cannot drift apart. A
 * shared name is never guessed: guessing is how two projects' maps meet.
 */
export function matchProject<P extends { id: string; name: string }>(
  projects: readonly P[],
  ref: string
): ProjectMatch<P> {
  const byId = projects.find((p) => p.id === ref)
  if (byId) return { ok: true, project: byId }
  const byName = projects.filter((p) => p.name === ref)
  if (byName.length > 1) return { ok: false, reason: 'ambiguous', count: byName.length }
  if (byName.length === 1) return { ok: true, project: byName[0]! }
  return { ok: false, reason: 'not_found' }
}

/**
 * The credential this command works with. Without the variable: the stored
 * one, unchanged, with no request. With it: one listing, then a copy whose
 * `project` is the resolved id - or a refusal naming the value.
 */
export async function scopeCredential(
  credential: Credential,
  env?: Env
): Promise<Outcome<ScopedCredential>> {
  const value = projectOverride(env)
  if (value === null) return { ok: true, value: credential }
  let answer: Awaited<ReturnType<typeof listProjects>>
  try {
    // The listing names no project, so asking it never sends the stored one.
    answer = await listProjects(credential)
  } catch (err) {
    return { ok: false, refusal: refusalFromCloudError(err, { project: value, override: true }) }
  }
  const rows = Array.isArray(answer?.projects) ? answer.projects : []
  const found = matchProject(rows, value)
  if (!found.ok) {
    return found.reason === 'ambiguous'
      ? refuse('project_env_ambiguous', { project: value, count: found.count })
      : refuse('project_env_not_found', { project: value })
  }
  return {
    ok: true,
    value: {
      ...credential,
      project: found.project.id,
      projectFrom: PROJECT_ENV,
      projectName: found.project.name,
    },
  }
}

/** Signed in, and scoped: `not_signed_in` before any request otherwise. */
export async function readScopedCredential(ctx: {
  home?: string
  env?: Env
}): Promise<Outcome<ScopedCredential>> {
  const credential = readCredential(ctx.home)
  if (!credential) return refuse('not_signed_in')
  return scopeCredential(credential, ctx.env)
}

/**
 * The project, as a line that names it says it: the stored id as before, or
 * the name with "(from VEILIO_PROJECT)" when the variable chose it. Null when
 * none is in use.
 */
export function projectLabel(credential: ScopedCredential): string | null {
  if (!credential.project) return null
  if (credential.projectFrom)
    return `${credential.projectName ?? credential.project} (from ${PROJECT_ENV})`
  return credential.project
}

/** What a refusal from a failed request needs to name the project rightly. */
export function refusalScope(credential: ScopedCredential): {
  project?: string
  override?: boolean
} {
  if (credential.projectFrom)
    return { project: credential.projectName ?? credential.project, override: true }
  return { project: credential.project }
}

/**
 * What `projects` says about the variable, beside the list. A value that
 * matches nothing is listed against rather than refused: the list is how
 * somebody finds the value to set instead.
 */
export function overrideSentence(
  override:
    | { value: string; id: string }
    | { value: string; id: null; reason: 'not_found' }
    | { value: string; id: null; reason: 'ambiguous'; count: number },
  chosen: string | null
): string {
  if (override.id !== null)
    return (
      `${PROJECT_ENV} is "${override.value}", so that project is in use here` +
      (chosen && chosen !== override.id
        ? `; the one chosen for this sign-in (${chosen}) applies again once it is unset.`
        : '.')
    )
  if (override.reason === 'ambiguous')
    return (
      `${PROJECT_ENV} is "${override.value}", and ${override.count} of these projects are called that, ` +
      'so every command that uses a project refuses until it is set to one of their ids.'
    )
  return (
    `${PROJECT_ENV} is "${override.value}", which is none of these projects, so every command that ` +
    'uses a project refuses until it is set to one of them, or unset.'
  )
}

/** What `projects use` adds when the variable overrides what it just stored. */
export function overriddenSentence(
  used: { name: string; overriddenBy: string | null },
  where: 'shell' | 'server'
): string {
  return (
    `${PROJECT_ENV} is set ("${used.overriddenBy}") ${where === 'shell' ? 'in this shell' : 'for this MCP server'}, ` +
    `and it overrides this choice: ${where === 'shell' ? 'unset it' : 'remove it from the server’s env'} to work in ${used.name}.`
  )
}
