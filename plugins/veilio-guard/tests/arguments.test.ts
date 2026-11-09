// Spec 033 US1 and FR-005: the model writes placeholders; the tool runs on the
// real names. An edit with a placeholder the map cannot resolve is refused, and
// the tool never runs.
import { expect, test } from 'claude-code/testing'
import { CANARY, eventOf, mapFile, project, recorded, ROOT } from './helpers.ts'
import type { Fields } from './fixtures/recorded.ts'
import type { TestHost, TestOn } from './kit.ts'

const MAP = { __CLS__1: CANARY, __VAR__1: 'settledTotal', __VAR__3: 'closedTotal' }

test('a shell command runs with the real names', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  const seen: Fields[] = []
  on('tool.call', (_, e) => {
    seen.push(e)
    return {
      result: {
        stdout: '',
        stderr: '',
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
      },
    }
  })
  await $.tool.call({ tool: 'Bash', command: 'grep -rn __CLS__1 src', description: 'search' })
  expect(seen[0].command).toBe(`grep -rn ${CANARY} src`)
})

test('an edit with known placeholders lands with the real names', async ($, on) => {
  const edit = recorded('Edit')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  const seen: Fields[] = []
  on('tool.call', (_, e) => {
    seen.push(e)
    return edit.r
  })
  await $.tool.call({
    ...eventOf(edit),
    old_string: 'const __VAR__1 =',
    new_string: 'const __VAR__3 =',
  })
  expect(seen[0].old_string).toBe('const settledTotal =')
  expect(seen[0].new_string).toBe('const closedTotal =')
})

test('an edit naming a placeholder the map does not have is refused, and the file is untouched', async ($, on) => {
  const edit = recorded('Edit')
  const p = project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  let ran = false
  on('tool.call', () => {
    ran = true
    return edit.r
  })
  const out = await $.tool.call({
    ...eventOf(edit),
    old_string: '__VAR__1',
    new_string: '__VAR__9',
  })
  expect(ran).toBe(false)
  expect(out.deny).toContain('Veilio refused this call')
  expect(out.deny).toContain('__VAR__9')
  expect(p.logs.join('\n')).toContain('__VAR__9')
})

test('an edit with a re-cased placeholder is refused too', async ($, on) => {
  const write = recorded('Write')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  let ran = false
  on('tool.call', () => {
    ran = true
    return write.r
  })
  const out = await $.tool.call({ ...eventOf(write), content: 'export const x = __var__1' })
  expect(ran).toBe(false)
  expect(out.deny).toContain('__var__1')
  expect(out.deny).toContain('exact spelling')
})

test('a search for a literal placeholder still runs: searches are lenient', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  const seen: Fields[] = []
  on('tool.call', (_, e) => {
    seen.push(e)
    return { result: { mode: 'content', numFiles: 0, filenames: [], content: '', numLines: 0 } }
  })
  await $.tool.call({ tool: 'Grep', pattern: '__TODO__7', output_mode: 'content' })
  expect(seen[0].pattern).toBe('__TODO__7')
})

test('a web request never gets the real names', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  const seen: Fields[] = []
  on('tool.call', (_, e) => {
    seen.push(e)
    return { result: 'ok' }
  })
  await $.tool.call({
    tool: 'WebFetch',
    url: 'https://example.com/?q=__CLS__1',
    prompt: 'about __CLS__1',
  })
  await $.tool.call({ tool: 'WebSearch', query: '__CLS__1 error' })
  expect(JSON.stringify(seen)).not.toContain(CANARY)
})

// Spec 078 FR-009: the servers are named in the plugin's settings only.
test(
  "an MCP tool gets the real names only for a server the plugin's settings name",
  { options: { mcpRestore: ['local_db'] } },
  async ($, on) => {
    project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
    const seen: Fields[] = []
    on('tool.call', (_, e) => {
      seen.push(e)
      return { result: [{ type: 'text', text: 'ok' }] }
    })
    await $.tool.call({ tool: 'mcp__local_db__query', sql: 'select * from __CLS__1' })
    await $.tool.call({ tool: 'mcp__github__create_issue', title: 'bug in __CLS__1' })
    expect(seen[0].sql).toBe(`select * from ${CANARY}`)
    expect(seen[0].tool).toBe('mcp__local_db__query')
    expect(seen[1].title).toBe('bug in __CLS__1')
  }
)

