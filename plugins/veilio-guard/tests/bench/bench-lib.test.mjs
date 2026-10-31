// node --test plugins/veilio-guard/tests/bench/bench-lib.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ARM_ORDER,
  TOOLS,
  armArgs,
  byLanguage,
  callTeam,
  deadlinePassed,
  isTeamArm,
  loadTeam,
  schedule,
  sessionEnv,
  veilioFingerprint,
  denied,
  teamTable,
} from './bench-lib.mjs'

const tasks = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => ({ id }))
const arms = ['plain', 'guard-warm', 'guard-team']

test('every (task, arm, rep) is scheduled exactly once', () => {
  const waves = schedule({ tasks, arms, reps: 3, concurrency: 4, members: 4 })
  const seen = waves.flatMap((w) => w.items.map((i) => `${i.task.id}.${w.arm}.${w.rep}`))
  assert.equal(seen.length, tasks.length * arms.length * 3)
  assert.equal(new Set(seen).size, seen.length)
})

test('a wave holds one arm and up to n different tasks', () => {
  for (const w of schedule({ tasks, arms, reps: 2, concurrency: 4, members: 4 })) {
    assert.ok(w.items.length <= 4 && w.items.length > 0)
    assert.equal(new Set(w.items.map((i) => i.task.id)).size, w.items.length)
    assert.ok(arms.includes(w.arm))
  }
})

test('the arm that runs first turns with every group and rep', () => {
  const waves = schedule({ tasks, arms, reps: 2, concurrency: 4, members: 4 })
  const firsts = new Set()
  for (let i = 0; i < waves.length; i += arms.length) firsts.add(waves[i].arm)
  assert.equal(firsts.size, arms.length)
})

test('in a wave every member has its own task, and a task changes member between reps', () => {
  const waves = schedule({ tasks, arms: ['guard-team'], reps: 3, concurrency: 4, members: 4 })
  for (const w of waves) assert.equal(new Set(w.items.map((i) => i.member)).size, w.items.length)
  for (const t of tasks) {
    const members = waves.flatMap((w) =>
      w.items.filter((i) => i.task.id === t.id).map((i) => i.member)
    )
    assert.equal(new Set(members).size, 3, `${t.id} worked by ${members}`)
  }
})

test('concurrency 1 keeps the old order: per rep, per task, the arms turning', () => {
  const waves = schedule({
    tasks: tasks.slice(0, 2),
    arms: ['plain', 'guard-cold', 'guard-warm'],
    reps: 1,
    concurrency: 1,
    members: 1,
  })
  const order = waves.map((w) => `${w.items[0].task.id}.${w.arm}`)
  // arm = arms[(k + i + rep) % 3], rep 1
  assert.deepEqual(order, [
    'a.guard-cold',
    'a.guard-warm',
    'a.plain',
    'b.guard-warm',
    'b.plain',
    'b.guard-cold',
  ])
})

test('no wave starts after the time box; no box, no limit', () => {
  const start = 1_000_000
  assert.equal(deadlinePassed(start, 3, start + 3 * 3600_000 - 1), false)
  assert.equal(deadlinePassed(start, 3, start + 3 * 3600_000), true)
  assert.equal(deadlinePassed(start, undefined, start + 1e12), false)
})

test('every arm may run each language test command', () => {
  for (const p of [
    'Bash(npx vitest:*)',
    'Bash(python3 -m unittest:*)',
    'Bash(mvn:*)',
    'Bash(ruby:*)',
  ])
    assert.ok(TOOLS.split(',').includes(p), p)
})

test('the score groups sessions by arm and language', () => {
  const runs = [
    { arm: 'plain', language: 'java', passed: true },
    { arm: 'plain', language: 'java', passed: false },
    { arm: 'guard-team', language: 'ruby', passed: true },
    { arm: 'plain' },
  ]
  const g = byLanguage(runs)
  assert.deepEqual(Object.keys(g).sort(), ['java', 'ruby', 'unknown'])
  assert.equal(g.java.plain.length, 2)
  assert.equal(g.ruby['guard-team'].length, 1)
})

test('the team arm needs a team module', async () => {
  await assert.rejects(() => loadTeam(null, ['plain', 'guard-team']), /guard-team needs --team/)
  assert.equal(await loadTeam(null, ['plain', 'guard-warm']), null)
})

