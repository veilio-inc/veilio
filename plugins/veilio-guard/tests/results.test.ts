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

test('shell output naming only known names: replaced, and the map is not rewritten', async ($, on) => {
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

test('a map built before the engine kept length: a source Read leaves .length as written', async ($, on) => {
  const read = recorded('Read')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __VAR__3: 'length' }),
  })
  on('tool.call', () => ({
    ...read.r,
    result: {
      ...read.r.result,
      file: { ...read.r.result.file, content: 'const n = batchEntries.length\n' },
    },
  }))
  const out: any = await $.tool.call(eventOf(read))
  expect(out.result.file.content).toBe('const n = __VAR__2.length\n')
})

// Guard follow-up d03a: a file of sample credentials (a secret detector and its
// tests) was redacted, then the last scan read the redaction tokens as
// credentials and withheld every edit to it.
test('an edit to a file of sample credentials: redacted, and the result is sent', async ($, on) => {
  const edit = recorded('Edit')
  const samples = [
    "const kinds = { 'google-api-key': 'GOOGLE_KEY', 'password-assignment': 'CREDENTIAL' }",
    'export const fixture = { password: "Tr0ub4dor3xzQ" }',
    'const url = "postgres://admin:Tr0ub4dor3xz@db.internal:5432/prod"',
  ].join('\n')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  on('tool.call', () => ({ ...edit.r, result: { ...edit.r.result, originalFile: samples } }))
  const out: any = await $.tool.call({
    ...eventOf(edit),
    old_string: '__VAR__1',
    new_string: '__VAR__1',
  })
  expect(out.deny).toBeUndefined()
  const sent = JSON.stringify(out.result)
  expect(sent).not.toContain('Tr0ub4dor3xz')
  expect(sent).toContain('__REDACTED_')
})

// Review of 9d3f6d0: a placeholder can stand for part of a credential.
test('a password holding a project name is still redacted in shell output', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __CLS__7: 'Acme' }) })
  const stdout = 'DB_PASSWORD = "Acme!9xQz"\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out: any = await $.tool.call(eventOf(bash))
  expect(JSON.stringify(out)).not.toContain('9xQz')
  expect(JSON.stringify(out)).not.toContain('Acme')
})

test('a secret a rule only partly took is redacted whole, and the result is sent', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  // 41 characters; the AWS rule takes 40 and left the last one beside its token.
  const stdout = 'aws_secret_access_key = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY123"\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out: any = await $.tool.call(eventOf(bash))
  expect(out.deny).toBeUndefined()
  expect(out.result.stdout).toMatch(/= "__REDACTED_[A-Z_]+_\d+__"/)
})

test('a plain word under a long placeholder number is not read as a credential', async ($, on) => {
  const read = recorded('Read')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __STR__1290: 'disabled' }) })
  const content = 'export const auth = { client_secret: "disabled" }\n'
  on('tool.call', () => ({
    ...read.r,
    result: { ...read.r.result, file: { ...read.r.result.file, content } },
  }))
  const out: any = await $.tool.call(eventOf(read))
  expect(out.deny).toBeUndefined()
  expect(out.result.file.content).toContain('__STR__1290')
})

test('a credential-shaped placeholder for a plain word in output is not read as a credential', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __VAR__1289: 'otherName' }) })
  // `abAbab` is too plain to be a credential; masked, its placeholder
  // (`__VAR__1290`) has the entropy of one. The last scan reads what it stands for.
  const stdout = 'secret: "abAbab"\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out: any = await $.tool.call(eventOf(bash))
  expect(out.deny).toBeUndefined()
  expect(out.result.stdout).not.toContain('abAbab')
})

test('a plain word under a long placeholder number is masked, not redacted, in output', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __VAR__1290: 'disabled' }) })
  const stdout = 'client_secret: "disabled"\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out: any = await $.tool.call(eventOf(bash))
  expect(out.deny).toBeUndefined()
  expect(out.result.stdout).toContain('"__VAR__1290"')
})

test('a value the author marked by hand is sent, without the value, not withheld', async ($, on) => {
  const bash = recorded('Bash')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __MANUAL__1: 'Tr0ub4dor3xzQ' }),
  })
  const stdout = 'password = "Tr0ub4dor3xzQ"\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out: any = await $.tool.call(eventOf(bash))
  expect(out.deny).toBeUndefined()
  expect(JSON.stringify(out)).not.toContain('Tr0ub4dor3xzQ')
})