// Spec 085 L18 (Q1 = A, strings.md #10): a real name goes into an MCP tool's
// arguments only when it is shaped like a name or a path; Edit and Write
// content keeps a teammate's value as written (strings.md #15).
const UNSHAPED = (p: string) =>
  `Veilio refused this call: the real name for ${p} is not shaped like a name or a path, so it is not put into an MCP tool's arguments. Ask the user to run this call.`

function unshapedRefused(value: string) {
  return async ($: TestHost, on: TestOn) => {
    project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: value }) })
    const seen: Fields[] = []
    on('tool.call', (_, e) => (seen.push(e), { result: [{ type: 'text', text: 'ok' }] }))
    const out = await $.tool.call({ tool: 'mcp__local_db__query', sql: 'select * from __CLS__1' })
    expect(out.deny).toBe(UNSHAPED('__CLS__1'))
    expect(seen).toHaveLength(0)
  }
}
const LOCAL_DB = { options: { mcpRestore: ['local_db'] } }

test(
  'L18: a map value holding SQL is not restored into an MCP tool',
  LOCAL_DB,
  unshapedRefused('users; DELETE FROM accounts')
)
// Spec 085 R2-18: a map value with a line break is not a name, so the map is
// refused whole (the guard stops), as the CLI refuses it; nothing is restored.
test(
  'L18: a map value holding a line break is not restored into an MCP tool',
  LOCAL_DB,
  async ($, on) => {
    project(on, {
      [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: 'users\nDROP TABLE accounts' }),
    })
    const seen: Fields[] = []
    on('tool.call', (_, e) => (seen.push(e), { result: [{ type: 'text', text: 'ok' }] }))
    const out = await $.tool.call({ tool: 'mcp__local_db__query', sql: 'select * from __CLS__1' })
    expect(out.deny).toMatch(/a map entry is not a name/)
    expect(seen).toHaveLength(0)
  }
)
test(
  'L18: a map value holding a space is not restored into an MCP tool',
  LOCAL_DB,
  unshapedRefused('Payment Gateway')
)
test(
  'L18: a map value holding an option is not restored into an MCP tool',
  LOCAL_DB,
  unshapedRefused('--all')
)

// Review round 1 #7: a URL or a path that climbs out is not a name either.
test(
  'R1#7: a map value that is a URL is not restored into an MCP tool',
  LOCAL_DB,
  unshapedRefused('https://evil.example/x')
)
test(
  'R1#7: a map value with a .. segment is not restored into an MCP tool',
  LOCAL_DB,
  unshapedRefused('src/../../etc/passwd')
)

test(
  'R1#7: a decomposed non-ASCII name and a name with $ restore into an MCP tool',
  LOCAL_DB,
  async ($, on) => {
    const nfd = 'Zahlungstu\u0308r'
    project(on, {
      [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: nfd, __VAR__2: 'ledger$entry' }),
    })
    const seen: Fields[] = []
    on('tool.call', (_, e) => (seen.push(e), { result: [{ type: 'text', text: 'ok' }] }))
    await $.tool.call({ tool: 'mcp__local_db__query', sql: 'select __CLS__1, __VAR__2' })
    expect(seen[0]?.sql).toBe(`select ${nfd}, ledger$entry`)
  }
)

// Review round 3 #7: a leading scheme is a URL however few slashes follow.
test(
  'R3#7: a map value with a file: scheme is not restored into an MCP tool',
  LOCAL_DB,
  unshapedRefused('file:/etc/passwd')
)
test(
  'R7: a protocol-relative URL map value is not restored into an MCP tool',
  LOCAL_DB,
  unshapedRefused('//evil.example/x')
)
test(
  'R3#7: a map value with a javascript: scheme is not restored into an MCP tool',
  LOCAL_DB,
  unshapedRefused('javascript:alert')
)
test(
  'R3#7: a Windows drive path and a Ledger::Entry name restore into an MCP tool',
  LOCAL_DB,
  async ($, on) => {
    project(on, {
      [`${ROOT}/.veilio/map.json`]: mapFile({
        __VAR__1: 'C:/repo/src/pay.ts',
        __CLS__2: 'Ledger::Entry',
      }),
    })
    const seen: Fields[] = []
    on('tool.call', (_, e) => (seen.push(e), { result: [{ type: 'text', text: 'ok' }] }))
    await $.tool.call({ tool: 'mcp__local_db__query', sql: 'select __VAR__1, __CLS__2' })
    expect(seen[0]?.sql).toBe('select C:/repo/src/pay.ts, Ledger::Entry')
  }
)

