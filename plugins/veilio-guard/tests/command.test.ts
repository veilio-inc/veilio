// Spec 033 contracts/mod.md: /veilio reports the state, and switches the guard
// off for this project only by name, with a warning that stays.
import { expect, test } from 'claude-code/testing'
import { CANARY, eventOf, mapFile, project, recorded, ROOT } from './helpers.ts'

test('/veilio reports state, the map and coverage', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }) })
  const out = await $.command.run({ command: 'veilio', args: '' })
  expect(out.text).toMatch(/Veilio guard on/)
  expect(out.text).toContain(`${ROOT}/.veilio/map.json (1 entries)`)
  expect(out.text).toContain('COVERAGE.md')
  expect(out.text).toContain('by you (personal)')
})

test('/veilio off: written for the project, and the next result reaches the model as it is', async ($, on) => {
  const read = recorded('Read')
  const p = project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({}) }, { home: '/home/dev' })
  on('tool.call', () => read.r)
  const out = await $.command.run({ command: 'veilio', args: 'off' })
  expect(out.text).toContain('OFF for this project')
  // Spec 078 FR-010: recorded under ~/.veilio, not in the project.
  const state = JSON.parse(p.files['/home/dev/.veilio/guard-state.json'])
  expect(state.projects[ROOT].enabled).toBe(false)
  const r = await $.tool.call(eventOf(read))
  expect(JSON.stringify(r)).toContain(CANARY)
})

test('/veilio on: back on, and scrubbing again', async ($, on) => {
  const read = recorded('Read')
  const state = { version: 1, projects: { [ROOT]: { enabled: false, changedAt: '2026-11-07' } } }
  project(
    on,
    { '/home/dev/.veilio/guard-state.json': JSON.stringify(state) },
    { home: '/home/dev' }
  )
  on('tool.call', () => read.r)
  await $.command.run({ command: 'veilio', args: 'on' })
  const r = await $.tool.call(eventOf(read))
  expect(JSON.stringify(r)).not.toContain(CANARY)
})

test("/veilio off and on leave the project's own lists in guard.json", async ($, on) => {
  const p = project(
    on,
    {
      [`${ROOT}/.veilio/guard.json`]: JSON.stringify({
        rawOnly: ['secrets/**'],
        mcpRestore: ['local_db'],
      }),
    },
    { home: '/home/dev' }
  )
  let ran = false
  on('tool.call', () => {
    ran = true
    return { result: 'x' }
  })
  await $.command.run({ command: 'veilio', args: 'off' })
  await $.command.run({ command: 'veilio', args: 'on' })
  // Spec 078: /veilio no longer writes guard.json at all.
  const saved = JSON.parse(p.files[`${ROOT}/.veilio/guard.json`])
  expect(saved).toEqual({ rawOnly: ['secrets/**'], mcpRestore: ['local_db'] })
  const out = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/secrets/prod.yaml` })
  expect(ran).toBe(false)
  expect(out.deny).toContain('away from the model')
})

// Spec 078 US4 (A#5, research R5): nothing the agent can write decides what
// leaves the machine. guard.json adds raw-only paths only; /veilio off is
// recorded under ~/.veilio (raw-only); the band names the MCP servers that get
// real names; Claude Code's settings files are refused to the agent.
const HOME = '/home/dev'
const STATE = `${HOME}/.veilio/guard-state.json`
const BACK_ON =
  'Veilio guard is back on: an off setting in .veilio/guard.json was ignored, because a file in the project can be written by the agent. To switch the guard off for this project, run /veilio off.'
const MCP_IGNORED =
  "Veilio: mcpRestore in .veilio/guard.json was ignored, because a file in the project can be written by the agent. Set it in the plugin's settings (/config)."

test("an untracked guard.json's mcpRestore and enabled:false are ignored, and the band says so once", async ($, on) => {
  const p = project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }),
    [`${ROOT}/.veilio/guard.json`]: JSON.stringify({ mcpRestore: ['web'], enabled: false }),
  })
  const seen: Record<string, unknown>[] = []
  on('tool.call', (_, e) => (seen.push(e), { result: [{ type: 'text', text: 'ok' }] }))
  await $.tool.call({ tool: 'mcp__web__fetch', url: 'https://x.example/?q=__CLS__1' })
  await $.tool.call({ tool: 'mcp__web__fetch', url: 'https://x.example/?q=__CLS__1' })
  expect(JSON.stringify(seen)).not.toContain(CANARY)
  const status = await $.command.run({ command: 'veilio', args: '' })
  expect(status.text).toMatch(/^Veilio guard on/)
  expect(p.logs.filter((l) => l === BACK_ON)).toHaveLength(1)
  expect(p.logs.filter((l) => l === MCP_IGNORED)).toHaveLength(1)
})

test(
  "the plugin's settings name the MCP servers that get real names, and the band shows them",
  { options: { mcpRestore: ['local_db'] } },
  async ($, on) => {
    project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }) })
    const seen: Record<string, unknown>[] = []
    on('tool.call', (_, e) => (seen.push(e), { result: [{ type: 'text', text: 'ok' }] }))
    await $.tool.call({ tool: 'mcp__local_db__query', sql: 'select * from __CLS__1' })
    expect(seen[0]?.sql).toBe(`select * from ${CANARY}`)
    const status = await $.command.run({ command: 'veilio', args: '' })
    expect(status.text.split('\n')[0]).toMatch(/ · real names to: local_db$/)
  }
)

test('/veilio off is recorded under ~/.veilio, not in the project, and /veilio on clears it', async ($, on) => {
  const p = project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({}) }, { home: HOME })
  const off = await $.command.run({ command: 'veilio', args: 'off' })
  expect(off.text.split('\n')[0]).toBe(
    'Veilio guard OFF for this project: Claude reads raw code. /veilio on Recorded for this project in ~/.veilio/guard-state.json.'
  )
  const record = JSON.parse(p.files[STATE])
  expect(record.version).toBe(1)
  expect(record.projects[ROOT].enabled).toBe(false)
  expect(record.projects[ROOT].changedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(p.modes[STATE]).toBe(0o600)
  expect(p.files[`${ROOT}/.veilio/guard.json`]).toBeUndefined()
  await $.command.run({ command: 'veilio', args: 'on' })
  expect(JSON.parse(p.files[STATE]).projects[ROOT]).toBeUndefined()
})

test('an off record written earlier keeps the guard off when it loads', async ($, on) => {
  const read = recorded('Read')
  project(
    on,
    {
      [`${ROOT}/.veilio/map.json`]: mapFile({}),
      [STATE]: JSON.stringify({
        version: 1,
        projects: { [ROOT]: { enabled: false, changedAt: '2026-11-07' } },
      }),
    },
    { home: HOME }
  )
  on('tool.call', () => read.r)
  const r = await $.tool.call(eventOf(read))
  expect(JSON.stringify(r)).toContain(CANARY)
})

test('an unreadable off record keeps the guard on, and the band says so', async ($, on) => {
  const read = recorded('Read')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({}), [STATE]: '{"version":' }, { home: HOME })
  on('tool.call', () => read.r)
  const r = await $.tool.call(eventOf(read))
  expect(JSON.stringify(r)).not.toContain(CANARY)
  const status = await $.command.run({ command: 'veilio', args: '' })
  expect(status.text.split('\n')[0]).toContain('~/.veilio/guard-state.json could not be read')
})

const SETTINGS_REFUSED =
  "Veilio refused this call: Claude Code's settings can switch the guard off, so the agent may not change them. Ask the user to make this change."
for (const path of [
  `${ROOT}/.claude/settings.json`,
  `${ROOT}/.claude/settings.local.json`,
  `${HOME}/.claude/settings.json`,
])
  test(`the agent may not write ${path}, by any write tool or a shell command`, async ($, on) => {
    project(on, {}, { home: HOME })
    const seen: Record<string, unknown>[] = []
    on('tool.call', (_, e) => (seen.push(e), { result: { stdout: '', stderr: '' } }))
    const calls = [
      { tool: 'Write', file_path: path, content: '{"disableAllHooks":true}' },
      { tool: 'Edit', file_path: path, old_string: '{', new_string: '{"disableAllHooks":true,' },
      { tool: 'MultiEdit', file_path: path, edits: [{ old_string: '{', new_string: '{ ' }] },
      { tool: 'NotebookEdit', notebook_path: path, new_source: 'x' },
      { tool: 'Bash', command: `echo '{}' > ${path}`, description: 'x' },
      { tool: 'Bash', command: `cat ${path}`, description: 'x' },
    ]
    for (const call of calls) {
      const out = await $.tool.call(call)
      expect(`${call.tool} -> ${out.deny}`).toBe(`${call.tool} -> ${SETTINGS_REFUSED}`)
    }
    expect(seen).toHaveLength(0)
  })

test("a Read of Claude Code's project settings still runs", async ($, on) => {
  project(on, { [`${ROOT}/.claude/settings.json`]: '{}' })
  let ran = false
  on('tool.call', () => {
    ran = true
    return {
      result: {
        type: 'text',
        file: {
          filePath: `${ROOT}/.claude/settings.json`,
          content: '{}',
          numLines: 1,
          startLine: 1,
          totalLines: 1,
        },
      },
    }
  })
  const out = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/.claude/settings.json` })
  expect(out.deny).toBeUndefined()
  expect(ran).toBe(true)
})

