// Spec 033 R7: the developer reads the real names; the model and the stored
// transcript keep the placeholders. And the band says what the guard is doing.
import { expect, mock, test } from 'claude-code/testing'
import { CANARY, mapFile, project, ROOT } from './helpers.ts'
import type { Fields } from './fixtures/recorded.ts'
import type { TestHost, TestOn } from './kit.ts'

const SITE = (component: string, props: Record<string, unknown>) => ({
  plugin: 'veilio-guard',
  component,
  requestId: 'm1',
  surface: 'terminal' as const,
  viewport: { columns: 120, rows: 40 },
  props,
})

// What Claude Code would draw: the props it was handed, as text.
function drawn(on: TestOn, seen: Fields[]) {
  on('ui.render', (_, e) => {
    seen.push(e)
    return { type: 'Text', props: {}, children: [String(e.props?.text ?? '')] }
  })
}

async function loaded(
  $: TestHost,
  on: TestOn,
  files: Record<string, string>,
  opts: Parameters<typeof project>[2] = {}
) {
  const p = project(on, files, opts)
  on('session.start', () => ({ cwd: ROOT }))
  return p
}

test("Claude's reply is drawn with the real names", async ($, on) => {
  await loaded($, on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }) })
  const seen: Fields[] = []
  drawn(on, seen)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
  const ui = await $.ui.mount(
    SITE('AssistantMessage', { text: 'The bug is in __CLS__1.', isFirstOfReply: true })
  )
  expect(await ui.find({ type: 'Text', text: `The bug is in ${CANARY}.` })).toBeDefined()
})

test('a tool row is drawn with the real names in its input', async ($, on) => {
  await loaded($, on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }) })
  const seen: Fields[] = []
  drawn(on, seen)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
  await $.ui.mount(
    SITE('ToolUse', {
      tool_use_id: 't1',
      tool: 'Bash',
      input: { command: 'grep -rn __CLS__1 src' },
      isRunning: false,
    })
  )
  expect(seen[0].props.input.command).toBe(`grep -rn ${CANARY} src`)
})

test("an edit's diff is drawn with the real names", async ($, on) => {
  await loaded($, on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }) })
  const seen: Fields[] = []
  drawn(on, seen)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
  await $.ui.mount(
    SITE('ToolResult', {
      tool_use_id: 't1',
      tool: 'Edit',
      isErrored: false,
      output: {
        filePath: `${ROOT}/src/ledger.ts`,
        oldString: 'class __CLS__1 {',
        newString: 'class __CLS__1 {',
        structuredPatch: [
          { oldStart: 1, lines: ['-export class __CLS__1 {', '+export class __CLS__1 {'] },
        ],
      },
    })
  )
  expect(seen[0].props.output.structuredPatch[0].lines).toEqual([
    `-export class ${CANARY} {`,
    `+export class ${CANARY} {`,
  ])
  expect(seen[0].props.output.structuredPatch[0].oldStart).toBe(1)
})

test("an unfolded tool row's result is drawn with the real names", async ($, on) => {
  await loaded($, on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }) })
  const seen: Fields[] = []
  drawn(on, seen)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
  await $.ui.mount(
    SITE('ToolUse', {
      tool_use_id: 't1',
      tool: 'Bash',
      input: { command: 'cat src/ledger.ts' },
      isRunning: false,
      output: { stdout: 'export class __CLS__1 {}', stderr: '' },
    })
  )
  expect(seen[0].props.output.stdout).toBe(`export class ${CANARY} {}`)
})

test('the band says the guard is on, with what it did', async ($, on) => {
  await loaded($, on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY, __VAR__1: 'x' }),
  })
  drawn(on, [])
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
  const ui = await $.ui.mount(
    SITE('AbovePrompt', {
      hasSurvey: false,
      isWorking: false,
      maxRows: 5,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 5 },
      view: {},
    })
  )
  expect(
    await ui.find({ type: 'Text', text: /^Veilio guard on · 2 names in the map/ })
  ).toBeDefined()
})