test(
  'L18: names and paths, a non-ASCII name too, restore into an MCP tool',
  { options: { mcpRestore: ['local_db'] } },
  async ($, on) => {
    project(on, {
      [`${ROOT}/.veilio/map.json`]: mapFile({
        __CLS__1: 'PaymentGateway',
        __VAR__2: 'src/pay.ts',
        __CLS__3: 'ZahlungsTür',
      }),
    })
    const seen: Fields[] = []
    on('tool.call', (_, e) => (seen.push(e), { result: [{ type: 'text', text: 'ok' }] }))
    await $.tool.call({ tool: 'mcp__local_db__query', sql: 'select __CLS__1, __VAR__2, __CLS__3' })
    expect(seen[0]?.sql).toBe('select PaymentGateway, src/pay.ts, ZahlungsTür')
  }
)

test('L18, R2-18: a map value with a line break stops the guard, so no Edit gets it', async ($, on) => {
  const edit = recorded('Edit')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __VAR__1: 'first\nsecond' }) })
  const seen: Fields[] = []
  on('tool.call', (_, e) => (seen.push(e), edit.r))
  const out = await $.tool.call({
    ...eventOf(edit),
    old_string: 'x',
    new_string: 'const a = __VAR__1',
  })
  expect(out.deny).toMatch(/a map entry is not a name/)
  expect(seen).toHaveLength(0)
})

// Spec 085 L20 (strings.md #11): the server is the tool name's exact prefix,
// and a tool name that splits into a server and a tool in more than one way
// gets no real names, whichever of its servers the settings list.
const AMBIGUOUS =
  'Veilio: mcp__jira__helper__search could belong to more than one MCP server, so it gets placeholders, not real names.'
const PAYMENT = { __CLS__1: 'PaymentGateway' }
const MCP_OK = { result: [{ type: 'text', text: 'ok' }] }

test(
  'L20: mcpRestore jira restores into mcp__jira__search, not into mcp__jira__helper__search',
  { options: { mcpRestore: ['jira'] } },
  async ($, on) => {
    const p = project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(PAYMENT) })
    const seen: Fields[] = []
    on('tool.call', (_, e) => (seen.push(e), MCP_OK))
    await $.tool.call({ tool: 'mcp__jira__helper__search', q: 'find __CLS__1' })
    await $.tool.call({ tool: 'mcp__jira__helper__search', q: 'again __CLS__1' })
    await $.tool.call({ tool: 'mcp__jira__search', q: 'find __CLS__1' })
    expect(seen.map((e) => e.q)).toEqual(['find __CLS__1', 'again __CLS__1', 'find PaymentGateway'])
    expect(p.logs.filter((l) => l === AMBIGUOUS)).toHaveLength(1)
  }
)

test(
  'L20: with jira and jira__helper both listed, mcp__jira__helper__search still gets placeholders',
  { options: { mcpRestore: ['jira', 'jira__helper'] } },
  async ($, on) => {
    const p = project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(PAYMENT) })
    const seen: Fields[] = []
    on('tool.call', (_, e) => (seen.push(e), MCP_OK))
    await $.tool.call({ tool: 'mcp__jira__helper__search', q: 'find __CLS__1' })
    expect(seen[0]?.q).toBe('find __CLS__1')
    expect(p.logs).toContain(AMBIGUOUS)
  }
)

test("Claude Code's own refusal, which quotes the restored command, reaches the model masked", async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  // The permission check refuses the call it was given - the restored one.
  on('tool.call', (_, e) => ({
    deny: `Permission to use Bash with command ${e.command} was denied.`,
  }))
  // A read (spec 078 R1: only reads and tests get real names back).
  const out = await $.tool.call({ tool: 'Bash', command: 'cat __CLS__1', description: 'x' })
  expect(out.deny).toContain('cat __CLS__1')
  expect(out.deny).not.toContain(CANARY)
})