test('the mcp-team and cli-team arms need a team module too; mcp and cli do not', async () => {
  await assert.rejects(() => loadTeam(null, ['mcp', 'mcp-team']), /mcp-team needs --team/)
  await assert.rejects(() => loadTeam(null, ['cli-team']), /cli-team needs --team/)
  assert.equal(await loadTeam(null, ['plain', 'mcp', 'cli']), null)
  assert.deepEqual(
    ['plain', 'guard-warm', 'guard-team', 'mcp', 'mcp-team', 'cli', 'cli-team'].filter(isTeamArm),
    ['guard-team', 'mcp-team', 'cli-team']
  )
})

test('a team module must implement every hook', async () => {
  const url = 'data:text/javascript,export default { members: () => ["m1"] }'
  await assert.rejects(() => loadTeam(url, ['guard-team']), /missing setup/)
})

test('team hooks are called with their arguments and their fields come back', async () => {
  const calls = []
  const team = {
    members: () => ['m1', 'm2'],
    setup: async (a) => calls.push(['setup', Object.keys(a).sort().join()]),
    beforeSession: async (a) => calls.push(['before', a.member]),
    afterSession: async (a) => (
      calls.push(['after', a.member, a.record.passed]),
      { publish: 'ok' }
    ),
    afterWave: async (a) => (calls.push(['wave', a.records.length]), { clashes: 0 }),
    teardown: async () => calls.push(['teardown']),
  }
  await callTeam(team, 'setup', { cleanRepo: '/x', cli: '/cli', outDir: '/o' })
  await callTeam(team, 'beforeSession', { member: 'm1', repo: '/r', task: { id: 'a' } })
  const extra = await callTeam(team, 'afterSession', {
    member: 'm1',
    repo: '/r',
    task: { id: 'a' },
    record: { passed: true },
  })
  const wave = await callTeam(team, 'afterWave', { records: [{}, {}] })
  await callTeam(team, 'teardown', {})
  assert.deepEqual(extra, { publish: 'ok' })
  assert.deepEqual(wave, { clashes: 0 })
  assert.deepEqual(calls, [
    ['setup', 'cleanRepo,cli,outDir'],
    ['before', 'm1'],
    ['after', 'm1', true],
    ['wave', 2],
    ['teardown'],
  ])
  // No module (the arm is not a team arm): nothing is called, nothing comes back.
  assert.deepEqual(await callTeam(null, 'afterSession', {}), {})
})

test('plain and guard arms keep their tools and get no extra prompt or server', () => {
  for (const arm of ['plain', 'guard-cold', 'guard-warm', 'guard-team']) {
    const a = armArgs(arm, {})
    assert.equal(a.allowed, TOOLS)
    assert.equal(a.disallowed, null)
    assert.equal(a.mcpConfig, null)
    assert.equal(a.appendPrompt, null)
    assert.equal(a.guard, arm !== 'plain')
    assert.equal(a.veilioOnPath, false)
  }
})

test('the mcp arm reads only through the MCP server and restores with the CLI', () => {
  const server = { command: 'node', args: ['/mcp/index.js'], env: { HOME: '/h' } }
  const a = armArgs('mcp', { armPrompts: { mcp: 'use anonymize_file' }, mcpServer: server })
  assert.equal(a.guard, false)
  assert.deepEqual(a.mcpConfig, { mcpServers: { veilio: server } })
  const allowed = a.allowed.split(',')
  for (const t of [
    'mcp__veilio__anonymize_file',
    'mcp__veilio__symbol_map_summary',
    'Bash(veilio restore:*)',
  ])
    assert.ok(allowed.includes(t), t)
  for (const t of ['Read', 'Grep', 'Bash(cat:*)', 'Bash(grep:*)']) {
    assert.ok(!allowed.includes(t), `${t} still allowed`)
    assert.ok(a.disallowed.split(',').includes(t), `${t} not denied`)
  }
  assert.equal(a.appendPrompt, 'use anonymize_file')
  assert.equal(a.veilioOnPath, true)
})

test('the cli arm reads only through veilio scrub and restores with veilio restore', () => {
  const a = armArgs('cli', { armPrompts: { cli: 'use veilio scrub' } })
  assert.equal(a.guard, false)
  assert.equal(a.mcpConfig, null)
  const allowed = a.allowed.split(',')
  assert.ok(allowed.includes('Bash(veilio scrub:*)') && allowed.includes('Bash(veilio restore:*)'))
  for (const t of ['Read', 'Grep', 'Bash(cat:*)', 'Bash(grep:*)'])
    assert.ok(!allowed.includes(t), t)
  assert.equal(a.appendPrompt, 'use veilio scrub')
  assert.equal(a.veilioOnPath, true)
})

