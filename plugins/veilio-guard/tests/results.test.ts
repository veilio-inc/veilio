// Spec 033 US1: every tool result reaches the model scrubbed. Each test fires
// the recorded tool.call through the real hooks; the stub answers in Claude
// Code's place with the result it gave in the live session.
import { expect, test } from 'claude-code/testing'
import {
  CANARY,
  STRIPE,
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

test(
  'a very long line of separators is filtered in bounded time',
  { timeoutMs: 60_000 },
  async ($, on) => {
    const grep = recorded('Grep')
    project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
    let content = ''
    on('tool.call', () => ({ ...grep.r, result: { ...grep.r.result, content, numLines: 1 } }))
    // Time against the line's length, not a wall clock: a shared CI runner is
    // slow some days, but a filter that is quadratic grows ~100x for 10x the line.
    const timed = async (n: number) => {
      content = `${ROOT}/dist/app.min.js:1:${'-'.repeat(n)}`
      const started = performance.now()
      await $.tool.call(eventOf(grep))
      return performance.now() - started
    }
    await timed(1_000) // warm-up
    const base = await timed(1_000) // the fixed cost of one call, ~1 s on CI
    const small = (await timed(20_000)) - base
    const large = (await timed(200_000)) - base
    expect(large).toBeLessThan(30 * Math.max(small, 0) + 500)
  }
)

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
]
const toolOf = {
  'a Write': 'Write',
  'an Edit': 'Edit',
  'a git diff': 'Bash',
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

// Ship check of e72: a Grep result is masked line by line exactly as before,
// and the key rule learns nothing from it - its lines' files cannot be told
// apart safely (a secret file named by its path, a .pgpass line, no -n).
// Spec 074: these files are not on disk, so no line is resolved and pass 2
// adds nothing; search-output.test.ts has the resolved twins.
for (const [label, content] of [
  ['a config line', `${ROOT}/config/app.yaml:12:password: Xk9mQ2vL7ZpQwR`],
  [
    'one Python file without paths',
    '4:    self.secret_key = Xk9mQ2vL7ZpQwR\n5:    session_token = "Xk9mQ2vL7ZpQwR"',
  ],
] as const)
  test(`a search's key values are masked there and not learned: ${label}`, async ($, on) => {
    const grep = recorded('Grep')
    const bash = recorded('Bash')
    project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
    let call = 0
    on('tool.call', () =>
      call++ === 0
        ? { ...grep.r, result: { ...grep.r.result, content, numLines: content.split('\n').length } }
        : { ...bash.r, result: { ...bash.r.result, stdout: 'Xk9mQ2vL7ZpQwR\n' } }
    )
    const one = await $.tool.call(eventOf(grep))
    expect(res(one).content).not.toContain('Xk9mQ2vL7ZpQwR')
    const two = await $.tool.call(eventOf(bash))
    expect(res(two).stdout).not.toContain('__REDACTED_')
  })

// Byte for byte as before e72: a Grep line's key value goes under its own
// token, even one holding a finding's token (notes.txt is not on disk:
// unresolved, spec 074).
test("a search line's key value is masked exactly as before e72", async ($, on) => {
  const grep = recorded('Grep')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(SEEDED) })
  const ghp = 'ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const content = `${ROOT}/notes.txt:1:GITHUB_TOKEN=${ghp}&x=1`
  on('tool.call', () => ({ ...grep.r, result: { ...grep.r.result, content, numLines: 1 } }))
  const out = await $.tool.call(eventOf(grep))
  expect(res(out).content).toMatch(/:1:GITHUB_TOKEN=__REDACTED_CREDENTIAL_1002__$/)
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

// Spec 078 FR-018a (research R2, N2): a shell command can print a source
// file's names encoded, with no placeholder in the command. Each encoded form
// is computed here from the plain names, never written out.
const PAY = 'class PaymentGateway {\n  chargeCard(order: OrderService) {}\n}\n'
const PAY_MAP = {
  __CLS__1: 'PaymentGateway',
  __FN__1: 'chargeCard',
  __CLS__2: 'OrderService',
  __CLS__3: 'InvoiceBuilder',
}
const ENCODED =
  'Veilio withheld this result: it holds a project name encoded (base64, hex, reversed or spelled down a column). Nothing from it was sent.'
// The mod runtime has no Buffer: ASCII text, encoded with the web's btoa.
const b64 = (s: string) => btoa(s)
const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const hex = (s: string) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
const wrap = (s: string, n: number) => s.match(new RegExp(`.{1,${n}}`, 'gs'))!.join('\n')
const reversed = (s: string) =>
  s
    .split('\n')
    .map((l) => [...l].reverse().join(''))
    .join('\n')

async function shellPrints(
  $: Parameters<Parameters<typeof test>[1]>[0],
  on: Parameters<Parameters<typeof test>[1]>[1],
  command: string,
  stdout: string,
  map: Record<string, string> = PAY_MAP
) {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(map), [`${ROOT}/src/pay.ts`]: PAY })
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, stdout, stderr: '' } }))
  return $.tool.call({ ...eventOf(bash), command })
}

