// Spec 033 US1: every tool result reaches the model scrubbed. Each test fires
// the recorded tool.call through the real hooks; the stub answers in Claude
// Code's place with the result it gave in the live session.
import { expect, test } from 'claude-code/testing'
import {
  CANARY,
  eventOf,
  mapFile,
  project,
  recorded,
  ROOT,
  res,
  outcome,
  recordedRaw,
  isFields,
} from './helpers.ts'
import type { Fields } from './fixtures/recorded.ts'

const SEEDED = { __CLS__1: CANARY, __VAR__1: 'settledTotal', __VAR__2: 'batchEntries' }

test('a source Read: the model gets placeholders, and the new names are saved first', async ($, on) => {
  const read = recorded('Read')
  const p = project(on)
  on('tool.call', () => read.r)
  const out = await $.tool.call(eventOf(read))
  expect(JSON.stringify(out)).not.toContain(CANARY)
  expect(JSON.stringify(out)).not.toContain('settledTotal')
  expect(res(out).type).toBe('text')
  expect(out.ref).toBeUndefined()
  expect(out.text).toBeUndefined()
  const saved = JSON.parse(p.files[`${ROOT}/.veilio/map.json`])
  expect(Object.values(saved.map)).toContain(CANARY)
  expect(p.files[`${ROOT}/.veilio/.gitignore`]).toBe('*\n')
  // The placeholder the model sees is the one the file now holds.
  const placeholder = Object.keys(saved.map).find((k) => saved.map[k] === CANARY)!
  expect(res(out).file.content).toContain(placeholder)
})

test("a subagent's Read is scrubbed the same way", async ($, on) => {
  const read = recorded('Read', 2)
  expect(read.e.agentId).toBeDefined()
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  on('tool.call', () => read.r)
  const out = await $.tool.call(eventOf(read))
  expect(JSON.stringify(out)).not.toContain(CANARY)
})

test('shell output naming only known names: replaced, and the map is not rewritten', async ($, on) => {
  const bash = recorded('Bash')
  expect(JSON.stringify(bash.r.result)).toContain(CANARY)
  const p = project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  on('tool.call', () => bash.r)
  const out = await $.tool.call(eventOf(bash))
  expect(JSON.stringify(out)).not.toContain(CANARY)
  expect(res(out).stdout).toContain('__CLS__1')
  expect(p.writes.filter((w) => w.path.endsWith('map.json'))).toEqual([])
})

// Claude Code checks a hook's `{ result }` against the tool's output schema,
// and an error's text never fits it: the error goes back as the text the model
// reads, masked, the way a refusal does.
test('a failed command: the error text is scrubbed and still an error', async ($, on) => {
  const failed = recordedRaw('Bash', 1)
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __STR__1: 'nonexistent-dir' }) })
  on('tool.call', () => failed.r)
  const out = await $.tool.call(eventOf(failed))
  expect(outcome(out).result).toBeUndefined()
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
  const out = await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: `${ROOT}/src` })
  expect(outcome(out).result).toBeUndefined()
  expect(out.deny).toBe(`EISDIR: illegal operation on a directory, read '${ROOT}/src/__CLS__1'`)
})

test('a comment in a source Read: known names masked, everyday words left', async ($, on) => {
  const read = recorded('Read')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({
      ...SEEDED,
      __VAR__9: 'total',
      __VAR__10: 'tarnwick',
      __STR__1: 'keep',
    }),
  })
  on('tool.call', () => ({
    ...read.r,
    result: {
      ...read.r.result,
      file: {
        ...read.r.result.file,
        content: `// keep the total and the tarnwick in ${CANARY}\nexport class ${CANARY} {\n  total = 1\n  tarnwick = 2\n}\n`,
      },
    },
  }))
  const out = await $.tool.call(eventOf(read))
  const lines = res(out).file.content.split('\n')
  // Spec 064: ordinary words stay readable. `total` is an English word, left
  // as written though the map holds it; `tarnwick` is masked, in the comment too.
  expect(lines[0]).toBe('// keep the total and the __VAR__10 in __CLS__1')
  expect(lines[1]).toBe('export class __CLS__1 {')
  expect(lines[2]).toBe('  total = 1')
  expect(lines[3]).toBe('  __VAR__10 = 2')
})