test('a write that would put a redaction token on disk is refused: the real key would be lost', async ($, on) => {
  const write = recorded('Write')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  let ran = false
  on('tool.call', () => {
    ran = true
    return write.r
  })
  const out = await $.tool.call({
    ...eventOf(write),
    content: 'const key = "__REDACTED_STRIPE_KEY_1__"\n',
  })
  expect(ran).toBe(false)
  expect(out.deny).toContain('__REDACTED_STRIPE_KEY_1__')
})

test('tokens a language owns, such as the DEV and FILE globals, are not placeholders: the edit runs', async ($, on) => {
  const edit = recorded('Edit')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  const seen: Fields[] = []
  on('tool.call', (_, e) => {
    seen.push(e)
    return edit.r
  })
  const out = await $.tool.call({
    ...eventOf(edit),
    old_string: 'if (__DEV__) log(__FILE__, __dirname)',
    new_string: 'if (__DEV__) __CLS__1.log(__FILE__, __dirname)',
  })
  expect(out.deny).toBeUndefined()
  expect(seen[0].new_string).toBe(`if (__DEV__) ${CANARY}.log(__FILE__, __dirname)`)
})

// A shell command can write a file (sed -i, echo >), so the checks an edit gets
// hold for it too. A placeholder the map does not have means nothing in the
// real project, so refusing it refuses nothing Claude could use.
function shell(on: TestOn) {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  const seen: Fields[] = []
  on('tool.call', (_, e) => {
    seen.push(e)
    return {
      result: {
        stdout: '',
        stderr: '',
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
      },
    }
  })
  return seen
}

test('a shell command naming a placeholder the map does not have is refused before it runs', async ($, on) => {
  const seen = shell(on)
  const out = await $.tool.call({
    tool: 'Bash',
    command: "sed -i '' 's/__VAR__1/__FN__9/' src/ledger.ts",
    description: 'rename',
  })
  expect(seen.length).toBe(0)
  expect(out.deny).toContain('__FN__9')
  expect(out.deny).toContain('Edit')
})

test('a shell command with a re-cased placeholder is refused too', async ($, on) => {
  const seen = shell(on)
  const out = await $.tool.call({
    tool: 'Bash',
    command: "sed -i '' 's/x/__var__1/' src/ledger.ts",
    description: 'rename',
  })
  expect(seen.length).toBe(0)
  expect(out.deny).toContain('exact spelling')
})

test('a shell command that would write a redaction token is refused: the real key would be lost', async ($, on) => {
  const seen = shell(on)
  const out = await $.tool.call({
    tool: 'Bash',
    command: `echo 'const key = "__REDACTED_STRIPE_KEY_1__"' > src/config.ts`,
    description: 'write config',
  })
  expect(seen.length).toBe(0)
  expect(out.deny).toContain('__REDACTED_STRIPE_KEY_1__')
})

test('a shell command with known placeholders and language tokens runs', async ($, on) => {
  const seen = shell(on)
  const out = await $.tool.call({
    tool: 'Bash',
    // A read and a search (spec 078 R1: only reads and tests get real names back).
    command: 'grep -rn __VAR__1 src/ledger.ts && grep -rn __DEV__ src',
    description: 'search',
  })
  expect(out.deny).toBeUndefined()
  expect(seen[0].command).toBe('grep -rn settledTotal src/ledger.ts && grep -rn __DEV__ src')
})

// Security review of 2af9fca: a placeholder for a provider-format key is
// never restored, even in a fresh session that learned nothing yet.
test('a map entry holding a provider-format key is never restored, in a fresh session', async ($, on) => {
  const edit = recorded('Edit')
  const key = 'AKIA' + 'Q7RZ2XKM4PLB8WNE'
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...MAP, __STR__7: key }) })
  let ran = false
  on('tool.call', () => {
    ran = true
    return edit.r
  })
  const out = await $.tool.call({
    ...eventOf(edit),
    old_string: 'x',
    new_string: 'id = "__STR__7"',
  })
  expect(ran).toBe(false)
  expect(out.deny).toContain('Veilio refused this call')
})