const ENCODED_FORMS: [string, string][] = [
  ['base64 src/pay.ts', wrap(b64(PAY), 76) + '\n'],
  ['cat src/pay.ts | fold -w3', wrap(PAY.replace(/\n/g, ''), 3) + '\n'],
  ['cat src/pay.ts | fold -w1', wrap('PaymentGateway', 1) + '\n'],
  ['xxd -p src/pay.ts', wrap(hex(PAY), 60) + '\n'],
  [
    'od -An -tx1 src/pay.ts',
    wrap(hex(PAY), 32)
      .split('\n')
      .map((l) => ' ' + l.match(/../g)!.join(' '))
      .join('\n') + '\n',
  ],
  ['rev src/pay.ts', reversed(PAY)],
  [
    'npx vitest run tests/pay.test.ts',
    ` ✓ tests/pay.test.ts (1)\nstdout | encoded: ${b64('PaymentGateway')}\n`,
  ],
  ['node tests/pay.mjs', `${b64url('chargeCard(order)?')}\n`],
]
for (const [command, stdout] of ENCODED_FORMS)
  test(`a project name printed encoded is withheld: ${command}`, async ($, on) => {
    const out = await shellPrints($, on, command, stdout)
    expect(out.deny).toBe(ENCODED)
  })

// COVERAGE.md, Not covered: Tests the agent writes (re-cased output, strings.md #24).
test('the documented limit: a re-cased copy of a file still reaches the model (tr A-Z a-z)', async ($, on) => {
  const out = await shellPrints($, on, 'tr A-Z a-z < src/pay.ts', PAY.toLowerCase())
  expect(out.deny).toBeUndefined()
  expect(res(out).stdout).toContain('paymentgateway')
})

// COVERAGE.md, Not covered: Tests the agent writes - the forms the
// encoded-name check does not read (review round 1 item (e)).
const od = (s: string) =>
  wrap([...s].map((c) => (c === '\n' ? '  \\n' : `   ${c}`)).join(''), 64)
    .split('\n')
    .map((l, i) => `${(i * 16).toString(8).padStart(7, '0')} ${l}`)
    .join('\n') + '\n'
const LIMITS: [string, string][] = [
  ['od -c src/pay.ts', od(PAY)],
  ['cat src/pay.ts | fold -w5', wrap(PAY.replace(/\n/g, ''), 5) + '\n'],
  ['node tests/pay.mjs', `build/${b64('PaymentGateway')}\n`],
]
for (const [command, stdout] of LIMITS)
  test(`the documented limit: a project name in a form the guard does not decode still reaches the model: ${command}`, async ($, on) => {
    const out = await shellPrints($, on, command, stdout)
    expect(out.deny).toBeUndefined()
  })

const ORDINARY: [string, string, Record<string, string>?][] = [
  ['npm ls', 'app@1.0.0 /work/project\n├── payment-gateway@2.1.0\n└── paymentgateway@1.0.0\n'],
  [
    'git log --oneline',
    'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 fix: totals\n0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6 docs\n',
  ],
  [
    'cat tests/fixtures/logo.b64',
    btoa(String.fromCharCode(...Array.from({ length: 96 }, (_, i) => (i * 37 + 11) % 256))) + '\n',
  ],
  // A spec 064 ordinary word is readable as itself: so is its encoding.
  [
    'cat tests/fixtures/total.b64',
    `${b64('the total is 42 today')}\n`,
    { ...PAY_MAP, __VAR__5: 'total' },
  ],
  // Under 4 characters, a name is too short to tell from ordinary text.
  [
    'cat tests/fixtures/short.b64',
    `${b64('Hello Gx and friends')}\n`,
    { ...PAY_MAP, __CLS__7: 'Gx' },
  ],
  // No case-folding for names: the lower-case npm package name is not PaymentGateway.
  ['npm view paymentgateway --json', `${b64('{"name":"paymentgateway"}')}\n`],
]
for (const [command, stdout, map] of ORDINARY)
  test(`ordinary output is not withheld: ${command}`, async ($, on) => {
    const out = await shellPrints($, on, command, stdout, map)
    expect(out.deny).toBeUndefined()
  })

