// Spec 033 contracts/mod.md: /veilio reports the state, and switches the guard
// off for this project only by name, with a warning that stays.
import { expect, test } from 'claude-code/testing'
import { PROMPT_FAILED } from '../lib/guard.ts'
import { COLD_FILES } from './fixtures/cold.ts'
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

// Review round 2 #3: a cd inside a substitution or a nested shell never
// moves the shell the next call runs in.
test('a nested cd does not move the shell: a write to settings.json after cd .claude is still refused', async ($, on) => {
  project(on, { [`${ROOT}/.claude/settings.json`]: '{}' }, { home: HOME })
  const seen: Record<string, unknown>[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  const calls: [string, string | undefined][] = [
    ['cd .claude', undefined],
    ['echo $(cd /tmp && pwd)', undefined],
    ["echo '{}' > settings.json", SETTINGS_REFUSED],
  ]
  for (const [command, want] of calls) {
    const out = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(`${command} -> ${out.deny}`).toBe(`${command} -> ${want}`)
  }
  expect(seen).toHaveLength(2)
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

// Spec 083 US1 (research R2): a slash command's arguments and what it records
// for the model are masked; a command that takes a path or a setting runs as typed.
function commands(on: Parameters<typeof project>[0], files?: Record<string, string>) {
  project(on, files ?? { [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }) }, {
    home: '/home/dev',
  })
  const ran: { command: string; args?: string }[] = []
  on('command.run', (_, e) => {
    ran.push(e)
    return { text: 'done', context: [`Reviewed ${CANARY}`] }
  })
  return ran
}

test("a slash command's arguments are masked before it runs", async ($, on) => {
  const ran = commands(on)
  await $.command.run({ command: 'review', args: `${CANARY} please` })
  expect(ran[0].args).toBe('__CLS__1 please')
})

test("a skill command's arguments are masked too", async ($, on) => {
  const ran = commands(on)
  await $.command.run({ command: 'simplify', args: CANARY })
  expect(ran[0].args).toBe('__CLS__1')
})

test('what a command records for the model is passed as the command left it', async ($, on) => {
  commands(on)
  const out = await $.command.run({ command: 'review', args: '' })
  expect(out.context).toEqual([`Reviewed ${CANARY}`])
  expect(out.text).toBe('done')
})

// Second review of spec 083: nothing says a built-in's line stays out of the
// model's requests, so a path or a setting is masked too.
test("a built-in command's arguments are masked too, a path or a setting included", async ($, on) => {
  const ran = commands(on)
  await $.command.run({ command: 'add-dir', args: `src/${CANARY}` })
  await $.command.run({ command: 'model', args: CANARY })
  expect(ran.map((r) => r.args)).toEqual(['src/__CLS__1', '__CLS__1'])
})

test('/veilio keeps its own hook', async ($, on) => {
  const ran = commands(on)
  const out = await $.command.run({ command: 'veilio', args: '' })
  expect(ran).toHaveLength(0)
  expect(out.text).toMatch(/Veilio guard on/)
})

test('a command runs as typed while the guard is off', async ($, on) => {
  const state = { version: 1, projects: { [ROOT]: { enabled: false, changedAt: '2026-11-07' } } }
  const ran = commands(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }),
    '/home/dev/.veilio/guard-state.json': JSON.stringify(state),
  })
  await $.command.run({ command: 'review', args: CANARY })
  expect(ran[0]?.args).toBe(CANARY)
})

test('a command is refused while the guard is stopped, with or without arguments', async ($, on) => {
  const ran = commands(on, { [`${ROOT}/.veilio/map.json`]: '{ not json' })
  const out = await $.command.run({ command: 'review', args: CANARY })
  expect(out.text).toContain('Veilio guard stopped')
  await $.command.run({ command: 'clear', args: '' })
  expect(ran).toHaveLength(0)
})

const UNKNOWN = (field: string) =>
  `Veilio did not send this prompt: it carries \`${field}\`, which this version of the guard cannot check. Update the guard (\`claude plugin marketplace update veilio\`, then \`claude plugin update veilio-guard@veilio\`), then send it again.`

test('a command with an unknown field that holds text does not run, and the field is named', async ($, on) => {
  const ran = commands(on)
  for (const [field, value] of [
    ['note', CANARY],
    ['extra', { body: 'x' }],
  ] as const) {
    const out = await $.command.run({ command: 'review', args: '', [field]: value } as never)
    expect(out.text).toBe(UNKNOWN(field))
  }
  expect(ran).toHaveLength(0)
})

test('a command with an unknown field that holds no text runs', async ($, on) => {
  const ran = commands(on)
  await $.command.run({ command: 'review', args: '', flag: true } as never)
  expect(ran).toHaveLength(1)
})