test('an mcp or cli arm without its workflow text is refused', () => {
  assert.throws(() => armArgs('mcp', { mcpServer: {} }), /armPrompts\.mcp/)
  assert.throws(() => armArgs('cli', {}), /armPrompts\.cli/)
  assert.throws(() => armArgs('mcp', { armPrompts: { mcp: 'x' } }), /mcpServer/)
})

const prompts = { mcp: 'use anonymize_file', cli: 'use veilio scrub' }
const solo = {
  command: 'node',
  args: ['/mcp/index.js'],
  env: { HOME: '/out', USERPROFILE: '/out' },
}

test('the mcp and cli arms keep the signed-out home', () => {
  assert.equal(armArgs('mcp', { armPrompts: prompts, mcpServer: solo }).home, null)
  assert.equal(armArgs('cli', { armPrompts: prompts }).home, null)
  // A member's home handed to a solo arm is ignored: it never signs a solo arm in.
  const a = armArgs('mcp', { armPrompts: prompts, mcpServer: solo, home: '/m1' })
  assert.equal(a.home, null)
  assert.deepEqual(a.mcpConfig.mcpServers.veilio.env, { HOME: '/out', USERPROFILE: '/out' })
})

test('mcp-team is the mcp arm with the MCP server in the member’s signed-in home', () => {
  const a = armArgs('mcp-team', { armPrompts: prompts, mcpServer: solo, home: '/m1' })
  const base = armArgs('mcp', { armPrompts: prompts, mcpServer: solo })
  assert.equal(a.allowed, base.allowed)
  assert.equal(a.disallowed, base.disallowed)
  assert.equal(a.guard, false)
  assert.equal(a.veilioOnPath, true)
  assert.equal(a.appendPrompt, 'use anonymize_file') // the product's own workflow text
  assert.equal(a.home, '/m1')
  const server = a.mcpConfig.mcpServers.veilio
  assert.deepEqual(Object.keys(a.mcpConfig.mcpServers), ['veilio'])
  assert.equal(server.command, 'node')
  assert.deepEqual(server.args, ['/mcp/index.js'])
  assert.deepEqual(server.env, { HOME: '/m1', USERPROFILE: '/m1', VEILIO_PROJECT: '' })
  // The solo server is not changed in place.
  assert.equal(solo.env.HOME, '/out')
})

test('cli-team is the cli arm with veilio in the member’s signed-in home', () => {
  const a = armArgs('cli-team', { armPrompts: prompts, home: '/m2' })
  const base = armArgs('cli', { armPrompts: prompts })
  assert.equal(a.allowed, base.allowed)
  assert.equal(a.disallowed, base.disallowed)
  assert.equal(a.mcpConfig, null)
  assert.equal(a.appendPrompt, 'use veilio scrub')
  assert.equal(a.home, '/m2')
  assert.equal(a.veilioOnPath, true)
  assert.equal(a.guard, false)
})

test('a team variant of the workflow text is taken when the task list has one', () => {
  const a = armArgs('cli-team', { armPrompts: { ...prompts, 'cli-team': 'team text' }, home: '/m' })
  assert.equal(a.appendPrompt, 'team text')
})

test('mcp-team and cli-team are refused without a member home, a server or workflow text', () => {
  assert.throws(() => armArgs('mcp-team', { armPrompts: prompts, mcpServer: solo }), /home/)
  assert.throws(() => armArgs('cli-team', { armPrompts: prompts }), /home/)
  assert.throws(() => armArgs('mcp-team', { armPrompts: prompts, home: '/m' }), /mcpServer/)
  assert.throws(() => armArgs('cli-team', { home: '/m' }), /armPrompts\.cli/)
})

test('guard-team is unchanged by a home', () => {
  assert.deepEqual(armArgs('guard-team', { home: '/m1' }), armArgs('guard-warm', {}))
})