// Security review of the encoded-name check (HIGH): a failed command's error
// text reaches the model too.
test('a failed command whose error text holds a name encoded is withheld', async ($, on) => {
  const failed = recordedRaw('Bash', 1)
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(PAY_MAP), [`${ROOT}/src/pay.ts`]: PAY })
  const text = `Exit code 1\nunexpected token: ${b64('class PaymentGateway {}')}`
  on('tool.call', () => ({ ...failed.r, result: `Error: ${text}`, text, isError: true }))
  const out = await $.tool.call({ ...eventOf(failed), command: 'node tests/pay.mjs' })
  expect(out.deny).toBe(ENCODED)
})

// Review round 1 item 5: a background shell's output, read later, is a
// shell's stdout too.
for (const tool of ['BashOutput', 'TaskOutput'])
  test(`a background shell's output holding a name encoded is withheld: ${tool}`, async ($, on) => {
    const bash = recorded('Bash')
    project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: 'PaymentGateway' }) })
    const stdout = `${b64('PaymentGateway')}\n`
    on('tool.call', () => ({
      ...bash.r,
      result: { shellId: 'bash_1', status: 'running', stdout, stderr: '', stdoutLines: 1 },
    }))
    const out = await $.tool.call({
      tool,
      bash_id: 'bash_1',
      task_id: 'bash_1',
      agentId: bash.e.agentId,
    })
    expect(out.deny).toBe(ENCODED)
  })

// Spec 078 US2 (A#2, N1, research R3): a credential removed earlier stays
// removed when it comes back reformatted, sliced or encoded. The key is the
// helpers' fake STRIPE value, built by concatenation; every form of it is
// computed here.
const RESHAPED =
  'Veilio withheld this result: a credential removed earlier in this session came back in another form (spaced, split, sliced or encoded). Nothing from it was sent.'
const KEY_TAIL = STRIPE.slice('sk_live_'.length) // starts with a digit
const CONFIG = `export const stripeKey = '${STRIPE}'\n`

/** A session that has read src/config.ts (removing the key), then runs `tool`. */
async function afterKeyRead(
  $: Parameters<Parameters<typeof test>[1]>[0],
  on: Parameters<Parameters<typeof test>[1]>[1],
  answer: (e: Record<string, unknown>) => unknown,
  map: Record<string, string> = PAY_MAP,
  files: Record<string, string> = {}
) {
  const read = recorded('Read')
  const p = project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile(map),
    [`${ROOT}/src/config.ts`]: CONFIG,
    ...files,
  })
  let first = true
  on('tool.call', (_, e) => {
    if (first) {
      first = false
      return {
        ...read.r,
        result: {
          ...read.r.result,
          file: { ...read.r.result.file, filePath: `${ROOT}/src/config.ts`, content: CONFIG },
        },
      }
    }
    return answer(e)
  })
  const shown = await $.tool.call({ ...eventOf(read), file_path: `${ROOT}/src/config.ts` })
  expect(JSON.stringify(shown)).not.toContain(KEY_TAIL)
  expect(JSON.stringify(shown)).toContain('__REDACTED_CREDENTIAL_')
  return p
}

const bashOut = (stdout: string) => {
  const bash = recorded('Bash')
  return { ...bash.r, result: { ...bash.r.result, stdout, stderr: '' } }
}

/** The key in 8-character pieces joined by `sep`, as text. */
const eights = (sep: string) => STRIPE.match(/.{1,8}/g)!.join(sep)

const KEY_FORMS: [string, string][] = [
  ['spaced', [...STRIPE].join(' ')],
  ['comma', [...STRIPE].join(',')],
  ['a 22-character slice starting with a digit', KEY_TAIL.slice(0, 22)],
  ['dash groups of 4', KEY_TAIL.match(/.{1,4}/g)!.join('-')],
  ['lines of 6', KEY_TAIL.match(/.{1,6}/g)!.join('\n')],
  ['reversed', [...STRIPE].reverse().join('')],
  ['base64', btoa(STRIPE)],
  ['hex', hex(STRIPE)],
  [
    'upper-cased and spaced in a test runner',
    `FAIL expected ${[...STRIPE.toUpperCase()].join(' ')}`,
  ],
  // Review round 1 item 7: escape sequences written as text, in 8-character
  // pieces (each under the 12 a name is held to).
  ...['\\n', '\\t', '\\r', '\\0', '\\x0a', '\\u000a'].map((esc): [string, string] => [
    `in pieces joined by ${esc}`,
    eights(esc),
  ]),
]
for (const [form, text] of KEY_FORMS)
  test(`a removed credential that comes back ${form} through Bash is withheld`, async ($, on) => {
    await afterKeyRead($, on, () => bashOut(`${text}\n`))
    const bash = recorded('Bash')
    const out = await $.tool.call({ ...eventOf(bash), command: 'node tests/key.mjs' })
    expect(out.deny).toBe(RESHAPED)
  })

