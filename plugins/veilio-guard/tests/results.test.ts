// Spec 033 US1: every tool result reaches the model scrubbed. Each test fires
// the recorded tool.call through the real hooks; the stub answers in Claude
// Code's place with the result it gave in the live session.
import { expect, test } from 'claude-code/testing'
import { CANARY, eventOf, mapFile, project, recorded, ROOT } from './helpers.ts'

const SEEDED = { __CLS__1: CANARY, __VAR__1: 'settledTotal', __VAR__2: 'batchEntries' }

test('a source Read: the model gets placeholders, and the new names are saved first', async ($, on) => {
  const read = recorded('Read')
  const p = project(on)
  on('tool.call', () => read.r)
  const out: any = await $.tool.call(eventOf(read))
  expect(JSON.stringify(out)).not.toContain(CANARY)
  expect(JSON.stringify(out)).not.toContain('settledTotal')
  expect(out.result.type).toBe('text')
  expect(out.ref).toBeUndefined()
  expect(out.text).toBeUndefined()
  const saved = JSON.parse(p.files[`${ROOT}/.veilio/map.json`])
  expect(Object.values(saved.map)).toContain(CANARY)
  expect(p.files[`${ROOT}/.veilio/.gitignore`]).toBe('*\n')
  // The placeholder the model sees is the one the file now holds.
  const placeholder = Object.keys(saved.map).find((k) => saved.map[k] === CANARY)!
  expect(out.result.file.content).toContain(placeholder)
})

test("a subagent's Read is scrubbed the same way", async ($, on) => {
  const read = recorded('Read', 2)
  expect(read.e.agentId).toBeDefined()
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  on('tool.call', () => read.r)
  const out: any = await $.tool.call(eventOf(read))
  expect(JSON.stringify(out)).not.toContain(CANARY)
})

test('shell output: known names replaced, and nothing added to the map', async ($, on) => {
  const bash = recorded('Bash')
  expect(JSON.stringify(bash.r.result)).toContain(CANARY)
  const p = project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  on('tool.call', () => bash.r)
  const out: any = await $.tool.call(eventOf(bash))
  expect(JSON.stringify(out)).not.toContain(CANARY)
  expect(out.result.stdout).toContain('__CLS__1')
  expect(p.writes.filter((w) => w.path.endsWith('map.json'))).toEqual([])
})

test('a failed command: the error text is scrubbed and still an error', async ($, on) => {
  const failed = recorded('Bash', 1)
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __STR__1: 'nonexistent-dir' }) })
  on('tool.call', () => failed.r)
  const out: any = await $.tool.call(eventOf(failed))
  expect(out.isError).toBe(true)
  expect(out.result).not.toContain('nonexistent-dir')
})

test('Grep in both modes and Glob: content and file names scrubbed, enums kept', async ($, on) => {
  const content = recorded('Grep')
  const files = recorded('Grep', 1)
  const glob = recorded('Glob')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __STR__9: 'ledger' }) })
  on('tool.call', (_: any, e: any) =>
    e.tool === 'Glob' ? glob.r : e.output_mode === 'content' ? content.r : files.r
  )
  const a: any = await $.tool.call(eventOf(content))
  const b: any = await $.tool.call(eventOf(files))
  const c: any = await $.tool.call(eventOf(glob))
  expect(a.result.mode).toBe('content')
  expect(b.result.mode).toBe('files_with_matches')
  expect(JSON.stringify(a)).not.toContain('settledTotal')
  expect(JSON.stringify(c)).not.toContain('ledger.ts')
})

test('Edit and Write records: the original file and the patch are scrubbed', async ($, on) => {
  const edit = recorded('Edit')
  const write = recorded('Write', 1)
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({
      ...SEEDED,
      __VAR__3: 'closedTotal',
      __VAR__4: 'quasarExtra',
    }),
  })
  on('tool.call', (_: any, e: any) => (e.tool === 'Edit' ? edit.r : write.r))
  // The model's Edit names the placeholders it was shown.
  const a: any = await $.tool.call({
    ...eventOf(edit),
    old_string: '__VAR__1',
    new_string: '__VAR__3',
  })
  const b: any = await $.tool.call(eventOf(write))
  expect(JSON.stringify(a)).not.toContain(CANARY)
  expect(JSON.stringify(a)).not.toContain('settledTotal')
  expect(JSON.stringify(b)).not.toContain('quasarExtra')
  expect(a.result.replaceAll).toBe(edit.r.result.replaceAll)
  expect(b.result.type).toBe('update')
})

test('an MCP text result is scrubbed', async ($, on) => {
  const mcp = recorded('mcp__veilio__anonymize_text')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({ __STR__1: 'masked code', __STR__2: 'inline text' }),
  })
  on('tool.call', () => mcp.r)
  const out: any = await $.tool.call(eventOf(mcp))
  expect(out.result[0].type).toBe('text')
  expect(out.result[0].text).not.toContain('inline text')
})

test('a tool with no field list has every string scrubbed: the Agent launch record', async ($, on) => {
  const agent = recorded('Agent')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __STR__1: 'notes.md' }) })
  on('tool.call', () => agent.r)
  const out: any = await $.tool.call(eventOf(agent))
  expect(JSON.stringify(out.result)).not.toContain('notes.md')
  expect(out.result.status).toBe('async_launched')
})

test('an image Read is withheld: images are not scrubbed yet', async ($, on) => {
  const read = recorded('Read')
  project(on)
  on('tool.call', () => ({
    result: { type: 'image', file: { base64: 'AAAA', type: 'image/png' } },
  }))
  const out: any = await $.tool.call({ ...eventOf(read), file_path: `${ROOT}/screen.png` })
  expect(out.deny).toContain('Veilio withheld this result')
  expect(out.deny).toContain('image')
})