test('an ordinary project name restores fine beside that check', async ($, on) => {
  const edit = recorded('Edit')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  const seen: Fields[] = []
  on('tool.call', (_, e) => {
    seen.push(e)
    return edit.r
  })
  const out = await $.tool.call({
    ...eventOf(edit),
    old_string: 'const __VAR__1 =',
    new_string: 'const __VAR__1 =',
  })
  expect(out.deny).toBeUndefined()
  expect(seen[0].new_string).toBe('const settledTotal =')
})

test('a restore that puts back a second provider key beside one already written is refused', async ($, on) => {
  const edit = recorded('Edit')
  const written = 'AKIA' + 'ZZ7RZ2XKM4PLB8WN'
  // The map holds the key's tail, not a key by itself: only the restored
  // text holds the second key.
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...MAP, __STR__7: 'Q7RZ2XKM4PLB8WNE' }) })
  let ran = false
  on('tool.call', () => {
    ran = true
    return edit.r
  })
  const out = await $.tool.call({
    ...eventOf(edit),
    old_string: 'x',
    new_string: `a = "${written}"\nb = "AKIA__STR__7"`,
  })
  expect(ran).toBe(false)
  expect(out.deny).toContain('Veilio refused this call')
})

test('an edit beside a regulated number the map holds runs, and one that writes it back is refused', async ($, on) => {
  const edit = recorded('Edit')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({ ...MAP, __IBAN__1: 'GB29NWBK60161331926819' }),
  })
  let ran = 0
  on('tool.call', () => (ran++, edit.r))
  const beside = await $.tool.call({
    ...eventOf(edit),
    old_string: 'const __VAR__1 =',
    new_string: 'const __VAR__1 = 2',
  })
  expect(beside.deny).toBeUndefined()
  const back = await $.tool.call({
    ...eventOf(edit),
    old_string: 'x',
    new_string: 'iban = "__IBAN__1"',
  })
  expect(back.deny).toContain('Veilio refused this call')
  expect(ran).toBe(1)
})

// Commit security review of f4e81cb: decided by the placeholder, not by
// detecting the number again, so no spelling of it slips through.
function writesBack(value: string) {
  return async ($: TestHost, on: TestOn) => {
    const edit = recorded('Edit')
    project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...MAP, __IBAN__1: value }) })
    let ran = false
    on('tool.call', () => ((ran = true), edit.r))
    const out = await $.tool.call({
      ...eventOf(edit),
      old_string: 'x',
      new_string: 'v = "__IBAN__1"',
    })
    expect(ran).toBe(false)
    expect(out.deny).toContain('Veilio refused this call')
  }
}

test(
  'a restoration that writes back a spaced IBAN is refused',
  writesBack('GB29 NWBK 6016 1331 9268 19')
)
test(
  'a restoration that writes back a dashed card number is refused',
  writesBack('4539-1488-0343-6467')
)
test(
  'a restoration that writes back an IBAN glued to letters is refused',
  writesBack('refGB29NWBK60161331926819x')
)

// Review of 55ae576: judged by the keys restore() itself resolved.
function refusedRestore(map: Record<string, string>, newString: string) {
  return async ($: TestHost, on: TestOn) => {
    const edit = recorded('Edit')
    project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...MAP, ...map }) })
    let ran = false
    on('tool.call', () => ((ran = true), edit.r))
    const out = await $.tool.call({ ...eventOf(edit), old_string: 'x', new_string: newString })
    expect(ran).toBe(false)
    expect(out.deny).toContain('Veilio refused this call')
  }
}

test(
  'a regulated placeholder glued to letters is refused on restore',
  refusedRestore({ __IBAN__1: 'GB29NWBK60161331926819' }, 'v = "ref__IBAN__1x"')
)
test(
  'a value marked by hand is refused on restore',
  refusedRestore({ __MANUAL__1: 'Contoso Harbour Bank' }, 'bank = "__MANUAL__1"')
)
test(
  'a quarantined placeholder is refused on restore',
  refusedRestore({ __QUARANTINED__1: 'connectXk9mQ2vL7QPool' }, '__QUARANTINED__1()')
)

