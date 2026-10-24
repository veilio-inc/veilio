// Spec 050 US1: on a project that has never used Veilio, nothing the project
// declares reaches the model - from the first result, with no Read. On
// 2026-10-24 the guard masked a result only against names already in the map,
// and the map grew only through Read: in 9 of 18 cold benchmark sessions Claude
// never used Read, and every test run and search went out as written.
import { expect, test } from 'claude-code/testing'
import { COLD_FILES, DECLARED, GREP, TEST_RUN } from './fixtures/cold.ts'
import { eventOf, mapFile, project, ROOT } from './helpers.ts'

const MAP = `${ROOT}/.veilio/map.json`
const leaked = (out: unknown) => {
  const text = JSON.stringify(out)
  return DECLARED.filter((name) => new RegExp(`\\b${name}\\b`).test(text))
}
const saved = (p: { files: Record<string, string> }) =>
  Object.values(JSON.parse(p.files[MAP] ?? '{"map":{}}').map) as string[]

test('the first call is a test run: its stack trace reaches the model masked', async ($, on) => {
  const p = project(on, { ...COLD_FILES })
  on('tool.call', () => TEST_RUN.r)
  const out: any = await $.tool.call(eventOf(TEST_RUN))
  expect(leaked(out)).toEqual([])
  // Still a test run's output: the runner's own words are as written.
  expect(out.result.stdout).toContain('AssertionError: expected false to be true')
  expect(saved(p)).toEqual(expect.arrayContaining(DECLARED))
})

test('the first call is a search: every matching line reaches the model masked', async ($, on) => {
  const p = project(on, { ...COLD_FILES })
  on('tool.call', () => GREP.r)
  const out: any = await $.tool.call(eventOf(GREP))
  expect(leaked(out)).toEqual([])
  expect(saved(p)).toEqual(expect.arrayContaining(['luhnValid', 'reconcileBatch']))
})

test('an edit written with a placeholder from a search lands with the real name', async ($, on) => {
  const p = project(on, { ...COLD_FILES })
  const seen: any[] = []
  // One stub for both calls: the kit takes no new hook once the test called $.
  on('tool.call', (_: any, e: any) => {
    if (e.tool === 'Grep') return GREP.r
    seen.push(e)
    return { result: { filePath: e.file_path, oldString: e.old_string, newString: e.new_string } }
  })
  await $.tool.call(eventOf(GREP))
  const map = JSON.parse(p.files[MAP]).map as Record<string, string>
  const placeholder = Object.keys(map).find((k) => map[k] === 'luhnValid')!
  expect(placeholder).toMatch(/^__[A-Z]+__\d+$/)

  await $.tool.call({
    tool: 'Edit',
    tool_use_id: 'toolu_cold_3',
    file_path: `${ROOT}/src/secrets.ts`,
    old_string: `export function ${placeholder}(value: string): boolean {`,
    new_string: `export function ${placeholder}(value: string): boolean {\n  // checked`,
  })
  expect(seen[0].old_string).toBe('export function luhnValid(value: string): boolean {')
})

test('a project with a map: a name the map does not hold yet is masked and added', async ($, on) => {
  const p = project(on, {
    ...COLD_FILES,
    [MAP]: mapFile({ __FN__1: 'luhnValid' }),
  })
  on('tool.call', () => TEST_RUN.r)
  const out: any = await $.tool.call(eventOf(TEST_RUN))
  expect(leaked(out)).toEqual([])
  expect(out.result.stdout).toContain('__FN__1')
  expect(saved(p)).toEqual(expect.arrayContaining(['luhnValid', 'settle', 'reconcileBatch']))
})

test('not a git checkout: the files a result names are still masked before it goes', async ($, on) => {
  project(on, { ...COLD_FILES }, { noGit: true })
  on('tool.call', () => TEST_RUN.r)
  const out: any = await $.tool.call(eventOf(TEST_RUN))
  expect(leaked(out)).toEqual([])
})

test('a name from a file the index cannot reach is masked when shaped like one', async ($, on) => {
  // A frame in a generated bundle: not tracked, not on disk in the project.
  const run = {
    e: { ...TEST_RUN.e, tool_use_id: 'toolu_cold_4' },
    r: {
      ...TEST_RUN.r,
      result: {
        ...TEST_RUN.r.result,
        stdout:
          ' ❯ renderInvoiceTotals dist/assets/chunk-a1b2.js:3:1\nAssertionError: expected 1 to be 2',
      },
    },
  }
  const p = project(on, { ...COLD_FILES })
  on('tool.call', () => run.r)
  const out: any = await $.tool.call(eventOf(run))
  expect(JSON.stringify(out)).not.toContain('renderInvoiceTotals')
  expect(out.result.stdout).toContain('AssertionError: expected 1 to be 2')
  expect(saved(p)).toContain('renderInvoiceTotals')
})