test('Grep in both modes and Glob: content and file names scrubbed, enums kept', async ($, on) => {
  const content = recorded('Grep')
  const files = recorded('Grep', 1)
  const glob = recorded('Glob')
  // `ledger`, the recorded file's name, is an ordinary word (spec 064): the
  // Glob result names a file with a distinctive one instead.
  const globbed = {
    ...glob.r,
    result: { ...glob.r.result, filenames: ['src/quayward.ts'] },
    text: 'src/quayward.ts',
  }
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __PKG__9: 'quayward' }) })
  on('tool.call', (_, e) =>
    e.tool === 'Glob' ? globbed : e.output_mode === 'content' ? content.r : files.r
  )
  const a = await $.tool.call(eventOf(content))
  const b = await $.tool.call(eventOf(files))
  const c = await $.tool.call(eventOf(glob))
  expect(res(a).mode).toBe('content')
  expect(res(b).mode).toBe('files_with_matches')
  expect(JSON.stringify(a)).not.toContain('settledTotal')
  expect(JSON.stringify(c)).not.toContain('quayward')
  expect(JSON.stringify(c)).toContain('__PKG__9.ts')
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
  on('tool.call', (_, e) => (e.tool === 'Edit' ? edit.r : write.r))
  // The model's Edit names the placeholders it was shown.
  const a = await $.tool.call({
    ...eventOf(edit),
    old_string: '__VAR__1',
    new_string: '__VAR__3',
  })
  const b = await $.tool.call(eventOf(write))
  expect(JSON.stringify(a)).not.toContain(CANARY)
  expect(JSON.stringify(a)).not.toContain('settledTotal')
  expect(JSON.stringify(b)).not.toContain('quasarExtra')
  expect(res(a).replaceAll).toBe(edit.r.result.replaceAll)
  expect(res(b).type).toBe('update')
})

test('an MCP text result is scrubbed', async ($, on) => {
  const mcp = recordedRaw('mcp__veilio__anonymize_text')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({ __STR__1: 'masked code', __STR__2: 'inline text' }),
  })
  on('tool.call', () => mcp.r)
  const out = await $.tool.call(eventOf(mcp))
  const blocks = outcome(out).result
  const first = Array.isArray(blocks) && isFields(blocks[0]) ? blocks[0] : {}
  expect(first.type).toBe('text')
  expect(first.text).not.toContain('inline text')
})

test('a tool with no field list has every string scrubbed: the Agent launch record', async ($, on) => {
  const agent = recorded('Agent')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __STR__1: 'notes.md' }) })
  on('tool.call', () => agent.r)
  const out = await $.tool.call(eventOf(agent))
  expect(JSON.stringify(res(out))).not.toContain('notes.md')
  expect(res(out).status).toBe('async_launched')
})

test('an image Read is withheld: images are not scrubbed yet', async ($, on) => {
  const read = recorded('Read')
  project(on)
  on('tool.call', () => ({
    result: { type: 'image', file: { base64: 'AAAA', type: 'image/png' } },
  }))
  const out = await $.tool.call({ ...eventOf(read), file_path: `${ROOT}/screen.png` })
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
  const out = await $.tool.call({ ...eventOf(read), offset: 160, limit: 3 })
  const lines = res(out).file.content.split('\n')
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
  const out = await $.tool.call(eventOf(read))
  expect(res(out).file.content).toBe('const n = __VAR__2.length\n')
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
  const out = await $.tool.call({
    ...eventOf(edit),
    old_string: '__VAR__1',
    new_string: '__VAR__1',
  })
  expect(out.deny).toBeUndefined()
  const sent = JSON.stringify(res(out))
  expect(sent).not.toContain('Tr0ub4dor3xz')
  expect(sent).toContain('__REDACTED_')
})

// Review of 9d3f6d0: a placeholder can stand for part of a credential.
test('a password holding a project name is still redacted in shell output', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __CLS__7: 'Acme' }) })
  const stdout = 'DB_PASSWORD = "Acme!9xQz"\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out = await $.tool.call(eventOf(bash))
  expect(JSON.stringify(out)).not.toContain('9xQz')
  expect(JSON.stringify(out)).not.toContain('Acme')
})

test('a secret a rule only partly took is redacted whole, and the result is sent', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  // 41 characters; the AWS rule takes 40 and left the last one beside its token.
  const stdout = 'aws_secret_access_key = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY123"\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out = await $.tool.call(eventOf(bash))
  expect(out.deny).toBeUndefined()
  expect(res(out).stdout).toMatch(/= "__REDACTED_[A-Z_]+_\d+__"/)
})

test('a plain word under a long placeholder number is not read as a credential', async ($, on) => {
  const read = recorded('Read')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __STR__1290: 'quayward' }) })
  const content = 'export const auth = { client_secret: "quayward" }\n'
  on('tool.call', () => ({
    ...read.r,
    result: { ...read.r.result, file: { ...read.r.result.file, content } },
  }))
  const out = await $.tool.call(eventOf(read))
  expect(out.deny).toBeUndefined()
  expect(res(out).file.content).toContain('__STR__1290')
})

test('a credential-shaped placeholder for a plain word in output is not read as a credential', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __VAR__1289: 'otherName' }) })
  // `abAbab` is too plain to be a credential; masked, its placeholder
  // (`__VAR__1290`) has the entropy of one. The last scan reads what it stands for.
  const stdout = 'secret: "abAbab"\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out = await $.tool.call(eventOf(bash))
  expect(out.deny).toBeUndefined()
  expect(res(out).stdout).not.toContain('abAbab')
})

test('a plain word under a long placeholder number is masked, not redacted, in output', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __VAR__1290: 'quayward' }) })
  const stdout = 'client_secret: "quayward"\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out = await $.tool.call(eventOf(bash))
  expect(out.deny).toBeUndefined()
  expect(res(out).stdout).toContain('"__VAR__1290"')
})

