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

// Claude Code checks a hook's `{ result }` against the tool's output schema,
// and an error's text never fits it: the error goes back as the text the model
// reads, masked, the way a refusal does.
test('a failed command: the error text is scrubbed and still an error', async ($, on) => {
  const failed = recorded('Bash', 1)
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __STR__1: 'nonexistent-dir' }) })
  on('tool.call', () => failed.r)
  const out: any = await $.tool.call(eventOf(failed))
  expect(out.result).toBeUndefined()
  expect(out.deny).toContain('No such file or directory')
  expect(out.deny).not.toContain('nonexistent-dir')
})

test('a Read of a directory: the error reaches the model as masked text, not as a Read result', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  // Recorded from Claude Code 2.1.288 (Read on a directory).
  on('tool.call', () => ({
    ref: 1,
    result: `Error: EISDIR: illegal operation on a directory, read '${ROOT}/src/${CANARY}'`,
    text: `EISDIR: illegal operation on a directory, read '${ROOT}/src/${CANARY}'`,
    isError: true,
    isReadOnly: true,
  }))
  const out: any = await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: `${ROOT}/src` })
  expect(out.result).toBeUndefined()
  expect(out.deny).toBe(`EISDIR: illegal operation on a directory, read '${ROOT}/src/__CLS__1'`)
})

test('a comment in a source Read: known names masked, everyday words left', async ($, on) => {
  const read = recorded('Read')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __VAR__9: 'total', __STR__1: 'keep' }),
  })
  on('tool.call', () => ({
    ...read.r,
    result: {
      ...read.r.result,
      file: {
        ...read.r.result.file,
        content: `// keep the total in ${CANARY}\nexport class ${CANARY} {\n  total = 1\n}\n`,
      },
    },
  }))
  const out: any = await $.tool.call(eventOf(read))
  const lines = out.result.file.content.split('\n')
  expect(lines[0]).toBe('// keep the __VAR__9 in __CLS__1')
  expect(lines[1]).toBe('export class __CLS__1 {')
  expect(lines[2]).toBe('  __VAR__9 = 1')
})

test('Grep in both modes and Glob: content and file names scrubbed, enums kept', async ($, on) => {
  const content = recorded('Grep')
  const files = recorded('Grep', 1)
  const glob = recorded('Glob')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __PKG__9: 'ledger' }) })
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

test('part of a TypeScript file that reads like SQL is scrubbed as TypeScript: its prose is not masked', async ($, on) => {
  const read = recorded('Read')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const fragment = [
    '  // Select the live subscription, then update it where the order matches.',
    '  const row = db.select().from(ledgerRows).where(eq(ledgerRows.orderId, orderId)).get()',
    '  db.update(ledgerRows).set({ settledTotal: total }).where(eq(ledgerRows.id, row.id)).run()',
  ].join('\n')
  on('tool.call', () => ({
    ...read.r,
    result: { ...read.r.result, file: { ...read.r.result.file, content: fragment } },
  }))
  const out: any = await $.tool.call({ ...eventOf(read), offset: 160, limit: 3 })
  const lines = out.result.file.content.split('\n')
  // Read as SQL, every word of the comment was an identifier ("Select
  // __VAR__10 __VAR__9 __VAR__1"). As TypeScript, only the code's own method
  // names are masked, as they are anywhere in the file.
  expect(lines[0]).toContain('// Select the live subscription, then')
  expect(lines[0]).toContain('the order matches.')
  expect(lines[2]).toContain('__VAR__1')
})