// Review of 5347c7c: judged by what restore() resolved, worded by kind.
test('a name that merely contains a hand-marked value restores fine', async ($, on) => {
  const edit = recorded('Edit')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({ ...MAP, __VAR__9: 'AcmeLedger', __MANUAL__1: 'Acme' }),
  })
  on('tool.call', () => edit.r)
  const out = await $.tool.call({
    ...eventOf(edit),
    old_string: 'x',
    new_string: 'new __VAR__9()',
  })
  expect(out.deny).toBeUndefined()
})

test('each refusal names what it would have written back', async ($, on) => {
  const edit = recorded('Edit')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({
      ...MAP,
      __MANUAL__1: 'Contoso Harbour Bank',
      __IBAN__1: 'GB29NWBK60161331926819',
    }),
  })
  on('tool.call', () => edit.r)
  const manual = await $.tool.call({
    ...eventOf(edit),
    old_string: 'x',
    new_string: '__MANUAL__1',
  })
  expect(manual.deny).toContain('marked by hand')
  const iban = await $.tool.call({
    ...eventOf(edit),
    old_string: 'x',
    new_string: '__IBAN__1',
  })
  expect(iban.deny).toContain('regulated number')
})

test('a hand-marked value only inside another word of the text is still refused on restore', async ($, on) => {
  const edit = recorded('Edit')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({ ...MAP, __VAR__9: 'AcmeLedger', __MANUAL__1: 'Jan' }),
  })
  let ran = 0
  on('tool.call', () => (ran++, edit.r))
  // The name holding the mark restores; the mark itself, where the text
  // holds it only inside 'January', does not.
  const ok = await $.tool.call({
    ...eventOf(edit),
    old_string: 'x',
    new_string: 'new __VAR__9()',
  })
  expect(ok.deny).toBeUndefined()
  const no = await $.tool.call({
    ...eventOf(edit),
    old_string: 'x',
    new_string: 'January __MANUAL__1',
  })
  expect(no.deny).toContain('marked by hand')
  expect(ran).toBe(1)
})

test('a hand-marked value inside a word with a letter outside ASCII is still refused on restore', async ($, on) => {
  const edit = recorded('Edit')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...MAP, __MANUAL__1: 'Jan' }) })
  let ran = 0
  on('tool.call', () => (ran++, edit.r))
  const no = await $.tool.call({
    ...eventOf(edit),
    old_string: 'x',
    new_string: 'Janów __MANUAL__1',
  })
  expect(no.deny).toContain('marked by hand')
  expect(ran).toBe(0)
})

// Round 5 additions #6: a placeholder that is never written back says so,
// shown or not.
test('R5b#6: outside git, an unshown hand-marked placeholder is refused as never written back', async ($, on) => {
  project(
    on,
    { [`${ROOT}/.veilio/map.json`]: mapFile({ __MANUAL__1: 'Contoso Harbour Bank' }) },
    { noGit: true }
  )
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { type: 'create', filePath: `${ROOT}/a.js` } })
  )
  const out = await $.tool.call({
    tool: 'Write',
    file_path: `${ROOT}/a.js`,
    content: 'bank = "__MANUAL__1"',
  })
  expect(out.deny).toContain('which is never written back')
  expect(seen).toHaveLength(0)
})

// Spec 085 part 3, R2-9 (security audit run-2): a server named in mcpRestore
// was trusted by name, so a repository's .mcp.json declaring a server of that
// name, pointing elsewhere, received real names; and the agent could edit
// .mcp.json. Now a listed server the project redeclares gets placeholders
// (#57, once), and .mcp.json is write-protected (#59).
const REDECLARED =
  "Veilio: `jira` is also declared in this project's .mcp.json, so its tools get placeholders, not real names."
const MCP_CONFIG_PROTECTED =
  'Veilio refused this change: .mcp.json decides which MCP servers receive your real names, so the agent may not change it. Ask the user to make this change.'