test('a removed credential in 8-character pieces joined by backslash-n in a Read is withheld, and no piece is saved', async ($, on) => {
  const split = `export const parts = "${eights('\\n')}"\n`
  const read = recorded('Read')
  const p = await afterKeyRead($, on, () => ({
    ...read.r,
    result: {
      ...read.r.result,
      file: { ...read.r.result.file, filePath: `${ROOT}/src/split.ts`, content: split },
    },
  }))
  p.files[`${ROOT}/src/split.ts`] = split
  const out = await $.tool.call({ ...eventOf(read), file_path: `${ROOT}/src/split.ts` })
  expect(out.deny).toBe(RESHAPED)
  const saved = Object.values(JSON.parse(p.files[`${ROOT}/.veilio/map.json`]).map) as string[]
  for (const piece of STRIPE.match(/.{1,8}/g)!) expect(saved).not.toContain(piece)
  expect(saved.filter((n) => STRIPE.includes(n) && n.length >= 4)).toEqual([])
})

test('a removed credential in 8-character pieces joined by backslash-0 is withheld when a cat names its file', async ($, on) => {
  const split = `export const parts = "${eights('\\0')}"\n`
  const p = await afterKeyRead($, on, () => bashOut(split))
  p.files[`${ROOT}/src/split.ts`] = split
  const bash = recorded('Bash')
  const out = await $.tool.call({ ...eventOf(bash), command: 'cat src/split.ts' })
  expect(out.deny).toBe(RESHAPED)
  const saved = Object.values(JSON.parse(p.files[`${ROOT}/.veilio/map.json`]).map) as string[]
  expect(saved.filter((n) => STRIPE.includes(n.replace(/^0/, '')) && n.length >= 4)).toEqual([])
})

test('a slice of a removed credential inside a Grep result is withheld', async ($, on) => {
  const grep = recorded('Grep')
  await afterKeyRead($, on, () => ({
    ...grep.r,
    result: {
      ...grep.r.result,
      content: `src/notes.md:3:see ${KEY_TAIL.slice(2, 24)} here`,
      numLines: 1,
    },
  }))
  const out = await $.tool.call(eventOf(grep))
  expect(out.deny).toBe(RESHAPED)
})

test('a slice of a removed credential inside an MCP text result is withheld', async ($, on) => {
  const mcp = recordedRaw('mcp__veilio__anonymize_text')
  await afterKeyRead($, on, () => ({
    ...mcp.r,
    result: [{ type: 'text', text: `k=${KEY_TAIL.slice(4, 24)}` }],
  }))
  const out = await $.tool.call(eventOf(mcp))
  expect(out.deny).toBe(RESHAPED)
})

// N1: a 12-15-character slice is not withheld (under 16), and no name holding
// it is ever saved: an identifier built on it is masked under a quarantine
// placeholder instead, so the map a team shares never carries it.
test('a name holding a short slice of a removed credential is never saved to the map', async ($, on) => {
  const slice = KEY_TAIL.slice(2, 15) // 13 characters
  const other = `export function build${slice}Total() {}\n`
  const read = recorded('Read')
  const p = await afterKeyRead($, on, () => ({
    ...read.r,
    result: {
      ...read.r.result,
      file: { ...read.r.result.file, filePath: `${ROOT}/src/other.ts`, content: other },
    },
  }))
  p.files[`${ROOT}/src/other.ts`] = other
  const out = await $.tool.call({ ...eventOf(read), file_path: `${ROOT}/src/other.ts` })
  expect(JSON.stringify(out)).not.toContain(slice)
  expect(res(out).file.content).toMatch(/__QUARANTINED__\d+/)
  const compact = STRIPE.replace(/[^A-Za-z0-9]/g, '').toLowerCase()
  const saved = Object.values(JSON.parse(p.files[`${ROOT}/.veilio/map.json`]).map) as string[]
  for (const name of saved) {
    const c = name.replace(/[^A-Za-z0-9]/g, '').toLowerCase()
    for (let k = 0; k + 12 <= c.length; k++)
      expect(`${name}: ${compact.includes(c.slice(k, k + 12))}`).toBe(`${name}: false`)
  }
})