test('a value the author marked by hand is sent, without the value, not withheld', async ($, on) => {
  const bash = recorded('Bash')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __MANUAL__1: 'Tr0ub4dor3xzQ' }),
  })
  const stdout = 'password = "Tr0ub4dor3xzQ"\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out = await $.tool.call(eventOf(bash))
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
  const out = await $.tool.call(eventOf(bash))
  expect(out.deny).toBeUndefined()
  expect(res(out).stdout).toContain('__MANUAL__1')
})

// Third review (ccc5fff): names are replaced before the secret scan, so a name
// written against what a rule redacts is still masked.
test('a project name written against a redacted key is still masked', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __CLS__7: 'AcmeBilling' }) })
  const stdout =
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7bq9xZ2kLmN3pQ4rS5tU6vW7xY8zA9bC0dE1fG2hI3jK4lM5\n-----END RSA PRIVATE KEY-----AcmeBilling.pem\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out = await $.tool.call(eventOf(bash))
  expect(JSON.stringify(out)).not.toContain('AcmeBilling')
  expect(JSON.stringify(out)).not.toContain('MIIEowIBAAKCAQEA')
})

test('a regulated number the map holds stays its placeholder in a credential slot, as in a Read', async ($, on) => {
  const bash = recorded('Bash')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __IBAN__1: 'GB82WEST12345698765432' }),
  })
  const stdout = 'api_key = "GB82WEST12345698765432"\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out = await $.tool.call(eventOf(bash))
  // A value the map already masks reversibly is never destroyed (review of 99325ba).
  expect(out.deny).toBeUndefined()
  expect(JSON.stringify(out)).not.toContain('GB82WEST12345698765432')
  expect(res(out).stdout).toContain('"__IBAN__1"')
})

// Security review of a162a37: credentials are found in the text as written,
// before any name is replaced, and nothing the map knows overrides that.
test('a short connection-string password under a mapped user is redacted', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __VAR__5: 'ledger_user' }) })
  const stdout = 'DATABASE_URL=postgres://ledger_user:x9Q@db.internal:5432/prod\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out = await $.tool.call(eventOf(bash))
  expect(JSON.stringify(out)).not.toContain('x9Q@')
  expect(JSON.stringify(out)).not.toContain('ledger_user')
})

test('a credential that reads as one as written stays destroyed, whatever the map holds', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __VAR__1290: 'quayward' }) })
  // As written, this value has the entropy of key material: it is destroyed,
  // though it is spelled like one of the map's placeholders.
  const stdout = 'password = "__VAR__1290"\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out = await $.tool.call(eventOf(bash))
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
  const out = await $.tool.call(eventOf(bash))
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
  const out = await $.tool.call(eventOf(bash))
  expect(out.deny).toBeUndefined()
  // Not shaped like a name, so nothing but the redaction would hide it.
  expect(JSON.stringify(out)).not.toContain('xk9mq2vlp7rzq')
})

test('a credential repeated bare in a typed prompt is redacted in both places', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  on('prompt.attachment', (_, e) => ({ text: e.text }))
  const text = 'DB_PASSWORD = "xk9mq2vlp7rz"\nthe URL is postgres://app@db/x?pw=xk9mq2vlp7rz'
  const out = await $.prompt.attachment({ type: 'edited_text_file', text })
  expect(out.text).not.toContain('xk9mq2vlp7rz')
})

// Security review of 75fe4c0: what a scan destroys anywhere in a result is
// removed from all of it, and values that overlap are removed whole.
test('a secret found on one Grep line is removed from every line of the result', async ($, on) => {
  const grep = recorded('Grep')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const content = [
    `${ROOT}/notes.md:1:password="xk9mq2vlp7rz"`,
    `${ROOT}/notes.md:7:the staging login still uses xk9mq2vlp7rz`,
  ].join('\n')
  on('tool.call', () => ({ ...grep.r, result: { ...grep.r.result, content, numLines: 2 } }))
  const out = await $.tool.call(eventOf(grep))
  expect(out.deny).toBeUndefined()
  expect(JSON.stringify(out)).not.toContain('xk9mq2vlp7rz')
})

test('a secret found in one field of a result is removed from the others', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  on('tool.call', () => ({
    ...bash.r,
    result: {
      ...bash.r.result,
      stdout: 'password="xk9mq2vlp7rz"\n',
      stderr: 'warning: xk9mq2vlp7rz is weak\n',
    },
  }))
  const out = await $.tool.call(eventOf(bash))
  expect(JSON.stringify(out)).not.toContain('xk9mq2vlp7rz')
})

test('two secrets where one is a prefix of the other are both removed whole', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const stdout = [
    'password="xk9mq2vlp7rz"',
    'api_key="xk9mq2vlp7rzwq8tn4"',
    'rotated to xk9mq2vlp7rzwq8tn4 today',
  ].join('\n')
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out = await $.tool.call(eventOf(bash))
  const sent = JSON.stringify(out)
  expect(sent).not.toContain('xk9mq2vlp7rz')
  expect(sent).not.toContain('wq8tn4')
})

