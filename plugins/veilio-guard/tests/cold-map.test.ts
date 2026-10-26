// Spec 050 US1: on a project that has never used Veilio, nothing the project
// declares reaches the model - from the first result, with no Read. On
// 2026-10-24 the guard masked a result only against names already in the map,
// and the map grew only through Read: in 9 of 18 cold benchmark sessions Claude
// never used Read, and every test run and search went out as written.
import { expect, test } from 'claude-code/testing'
import { COLD_FILES, DECLARED, GREP, TEST_RUN } from './fixtures/cold.ts'
import { eventOf, mapFile, project, ROOT, STRIPE, res } from './helpers.ts'
import type { Fields } from './fixtures/recorded.ts'
import type { TestHost, TestOn } from './kit.ts'

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
  const out = await $.tool.call(eventOf(TEST_RUN))
  expect(leaked(out)).toEqual([])
  // Still a test run's output: the runner's own words are as written.
  expect(res(out).stdout).toContain('AssertionError: expected false to be true')
  expect(saved(p)).toEqual(expect.arrayContaining(DECLARED))
})

test('the first call is a search: every matching line reaches the model masked', async ($, on) => {
  const p = project(on, { ...COLD_FILES })
  on('tool.call', () => GREP.r)
  const out = await $.tool.call(eventOf(GREP))
  expect(leaked(out)).toEqual([])
  expect(saved(p)).toEqual(expect.arrayContaining(['luhnValid', 'reconcileBatch']))
})