test('the team table has a column per team arm: publish, refusals, restores, minted', () => {
  const t = (arm, team) => ({ arm, team })
  const restore = (right, left, leftLocal, wrong) => ({ right, left, leftLocal, wrong })
  const runs = [
    t('guard-team', {
      publish: 'ok',
      minted: 3,
      restore: restore(3, 0, 0, 0),
      requests: 4,
      pull: { refused: null },
      regressed: [],
    }),
    t('cli-team', {
      publish: 'cap',
      minted: 2,
      restore: restore(0, 1, 1, 0),
      requests: 5,
      pull: { refused: { reason: 'cap' } },
      regressed: ['__VAR__9'],
    }),
    t('cli-team', {
      publish: 'unchanged',
      minted: 0,
      restore: restore(0, 0, 0, 0),
      requests: 1,
      pull: { refused: null },
      regressed: [],
    }),
    { arm: 'plain' },
  ]
  const { arms, rows } = teamTable(runs)
  assert.deepEqual(arms, ['guard-team', 'cli-team']) // the score's arm order, only arms that ran
  const row = (label) => rows.find((r) => r[0] === label)?.slice(1)
  assert.deepEqual(row('sessions'), ['1', '2'])
  assert.deepEqual(row('publish ok'), ['1', '0'])
  assert.deepEqual(row('publish cap'), ['0', '1'])
  assert.deepEqual(row('publish unchanged'), ['0', '1'])
  assert.deepEqual(row('sessions with a refused publish'), ['0', '1'])
  assert.deepEqual(row('sessions whose reservation was refused'), ['0', '1'])
  assert.deepEqual(row('teammate placeholders restored right · left · left-local · wrong'), [
    '3 · 0 · 0 · 0',
    '0 · 1 · 1 · 0',
  ])
  assert.deepEqual(row('minted outside the local family after a refusal'), ['0', '1'])
  assert.deepEqual(row('new names minted in sessions'), ['3', '2'])
  assert.deepEqual(row('Cloud requests by the CLI (sessions’ pull and publish)'), ['4', '6'])
  assert.deepEqual(teamTable([{ arm: 'plain' }]), { arms: [], rows: [] })
})

test('the score lists the seven arms in the run order', () => {
  assert.deepEqual(
    ARM_ORDER.filter((a) => a !== 'guard-cold'),
    ['plain', 'guard-warm', 'guard-team', 'mcp', 'mcp-team', 'cli', 'cli-team']
  )
})

// An mcp or cli arm's session keeps the runner's HOME: Claude Code is "Not
// logged in" under any other (checked 2026-10-31). Its own `veilio` wrapper
// comes first on PATH, and the runner checks the developer's ~/.veilio after
// each session instead (veilioFingerprint).
test('the mcp and cli arms keep HOME and put the arm wrapper first on PATH', () => {
  const runner = {
    HOME: '/dev-home',
    USERPROFILE: '/dev-home',
    PATH: '/usr/bin',
    VEILIO_PROJECT: 'p',
    OTHER: 'x',
  }
  for (const arm of ['mcp', 'cli', 'mcp-team', 'cli-team']) {
    const a = armArgs(arm, {
      armPrompts: { mcp: 'm', cli: 'c' },
      mcpServer: { command: 'node' },
      home: '/member',
    })
    const env = sessionEnv(a, { env: runner, bin: '/bin-dir' })
    assert.equal(env.HOME, '/dev-home', arm)
    assert.equal(env.USERPROFILE, '/dev-home', arm)
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined, arm)
    assert.equal(env.VEILIO_PROJECT, '', arm)
    assert.equal(env.PATH, '/bin-dir:/usr/bin', arm)
    assert.equal(env.OTHER, 'x', arm)
  }
  for (const arm of ['plain', 'guard-warm', 'guard-team'])
    assert.equal(sessionEnv(armArgs(arm, {}), { env: runner, bin: '' }), runner, arm)
})

test('the ~/.veilio fingerprint changes when any file in it changes, and is empty when absent', () => {
  const d = mkdtempSync(join(tmpdir(), 'fp-'))
  try {
    assert.equal(veilioFingerprint(join(d, 'none')), '')
    mkdirSync(join(d, 'v', 'maps'), { recursive: true })
    writeFileSync(join(d, 'v', 'credential.json'), '{}')
    const before = veilioFingerprint(join(d, 'v'))
    assert.equal(veilioFingerprint(join(d, 'v')), before)
    writeFileSync(join(d, 'v', 'maps', 'm.json'), '{}')
    const added = veilioFingerprint(join(d, 'v'))
    assert.notEqual(added, before)
    writeFileSync(join(d, 'v', 'credential.json'), '{"t":1}')
    assert.notEqual(veilioFingerprint(join(d, 'v')), added)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('every arm is denied reading or writing the developer ~/.veilio', () => {
  assert.equal(
    denied(null, '/h/.veilio'),
    'Read(/h/.veilio/**),Edit(/h/.veilio/**),Write(/h/.veilio/**)'
  )
  assert.equal(
    denied('Read,Grep', '/h/.veilio'),
    'Read,Grep,Read(/h/.veilio/**),Edit(/h/.veilio/**),Write(/h/.veilio/**)'
  )
})