test('a source Read: a secret repeated in a comment is removed there too', async ($, on) => {
  const read = recorded('Read')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const content = 'const password = "xk9mq2vlp7rz"\n// was xk9mq2vlp7rz before the rotation\n'
  on('tool.call', () => ({
    ...read.r,
    result: { ...read.r.result, file: { ...read.r.result.file, content } },
  }))
  const out = await $.tool.call(eventOf(read))
  expect(out.deny).toBeUndefined()
  expect(JSON.stringify(out)).not.toContain('xk9mq2vlp7rz')
})

// Review of 28414f4.
test('a new project name written against a redacted key is masked and added', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const stdout =
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7bq9xZ2kLmN3pQ4rS5tU6vW7xY8zA9bC0dE1fG2hI3jK4lM5\n-----END RSA PRIVATE KEY-----AcmeBilling.pem\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out = await $.tool.call(eventOf(bash))
  expect(JSON.stringify(out)).not.toContain('AcmeBilling')
})

test('a source Read: a secret a rule only partly took is removed whole, and the Read is sent', async ($, on) => {
  const read = recorded('Read')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const content = 'const aws_secret_access_key = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY123"\n'
  on('tool.call', () => ({
    ...read.r,
    result: { ...read.r.result, file: { ...read.r.result.file, content } },
  }))
  const out = await $.tool.call(eventOf(read))
  expect(out.deny).toBeUndefined()
  expect(res(out).file.content).toMatch(/= "__REDACTED_[A-Z_]+_\d+__"/)
})

// Review of fe5078c: values a scan destroys are removed from the text as
// written, before any masking, so no repeat of one reaches the map.
test('a source Read: a password repeated in a string literal never reaches the map', async ($, on) => {
  const read = recorded('Read')
  const p = project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const content = 'const password = "Tr0ub4dor3xzQ"\nconsole.log("using Tr0ub4dor3xzQ now")\n'
  on('tool.call', () => ({
    ...read.r,
    result: { ...read.r.result, file: { ...read.r.result.file, content } },
  }))
  const out = await $.tool.call(eventOf(read))
  expect(JSON.stringify(out)).not.toContain('Tr0ub4dor3xzQ')
  expect(p.files[`${ROOT}/.veilio/map.json`] ?? '').not.toContain('Tr0ub4dor3xzQ')
})

test('a bare repeat of a secret a rule only partly took is removed whole', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const secret = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY1234567890ab'
  const stdout = `aws_secret_access_key = "${secret}"\nlog: ${secret} done\n`
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out = await $.tool.call(eventOf(bash))
  const sent = JSON.stringify(out)
  expect(sent).not.toContain('34567890ab')
  expect(sent).not.toContain('wJalrXUtn')
})

test('one secret gets one token everywhere, and two secrets two tokens', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  on('tool.call', () => ({
    ...bash.r,
    result: {
      ...bash.r.result,
      stdout: 'password = "Tr0ub4dor3xzQ"\n',
      stderr: 'api_key = "Zq8vB3nM1kL0pW"\nwarn: Tr0ub4dor3xzQ rejected\n',
    },
  }))
  const out = await $.tool.call(eventOf(bash))
  const a = /"(__REDACTED_[A-Z_]+_\d+__)"/.exec(res(out).stdout)?.[1]
  const b = /api_key = "(__REDACTED_[A-Z_]+_\d+__)"/.exec(res(out).stderr)?.[1]
  const c = /warn: (__REDACTED_[A-Z_]+_\d+__) rejected/.exec(res(out).stderr)?.[1]
  expect(a).toBeDefined()
  expect(a).toBe(c)
  expect(a).not.toBe(b)
})

test('a source Read: an identifier holding a secret is one placeholder everywhere, and the model never sees the secret', async ($, on) => {
  const read = recorded('Read')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const content =
    'const password = "Hunt3r2xyzQ"\nexport function connectHunt3r2xyzQPool() {}\nconnectHunt3r2xyzQPool()\n'
  on('tool.call', () => ({
    ...read.r,
    result: { ...read.r.result, file: { ...read.r.result.file, content } },
  }))
  const out = await $.tool.call(eventOf(read))
  const seen: string = res(out).file.content
  const decl = /export function (\S+)\(\)/.exec(seen)?.[1]
  expect(decl).toBeDefined()
  expect(seen).toContain(`\n${decl}()`)
  expect(JSON.stringify(out)).not.toContain('Hunt3r2xyzQ')
})

test('the rest of a partly taken secret with dashes and underscores is removed from a bare repeat', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const secret = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12345-67890_ab'
  const stdout = `aws_secret_access_key = "${secret}"\nlog: ${secret} done\n`
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out = await $.tool.call(eventOf(bash))
  expect(JSON.stringify(out)).not.toContain('67890')
})

// Security review of 69d4619: the run-on is not capped; its cost is bounded.
test('a key of over 300 characters repeated bare is removed whole, no tail left', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const key = `wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY${'Zq8vB3nM1kL0pW+/'.repeat(20)}abcdef`
  const stdout = `aws_secret_access_key = "${key}"\nlog: ${key} done\n`
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out = await $.tool.call(eventOf(bash))
  const sent = JSON.stringify(out)
  expect(sent).not.toContain('Zq8vB3nM1kL0pW')
  expect(sent).not.toContain('abcdef')
})

