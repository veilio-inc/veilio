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

const HOOKS = ['members', 'setup', 'beforeSession', 'afterSession', 'afterWave', 'teardown']

/**
 * The team module behind the guard-team arm, or null when no arm needs one.
 * The bench knows nothing of any Cloud instance: signing in, sharing maps and
 * counting what the team's maps hold are the module's.
 */
export async function loadTeam(spec, arms) {
  if (!arms.includes('guard-team')) return null
  if (!spec) throw new Error('guard-team needs --team <module>: the arm has no team without one')
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
