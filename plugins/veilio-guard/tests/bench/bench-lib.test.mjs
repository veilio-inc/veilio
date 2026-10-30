// node --test plugins/veilio-guard/tests/bench/bench-lib.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOLS, byLanguage, callTeam, deadlinePassed, loadTeam, schedule } from './bench-lib.mjs'

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