test('a secret seen once with a tail and once bare is removed in both places', async ($, on) => {
  const bash = recorded('Bash')
  const p = project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  // The AWS rule takes 40 characters; the slot holds them with a tail, the
  // log line holds the 40 alone, followed by a word boundary.
  const core = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12'
  const stdout = `aws_secret_access_key = "${core}=tail99"\nlog: ${core}. done\n`
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out = await $.tool.call(eventOf(bash))
  expect(JSON.stringify(out)).not.toContain('wJalrXUtn')
  expect(p.files[`${ROOT}/.veilio/map.json`] ?? '').not.toContain('wJalrXUtn')
})

test('a result with too many copies of a credential to remove is withheld, not sent', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const stdout = `password = "xk9mq2vlp7rz"\n${'xk9mq2vlp7rz '.repeat(150_000)}`
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out = await $.tool.call(eventOf(bash))
  expect(out.deny).toContain('Veilio withheld')
  expect(JSON.stringify(out)).not.toContain('xk9mq2vlp7rz')
})

// Phase-end review of 99325ba.
test('a docker-compose password that is a dictionary word does not eat the code that names it', async ($, on) => {
  const bash = recorded('Bash')
  const read = recorded('Read')
  const edit = recorded('Edit')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const compose = 'DATABASE_URL=postgres://postgres:postgres@localhost:5432/app\n'
  const source = "import postgres from 'postgres'\nconst postgresClient = postgres(url)\n"
  const seen: Fields[] = []
  on('tool.call', (_, e) => {
    seen.push(e)
    if (e.tool === 'Bash') return { ...bash.r, result: { ...bash.r.result, stdout: compose } }
    if (e.tool === 'Read')
      return {
        ...read.r,
        result: { ...read.r.result, file: { ...read.r.result.file, content: source } },
      }
    return edit.r
  })
  const first = await $.tool.call(eventOf(bash))
  expect(res(first).stdout).not.toContain(':postgres@')
  const r = await $.tool.call(eventOf(read))
  const shown: string = res(r).file.content
  expect(shown).not.toContain('__REDACTED_')
  // An edit built from what the model was shown runs.
  const line = shown.split('\n')[1]!
  const e = await $.tool.call({ ...eventOf(edit), old_string: line, new_string: line })
  expect(e.deny).toBeUndefined()
  expect(seen.some((x) => x.tool === 'Edit')).toBe(true)
})

test('a value the map holds reversibly stays its placeholder in a credential slot', async ($, on) => {
  const bash = recorded('Bash')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({
      ...SEEDED,
      __STR__41: 'acme_billing_session_token_v2',
    }),
  })
  const stdout = "session_token = 'acme_billing_session_token_v2'\n"
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const out = await $.tool.call(eventOf(bash))
  expect(res(out).stdout).toContain("'__STR__41'")
  expect(res(out).stdout).not.toContain('__REDACTED_')
})

test('a raw-only file dropped from a search teaches the guard nothing', async ($, on) => {
  const grep = recorded('Grep')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const content = [
    `${ROOT}/.env:1:API_KEY="Zq8vB3nM1kL0pW9x"`,
    `${ROOT}/notes.md:3:the fixture id Zq8vB3nM1kL0pW9x is public`,
  ].join('\n')
  on('tool.call', () => ({ ...grep.r, result: { ...grep.r.result, content, numLines: 2 } }))
  const out = await $.tool.call(eventOf(grep))
  expect(res(out).content).not.toContain('.env')
  expect(res(out).content).not.toContain('__REDACTED_')
})

test('a field the guard has no row for is scanned in full, whatever its text', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  // Its text equals the listed field's: told apart by where it stands. A
  // plain-word password is removed only by a scan of its own field.
  const url = 'postgres://postgres:postgres@db.internal:5432/app'
  on('tool.call', () => ({
    ...bash.r,
    result: { ...bash.r.result, stdout: url, returnCodeInterpretation: url },
  }))
  const out = await $.tool.call(eventOf(bash))
  expect(out.deny).toBeUndefined()
  expect(res(out).returnCodeInterpretation).not.toContain(':postgres@')
  expect(res(out).stdout).not.toContain(':postgres@')
})

// Security review of 933156e: a provider-format key always wins over the map.
const GH = 'ghp_' + 'Zq8vB3nM1kL0pW9xYc7dE6fG5hJ4kL3mN2pQ'
test('a provider-format key the map holds is still destroyed, and never restored', async ($, on) => {
  const bash = recorded('Bash')
  const edit = recorded('Edit')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __STR__9: GH }) })
  let edited = false
  on('tool.call', (_, e) => {
    if (e.tool === 'Edit') {
      edited = true
      return edit.r
    }
    return { ...bash.r, result: { ...bash.r.result, stdout: `token: ${GH}\n` } }
  })
  const out = await $.tool.call(eventOf(bash))
  expect(JSON.stringify(out)).not.toContain(GH)
  expect(res(out).stdout).not.toContain('__STR__9')
  const e = await $.tool.call({ ...eventOf(edit), old_string: 'x', new_string: '__STR__9' })
  expect(e.deny).toContain('Veilio refused this call')
  expect(edited).toBe(false)
})

