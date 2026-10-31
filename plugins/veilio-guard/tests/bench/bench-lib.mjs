// The parts of run-bench.mjs that decide what runs when, kept free of side
// effects so they can be tested without spending a session.

// The same tools in every arm. A call outside them is denied, and the denial
// costs every arm the same. Each language's test runner is here, so a task in
// any language can be confirmed in any arm.
export const TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Grep',
  'Glob',
  'Bash(npx vitest:*)',
  'Bash(npm test:*)',
  'Bash(npm run test:*)',
  'Bash(python3 -m unittest:*)',
  'Bash(mvn:*)',
  'Bash(ruby:*)',
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(grep:*)',
].join(',')

/**
 * The run as waves. A wave is one arm on up to `concurrency` different tasks,
 * started together. Per rep the tasks go in groups of `concurrency`, and each
 * group runs once per arm; the arm that goes first turns with every group and
 * rep, so no arm always runs first. With concurrency 1 this is the order the
 * bench always had.
 *
 * `member` is the team member a task goes to (its place in the group, turned
 * by group and rep), so in a wave every member has its own task and a task is
 * worked by a different member every rep. Arms without a team ignore it.
 */
export function schedule({ tasks, arms, reps, concurrency, members = 1 }) {
  const waves = []
  const groups = []
  for (let i = 0; i < tasks.length; i += concurrency) groups.push(tasks.slice(i, i + concurrency))
  for (let rep = 1; rep <= reps; rep++)
    for (const [g, group] of groups.entries())
      for (let k = 0; k < arms.length; k++)
        waves.push({
          arm: arms[(k + g + rep) % arms.length],
          rep,
          items: group.map((task, j) => ({ task, member: (j + g + rep) % members })),
        })
  return waves
}

/** No new wave once `hours` have passed since `startMs`; no box, no limit. */
export function deadlinePassed(startMs, hours, nowMs = Date.now()) {
  if (hours == null || Number.isNaN(Number(hours))) return false
  return nowMs - startMs >= Number(hours) * 3600_000
}

/** results grouped as { language: { arm: [runs] } }. */
export function byLanguage(runs) {
  const out = {}
  for (const r of runs) {
    const lang = r.language ?? 'unknown'
    ;((out[lang] ??= {})[r.arm] ??= []).push(r)
  }
  return out
}

/** Every arm, in the order the run lists them and the score shows them. */
export const ARM_ORDER = [
  'plain',
  'guard-cold',
  'guard-warm',
  'guard-team',
  'mcp',
  'mcp-team',
  'cli',
  'cli-team',
]

/** An arm whose sessions are worked by a team member: the team module is needed. */
export const isTeamArm = (arm) => arm.endsWith('-team')

const HOOKS = ['members', 'setup', 'beforeSession', 'afterSession', 'afterWave', 'teardown']

/**
 * The team module behind the team arms, or null when no arm needs one.
 * The bench knows nothing of any Cloud instance: signing in, sharing maps and
 * counting what the team's maps hold are the module's.
 */
export async function loadTeam(spec, arms) {
  const arm = arms.find(isTeamArm)
  if (!arm) return null
  if (!spec) throw new Error(`${arm} needs --team <module>: the arm has no team without one`)
  const mod = (await import(spec)).default
  for (const h of HOOKS)
    if (typeof mod?.[h] !== 'function') throw new Error(`the team module is missing ${h}()`)
  return mod
}

/** Call one hook; whatever fields it returns are the record's (or the wave's). */
export async function callTeam(team, hook, args) {
  if (!team) return {}
  return (await team[hook](args)) ?? {}
}

// What a session that must not read raw code may not call. Everything else in
// TOOLS (Edit, Write, Glob, ls, the test runners) stays, so every arm can still
// list files, write its fix and confirm it.
const RAW_READS = ['Read', 'Grep', 'Bash(cat:*)', 'Bash(grep:*)']
const withoutRawReads = (extra) =>
  [...TOOLS.split(',').filter((t) => !RAW_READS.includes(t)), ...extra].join(',')