test('an edit written with a placeholder from a search lands with the real name', async ($, on) => {
  const p = project(on, { ...COLD_FILES })
  const seen: Fields[] = []
  // One stub for both calls: the kit takes no new hook once the test called $.
  on('tool.call', (_, e) => {
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
  const out = await $.tool.call(eventOf(TEST_RUN))
  expect(leaked(out)).toEqual([])
  expect(res(out).stdout).toContain('__FN__1')
  expect(saved(p)).toEqual(expect.arrayContaining(['luhnValid', 'settle', 'reconcileBatch']))
})

test('not a git checkout: the files a result names are still masked before it goes', async ($, on) => {
  project(on, { ...COLD_FILES }, { noGit: true })
  on('tool.call', () => TEST_RUN.r)
  const out = await $.tool.call(eventOf(TEST_RUN))
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
  const out = await $.tool.call(eventOf(run))
  expect(JSON.stringify(out)).not.toContain('renderInvoiceTotals')
  expect(res(out).stdout).toContain('AssertionError: expected 1 to be 2')
  expect(saved(p)).toContain('renderInvoiceTotals')
})

// Review of ef1a533: a path the result names in a form the guard did not read
// left its file unindexed, and a lowercase name in it went out as written.
const shellWith = (stdout: string, id: string) => ({
  e: { ...TEST_RUN.e, tool_use_id: id },
  r: { ...TEST_RUN.r, result: { ...TEST_RUN.r.result, stdout } },
})

const lowercaseNameIsMasked = (stdout: string) => async ($: TestHost, on: TestOn) => {
  project(on, { ...COLD_FILES })
  const run = shellWith(stdout, 'toolu_form')
  on('tool.call', () => run.r)
  const out = await $.tool.call(eventOf(run))
  expect(JSON.stringify(out)).not.toMatch(/\bsettle\b/)
}
test(
  'a lowercase name is masked when the output names its file as a Windows path',
  lowercaseNameIsMasked(' ❯ settle src\\secrets.ts:11:3')
)
test(
  'a lowercase name is masked when the output names its file as a file URL',
  lowercaseNameIsMasked(` ❯ settle file://${ROOT}/src/secrets.ts:11:3`)
)
test(
  'a lowercase name is masked when the output names its file as a path in brackets',
  lowercaseNameIsMasked(' at settle [src/secrets.ts:11:3]')
)
test(
  'a lowercase name is masked when the output names its file as a path after a semicolon',
  lowercaseNameIsMasked('see;src/secrets.ts: settle failed')
)
test(
  'a lowercase name is masked when the output names its file as a path relative to a subdirectory',
  lowercaseNameIsMasked(' ❯ settle ../src/secrets.ts:11:3')
)

test('a path the guard cannot resolve makes it finish the index before the result goes', async ($, on) => {
  const files = {
    ...COLD_FILES,
    [`${ROOT}/src/my dir/ledger.ts`]: 'export function reconcile() {}\n',
  }
  project(on, files)
  const run = shellWith(' ❯ reconcile src/my dir/ledger.ts:1:17', 'toolu_space')
  on('tool.call', () => run.r)
  const out = await $.tool.call(eventOf(run))
  expect(JSON.stringify(out)).not.toMatch(/\breconcile\b/)
})

test('a denial that names a project function is masked like a result', async ($, on) => {
  project(on, { ...COLD_FILES })
  on('tool.call', () => ({ deny: 'cannot run settle: src/secrets.ts is locked' }))
  const out = await $.tool.call(eventOf(TEST_RUN))
  expect(out.deny).not.toMatch(/\bsettle\b/)
})

test('in a record, a one-word value that is not an enum is still shape-masked', async ($, on) => {
  project(on, { ...COLD_FILES })
  on('tool.call', () => ({
    ref: 1,
    result: { type: 'text', name: 'renderInvoiceTotals' },
    isReadOnly: true,
  }))
  const out = await $.tool.call({ tool: 'mcp__acme__lookup', tool_use_id: 'toolu_rec' })
  expect(JSON.stringify(out)).not.toContain('renderInvoiceTotals')
  expect(res(out).type).toBe('text')
})

// Security review of f03f45c.
test('an enum-like key deeper in a record, or holding a sentence, is still masked', async ($, on) => {
  project(on, { ...COLD_FILES })
  on('tool.call', () => ({
    ref: 1,
    result: {
      type: 'text',
      status: 'renderInvoiceTotals failed',
      detail: { status: 'computeLedgerBalance' },
    },
    isReadOnly: true,
  }))
  const out = await $.tool.call({ tool: 'mcp__acme__lookup', tool_use_id: 'toolu_rec2' })
  expect(JSON.stringify(out)).not.toContain('renderInvoiceTotals')
  expect(JSON.stringify(out)).not.toContain('computeLedgerBalance')
  expect(res(out).type).toBe('text')
})

test('a denial that still holds a credential after masking is withheld', async ($, on) => {
  project(on, { ...COLD_FILES })
  on('tool.call', () => ({ deny: `refused: STRIPE_SECRET_KEY=${STRIPE}` }))
  const out = await $.tool.call(eventOf(TEST_RUN))
  expect(JSON.stringify(out)).not.toContain(STRIPE)
})

// Final review of b0dded9: a path the guard could not find passed the result
// unless the index was mid-way; with no listing, nothing stopped it.
test('a diff names its files as a/ and b/: they are found and indexed', async ($, on) => {
  project(on, { ...COLD_FILES })
  const run = shellWith(
    'diff --git a/src/secrets.ts b/src/secrets.ts\n-export function settle(batch: number[]): number {',
    'toolu_diff'
  )
  on('tool.call', () => run.r)
  const out = await $.tool.call(eventOf(run))
  expect(JSON.stringify(out)).not.toMatch(/\bsettle\b/)
})

test('with no listing, a source path the guard cannot find withholds the result', async ($, on) => {
  project(on, { ...COLD_FILES }, { noGit: true })
  const run = shellWith(' ❯ settle lib/elsewhere/ledger.ts:3:1', 'toolu_nolist')
  on('tool.call', () => run.r)
  const out = await $.tool.call(eventOf(run))
  expect(out.deny).toContain('Veilio withheld this result')
  expect(JSON.stringify(out)).not.toMatch(/\bsettle\b/)
})

// Security review of 2947c81: a path found only by stripping directories may be
// another file than the one printed; it does not count as checked.
test('a path found only by stripping its directories is not trusted before the index is complete', async ($, on) => {
  project(on, { ...COLD_FILES }, { noGit: true })
  const run = shellWith(' ❯ settle vendor/acme/src/secrets.ts:3:1', 'toolu_strip')
  on('tool.call', () => run.r)
  const out = await $.tool.call(eventOf(run))
  expect(out.deny).toContain('Veilio withheld this result')
})

// Review of da4ff84: a name that holds a credential the session destroyed is
// left out of the map, and the rest of the batch is saved.
test('indexing a file whose name holds a destroyed credential saves the other names', async ($, on) => {
  const files = {
    ...COLD_FILES,
    [`${ROOT}/src/pool.ts`]:
      'export function connectXk9mQ2vL7QPool() {}\nexport function ledgerHarvestTotal() {}\n',
  }
  const p = project(on, files)
  on('tool.call', (_, e) =>
    e.tool === 'Bash'
      ? { ...TEST_RUN.r, result: { ...TEST_RUN.r.result, stdout: 'password = "Xk9mQ2vL7Q"\n' } }
      : {
          ...GREP.r,
          result: {
            ...GREP.r.result,
            content: [
              'src/pool.ts:1:export function connectXk9mQ2vL7QPool() {}',
              'src/pool.ts:2:export function ledgerHarvestTotal() {}',
            ].join('\n'),
          },
        }
  )
  await $.tool.call({ ...eventOf(TEST_RUN), command: 'cat .netrc.example' })
  const out = await $.tool.call(eventOf(GREP))
  expect(out.deny).toBeUndefined()
  expect(saved(p)).toContain('ledgerHarvestTotal')
  expect(saved(p).join(' ')).not.toContain('Xk9mQ2vL7Q')
  // Masked as one name in the result, by a placeholder kept in memory only.
  const shown: string = res(out).content
  expect(shown).not.toContain('Xk9mQ2vL7Q')
  expect(shown).not.toContain('connect')
  // A placeholder of its own namespace, which no saved entry can ever share.
  expect(shown).toMatch(/export function __QUARANTINED__\d+\(\) \{\}/)
  expect(p.files[MAP]).not.toContain('__QUARANTINED__')
})
