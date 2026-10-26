// Spec 033 US1 and FR-005: the model writes placeholders; the tool runs on the
// real names. An edit with a placeholder the map cannot resolve is refused, and
// the tool never runs.
import { expect, test } from 'claude-code/testing'
import { CANARY, eventOf, mapFile, project, recorded, ROOT } from './helpers.ts'

const MAP = { __CLS__1: CANARY, __VAR__1: 'settledTotal', __VAR__3: 'closedTotal' }

test('a shell command runs with the real names', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  const seen: any[] = []
  on('tool.call', (_: any, e: any) => {
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
  const seen: any[] = []
  on('tool.call', (_: any, e: any) => {
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
  const out: any = await $.tool.call({
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
  const out: any = await $.tool.call({ ...eventOf(write), content: 'export const x = __var__1' })
  expect(ran).toBe(false)
  expect(out.deny).toContain('__var__1')
  expect(out.deny).toContain('exact spelling')
})

test('a search for a literal placeholder still runs: searches are lenient', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  const seen: any[] = []
  on('tool.call', (_: any, e: any) => {
    seen.push(e)
    return { result: { mode: 'content', numFiles: 0, filenames: [], content: '', numLines: 0 } }
  })
  await $.tool.call({ tool: 'Grep', pattern: '__TODO__7', output_mode: 'content' })
  expect(seen[0].pattern).toBe('__TODO__7')
})

test('a web request never gets the real names', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  const seen: any[] = []
  on('tool.call', (_: any, e: any) => {
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

test('an MCP tool gets the real names only for a server the project names', async ($, on) => {
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile(MAP),
    [`${ROOT}/.veilio/guard.json`]: JSON.stringify({ mcpRestore: ['local_db'] }),
  })
  const seen: any[] = []
  on('tool.call', (_: any, e: any) => {
    seen.push(e)
    return { result: [{ type: 'text', text: 'ok' }] }
  })
  await $.tool.call({ tool: 'mcp__local_db__query', sql: 'select * from __CLS__1' })
  await $.tool.call({ tool: 'mcp__github__create_issue', title: 'bug in __CLS__1' })
  expect(seen[0].sql).toBe(`select * from ${CANARY}`)
  expect(seen[0].tool).toBe('mcp__local_db__query')
  expect(seen[1].title).toBe('bug in __CLS__1')
})

test("Claude Code's own refusal, which quotes the restored command, reaches the model masked", async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  // The permission check refuses the call it was given - the restored one.
  on('tool.call', (_: any, e: any) => ({
    deny: `Permission to use Bash with command ${e.command} was denied.`,
  }))
  const out: any = await $.tool.call({ tool: 'Bash', command: 'rm -rf __CLS__1', description: 'x' })
  expect(out.deny).toContain('rm -rf __CLS__1')
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
  const out: any = await $.tool.call({
    ...eventOf(write),
    content: 'const key = "__REDACTED_STRIPE_KEY_1__"\n',
  })
  expect(ran).toBe(false)
  expect(out.deny).toContain('__REDACTED_STRIPE_KEY_1__')
})

test('tokens a language owns, such as the DEV and FILE globals, are not placeholders: the edit runs', async ($, on) => {
  const edit = recorded('Edit')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  const seen: any[] = []
  on('tool.call', (_: any, e: any) => {
    seen.push(e)
    return edit.r
  })
  const out: any = await $.tool.call({
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
function shell(on: any) {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  const seen: any[] = []
  on('tool.call', (_: any, e: any) => {
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
  const out: any = await $.tool.call({
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
  const out: any = await $.tool.call({
    tool: 'Bash',
    command: "sed -i '' 's/x/__var__1/' src/ledger.ts",
    description: 'rename',
  })
  expect(seen.length).toBe(0)
  expect(out.deny).toContain('exact spelling')
})

test('a shell command that would write a redaction token is refused: the real key would be lost', async ($, on) => {
  const seen = shell(on)
  const out: any = await $.tool.call({
    tool: 'Bash',
    command: `echo 'const key = "__REDACTED_STRIPE_KEY_1__"' > src/config.ts`,
    description: 'write config',
  })
  expect(seen.length).toBe(0)
  expect(out.deny).toContain('__REDACTED_STRIPE_KEY_1__')
})

test('a shell command with known placeholders and language tokens runs', async ($, on) => {
  const seen = shell(on)
  const out: any = await $.tool.call({
    tool: 'Bash',
    command: "sed -i '' 's/__VAR__1/__VAR__3/' src/ledger.ts && grep -rn __DEV__ src",
    description: 'rename',
  })
  expect(out.deny).toBeUndefined()
  expect(seen[0].command).toBe(
    "sed -i '' 's/settledTotal/closedTotal/' src/ledger.ts && grep -rn __DEV__ src"
  )
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
  const out: any = await $.tool.call({
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
  const seen: any[] = []
  on('tool.call', (_: any, e: any) => {
    seen.push(e)
    return edit.r
  })
  const out: any = await $.tool.call({
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
  const out: any = await $.tool.call({
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
  const beside: any = await $.tool.call({
    ...eventOf(edit),
    old_string: 'const __VAR__1 =',
    new_string: 'const __VAR__1 = 2',
  })
  expect(beside.deny).toBeUndefined()
  const back: any = await $.tool.call({
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
  return async ($: any, on: any) => {
    const edit = recorded('Edit')
    project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...MAP, __IBAN__1: value }) })
    let ran = false
    on('tool.call', () => ((ran = true), edit.r))
    const out: any = await $.tool.call({
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
  return async ($: any, on: any) => {
    const edit = recorded('Edit')
    project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...MAP, ...map }) })
    let ran = false
    on('tool.call', () => ((ran = true), edit.r))
    const out: any = await $.tool.call({ ...eventOf(edit), old_string: 'x', new_string: newString })
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
  const out: any = await $.tool.call({
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
  const manual: any = await $.tool.call({
    ...eventOf(edit),
    old_string: 'x',
    new_string: '__MANUAL__1',
  })
  expect(manual.deny).toContain('marked by hand')
  const iban: any = await $.tool.call({
    ...eventOf(edit),
    old_string: 'x',
    new_string: '__IBAN__1',
  })
  expect(iban.deny).toContain('regulated number')
})