test('a heuristic finding still defers to a value the map holds', async ($, on) => {
  const bash = recorded('Bash')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({ ...SEEDED, __STR__9: 'Zq8vB3nM1kL0pW9xYc7dE6fG' }),
  })
  on('tool.call', () => ({
    ...bash.r,
    result: { ...bash.r.result, stdout: 'auth_token: "Zq8vB3nM1kL0pW9xYc7dE6fG"\n' },
  }))
  const out = await $.tool.call(eventOf(bash))
  expect(res(out).stdout).toContain('"__STR__9"')
})

// Security audit 2026-11-01 (MEDIUM): the raw-only filter split a Grep line
// at its first ':' and its first '-N-', so a dated directory such as
// backups/2026-10-31/ - or a Windows drive letter - kept .env lines.
test('context and match lines of a raw-only file are dropped whatever its directory is called', async ($, on) => {
  const grep = recorded('Grep')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const content = [
    `${ROOT}/backups/2026-10-31/.env-1-DB_HOST=db.internal.acme-corp.example`,
    `${ROOT}/backups/2026-10-31/.env:2:PLAIN=hello world`,
    `${ROOT}/backups/2026-10-31/.env-3-DB_PASSWORD=hunter2hunter2`,
    `${ROOT}/src/app-v2-1-3/a.ts:4:const ok = 1`,
  ].join('\n')
  on('tool.call', () => ({ ...grep.r, result: { ...grep.r.result, content, numLines: 5 } }))
  const out = JSON.stringify(await $.tool.call(eventOf(grep)))
  expect(out).not.toContain('hunter2hunter2')
  expect(out).not.toContain('hello world')
  expect(out).not.toContain('.env')
  expect(out).toContain('const ok = 1')
})

test('a Windows path: every line of a raw-only file is dropped', async ($, on) => {
  const grep = recorded('Grep')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const content = [
    'C:\\work\\project\\.env:1:DB_HOST=db.internal.acme-corp.example',
    'C:\\work\\project\\.env-2-DB_PASSWORD=hunter2hunter2',
    'C:\\work\\project\\src\\a.ts:3:const ok = 1',
  ].join('\n')
  on('tool.call', () => ({ ...grep.r, result: { ...grep.r.result, content, numLines: 3 } }))
  const out = JSON.stringify(await $.tool.call(eventOf(grep)))
  expect(out).not.toContain('acme-corp')
  expect(out).not.toContain('hunter2hunter2')
  expect(out).toContain('const ok = 1')
})

// Automated review of aac1f66: without -n, ripgrep prints a context line as
// `path-text`, with no number to split on.
test('a context line printed without a line number is dropped too', async ($, on) => {
  const grep = recorded('Grep')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const content = [
    `${ROOT}/config/.env-DB_PASSWORD=hunter2hunter2`,
    `${ROOT}/config/.env:PLAIN=hello world`,
    `${ROOT}/src/a.ts:const ok = 1`,
  ].join('\n')
  on('tool.call', () => ({ ...grep.r, result: { ...grep.r.result, content, numLines: 3 } }))
  const out = JSON.stringify(await $.tool.call(eventOf(grep)))
  expect(out).not.toContain('hunter2hunter2')
  expect(out).not.toContain('hello world')
  expect(out).toContain('const ok = 1')
})

test('a very long line of separators is filtered in bounded time', async ($, on) => {
  const grep = recorded('Grep')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const content = `${ROOT}/dist/app.min.js:1:${'-'.repeat(200_000)}`
  on('tool.call', () => ({ ...grep.r, result: { ...grep.r.result, content, numLines: 1 } }))
  const started = Date.now()
  await $.tool.call(eventOf(grep))
  expect(Date.now() - started).toBeLessThan(5000)
})

// Work queue e72: a value the credential-named-key rule redacted was not
// learned, so a later result that printed it on its own sent it as written.
for (const [first, value] of [
  ['DB_PASSWORD=xQ7zW2vR9tY4pLmN', 'xQ7zW2vR9tY4pLmN'],
  ['export API_TOKEN="x9Kq2LmZ7vRt4Wp"', 'x9Kq2LmZ7vRt4Wp'],
  ['{"secretKey": "Zq8vB3nM1kL0pW9x"}', 'Zq8vB3nM1kL0pW9x'],
  ['password: Tq7wLz2Rk9Vx', 'Tq7wLz2Rk9Vx'],
  ['SMTP_PASS=qzkvwpxmrtbn8274', 'qzkvwpxmrtbn8274'],
])
  test(`a value redacted after its credential-named key stays redacted in a later result: ${first}`, async ($, on) => {
    const bash = recorded('Bash')
    const p = project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
    let stdout = `${first}\n`
    on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
    const one = await $.tool.call(eventOf(bash))
    expect(JSON.stringify(one)).not.toContain(value)
    stdout = `${value}\nconnecting with ${value} as admin\n`
    const two = await $.tool.call(eventOf(bash))
    expect(two.deny).toBeUndefined()
    expect(JSON.stringify(two)).not.toContain(value)
    // Destroyed, not taken for a project name: no placeholder, nothing saved
    // that a restore could write back.
    expect(res(two).stdout).toBe(
      '__REDACTED_CREDENTIAL_1001__\nconnecting with __REDACTED_CREDENTIAL_1001__ as admin\n'
    )
    expect(p.files[`${ROOT}/.veilio/map.json`]).not.toContain(value)
  })