test('the band warns while the guard is off', async ($, on) => {
  // Spec 078 FR-010: off is recorded under ~/.veilio, not in guard.json.
  const off = { version: 1, projects: { [ROOT]: { enabled: false, changedAt: '2026-11-07' } } }
  await loaded(
    $,
    on,
    { '/home/dev/.veilio/guard-state.json': JSON.stringify(off) },
    { home: '/home/dev' }
  )
  drawn(on, [])
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
  const ui = await $.ui.mount(
    SITE('AbovePrompt', {
      hasSurvey: false,
      isWorking: false,
      maxRows: 5,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 5 },
      view: {},
    })
  )
  expect(
    await ui.find({ type: 'Text', text: /OFF for this project: Claude reads raw code/ })
  ).toBeDefined()
})

// Windows test report F7: the band stayed empty after start-up until /veilio
// ran, because the first draw happened before the guard had loaded and
// nothing asked for another.
test('the band appears once the guard has loaded, with no /veilio first', async ($, on) => {
  await loaded($, on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }) })
  drawn(on, [])
  const ui = await $.ui.mount(
    SITE('AbovePrompt', {
      hasSurvey: false,
      isWorking: false,
      maxRows: 5,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 5 },
      view: {},
    })
  )
  expect(await ui.find({ type: 'Text', text: /^Veilio guard on/ })).toBeUndefined()
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
  await ui.drawn()
  expect(
    await ui.find({ type: 'Text', text: /^Veilio guard on · 1 name in the map/ })
  ).toBeDefined()
})

// Guard follow-up d03b: a headless run (`claude -p`, the Agent SDK) draws
// nothing, so its reply keeps the placeholders. The host's other routes would
// write real names where they must not go: a `turn.complete` answer is stored
// in the transcript on disk as a notice (and never replaces the printed
// result), and a `session.append` rewrite is what the next request sends.
// The guard takes neither, and this holds that.
test('a headless reply keeps its placeholders: no route writes real names into a stored or sent reply', async ($, on) => {
  await loaded($, on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }) })
  // The kit's store for rows (Claude Code 2.1.310 on); the oldest supported
  // kit, 2.1.288, has none, and there only the answer is checked.
  const session = 'session' in mock && typeof mock.session === 'function' ? mock.session(on) : null
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ surface: null, isInteractive: false, cwd: ROOT })
  const answer = 'The bug is in __CLS__1.'
  const end = await $.turn.complete({
    answer,
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  expect(end.text).toBe(answer)
  if (!session) return
  await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: answer }] } })
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: answer }] } })
  const stored = JSON.stringify(session.appended())
  expect(stored).toContain('__CLS__1')
  expect(stored).not.toContain(CANARY)
})

// Spec 065 US4: the band says whether the account's custom rules apply, and
// why not, for the whole session.
const HOME = '/home/dev'
const ME = { instance: 'https://veilio.dev', account: 'dev@example.com' }
const RULE = {
  id: 'r1',
  scope: 'personal',
  team_id: null,
  type: 'replace',
  name: 'codename',
  pattern: '^phoenix$',
  placeholder: '__CODENAME__',
  enabled: true,
  sort_order: 0,
}

async function band($: TestHost, on: TestOn, files: Record<string, string>): Promise<string> {
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  await loaded($, on, {
    [`${HOME}/.veilio/credential.json`]: JSON.stringify({ token: 't', ...ME }),
    // The personal-maps key still held: without it the cached rules are not applied.
    [`${HOME}/.veilio/personal-maps-key.json`]: JSON.stringify({
      v: 1,
      ...ME,
      expiresAt: '2999-01-01T00:00:00.000Z',
      key: btoa(String.fromCharCode(...new Uint8Array(32).fill(5))),
    }),
    ...files,
  })
  const seen: Fields[] = []
  drawn(on, seen)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
  const ui = await $.ui.mount(
    SITE('AbovePrompt', {
      hasSurvey: false,
      isWorking: false,
      maxRows: 5,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 5 },
      view: {},
    })
  )
  const line = await ui.find({ type: 'Text', text: /^Veilio guard on/ })
  return String(line?.children?.[0] ?? JSON.stringify(line))
}

const rules = (list: unknown[], skipped?: Record<string, number>) => ({
  [`${HOME}/.veilio/rules.json`]: JSON.stringify({
    ...ME,
    pulledAt: '2026-10-30T10:00:00Z',
    rules: list,
    skipped,
  }),
})

