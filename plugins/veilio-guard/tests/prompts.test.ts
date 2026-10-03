// Spec 033 US1: what the developer types, and what Claude Code adds by itself,
// reach the model with known names as placeholders and secrets removed.
import { expect, test } from 'claude-code/testing'
import { CANARY, mapFile, project, recordedPrompt, ROOT, STRIPE } from './helpers.ts'

const MAP = { __CLS__1: CANARY }

test('a typed prompt is masked before it is sent, and the developer is told', async ($, on) => {
  const p = project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  const sent: any[] = []
  on('prompt.submit', (_: any, e: any) => {
    sent.push(e)
    return { text: e.text }
  })
  await $.prompt.submit({
    ...recordedPrompt('prompt.submit').e,
    text: `Why does ${CANARY} fail with key ${STRIPE}?`,
  })
  expect(sent[0].text).toContain('__CLS__1')
  expect(sent[0].text).not.toContain(CANARY)
  expect(sent[0].text).not.toContain(STRIPE)
  expect(p.toasts.join()).toContain('masked')
})

test("a subagent's answer, delivered as a notification, is masked too", async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  const sent: any[] = []
  on('prompt.submit', (_: any, e: any) => {
    sent.push(e)
    return { text: e.text }
  })
  const notification = recordedPrompt('prompt.submit', 2).e
  expect(notification.text).toContain(CANARY)
  await $.prompt.submit(notification)
  expect(sent[0].text).not.toContain(CANARY)
})

test('a reminder Claude Code adds is masked', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  on('prompt.attachment', (_: any, e: any) => ({ text: e.text }))
  const out: any = await $.prompt.attachment({
    type: 'edited_text_file',
    text: `Note: src/ledger.ts was modified:\n1\texport class ${CANARY} {`,
  })
  expect(out.text).not.toContain(CANARY)
})

test('the project instructions sent with the first message are masked', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  const context = recordedPrompt('prompt.context').e
  expect(JSON.stringify(context)).toContain(CANARY)
  on('prompt.context', (_: any, e: any) => ({ blocks: e.blocks }))
  const out: any = await $.prompt.context(context)
  expect(JSON.stringify(out.blocks)).not.toContain(CANARY)
  expect(out.blocks[0].name).toBe('claudeMd')
})

test('the model is told once how placeholders work, in a block that holds no names', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  on('prompt.context', (_: any, e: any) => ({ blocks: e.blocks }))
  const out: any = await $.prompt.context(recordedPrompt('prompt.context').e)
  const note = out.blocks.find((b: any) => b.name === 'veilioGuard')
  expect(note.text).toContain('Use placeholders exactly as you see them')
  expect(note.text).not.toContain(CANARY)
})

test("a skill's text is masked", async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  const out: any = await $.skill.prompt({ skill: 'review', text: `Review ${CANARY} carefully.` })
  expect(out.text).toBe('Review __CLS__1 carefully.')
})

test('a prompt naming a plain-word method still gets its placeholder, so it matches the code', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __FN__1: 'reconcile', __STR__1: 'the' }) })
  const sent: any[] = []
  on('prompt.submit', (_: any, e: any) => {
    sent.push(e)
    return { text: e.text }
  })
  await $.prompt.submit({
    ...recordedPrompt('prompt.submit').e,
    text: 'Rename the method reconcile to settle',
  })
  expect(sent[0].text).toBe('Rename the method __FN__1 to settle')
})