// Review round 1 (T030) #6: the settings and the off switch are found the
// way raw-only files are - after a cd, across calls, and through a link.
test("a write to Claude Code's settings after a cd, in the next call, or through a link is refused", async ($, on) => {
  project(
    on,
    { [`${ROOT}/.claude/settings.json`]: '{}', [`${ROOT}/cfg.json`]: '' },
    { home: HOME, links: { [`${ROOT}/cfg.json`]: `${ROOT}/.claude/settings.json` } }
  )
  const seen: Record<string, unknown>[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  const calls: [Record<string, unknown>, string | undefined][] = [
    [
      { tool: 'Bash', command: "cd .claude && echo '{}' > settings.json", description: 'x' },
      SETTINGS_REFUSED,
    ],
    [{ tool: 'Bash', command: "echo '{}' > cfg.json", description: 'x' }, SETTINGS_REFUSED],
    [{ tool: 'Write', file_path: `${ROOT}/cfg.json`, content: '{}' }, SETTINGS_REFUSED],
    [{ tool: 'Bash', command: 'cd .claude', description: 'x' }, undefined],
    [{ tool: 'Bash', command: "echo '{}' > settings.json", description: 'x' }, SETTINGS_REFUSED],
  ]
  for (const [call, want] of calls) {
    const out = await $.tool.call(call)
    expect(`${JSON.stringify(call)} -> ${out.deny}`).toBe(`${JSON.stringify(call)} -> ${want}`)
  }
  expect(seen).toHaveLength(1)
})

test('the off switch in ~/.veilio cannot be written by a shell command', async ($, on) => {
  project(on, {}, { home: HOME })
  let ran = false
  on('tool.call', () => ((ran = true), { result: { stdout: '', stderr: '' } }))
  const out = await $.tool.call({
    tool: 'Bash',
    command: `echo '{"version":1,"projects":{}}' > ~/.veilio/guard-state.json`,
    description: 'x',
  })
  expect(out.deny).toContain('away from the model')
  expect(ran).toBe(false)
})