// Second review of spec 083: a command's output stays in the model's requests
// unless the plugin is bundled with Claude Code (CommandRunResult), so it is
// masked; the developer's row is drawn with the real names (ui.test.ts).
test("a command's output text reaches the model masked, its context as the command left it", async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }) })
  on('command.run', () => ({ text: `Reviewed ${CANARY}`, context: [`Notes on ${CANARY}`] }))
  const out = await $.command.run({ command: 'review', args: '' })
  expect(out.text).toBe('Reviewed __CLS__1')
  expect(out.context).toEqual([`Notes on ${CANARY}`])
})

test("a name in a project file the index has not reached yet is masked in a command's arguments", async ($, on) => {
  const ran = commands(on, COLD_FILES)
  await $.command.run({ command: 'review', args: 'why does tarnplot fail' })
  expect(ran[0].args).not.toContain('tarnplot')
})

test("a credential in a command's arguments under a key that is a project name is removed", async ($, on) => {
  const ran = commands(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY, __VAR__4: 'db_password' }),
  })
  await $.command.run({ command: 'review', args: 'db_password = "Xk9!mQ2vLp7"' })
  expect(ran[0].args).not.toContain('Xk9!mQ2vLp7')
  expect(ran[0].args).toContain('__VAR__4')
})

test("a command the guard cannot check answers with the guard's failure, not its own text", async ($, on) => {
  // The run beneath fails: the hook throws past next, and its .catch answers.
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }) })
  on('command.run', () => {
    throw new Error(`failed on ${CANARY}`)
  })
  const out = await $.command.run({ command: 'review', args: `fix ${CANARY}` })
  expect(out.text).toBe(PROMPT_FAILED)
  expect(JSON.stringify(out)).not.toContain(CANARY)
})

// Security review of 43b6227: while stopped nothing can be masked, so what a
// command prints is withheld from the model, as a prompt is; /veilio still runs.
test('nothing a command prints or records reaches the model while the guard is stopped', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: '{ not json' })
  on('command.run', () => ({ text: `Cost of ${CANARY}`, context: [`Notes on ${CANARY}`] }))
  const out = await $.command.run({ command: 'cost', args: '' })
  expect(out.text).toMatch(/^Veilio guard stopped: .*\. Run \/veilio\.$/)
  expect(JSON.stringify(out)).not.toContain(CANARY)
  const status = await $.command.run({ command: 'veilio', args: '' })
  expect(status.text).toContain('stopped')
})

// Security review of 43b6227: /veilio's arguments run as typed only when they
// are a switch it takes; anything else is masked like any command's.
test('/veilio runs as typed only with a switch it takes: anything else is a command like any other', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: '{ not json' })
  const refused = /^Veilio guard stopped: .*\. Run \/veilio\.$/
  for (const args of ['', 'on', ' on ']) {
    const out = await $.command.run({ command: 'veilio', args })
    expect(out.text).toContain('Project: /work/project')
    expect(out.text).not.toMatch(refused)
  }
  expect((await $.command.run({ command: 'veilio', args: `on ${CANARY}` })).text).toMatch(refused)
  expect((await $.command.run({ command: 'veilio', args: ' off ' })).text).toContain('OFF')
})

test("/veilio's line with a name in it is not sent as typed", async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }) })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const base = { wait: false, origin: { kind: 'user' } } as const
  const out = await $.prompt.submit({
    ...base,
    text: `/veilio on ${CANARY}`,
    command: { name: 'veilio', args: `on ${CANARY}` },
  } as never)
  expect(out.drop).toContain('does not let the guard mask the line of a slash command')
})

// Final review of 0f1b04c: a command named after a project name (a skill)
// is not sent as typed, and /veilio's status is masked like any output.
test('a slash command whose name is a masked name is not sent as typed', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }) })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const base = { wait: false, origin: { kind: 'user' } } as const
  const out = await $.prompt.submit({
    ...base,
    text: `/${CANARY}`,
    command: { name: CANARY, args: '' },
  } as never)
  expect(out.drop).toContain('does not let the guard mask the line of a slash command')
})

test("/veilio's status reaches the model masked, and reads as written otherwise", async ($, on) => {
  const root = `/work/${CANARY}`
  project(on, { [`${root}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }) }, { cwd: root })
  const out = await $.command.run({ command: 'veilio', args: '' })
  expect(out.text).not.toContain(CANARY)
  expect(out.text).toContain('secrets removed.')
})

test('a command whose arguments were masked says so', async ($, on) => {
  const p = project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }) })
  on('command.run', () => ({ text: 'done' }))
  await $.command.run({ command: 'review', args: 'the diff' })
  expect(p.toasts).toEqual([])
  await $.command.run({ command: 'add-dir', args: `src/${CANARY}` })
  expect(p.toasts).toEqual(['Veilio masked names in your prompt before sending it.'])
})

test('a command run from the composer, with where it shows, runs: origin and presentation are metadata', async ($, on) => {
  const ran = commands(on)
  const presentation = { isFullscreen: true, columns: 120 }
  await $.command.run({
    command: 'review',
    args: '',
    origin: { kind: 'composer' },
    presentation,
  } as never)
  expect(ran).toHaveLength(1)
})
