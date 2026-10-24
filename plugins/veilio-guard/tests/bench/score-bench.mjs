// Reads a run-bench.mjs results directory and writes summary.md beside it:
// per arm, how many sessions fixed the bug, and what it took (turns, cost,
// tokens, time), against the no-guard arm.
//
//   node plugins/veilio-guard/tests/bench/score-bench.mjs <results-dir>
//
// Pass rate leads. A placeholder costs about as many tokens as the name it
// hides, so the token count can stay flat while the model does worse.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
const runs = readFileSync(join(dir, 'results.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .map((r) => ({ ...r, contextTokens: r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens }))

// From the results, not meta.json: a resumed run can cover more than it began with.
const arms = ['plain', 'guard-cold', 'guard-warm'].filter((a) => runs.some((r) => r.arm === a))
const tasks = [...new Set(runs.map((r) => r.task))]
const reps = Math.max(...runs.map((r) => r.rep))
const METRICS = [
  ['turns', 'turns', (v) => v.toFixed(0)],
  ['toolCallCount', 'tool calls', (v) => v.toFixed(0)],
  ['contextTokens', 'input tokens (incl. cache)', (v) => `${(v / 1000).toFixed(0)}k`],
  ['outputTokens', 'output tokens', (v) => `${(v / 1000).toFixed(1)}k`],
  ['costUsd', 'cost (USD)', (v) => `$${v.toFixed(3)}`],
  ['wallMs', 'wall time', (v) => `${(v / 1000).toFixed(0)}s`],
]

const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b)
  if (!s.length) return null
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const of = (arm, task) => runs.filter((r) => r.arm === arm && (!task || r.task === task))
const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`

// Tasks differ in size, so the guard's overhead is the geometric mean of its
// per-task ratio to the no-guard arm, not a ratio of pooled medians.
function pairedRatio(arm, key) {
  const ratios = tasks
    .map((t) => [median(of(arm, t).map((r) => r[key])), median(of('plain', t).map((r) => r[key]))])
    .filter(([a, b]) => a != null && b)
    .map(([a, b]) => a / b)
  if (!ratios.length) return null
  return Math.exp(ratios.reduce((s, x) => s + Math.log(x), 0) / ratios.length)
}

const out = []
out.push(`# Guard benchmark: ${meta.repo.name}`, '')
out.push(
  `${meta.date.slice(0, 10)} · model \`${meta.model}\` · Claude Code ${meta.claudeCode} · plugin ${meta.plugin.commit?.slice(0, 7)}${meta.plugin.dirty ? ' (uncommitted changes)' : ''} · repo ${meta.repo.commit?.slice(0, 7)} · ${tasks.length} tasks × up to ${reps} reps, ${runs.length} sessions · max ${meta.maxTurns} turns`,
  ''
)
out.push(
  'Arms: **plain** has no guard. **guard-cold** has the guard on an empty map, which grows as Claude reads. **guard-warm** has the guard on a map `veilio scrub` built from the whole repository first, which is what a project already using Veilio has.',
  ''
)

out.push('## Result', '')
out.push(`| | ${arms.join(' | ')} |`, `|---|${arms.map(() => '---').join('|')}|`)
const passRow = arms.map((a) => {
  const rs = of(a)
  return `${rs.filter((r) => r.passed).length}/${rs.length} (${((100 * rs.filter((r) => r.passed).length) / rs.length).toFixed(0)}%)`
})
out.push(`| bug fixed | ${passRow.join(' | ')} |`)
const counted = (a, key) => of(a).filter((r) => typeof r[key] === 'number').length
for (const [key, label, fmt] of METRICS) {
  const cells = arms.map((a) => {
    const m = median(of(a).map((r) => r[key]))
    if (m == null) return '–'
    const ratio = a === 'plain' ? null : pairedRatio(a, key)
    // A session with no figure is left out; say so where it happens.
    const missing = of(a).length - counted(a, key)
    const note = missing ? ` [${missing} without]` : ''
    return ratio == null ? `${fmt(m)}${note}` : `${fmt(m)} (${pct(ratio - 1)})${note}`
  })
  out.push(`| ${label}, median | ${cells.join(' | ')} |`)
}
const perPass = arms.map((a) => {
  const rs = of(a)
  const passes = rs.filter((r) => r.passed).length
  if (!passes) return '–'
  if (counted(a, 'costUsd') < rs.length) return 'unknown: a session has no cost'
  return `$${(rs.reduce((s, r) => s + r.costUsd, 0) / passes).toFixed(3)}`
})
out.push(`| cost per bug fixed | ${perPass.join(' | ')} |`, '')
out.push(
  'The percentage beside a guarded median is the geometric mean, over tasks, of that arm\'s per-task median against plain\'s. "Cost per bug fixed" is everything the arm spent, divided by the bugs it fixed. It is what Claude Code reports as `total_cost_usd`; on a subscription that is usage, not a bill.',
  ''
)

out.push('## What went wrong', '')
const reasons = [
  ['test still fails', (r) => !r.testPassed],
  ['edited a test file', (r) => r.testsEdited.length > 0],
  ['wrote a placeholder into the code', (r) => r.placeholdersWritten.length > 0],
  ['hit the turn limit', (r) => r.subtype === 'error_max_turns'],
  ['session ended in error', (r) => r.isError && r.subtype !== 'error_max_turns'],
  ['a call was refused by the guard', (r) => r.guardRefused > 0],
  ['a result was withheld by the guard', (r) => r.guardWithheld > 0],
  ['a call was denied by permissions', (r) => r.permissionDenials > 0],
  ['final reply still shows placeholders', (r) => r.finalHasPlaceholders],
]
out.push(`| sessions where… | ${arms.join(' | ')} |`, `|---|${arms.map(() => '---').join('|')}|`)
for (const [label, test] of reasons)
  out.push(`| ${label} | ${arms.map((a) => of(a).filter(test).length).join(' | ')} |`)
out.push('')

out.push('## Per task', '')
out.push(`| task | ${arms.map((a) => `${a}: fixed · turns · cost`).join(' | ')} |`)
out.push(`|---|${arms.map(() => '---').join('|')}|`)
for (const t of tasks)
  out.push(
    `| ${t} | ${arms
      .map((a) => {
        const rs = of(a, t)
        if (!rs.length) return '–'
        const cost = median(rs.map((r) => r.costUsd))
        return `${rs.filter((r) => r.passed).length}/${rs.length} · ${median(rs.map((r) => r.turns)) ?? '–'} · ${cost == null ? '–' : `$${cost.toFixed(3)}`}`
      })
      .join(' | ')} |`
  )
out.push('')

// A run is only evidence if each arm was what it says it was.
const warnings = []
const baseline = (runs[0]?.plugins ?? [])
  .filter((p) => !/veilio/i.test(p))
  .sort()
  .join(', ')
for (const r of runs) {
  const guarded = r.plugins.some((p) => /veilio/i.test(p))
  if (r.arm === 'plain' && guarded)
    warnings.push(`${r.task} #${r.rep}: plain session loaded the guard`)
  if (r.arm !== 'plain' && !guarded)
    warnings.push(`${r.task} ${r.arm} #${r.rep}: guarded session did not list the guard`)
  if (r.arm !== 'plain' && r.mapAfter === 0)
    warnings.push(`${r.task} ${r.arm} #${r.rep}: the map is empty after the session`)
  if (r.arm === 'guard-warm' && r.mapBefore === 0)
    warnings.push(`${r.task} #${r.rep}: guard-warm started on an empty map`)
  // Claude Code loads a few plugins of its own whatever the settings say; what
  // matters is that every session loads the same ones.
  const others = r.plugins
    .filter((p) => !/veilio/i.test(p))
    .sort()
    .join(', ')
  if (others !== baseline)
    warnings.push(
      `${r.task} ${r.arm} #${r.rep}: other plugins differ (${others || 'none'}, not ${baseline || 'none'})`
    )
  if (r.mcpServers.length)
    warnings.push(`${r.task} ${r.arm} #${r.rep}: MCP servers loaded (${r.mcpServers.join(', ')})`)
  if (r.subtype === 'no-result') warnings.push(`${r.task} ${r.arm} #${r.rep}: no result line`)
}
out.push('## Checks on the run itself', '')
out.push(
  warnings.length
    ? warnings.map((w) => `- ${w}`).join('\n')
    : `Every arm was what it says: the guard loaded only where it should, every session loaded the same other plugins (${baseline || 'none'}: Claude Code's own) and no MCP server, and every guarded session had a map.`
)
out.push('')

const md = out.join('\n')
writeFileSync(join(dir, 'summary.md'), md)
console.log(md)
