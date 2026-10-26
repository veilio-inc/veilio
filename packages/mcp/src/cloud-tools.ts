// The map, team and project tools (spec 052 US2).
//
// Every one of these is a thin wrapper over `@veilio-inc/cli/client`: the CLI's
// own operations, with the CLI's own checks in the same order and the same
// words for every refusal (FR-007, FR-019). Nothing about a map's rules is
// decided here, with two exceptions that exist only because the caller is an
// agent rather than a person:
//
//   - THE DESTRUCTIVE GATE (FR-010). Removing a map, or an update that drops
//     entries, is refused unless the PERSON started this server with
//     VEILIO_MCP_DESTRUCTIVE=1 - a setting no tool argument can reach - and a
//     removal must also repeat the map's exact name. An agent that decides on
//     its own to tidy up cannot.
//   - WHAT A RESULT MAY SAY (FR-009). A result names the map, its entry count
//     and the outcome. Never a key, a passphrase, a wrapped key or an
//     envelope - none is ever in hand here to say - and never the real names
//     in a map: a clash names its placeholders, and the terminal-only detail
//     lines that show what they mean are not rendered.
//
// Personal maps open with the personal-maps key `veilio vault unlock` left,
// and only with it (FR-011): there is no passphrase prompt here because there
// is nobody to answer one.

import {
  createCloudMap,
  listCloudMaps,
  listTeamProjects,
  pullCloudMap,
  removeCloudMap,
  teamStatus,
  updateCloudMap,
  useProject,
  formatProjectsList,
  overriddenSentence,
  usedSentence,
  type ClientContext,
  type Outcome,
  type Refusal,
  refusal,
} from '@veilio-inc/cli/client'
import { resolveMapPath } from '@veilio-inc/cli/store'
import { PRODUCT_NAME } from '@veilio-inc/engine'
import { invalidateNamespace } from './namespace.js'
import type { ToolContext, ToolResult } from './tools.js'

export interface CloudToolDefinition {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}

/** A refusal as a tool error: the shared sentence, without the terminal's
 *  detail lines, which may hold real identifiers. */
export function refusalResult(r: Refusal): ToolResult {
  return { isError: true, text: `${PRODUCT_NAME}: ${r.message} ${r.resolve}` }
}

function client(ctx: ToolContext): ClientContext {
  // No `passphrase`: never asked for here. The server's own environment, so a
  // repository's `.mcp.json` `env` pins VEILIO_PROJECT for it (FR-012a).
  return { home: ctx.home, env: ctx.env }
}

function mapPathOf(ctx: ToolContext): string {
  return resolveMapPath(ctx.mapPath, ctx.cwd)
}

class ArgumentError extends Error {}

function text(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string') throw new ArgumentError(`argument "${key}" must be a string`)
  return v
}

function flag(args: Record<string, unknown>, key: string): boolean {
  const v = args[key]
  if (v === undefined || v === null) return false
  if (typeof v !== 'boolean') throw new ArgumentError(`argument "${key}" must be true or false`)
  return v
}

function answered<T>(outcome: Outcome<T>, render: (value: T) => string): ToolResult {
  return outcome.ok ? { text: render(outcome.value) } : refusalResult(outcome.refusal)
}

const ID = { type: 'string', description: 'The map id, from maps_list.' }