test('at load: a map entry sharing 12 characters with a removed credential is never restored', async ($, on) => {
  const planted = KEY_TAIL.slice(0, 14)
  const seen: Record<string, unknown>[] = []
  const edit = recorded('Edit')
  await afterKeyRead(
    $,
    on,
    (e) => {
      seen.push(e)
      return edit.r
    },
    { ...PAY_MAP, __VAR__8: planted }
  )
  const out = await $.tool.call({ ...eventOf(edit), old_string: 'x', new_string: 'use(__VAR__8)' })
  expect(out.deny).toContain('Veilio refused this call')
  expect(seen.length).toBe(0)
})

// Review round 1 item 4: the old placeholders a publish renumbered
// (.veilio/aliases.json) get the same quarantine as the map. Numbered apart
// from what the Read mints (a contested placeholder restores from neither).
const ALIASES = `${ROOT}/.veilio/aliases.json`
test('at load: neither a map entry nor an alias sharing 12 characters with a removed credential is restored', async ($, on) => {
  const seen: Record<string, unknown>[] = []
  const edit = recorded('Edit')
  await afterKeyRead(
    $,
    on,
    (e) => {
      seen.push(e)
      return edit.r
    },
    { ...PAY_MAP, __VAR__90201: `use${KEY_TAIL.slice(0, 12)}` },
    {
      [ALIASES]: JSON.stringify({
        version: 1,
        aliases: { __VAR__902: `old${KEY_TAIL.slice(12, 24)}`, __VAR__903: 'settledTotal' },
      }),
    }
  )
  for (const p of ['__VAR__90201', '__VAR__902']) {
    const out = await $.tool.call({ ...eventOf(edit), old_string: 'x', new_string: `${p}()` })
    expect(out.deny).toContain('Veilio refused this call')
  }
  expect(seen.length).toBe(0)
  // An alias that holds no credential still restores.
  await $.tool.call({ ...eventOf(edit), old_string: 'x', new_string: '__VAR__903()' })
  expect(seen[0]?.new_string).toBe('settledTotal()')
})

test('an alias restored before a credential is removed is not restored after it', async ($, on) => {
  const planted = `use${KEY_TAIL.slice(0, 12)}`
  const edit = recorded('Edit')
  const read = recorded('Read')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile(PAY_MAP),
    [`${ROOT}/src/config.ts`]: CONFIG,
    [ALIASES]: JSON.stringify({ version: 1, aliases: { __VAR__902: planted } }),
  })
  const seen: Record<string, unknown>[] = []
  on('tool.call', (_, e) => {
    if (e.tool === 'Read')
      return {
        ...read.r,
        result: {
          ...read.r.result,
          file: { ...read.r.result.file, filePath: `${ROOT}/src/config.ts`, content: CONFIG },
        },
      }
    seen.push(e)
    return edit.r
  })
  const call = { ...eventOf(edit), old_string: 'x', new_string: '__VAR__902()' }
  expect((await $.tool.call(call)).deny).toBeUndefined()
  expect(seen[0]?.new_string).toBe(`${planted}()`)
  const shown = await $.tool.call({ ...eventOf(read), file_path: `${ROOT}/src/config.ts` })
  expect(JSON.stringify(shown)).not.toContain(KEY_TAIL)
  expect((await $.tool.call(call)).deny).toContain('Veilio refused this call')
  expect(seen.length).toBe(1)
})