test(
  'R2-9: a listed server the project .mcp.json redeclares gets placeholders',
  { options: { mcpRestore: ['jira'] } },
  async ($, on) => {
    const p = project(on, {
      [`${ROOT}/.veilio/map.json`]: mapFile(PAYMENT),
      [`${ROOT}/.mcp.json`]: JSON.stringify({
        mcpServers: { jira: { type: 'http', url: 'http://127.0.0.1:9/' } },
      }),
    })
    const seen: Fields[] = []
    on('tool.call', (_, e) => (seen.push(e), MCP_OK))
    await $.tool.call({ tool: 'mcp__jira__search', query: '__CLS__1' })
    await $.tool.call({ tool: 'mcp__jira__search', query: 'again __CLS__1' })
    expect(seen.map((e) => e.query)).toEqual(['__CLS__1', 'again __CLS__1'])
    expect(p.logs.filter((l) => l === REDECLARED)).toHaveLength(1)
  }
)

test(
  'R2-9: an .mcp.json that cannot be read gives placeholders too',
  { options: { mcpRestore: ['jira'] } },
  async ($, on) => {
    project(on, {
      [`${ROOT}/.veilio/map.json`]: mapFile(PAYMENT),
      [`${ROOT}/.mcp.json`]: '{ not json',
    })
    const seen: Fields[] = []
    on('tool.call', (_, e) => (seen.push(e), MCP_OK))
    await $.tool.call({ tool: 'mcp__jira__search', query: '__CLS__1' })
    expect(seen[0]?.query).toBe('__CLS__1')
  }
)

test(
  'R2-9: with no .mcp.json, or one that does not name it, the listed server gets real names',
  { options: { mcpRestore: ['jira'] } },
  async ($, on) => {
    project(on, {
      [`${ROOT}/.veilio/map.json`]: mapFile(PAYMENT),
      [`${ROOT}/.mcp.json`]: JSON.stringify({ mcpServers: { github: { command: 'gh' } } }),
    })
    const seen: Fields[] = []
    on('tool.call', (_, e) => (seen.push(e), MCP_OK))
    await $.tool.call({ tool: 'mcp__jira__search', query: '__CLS__1' })
    expect(seen[0]?.query).toBe('PaymentGateway')
  }
)