test('a value under a credential-named key first seen in a config Read is never saved as a name', async ($, on) => {
  const read = recorded('Read')
  const bash = recorded('Bash')
  const p = project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const path = `${ROOT}/config/app.yaml`
  // The second line is a value under a key that names no secret: before e72
  // it was taken for a project name and written to the map.
  const content = 'password: Tq7wLz2Rk9Vx\nbackup_of: Tq7wLz2Rk9Vx\n'
  let call = 0
  on('tool.call', () =>
    call++ === 0
      ? {
          ...read.r,
          result: { ...read.r.result, file: { ...read.r.result.file, filePath: path, content } },
        }
      : { ...bash.r, result: { ...bash.r.result, stdout: 'Tq7wLz2Rk9Vx\n' } }
  )
  const one = await $.tool.call({ ...eventOf(read), file_path: path })
  expect(res(one).file.content).toContain('password: __REDACTED_CREDENTIAL_1001__\n')
  expect(res(one).file.content.split('__REDACTED_CREDENTIAL_1001__').length).toBe(3)
  const two = await $.tool.call(eventOf(bash))
  expect(res(two).stdout).toBe('__REDACTED_CREDENTIAL_1001__\n')
  expect(p.writes.filter((w) => w.path.endsWith('map.json')).length).toBeGreaterThan(0)
  expect(p.files[`${ROOT}/.veilio/map.json`]).not.toContain('Tq7wLz2Rk9Vx')
})

// Security review of 0228a04: whether a key's value is learned turns on the
// value (quoted, or a configuration line's), never on which tool showed it.
const CODE =
  'const apiToken = "Xk9mQ2vL7ZpQw"\nconst password = xQ7zW2vR9tY4pLmN;\nconst passKey = rotateKeyV2Xq9;\n'
const lines = CODE.trimEnd().split('\n')
const showing: [string, (r: Fields) => Fields][] = [
  ['a Write', (r) => ({ ...r, result: { ...r.result, content: CODE } })],
  [
    'an Edit',
    (r) => ({
      ...r,
      result: {
        ...r.result,
        newString: CODE,
        structuredPatch: [
          { oldStart: 1, oldLines: 0, newStart: 1, newLines: 3, lines: lines.map((l) => `+${l}`) },
        ],
      },
    }),
  ],
  [
    'a git diff',
    (r) => ({ ...r, result: { ...r.result, stdout: lines.map((l) => `+${l}`).join('\n') } }),
  ],
  [
    'a Grep without paths',
    (r) => ({
      ...r,
      result: { ...r.result, content: lines.map((l, i) => `${i + 1}:${l}`).join('\n') },
    }),
  ],
]
const toolOf = {
  'a Write': 'Write',
  'an Edit': 'Edit',
  'a git diff': 'Bash',
  'a Grep without paths': 'Grep',
} as const
for (const [label, shape] of showing)
  test(`${label} of code: a quoted value under a secret key is learned, code is not`, async ($, on) => {
    const first = recorded(toolOf[label as keyof typeof toolOf])
    const bash = recorded('Bash')
    project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
    let call = 0
    on('tool.call', () =>
      call++ === 0
        ? (shape(first.r as unknown as Fields) as unknown as typeof first.r)
        : {
            ...bash.r,
            result: {
              ...bash.r.result,
              stdout: 'Xk9mQ2vL7ZpQw xQ7zW2vR9tY4pLmN; rotateKeyV2Xq9;\n',
            },
          }
    )
    await $.tool.call(eventOf(first))
    const two = await $.tool.call(eventOf(bash))
    const words = (res(two).stdout as string).trim().split(' ')
    expect(words[0]).toMatch(/^__REDACTED_CREDENTIAL_\d+__$/)
    expect(words.slice(1).join(' ')).not.toContain('__REDACTED_')
  })

// Each line of a search is judged without its `path:N:` or `path-N-` prefix,
// by its own file's kind: a configuration line is learned, code is not.
test('a search learns each line by its own file: a config line is learned and swept, code is not', async ($, on) => {
  const grep = recorded('Grep')
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const content = [
    `${ROOT}/notes.md:1:rotated Xk9mQ2vL7ZpQwR last week`,
    `${ROOT}/config/app.yaml:12:password: Xk9mQ2vL7ZpQwR`,
    `${ROOT}/src/session.ts:3:const password = xQ7zW2vR9tY4pLmN;`,
    `${ROOT}/src/app.py:4:    self.secret_key = Xq9mK2pLzRvNw7`,
    `${ROOT}/src/app.py-5-api_token: Xq8nK3pLzRvMw6`,
  ].join('\n')
  let call = 0
  on('tool.call', () =>
    call++ === 0
      ? { ...grep.r, result: { ...grep.r.result, content, numLines: 5 } }
      : {
          ...bash.r,
          result: {
            ...bash.r.result,
            stdout: 'Xk9mQ2vL7ZpQwR xQ7zW2vR9tY4pLmN; Xq9mK2pLzRvNw7 Xq8nK3pLzRvMw6\n',
          },
        }
  )
  const one = await $.tool.call(eventOf(grep))
  expect(res(one).content).not.toContain('Xk9mQ2vL7ZpQwR')
  const two = await $.tool.call(eventOf(bash))
  const words = (res(two).stdout as string).trim().split(' ')
  expect(words[0]).toMatch(/^__REDACTED_CREDENTIAL_\d+__$/)
  expect(words.slice(1).join(' ')).not.toContain('__REDACTED_')
})