// Review round 1 item 8: of a private key, only the body between its BEGIN
// and END lines is learned, never the armor every key shares.
const PEM_BODY = wrap(btoa(`not a real key ${'fake-material-'.repeat(12)}`), 64)
const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----\n`
/** A session in which a shell printed a private key (removed), answering
 *  later Bash calls with `next()`'s stdout and Reads with src/parse.ts. */
async function afterPemRemoved(
  $: Parameters<Parameters<typeof test>[1]>[0],
  on: Parameters<Parameters<typeof test>[1]>[1],
  next: () => string,
  parse = ''
) {
  const read = recorded('Read')
  const p = project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile(PAY_MAP),
    [`${ROOT}/src/parse.ts`]: parse,
  })
  let first = true
  on('tool.call', (_, e) => {
    if (e.tool === 'Read')
      return {
        ...read.r,
        result: {
          ...read.r.result,
          file: { ...read.r.result.file, filePath: `${ROOT}/src/parse.ts`, content: parse },
        },
      }
    const stdout = first ? PEM : next()
    first = false
    return bashOut(stdout)
  })
  const shown = await $.tool.call({ ...eventOf(recorded('Bash')), command: 'node tests/key.mjs' })
  expect(JSON.stringify(shown)).not.toContain(PEM_BODY.slice(0, 40))
  return p
}

test('after a private key is removed, a result holding only its BEGIN line is not withheld', async ($, on) => {
  await afterPemRemoved($, on, () => '-----BEGIN RSA PRIVATE KEY-----\n')
  const out = await $.tool.call({ ...eventOf(recorded('Bash')), command: 'node tests/key.mjs' })
  expect(out.deny).toBeUndefined()
  // A fresh session prints this line the same way (its `KEY-----` is taken
  // as a keyed value): only the withholding is this check's.
  expect(res(out).stdout).toContain('-----BEGIN RSA PRIVATE ')
})

// Review round 2 #6: keys of one kind share their first bytes (the ASN.1 or
// OpenSSH header). Another key of the same kind is not the removed one.
test('after a private key is removed, another key of the same kind is not withheld as reshaped', async ($, on) => {
  const shared = btoa('fake-asn1-header-shared-by-every-key-of-a-kind!!').slice(0, 64)
  const tail = (s: string) => wrap(shared + btoa(`${s} ${'tail-material-'.repeat(8)}`), 64)
  const other = `-----BEGIN RSA PRIVATE KEY-----\n${tail('second')}\n-----END RSA PRIVATE KEY-----\n`
  const first = `-----BEGIN RSA PRIVATE KEY-----\n${tail('first')}\n-----END RSA PRIVATE KEY-----\n`
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(PAY_MAP) })
  let stdout = first
  on('tool.call', () => bashOut(stdout))
  const one = await $.tool.call({ ...eventOf(bash), command: 'node tests/key.mjs' })
  expect(JSON.stringify(one)).not.toContain(shared.slice(0, 24))
  stdout = other
  const two = await $.tool.call({ ...eventOf(bash), command: 'node tests/key.mjs' })
  expect(two.deny).toBeUndefined()
  expect(JSON.stringify(two)).not.toContain(shared.slice(0, 24))
  // Its first lines alone (as `head -2` prints them), which the scanner does not take for a key.
  stdout = other.split('\n').slice(0, 2).join('\n') + '\n'
  const head = await $.tool.call({ ...eventOf(bash), command: 'node tests/key.mjs' })
  expect(head.deny).toBeUndefined()
})

// Review round 3 #2: a key body too short to skip the shared prefix is
// learned whole, never as an empty string that matches every text.
test('after a short private key is removed, its body is still removed and other text is not withheld', async ($, on) => {
  const body = btoa('short fake key, not real')
  const short = `-----BEGIN EC PRIVATE KEY-----\n${body}\n-----END EC PRIVATE KEY-----\n`
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(PAY_MAP) })
  let stdout = short
  on('tool.call', () => bashOut(stdout))
  const one = await $.tool.call({ ...eventOf(bash), command: 'node tests/key.mjs' })
  expect(JSON.stringify(one)).not.toContain(body)
  // Learned: it comes back spaced and is withheld.
  stdout = `${[...body].join(' ')}\n`
  const two = await $.tool.call({ ...eventOf(bash), command: 'node tests/key.mjs' })
  expect(two.deny).toBe(RESHAPED)
  stdout = 'all tests passed\n'
  const three = await $.tool.call({ ...eventOf(bash), command: 'node tests/key.mjs' })
  expect(res(three).stdout).toBe('all tests passed\n')
})

test('after a private key is removed, a name like parseRsaPrivateKey is saved, not quarantined', async ($, on) => {
  const parse = 'export function parseRsaPrivateKey(pem: string) {}\n'
  const p = await afterPemRemoved($, on, () => '', parse)
  const out = await $.tool.call({ ...eventOf(recorded('Read')), file_path: `${ROOT}/src/parse.ts` })
  expect(JSON.stringify(out)).not.toContain('__QUARANTINED__')
  expect(Object.values(JSON.parse(p.files[`${ROOT}/.veilio/map.json`]).map)).toContain(
    'parseRsaPrivateKey'
  )
})

test('ordinary output with 16-character git SHAs is not withheld when no SHA was removed', async ($, on) => {
  await afterKeyRead($, on, () =>
    bashOut('a1b2c3d4e5f60718 fix: totals\n0f1e2d3c4b5a6978 docs: readme\n')
  )
  const bash = recorded('Bash')
  const out = await $.tool.call({ ...eventOf(bash), command: 'git log --oneline --abbrev=16' })
  expect(out.deny).toBeUndefined()
  expect(res(out).stdout).toContain('a1b2c3d4e5f60718')
})

// COVERAGE.md, Not covered: a credential under 16 characters is matched whole only.
test('the documented limit: a removed credential under 16 characters comes back spaced', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(PAY_MAP) })
  let stdout = 'Location: https://app.example/cb?access_token=Pq7rT2wZx9Lm&state=1\n'
  on('tool.call', () => bashOut(stdout))
  const one = await $.tool.call(eventOf(bash))
  expect(JSON.stringify(one)).not.toContain('Pq7rT2wZx9Lm')
  stdout = `${[...'Pq7rT2wZx9Lm'].join(' ')}\n`
  const two = await $.tool.call(eventOf(bash))
  expect(two.deny).toBeUndefined()
  expect(res(two).stdout).toContain('P q 7 r')
})

// Spec 085 L16: an MCP result's object keys are data like its values: masked
// and scanned, with no value lost. Two keys that would mask to one text
// withhold the result rather than merge.
const GATEWAY = { __CLS__1: 'PaymentGateway' }
const mcpResult = (extra: Record<string, unknown>) => ({
  result: { content: [{ type: 'text', text: 'found' }], ...extra },
})

test('L16: a structuredContent key holding a project name is masked', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(GATEWAY) })
  on('tool.call', () => mcpResult({ structuredContent: { PaymentGateway: 'src/pay.ts' } }))
  const out = await $.tool.call({ tool: 'mcp__notes__find', q: 'x' })
  expect(JSON.stringify(out)).not.toContain('PaymentGateway')
  const sc = (outcome(out).result as Fields).structuredContent as Fields
  expect(Object.keys(sc)).toEqual(['__CLS__1'])
})

test('L16: the keys of an MCP result with no content blocks (a deep result) are masked', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(GATEWAY) })
  on('tool.call', () => ({ result: { PaymentGateway: 1 } }))
  const out = await $.tool.call({ tool: 'mcp__notes__find', q: 'x' })
  expect(outcome(out).deny).toBeUndefined()
  expect(JSON.stringify(out)).not.toContain('PaymentGateway')
})

test('L16: a key that is a provider-shaped credential never reaches the model', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(GATEWAY) })
  on('tool.call', () => mcpResult({ structuredContent: { [STRIPE]: 'src/pay.ts' } }))
  const out = await $.tool.call({ tool: 'mcp__notes__find', q: 'x' })
  expect(outcome(out).deny).toBeUndefined()
  expect(JSON.stringify(out)).not.toContain(STRIPE.slice(8))
})

// Review round 2 #3: a key the map does not have yet is masked as a value
// is, minted and saved, so a new project identifier used as a key never
// reaches the model as written.
test('L16: a never-seen identifier-shaped key is masked and saved', async ($, on) => {
  const p = project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(GATEWAY) })
  on('tool.call', () => mcpResult({ structuredContent: { [CANARY]: 1 } }))
  const out = await $.tool.call({ tool: 'mcp__notes__find', q: 'x' })
  expect(outcome(out).deny).toBeUndefined()
  expect(JSON.stringify(out)).not.toContain(CANARY)
  expect(p.files[`${ROOT}/.veilio/map.json`]).toContain(CANARY)
})

test('L16: two keys that would mask to the same text withhold the result', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(GATEWAY) })
  on('tool.call', () => mcpResult({ structuredContent: { PaymentGateway: 1, __CLS__1: 2 } }))
  const out = await $.tool.call({ tool: 'mcp__notes__find', q: 'x' })
  expect(outcome(out).deny).toBe(
    'Veilio withheld this result: two keys of its result would read the same once masked, so they could not both be sent. Nothing from it was sent.'
  )
  expect(JSON.stringify(out)).not.toContain('PaymentGateway')
})

// The guard keeps a `__proto__` key as an own property (tests/guard/fields.test.ts
// pins that); whether it survives the trip back to Claude Code depends on the
// runtime (2.1.288 drops it, 2.1.319 keeps it). Either way no raw name gets through.
test('L16: a __proto__ key never carries a raw name: its subtree is kept masked or dropped', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(GATEWAY) })
  on('tool.call', () =>
    mcpResult({ structuredContent: JSON.parse('{"__proto__": {"owner": "PaymentGateway"}}') })
  )
  const out = await $.tool.call({ tool: 'mcp__notes__find', q: 'x' })
  const text = JSON.stringify(out)
  expect(text).not.toContain('PaymentGateway')
  const sc = JSON.stringify((outcome(out).result as Fields).structuredContent)
  const kept = sc === '{"__proto__":{"owner":"__CLS__1"}}'
  console.warn(`__proto__ key ${kept ? 'kept, masked' : 'dropped'} by this runtime`)
  expect(kept || sc === '{}').toBe(true)
})

test("L16: a built-in tool's record keeps its own keys", async ($, on) => {
  const read = recorded('Read')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __VAR__4: 'file', __VAR__5: 'content' }) })
  on('tool.call', () => read.r)
  const out = await $.tool.call(eventOf(read))
  expect(Object.keys(res(out))).toEqual(Object.keys(read.r.result))
  expect(Object.keys(res(out).file)).toEqual(Object.keys(read.r.result.file as Fields))
})

// Review round 1 (security) #3: any tool named mcp__… is an MCP tool, a name
// that is underscores after the server included.
test('R1#3: an MCP tool whose name ends in underscores still has its keys masked', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(GATEWAY) })
  on('tool.call', () => mcpResult({ structuredContent: { PaymentGateway: 1 } }))
  const out = await $.tool.call({ tool: 'mcp__notes___', q: 'x' })
  expect(JSON.stringify(out)).not.toContain('PaymentGateway')
})

test('R1#3: an MCP tool whose name ends in underscores still has an image result withheld', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(GATEWAY) })
  on('tool.call', () => ({
    result: { content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] },
  }))
  const out = await $.tool.call({ tool: 'mcp__notes___', q: 'x' })
  expect(outcome(out).deny).toMatch(/^Veilio withheld this result: MCP results other than text/)
})

// Review round 1 (security) #4: in an MCP result only a content block's
// `type` is an enum; a `status` or `mode` at its root is the server's data.
test('R1#4: an MCP result root status or mode holding a name is masked and saved', async ($, on) => {
  const p = project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(GATEWAY) })
  on('tool.call', () => ({ result: { status: CANARY, mode: 'InvoiceBuilderService' } }))
  const out = await $.tool.call({ tool: 'mcp__notes__find', q: 'x' })
  const text = JSON.stringify(out)
  expect(text).not.toContain(CANARY)
  expect(text).not.toContain('InvoiceBuilderService')
  expect(p.files[`${ROOT}/.veilio/map.json`]).toContain(CANARY)
})

// Review round 2 #3: keys follow the engine's own rule for values: a plain
// word stays, a compound identifier (`totalCount`, `html_url`) is masked. A
// tool with a strict output schema may then fail - an error, not a leak.
test('L16: plain-word keys stay readable, and compound identifier keys are masked like values', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(GATEWAY) })
  on('tool.call', () =>
    mcpResult({
      structuredContent: {
        name: 'z',
        id: 1,
        status: 'open',
        items: [],
        totalCount: 3,
        html_url: 'y',
      },
    })
  )
  const out = await $.tool.call({ tool: 'mcp__notes__find', q: 'x' })
  expect(outcome(out).deny).toBeUndefined()
  const keys = Object.keys((outcome(out).result as Fields).structuredContent as Fields)
  expect(keys.slice(0, 4)).toEqual(['name', 'id', 'status', 'items'])
  expect(keys.join()).not.toMatch(/totalCount|html_url/)
})

// Review round 3 #8 (checked, not reproduced): a placeholder this session
// showed but never saved is a quarantined name's, held with the removed
// credential, so a planted entry under it is refused as one; a planted map
// entry under it makes the guard fail closed (a quarantined placeholder is
// also a saved one).
test('R3#8: a planted aliases entry under a shown quarantine placeholder is refused', async ($, on) => {
  const slice = KEY_TAIL.slice(2, 15)
  const other = `export function build${slice}Total() {}\n`
  const read = recorded('Read')
  const p = project(
    on,
    {
      [`${ROOT}/.veilio/map.json`]: mapFile({}),
      [`${ROOT}/src/config.ts`]: CONFIG,
      [`${ROOT}/src/other.ts`]: other,
    },
    { noGit: true }
  )
  const seen: Fields[] = []
  on('tool.call', (_, e) => {
    seen.push(e)
    const path = String(e.file_path ?? '')
    if (e.tool === 'Read')
      return {
        ...read.r,
        result: {
          ...read.r.result,
          file: { ...read.r.result.file, filePath: path, content: p.files[path] ?? '' },
        },
      }
    return { result: { type: 'create', filePath: path } }
  })
  await $.tool.call({ ...eventOf(read), file_path: `${ROOT}/src/config.ts` })
  const out = await $.tool.call({ ...eventOf(read), file_path: `${ROOT}/src/other.ts` })
  const q = /__QUARANTINED__\d+/.exec(JSON.stringify(out))?.[0]
  expect(q).toBeDefined()
  p.files[`${ROOT}/.veilio/aliases.json`] = JSON.stringify({
    aliases: { [q!]: 'fakePlantedValue()' },
  })
  p.files[`${ROOT}/src/pay.ts`] = 'export class PaymentGatewayFake {}\n'
  await $.tool.call({ ...eventOf(read), file_path: `${ROOT}/src/pay.ts` })
  const writes = seen.length
  const w = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/a.ts`, content: `${q}()` })
  expect(w.deny).toBeDefined()
  expect(seen).toHaveLength(writes)
})
