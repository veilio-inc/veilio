// Spec 033 R7: the developer reads the real names; the model and the stored
// transcript keep the placeholders. And the band says what the guard is doing.
import { expect, test } from 'claude-code/testing'
import { CANARY, mapFile, project, ROOT } from './helpers.ts'

const SITE = (component: string, props: Record<string, unknown>) => ({
  plugin: 'veilio-guard',
  component,
  requestId: 'm1',
  surface: 'terminal' as const,
  viewport: { columns: 120, rows: 40 },
  props,
})

// What Claude Code would draw: the props it was handed, as text.
function drawn(on: any, seen: any[]) {
  on('ui.render', (_: any, e: any) => {
    seen.push(e)
    return { type: 'Text', props: {}, children: [String(e.props?.text ?? '')] }
  })
}

async function loaded($: any, on: any, files: Record<string, string>) {
  const p = project(on, files)
  on('session.start', () => ({ cwd: ROOT }))
  return p
}

test("Claude's reply is drawn with the real names", async ($, on) => {
  await loaded($, on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }) })
  const seen: any[] = []
  drawn(on, seen)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
  const ui = await $.ui.mount(
    SITE('AssistantMessage', { text: 'The bug is in __CLS__1.', isFirstOfReply: true })
  )
  expect(await ui.find({ type: 'Text', text: `The bug is in ${CANARY}.` })).toBeDefined()
})

test('a tool row is drawn with the real names in its input', async ($, on) => {
  await loaded($, on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }) })
  const seen: any[] = []
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
  await loaded($, on, { [`${ROOT}/.veilio/guard.json`]: JSON.stringify({ enabled: false }) })
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