// A context line (`rg -C`) is `path-N-text`: before, its pair had no value
// span and the password went out as written.
test("a search's context line is judged without its prefix: its password is removed and learned", async ($, on) => {
  const grep = recorded('Grep')
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const content = [
    `${ROOT}/deploy/settings.ini:2:[database]`,
    `${ROOT}/deploy/settings.ini-3-DB_PASSWORD=Qx7mKpL9zRvNwTyB`,
    `${ROOT}/deploy/settings.ini-4-smtp_password: Wb4nR8tLq2XzKm`,
  ].join('\n')
  let call = 0
  on('tool.call', () =>
    call++ === 0
      ? { ...grep.r, result: { ...grep.r.result, content, numLines: 3 } }
      : { ...bash.r, result: { ...bash.r.result, stdout: 'Qx7mKpL9zRvNwTyB Wb4nR8tLq2XzKm\n' } }
  )
  const one = await $.tool.call(eventOf(grep))
  expect(res(one).content).not.toMatch(/Qx7mKpL9zRvNwTyB|Wb4nR8tLq2XzKm/)
  const two = await $.tool.call(eventOf(bash))
  expect(res(two).stdout).toMatch(/^__REDACTED_CREDENTIAL_\d+__ __REDACTED_CREDENTIAL_\d+__\n$/)
})

// A context line whose path no match line names cannot be split: it is
// removed as before and teaches the session nothing (e72 closing review).
test('a context line no match line places is masked, and not learned from', async ($, on) => {
  const grep = recorded('Grep')
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  let call = 0
  on('tool.call', () =>
    call++ === 0
      ? {
          ...grep.r,
          result: {
            ...grep.r.result,
            content: `${ROOT}/src/app.py-4-self.secret_key=Xq9mK2pLzRvNw7`,
            numLines: 1,
          },
        }
      : { ...bash.r, result: { ...bash.r.result, stdout: 'Xq9mK2pLzRvNw7\n' } }
  )
  const one = await $.tool.call(eventOf(grep))
  expect(res(one).content).not.toContain('Xq9mK2pLzRvNw7')
  const two = await $.tool.call(eventOf(bash))
  expect(res(two).stdout).not.toContain('__REDACTED_')
})

// Code review of acea47b: an assignment without a `;` reads as a
// configuration line; in a file of a known language it is code.
const PY = '    self.secret_key = Xq9mK2pLzRvNw7\n'
const JS = 'this.apiKey = Xq9mK2pLzRvNw7\n'
for (const [name, path, content] of [
  ['Python', `${ROOT}/src/app.py`, PY],
  ['JavaScript', `${ROOT}/src/app.js`, JS],
] as const)
  for (const via of ['Read', 'Edit'] as const)
    test(`${name} code shown by ${via} is not learned by the key rule`, async ($, on) => {
      const first = recorded(via)
      const bash = recorded('Bash')
      project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
      const result =
        via === 'Read'
          ? { ...first.r.result, file: { ...first.r.result.file, filePath: path, content } }
          : { ...first.r.result, filePath: path, newString: content, originalFile: content }
      let call = 0
      on('tool.call', () =>
        call++ === 0
          ? { ...first.r, result }
          : { ...bash.r, result: { ...bash.r.result, stdout: 'Xq9mK2pLzRvNw7\n' } }
      )
      await $.tool.call({ ...eventOf(first), file_path: path })
      const two = await $.tool.call(eventOf(bash))
      expect(res(two).stdout).not.toContain('__REDACTED_')
    })

test('a token in a URL is learned without the query after it', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  let stdout = 'Location: https://app.example/cb?access_token=Pq7rT2wZx9Lm&state=1\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const one = await $.tool.call(eventOf(bash))
  expect(JSON.stringify(one)).not.toContain('Pq7rT2wZx9Lm')
  stdout = 'token Pq7rT2wZx9Lm\n'
  const two = await $.tool.call(eventOf(bash))
  expect(res(two).stdout).toMatch(/^token __REDACTED_CREDENTIAL_\d+__\n$/)
})

test('a weak value redacted after its credential-named key is not swept from later results', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  let stdout = 'DB_PASSWORD=sunshine2026\n'
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout } }))
  const one = await $.tool.call(eventOf(bash))
  expect(JSON.stringify(one)).not.toContain('sunshine2026')
  // Founder decision #5: a word and a year is not carried forward, as after
  // `password = "..."`; COVERAGE.md, A weak password away from its assignment.
  stdout = 'the sunshine2026 campaign\n'
  const two = await $.tool.call(eventOf(bash))
  expect(res(two).stdout).toContain('sunshine2026')
})
