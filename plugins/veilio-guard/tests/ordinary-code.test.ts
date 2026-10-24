// Spec 050 US2: Claude reads ordinary code as ordinary code. On 2026-10-24 a
// map `veilio scrub` built over this repository held `const`, `export` and
// `function` (a misread file put them there), and the guard masked them in
// every TypeScript file; the test runner's name and a flag in a typed command
// were masked too, and one benchmark session stopped to ask for its prompt.
import { expect, test } from 'claude-code/testing'
import { COLD_FILES, GREP } from './fixtures/cold.ts'
import { eventOf, mapFile, project, recordedPrompt, ROOT } from './helpers.ts'

const POISONED = {
  __VAR__1009: 'const',
  __VAR__690: 'export',
  __FN__1006: 'function',
  __FN__20: 'describe',
  __FN__23: 'expect',
  __PKG__4: 'vitest',
  __PKG__40: 'tests',
  __FN__1: 'luhnValid',
}
const MAP = `${ROOT}/.veilio/map.json`

test('a TypeScript Read keeps the language, with a map that holds its keywords', async ($, on) => {
  project(on, { ...COLD_FILES, [MAP]: mapFile(POISONED) })
  const content = COLD_FILES[`${ROOT}/src/secrets.ts`]!
  on('tool.call', () => ({
    ref: 1,
    result: {
      type: 'text',
      file: {
        filePath: `${ROOT}/src/secrets.ts`,
        content,
        numLines: 13,
        startLine: 1,
        totalLines: 13,
      },
    },
    isReadOnly: true,
  }))
  const out: any = await $.tool.call({
    tool: 'Read',
    tool_use_id: 't_r',
    file_path: `${ROOT}/src/secrets.ts`,
  })
  const seen: string = out.result.file.content
  // `value` is the project's own parameter, masked; the keywords stay.
  expect(seen).toMatch(/export function __FN__1\(__VAR__\d+: string\): boolean \{/)
  expect(seen).toMatch(/const __VAR__\d+ =/)
  expect(seen).not.toMatch(/__VAR__1009|__VAR__690|__FN__1006/)
})

test('a search over TypeScript keeps the keywords on every line', async ($, on) => {
  project(on, { ...COLD_FILES, [MAP]: mapFile(POISONED) })
  on('tool.call', () => GREP.r)
  const out: any = await $.tool.call(eventOf(GREP))
  expect(out.result.content).toContain('export function __FN__1(')
  expect(out.result.content).not.toMatch(/__VAR__690|__FN__1006/)
})

test('a test file reads with its third-party names, and the project name is masked', async ($, on) => {
  project(on, { ...COLD_FILES, [MAP]: mapFile(POISONED) })
  on('session.start', () => ({ cwd: ROOT }))
  const content = COLD_FILES[`${ROOT}/tests/secrets.test.ts`]!
  on('tool.call', () => ({
    ref: 1,
    result: {
      type: 'text',
      file: {
        filePath: `${ROOT}/tests/secrets.test.ts`,
        content,
        numLines: 7,
        startLine: 1,
        totalLines: 7,
      },
    },
    isReadOnly: true,
  }))
  // As in a session: it starts, and the index runs to the end.
  await $.session.start({ surface: 'terminal', isInteractive: false, cwd: ROOT })
  const out: any = await $.tool.call({
    tool: 'Read',
    tool_use_id: 't_t',
    file_path: `${ROOT}/tests/secrets.test.ts`,
  })
  const seen: string = out.result.file.content
  expect(seen).toContain("import { describe, expect, it } from 'vitest'")
  expect(seen).not.toContain('luhnValid')
})

test('a typed command keeps the runner, its flag and the test directory', async ($, on) => {
  project(on, { ...COLD_FILES, [MAP]: mapFile({ ...POISONED, __VAR__77: 'tenant' }) })
  const sent: any[] = []
  on('prompt.submit', (_: any, e: any) => {
    sent.push(e)
    return { text: e.text }
  })
  await $.prompt.submit({
    ...recordedPrompt('prompt.submit').e,
    text: 'The command `npx vitest run --tenant tests/secrets.test.ts` fails. Fix luhnValid.',
  })
  expect(sent[0].text).toContain('npx vitest run --tenant tests/')
  expect(sent[0].text).not.toContain('luhnValid')
})

test('while the index is incomplete, a name imported from a package is still masked', async ($, on) => {
  // Not every file is indexed yet: the one that declares `expect` might be next.
  project(on, { ...COLD_FILES, [MAP]: mapFile(POISONED) })
  const content = COLD_FILES[`${ROOT}/tests/secrets.test.ts`]!
  on('tool.call', () => ({
    ref: 1,
    result: {
      type: 'text',
      file: {
        filePath: `${ROOT}/tests/secrets.test.ts`,
        content,
        numLines: 7,
        startLine: 1,
        totalLines: 7,
      },
    },
    isReadOnly: true,
  }))
  const out: any = await $.tool.call({
    tool: 'Read',
    tool_use_id: 't_partial',
    file_path: `${ROOT}/tests/secrets.test.ts`,
  })
  expect(out.result.file.content).not.toContain('expect,')
})