export const CLOUD_TOOLS: CloudToolDefinition[] = [
  {
    name: 'maps_list',
    title: 'List the maps in Veilio Cloud',
    description:
      'List the maps this account can use in Veilio Cloud: its personal maps and the team maps of the ' +
      'project in use, each with its id, scope, symbol count, name and whose it is. Names and counts ' +
      'only - never what a map holds.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, ctx) =>
      answered(await listCloudMaps(client(ctx)), ({ maps, project }) => {
        if (maps.length === 0) return 'No maps in Cloud yet. maps_create uploads the local one.'
        const lines = maps.map((m) => {
          const count = m.count === null ? '?' : String(m.count)
          const whose = m.scope === 'team' && !m.mine ? '  (a teammate’s)' : ''
          return `${m.id}  ${m.scope.padEnd(8)} ${count.padStart(5)} symbols  ${m.name}${whose}`
        })
        return [
          ...lines,
          '',
          project
            ? `Team maps of project ${project}.`
            : 'No project chosen: team maps of every project.',
        ].join('\n')
      }),
  },
  {
    name: 'maps_pull',
    title: 'Pull a Cloud map into the project',
    description:
      "Fetch one map by id and write it into this project's local symbol map, so restore_text and the " +
      'anonymize tools use it. Opened here: a personal map with the personal-maps key from ' +
      '`veilio vault unlock`, a team map with the key from `veilio team unlock`. Refuses rather than ' +
      'drop local entries unless force is true.',
    inputSchema: {
      type: 'object',
      properties: {
        id: ID,
        force: {
          type: 'boolean',
          description:
            'Replace the local map even where it would drop local entries. Needs the destructive setting.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const askedToForce = flag(args, 'force')
      // force overwrites local entries - and the local map is the one thing
      // that restores text already masked - so it is gated like a drop
      // (FR-010, code review). A pull that overwrites nothing still works.
      const pulled = await pullCloudMap(client(ctx), text(args, 'id'), {
        mapPath: mapPathOf(ctx),
        force: askedToForce && ctx.destructive === true,
      })
      if (
        !pulled.ok &&
        askedToForce &&
        !ctx.destructive &&
        (pulled.refusal.code === 'pull_would_drop' || pulled.refusal.code === 'diverged')
      )
        return refusalResult(refusal('destructive_off'))
      return answered(
        pulled,
        ({ name, count, path }) => `Pulled "${name}" (${count} symbols) into ${path}`
      )
    },
  },
  {
    name: 'maps_create',
    title: 'Save the local map to Cloud',
    description:
      "Upload this project's local symbol map as a NEW map: scope personal (sealed with the " +
      "personal-maps key) or team (sealed with the team key, after checking it against the team's " +
      'other maps so no placeholder takes a second meaning). Use maps_update to change one that exists.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name to save it under.' },
        scope: { type: 'string', enum: ['personal', 'team'] },
      },
      required: ['name', 'scope'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const scope = text(args, 'scope')
      if (scope !== 'personal' && scope !== 'team')
        throw new ArgumentError('argument "scope" must be "personal" or "team"')
      const created = await createCloudMap(client(ctx), {
        name: text(args, 'name'),
        scope,
        mapPath: mapPathOf(ctx),
      })
      if (created.ok && scope === 'team') invalidateNamespace()
      return answered(created, (c) => {
        const notes = c.notes.length ? `\n\n${c.notes.join('\n')}` : ''
        if (c.scope === 'personal') return `Pushed ${c.count} symbols to Cloud as ${c.id}${notes}`
        const disputed = c.disputed ?? 0
        return (
          `Published "${c.name}" (${c.count} symbols) to the team as ${c.id}\n` +
          `The team's shared set now holds ${c.teamTotal} identifiers` +
          (disputed > 0
            ? `, ${disputed} of which ${disputed === 1 ? 'is' : 'are'} disputed and will not restore`
            : ', none disputed') +
          notes
        )
      })
    },
  },
  {
    name: 'maps_update',
    title: 'Update a Cloud map in place',
    description:
      "Replace a Cloud map's entries with this project's local map, keeping its id, name and project. " +
      'Only the map’s publisher may. Refused, saying why, if it would drop entries (allowDrop: true, ' +
      'which also needs the person to have started this server with VEILIO_MCP_DESTRUCTIVE=1), if a ' +
      "placeholder clashes with the team's other maps, if the team owes a key change, or if it changed " +
      'in Cloud since it was read.',
    inputSchema: {
      type: 'object',
      properties: {
        id: ID,
        allowDrop: {
          type: 'boolean',
          description:
            'Allow dropping entries the Cloud map has and the local map does not. Needs the destructive setting.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const askedToDrop = flag(args, 'allowDrop')
      const updated = await updateCloudMap(client(ctx), text(args, 'id'), {
        mapPath: mapPathOf(ctx),
        // The agent's word alone allows nothing: only with the person's
        // setting does allowDrop reach the client (FR-010).
        allowDrop: askedToDrop && ctx.destructive === true,
      })
      if (!updated.ok && updated.refusal.code === 'would_drop' && askedToDrop && !ctx.destructive)
        return refusalResult(refusal('destructive_off'))
      if (updated.ok && updated.value.scope === 'team') invalidateNamespace()
      return answered(updated, (u) => {
        const notes = u.notes.length ? `\n\n${u.notes.join('\n')}` : ''
        return (
          `Updated "${u.name}" (${u.id}) in place: ${u.count} symbols` +
          (u.dropped > 0 ? `, ${u.dropped} dropped as asked` : '') +
          `${u.scope === 'team' ? ', sealed with the team key' : ''}${notes}`
        )
      })
    },
  },
  {
    name: 'maps_remove',
    title: 'Remove a Cloud map',
    description:
      'Remove a map from Cloud. Off unless the person started this server with VEILIO_MCP_DESTRUCTIVE=1, ' +
      "and even then confirmName must repeat the map's exact name - ask the person for it rather than " +
      'reading it from maps_list. A teammate’s map is theirs to remove.',
    inputSchema: {
      type: 'object',
      properties: {
        id: ID,
        confirmName: {
          type: 'string',
          description: "The map's exact name, confirmed by the person.",
        },
      },
      required: ['id', 'confirmName'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      // Before anything else, a request included: off means nothing is sent.
      if (ctx.destructive !== true) return refusalResult(refusal('destructive_off'))
      if (typeof args.confirmName !== 'string')
        throw new ArgumentError(`missing required argument "confirmName" - the map's exact name`)
      const removed = await removeCloudMap(client(ctx), text(args, 'id'), {
        confirmName: args.confirmName,
      })
      if (removed.ok) invalidateNamespace()
      return answered(removed, ({ id, name }) =>
        name ? `Removed "${name}" (${id})` : `Removed ${id}`
      )
    },
  },
  {
    name: 'team_status',
    title: 'Team, project and key status',
    description:
      'Report the signed-in account, its team, the project in use, whether the team key and the ' +
      'personal-maps key are unlocked on this machine, and whether the team owes a key change. Says ' +
      'which command to run where something is locked.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, ctx) =>
      answered(await teamStatus(client(ctx)), (s) =>
        [
          `Account: ${s.account} on ${s.instance}`,
          `Team: ${s.teamId ?? 'none - this account is not in a team'}`,
          `Project: ${s.project ? `${s.project.name ?? 'name unknown'} (${s.project.id})${s.project.from ? ` (from ${s.project.from})` : ''}` : 'none chosen - team maps of every project are used; `veilio projects use <name>` chooses one'}`,
          `Team key: ${s.teamKeyUntil ? `unlocked here until ${s.teamKeyUntil}` : 'locked here - run `veilio team unlock` in a terminal'}`,
          `Personal-maps key: ${s.personalKeyUntil ? `unlocked here until ${s.personalKeyUntil}` : 'locked here - run `veilio vault unlock` in a terminal'}`,
          `Key change owed: ${
            s.rotationOwedSince === undefined
              ? 'unknown - Cloud did not say'
              : s.rotationOwedSince === null
                ? 'no'
                : `yes, since ${s.rotationOwedSince} - no team map can be written until a member who holds the current key changes it in the web app`
          }`,
        ].join('\n')
      ),
  },
  {
    name: 'projects_list',
    title: 'List the team’s projects',
    description:
      "List the projects this account's team works in, marking the one in use with *. A team map " +
      'belongs to exactly one project.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, ctx) =>
      answered(await listTeamProjects(client(ctx)), (listing) => {
        const { lines, note } = formatProjectsList(listing, { surface: 'mcp' })
        return (note ? [...lines, '', note] : lines).join('\n')
      }),
  },
  {
    name: 'projects_use',
    title: 'Choose the project to work in',
    description:
      'Choose the project this sign-in works in, by name or id. Kept with the sign-in, so the CLI uses ' +
      'it too. Team maps, pushes, updates and the team namespace then use that project only.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'The project name or id.' } },
      required: ['project'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const used = await useProject(client(ctx), text(args, 'project'))
      // The server's variable overrides the choice just stored: the namespace
      // it holds is for the variable's project and is not touched.
      if (used.ok && used.value.overriddenBy === null) invalidateNamespace()
      return answered(
        used,
        (u) =>
          usedSentence(u, { surface: 'mcp' }) +
          (u.overriddenBy !== null ? `\n\nWARNING: ${overriddenSentence(u, 'server')}` : '')
      )
    },
  },
]

export const CLOUD_TOOLS_BY_NAME = new Map(CLOUD_TOOLS.map((t) => [t.name, t]))

export { ArgumentError }