test('the band counts the custom rules applied', async ($, on) => {
  expect(await band($, on, rules([RULE, { ...RULE, id: 'r2', pattern: '^falcon$' }]))).toContain(
    ' · custom rules: 2'
  )
})

test('the band says when no custom rules are pulled, and how to pull them', async ($, on) => {
  expect(await band($, on, {})).toContain(' · custom rules: none pulled - run `veilio rules pull`')
})

test('the band says when the rules on this machine are for another account', async ($, on) => {
  const other = {
    [`${HOME}/.veilio/rules.json`]: JSON.stringify({
      ...ME,
      account: 'x@y.z',
      pulledAt: 'now',
      rules: [RULE],
    }),
  }
  expect(await band($, on, other)).toContain(
    ' · custom rules: none for this account - run `veilio rules pull`'
  )
})

test('the band names the custom rules skipped, by cause', async ($, on) => {
  const text = await band(
    $,
    on,
    rules([RULE, { ...RULE, id: 'bad', pattern: '(a)\\1' }], {
      vaultLocked: 2,
      teamLocked: 1,
      unopenable: 1,
    })
  )
  expect(text).toContain(
    ' · custom rules: 1 (not applied: 2 vault locked, 1 team key locked, 1 unopenable, 1 refused)'
  )
})

// Spec 066 R8: a refused reservation stays on the band for the whole session,
// ahead of how many reserved numbers are left - in the 065 benchmark it was
// said once, on stderr, and nobody saw it.
const RESERVED = `${ROOT}/.veilio/reserved.json`
const reservedWith = (extra: Record<string, unknown>) => ({
  [RESERVED]: JSON.stringify({
    version: 1,
    instance: 'https://veilio.test',
    account: 'me@example.test',
    teamId: 'team-1',
    blocks: { __CLS__: { start: 5001, end: 5500 } },
    local: { tag: 'K7Q2XA' },
    ...extra,
  }),
})
const hhmm = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

test('a refused reservation is on the band, with the next block’s time, on every render', async ($, on) => {
  const nextAt = '2026-11-01T09:14:00.000Z'
  const files = reservedWith({ refused: { reason: 'cap', at: '2026-10-31T10:00:00.000Z', nextAt } })
  const text = await band($, on, files)
  const said = ` · team numbers refused (cap): new names numbered here, next block ${hhmm(nextAt)}`
  expect(text).toContain(said)
  expect(text).not.toMatch(/team numbers: \d+ left/)
  // Every render: /veilio draws the same band.
  const status = await $.command.run({ command: 'veilio', args: '' })
  expect(status.text).toContain(said)
})

test('a refusal without a next time says only the reason', async ($, on) => {
  const text = await band(
    $,
    on,
    reservedWith({ refused: { reason: 'offline', at: '2026-10-31T10:00:00.000Z' } })
  )
  expect(text).toContain(' · team numbers refused (offline): new names numbered here ·')
})

test('control characters in a refusal’s detail never reach the band', async ($, on) => {
  const text = await band(
    $,
    on,
    reservedWith({
      refused: { reason: 'server', at: '2026-10-31T10:00:00.000Z', detail: 'boom\u001b[2J\u0007' },
    })
  )
  expect(text).toContain('team numbers refused (server: boom?[2J?)')
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  expect(text).not.toMatch(/[\u0000-\u001f]/)
})

test('without a refusal the band is as before', async ($, on) => {
  const text = await band($, on, reservedWith({}))
  expect(text).toContain(' · team numbers: 500 left')
  expect(text).not.toContain('refused (')
})

test('Unicode format characters in a refusal’s detail never reach the band (code review)', async ($, on) => {
  const text = await band(
    $,
    on,
    reservedWith({
      refused: {
        reason: 'server',
        at: '2026-10-31T10:00:00.000Z',
        detail: 'boom\u202Eevil\u2066x\u200By\u200F',
      },
    })
  )
  expect(text).toContain('team numbers refused (server: boom?evil?x?y?)')
  expect(text).not.toMatch(/\p{Cf}/u)
})