/**
 * How one arm's session is started, besides what every arm shares.
 *
 * - plain: no guard. guard-*: the guard plugin, the same tools.
 * - mcp: no guard; code is read only through the Veilio MCP server's
 *   anonymize_file, and a fix goes back through `veilio restore`.
 * - cli: no guard; code is read only through `veilio scrub`, and a fix goes
 *   back through `veilio restore`.
 * - mcp-team, cli-team: mcp and cli in a team member's signed-in CLI home
 *   (`home`, from the team module), so the MCP server and `veilio` number from
 *   the team's maps and the member's reserved blocks. mcp and cli always keep
 *   the signed-out home: `home` is null for them, whatever is passed.
 *
 * The workflow text an mcp or cli session is given comes from the task list
 * (`armPrompts`), so the bench itself says nothing about how a product is used.
 */
export function armArgs(arm, { armPrompts = {}, mcpServer, home } = {}) {
  const base = arm === 'mcp-team' || arm === 'cli-team' ? arm.slice(0, 3) : arm
  if (base === 'mcp' || base === 'cli') {
    const team = base !== arm
    // The product's own workflow text; a team variant only if the task list has one.
    const prompt = armPrompts[arm] ?? armPrompts[base]
    if (!prompt) throw new Error(`the ${arm} arm needs armPrompts.${base} in the task list`)
    if (base === 'mcp' && !mcpServer) throw new Error(`the ${arm} arm needs an mcpServer`)
    if (team && !home) throw new Error(`the ${arm} arm needs the member's signed-in home`)
    const server =
      base === 'mcp' && team
        ? { ...mcpServer, env: { HOME: home, USERPROFILE: home, VEILIO_PROJECT: '' } }
        : mcpServer
    const extra =
      base === 'mcp'
        ? [
            'mcp__veilio__anonymize_file',
            'mcp__veilio__symbol_map_summary',
            'Bash(veilio restore:*)',
          ]
        : ['Bash(veilio scrub:*)', 'Bash(veilio restore:*)']
    return {
      guard: false,
      allowed: withoutRawReads(extra),
      disallowed: RAW_READS.join(','),
      mcpConfig: base === 'mcp' ? { mcpServers: { veilio: server } } : null,
      appendPrompt: prompt,
      veilioOnPath: true,
      home: team ? home : null,
    }
  }
  return {
    guard: arm !== 'plain',
    allowed: TOOLS,
    disallowed: null,
    mcpConfig: null,
    appendPrompt: null,
    veilioOnPath: false,
  }
}

const RESTORES = ['right', 'left', 'leftLocal', 'wrong']

/**
 * The score's team section: one column per team arm that ran, so a refusal or
 * a wrong restore shows under the arm it happened in.
 */
export function teamTable(runs) {
  const teamRuns = runs.filter((r) => r.team)
  const arms = ARM_ORDER.filter((a) => teamRuns.some((r) => r.arm === a))
  if (!arms.length) return { arms, rows: [] }
  const of = (a) => teamRuns.filter((r) => r.arm === a)
  const row = (label, f) => [label, ...arms.map((a) => String(f(of(a))))]
  const sum = (rs, f) => rs.reduce((s, r) => s + (f(r.team) ?? 0), 0)
  const kinds = [...new Set(teamRuns.map((r) => r.team.publish))].sort()
  return {
    arms,
    rows: [
      row('sessions', (rs) => rs.length),
      ...kinds.map((k) =>
        row(`publish ${k}`, (rs) => rs.filter((r) => r.team.publish === k).length)
      ),
      row(
        'sessions with a refused publish',
        (rs) => rs.filter((r) => !['ok', 'unchanged'].includes(r.team.publish)).length
      ),
      row(
        'sessions whose reservation was refused',
        (rs) => rs.filter((r) => r.team.pull?.refused).length
      ),
      row('teammate placeholders restored right · left · left-local · wrong', (rs) =>
        RESTORES.map((k) => sum(rs, (t) => t.restore?.[k])).join(' · ')
      ),
      row('minted outside the local family after a refusal', (rs) =>
        sum(rs, (t) => t.regressed?.length)
      ),
      row('new names minted in sessions', (rs) => sum(rs, (t) => t.minted)),
      row('Cloud requests by the CLI (sessions’ pull and publish)', (rs) =>
        sum(rs, (t) => t.requests)
      ),
    ],
  }
}