test('a hand-marked value already masked in output stays masked for the last scan', async ($, on) => {
  const bash = recorded('Bash')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __MANUAL__1: 'Tr0ub4dor3xzQ' }),
  })
  // Output that already holds the mark, such as a masked file printed again.
  const stdout = 'password = "__MANUAL__1"\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out: any = await $.tool.call(eventOf(bash))
  expect(out.deny).toBeUndefined()
  expect(out.result.stdout).toContain('__MANUAL__1')
})

// Third review (ccc5fff): names are replaced before the secret scan, so a name
// written against what a rule redacts is still masked.
test('a project name written against a redacted key is still masked', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __CLS__7: 'AcmeBilling' }) })
  const stdout =
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7bq9xZ2kLmN3pQ4rS5tU6vW7xY8zA9bC0dE1fG2hI3jK4lM5\n-----END RSA PRIVATE KEY-----AcmeBilling.pem\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out: any = await $.tool.call(eventOf(bash))
  expect(JSON.stringify(out)).not.toContain('AcmeBilling')
  expect(JSON.stringify(out)).not.toContain('MIIEowIBAAKCAQEA')
})

test('a regulated number in a credential slot is destroyed as written, and the result is sent', async ($, on) => {
  const bash = recorded('Bash')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __IBAN__1: 'GB82WEST12345698765432' }),
  })
  const stdout = 'api_key = "GB82WEST12345698765432"\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out: any = await $.tool.call(eventOf(bash))
  // As written it is a credential, and that finding stands (security review of a162a37).
  expect(out.deny).toBeUndefined()
  expect(JSON.stringify(out)).not.toContain('GB82WEST12345698765432')
  expect(out.result.stdout).toContain('__REDACTED_')
})

// Security review of a162a37: credentials are found in the text as written,
// before any name is replaced, and nothing the map knows overrides that.
test('a short connection-string password under a mapped user is redacted', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __VAR__5: 'ledger_user' }) })
  const stdout = 'DATABASE_URL=postgres://ledger_user:x9Q@db.internal:5432/prod\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out: any = await $.tool.call(eventOf(bash))
  expect(JSON.stringify(out)).not.toContain('x9Q@')
  expect(JSON.stringify(out)).not.toContain('ledger_user')
})

test('a credential that reads as one as written stays destroyed, whatever the map holds', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __VAR__1290: 'disabled' }) })
  // As written, this value has the entropy of key material: it is destroyed,
  // though it is spelled like one of the map's placeholders.
  const stdout = 'password = "__VAR__1290"\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out: any = await $.tool.call(eventOf(bash))
  expect(JSON.stringify(out)).not.toContain('__VAR__1290')
  expect(JSON.stringify(out)).toContain('__REDACTED_')
})

test('a credential in a field the guard has no row for is redacted, not only caught', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const note = 'exit 1: password = "Tr0ub4dor3xzQ"'
  on('tool.call', () => ({
    ...bash.r,
    result: { ...bash.r.result, returnCodeInterpretation: note },
  }))
  const out: any = await $.tool.call(eventOf(bash))
  expect(out.deny).toBeUndefined()
  expect(JSON.stringify(out)).not.toContain('Tr0ub4dor3xzQ')
})

// Security review of 28414f4: a scan redacts the occurrence it matched in
// context; the same value elsewhere, bare, must go too.
test('a credential that appears twice, once with its key and once bare, is redacted in both', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const stdout = 'password="xk9mq2vlp7rzq"\nretrying login with xk9mq2vlp7rzq (attempt 2)\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out: any = await $.tool.call(eventOf(bash))
  expect(out.deny).toBeUndefined()
  // Not shaped like a name, so nothing but the redaction would hide it.
  expect(JSON.stringify(out)).not.toContain('xk9mq2vlp7rzq')
})

test('a credential repeated bare in a typed prompt is redacted in both places', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  on('prompt.attachment', (_: any, e: any) => ({ text: e.text }))
  const text = 'DB_PASSWORD = "xk9mq2vlp7rz"\nthe URL is postgres://app@db/x?pw=xk9mq2vlp7rz'
  const out: any = await $.prompt.attachment({ type: 'edited_text_file', text })
  expect(out.text).not.toContain('xk9mq2vlp7rz')
})