test('R2-9: Write and Edit of .mcp.json are refused', async ($, on) => {
  project(on, { [`${ROOT}/.mcp.json`]: '{}' })
  on('tool.call', () => ({ result: { type: 'update', filePath: `${ROOT}/.mcp.json` } }))
  const w = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/.mcp.json`, content: '{}' })
  expect(w.deny).toBe(MCP_CONFIG_PROTECTED)
  const e = await $.tool.call({
    tool: 'Edit',
    file_path: `${ROOT}/.mcp.json`,
    old_string: '{}',
    new_string: '{ "mcpServers": {} }',
  })
  expect(e.deny).toBe(MCP_CONFIG_PROTECTED)
})

// Review of the run-2 guard branch: Claude Code also defines MCP servers in
// ~/.claude.json (user scope, and local scope per project) and in a managed
// managed-mcp.json, and reads .mcp.json from where the session started. A
// listed server declared by the project, or in more than one scope, gets
// placeholders; the agent may change none of these files.
const USER_HOME = '/home/test'
const CLAUDE_JSON = `${USER_HOME}/.claude.json`
const SUB = `${ROOT}/packages/app`
const TWICE =
  'Veilio: `jira` is declared more than once in ~/.claude.json (for you and for this project), so its tools get placeholders, not real names.'
const protectedFile = (file: string) =>
  `Veilio refused this change: ${file} decides which MCP servers receive your real names, so the agent may not change it. Ask the user to make this change.`
const jiraAt = { jira: { type: 'http', url: 'https://jira.example.com/mcp' } }

test(
  'review: a server declared once, in the user scope of ~/.claude.json, gets real names',
  { options: { mcpRestore: ['jira'] } },
  async ($, on) => {
    project(on, {
      [`${ROOT}/.veilio/map.json`]: mapFile(PAYMENT),
      [CLAUDE_JSON]: JSON.stringify({ mcpServers: jiraAt, projects: { [ROOT]: {} } }),
    })
    const seen: Fields[] = []
    on('tool.call', (_, e) => (seen.push(e), MCP_OK))
    await $.tool.call({ tool: 'mcp__jira__search', query: '__CLS__1' })
    expect(seen[0]?.query).toBe('PaymentGateway')
  }
)

test(
  'review: a server declared for you and for this project in ~/.claude.json gets placeholders',
  { options: { mcpRestore: ['jira'] } },
  async ($, on) => {
    const p = project(on, {
      [`${ROOT}/.veilio/map.json`]: mapFile(PAYMENT),
      [CLAUDE_JSON]: JSON.stringify({
        mcpServers: jiraAt,
        projects: { [ROOT]: { mcpServers: { jira: { command: 'node', args: ['x.js'] } } } },
      }),
    })
    const seen: Fields[] = []
    on('tool.call', (_, e) => (seen.push(e), MCP_OK))
    await $.tool.call({ tool: 'mcp__jira__search', query: '__CLS__1' })
    await $.tool.call({ tool: 'mcp__jira__search', query: '__CLS__1' })
    expect(seen.map((e) => e.query)).toEqual(['__CLS__1', '__CLS__1'])
    expect(p.logs.filter((l) => l === TWICE)).toHaveLength(1)
  }
)

test(
  'review: a ~/.claude.json that cannot be read gives placeholders',
  { options: { mcpRestore: ['jira'] } },
  async ($, on) => {
    const p = project(on, {
      [`${ROOT}/.veilio/map.json`]: mapFile(PAYMENT),
      [CLAUDE_JSON]: '{ not json',
    })
    const seen: Fields[] = []
    on('tool.call', (_, e) => (seen.push(e), MCP_OK))
    await $.tool.call({ tool: 'mcp__jira__search', query: '__CLS__1' })
    expect(seen[0]?.query).toBe('__CLS__1')
    expect(p.logs).toContain(
      'Veilio: ~/.claude.json could not be read, so `jira` gets placeholders, not real names.'
    )
  }
)

test(
  'review: an .mcp.json where the session started, below the root, redeclares too',
  { options: { mcpRestore: ['jira'] } },
  async ($, on) => {
    const p = project(
      on,
      {
        [`${ROOT}/.veilio/map.json`]: mapFile(PAYMENT),
        [`${SUB}/.mcp.json`]: JSON.stringify({ mcpServers: jiraAt }),
        [`${SUB}/index.ts`]: 'export {}\n',
      },
      { cwd: SUB }
    )
    const seen: Fields[] = []
    on('tool.call', (_, e) => (seen.push(e), MCP_OK))
    await $.tool.call({ tool: 'mcp__jira__search', query: '__CLS__1' })
    expect(seen[0]?.query).toBe('__CLS__1')
    expect(p.logs).toContain(REDECLARED)
  }
)

test('review: Write of ~/.claude.json, managed-mcp.json or .mcp.json. is refused', async ($, on) => {
  project(on, {})
  on('tool.call', () => ({ result: { type: 'create', filePath: CLAUDE_JSON } }))
  const cases: [string, string][] = [
    [CLAUDE_JSON, '~/.claude.json'],
    ['/etc/claude-code/managed-mcp.json', 'managed-mcp.json'],
    [`${ROOT}/.mcp.json.`, '.mcp.json'],
    [`${ROOT}/.MCP.JSON `, '.mcp.json'],
  ]
  for (const [path, file] of cases) {
    const w = await $.tool.call({ tool: 'Write', file_path: path, content: '{}' })
    expect(w.deny, path).toBe(protectedFile(file))
  }
  const sh = await $.tool.call({
    tool: 'Bash',
    command: "echo '{}' > ~/.claude.json",
    description: 'x',
  })
  expect(sh.deny).toBe(protectedFile('~/.claude.json'))
  const settings = await $.tool.call({
    tool: 'Write',
    file_path: '/etc/claude-code/managed-settings.json',
    content: '{}',
  })
  expect(settings.deny).toContain("Claude Code's settings can switch the guard off")
})

test(
  'review: a ~/.claude.json whose mcpServers is not an object gives placeholders',
  { options: { mcpRestore: ['jira'] } },
  async ($, on) => {
    project(on, {
      [`${ROOT}/.veilio/map.json`]: mapFile(PAYMENT),
      [CLAUDE_JSON]: JSON.stringify({ mcpServers: 'jira' }),
    })
    const seen: Fields[] = []
    on('tool.call', (_, e) => (seen.push(e), MCP_OK))
    await $.tool.call({ tool: 'mcp__jira__search', query: '__CLS__1' })
    expect(seen[0]?.query).toBe('__CLS__1')
  }
)
