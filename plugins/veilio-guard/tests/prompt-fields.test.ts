// Spec 083 US1: every field of a prompt is masked, passed as metadata, or
// refused when the guard does not know it and it holds text (contracts/prompt-fields.md).
import { expect, test } from 'claude-code/testing'
import { CANARY, mapFile, project, recordedPrompt, ROOT } from './helpers.ts'
import type { Fields } from './fixtures/recorded.ts'

const MAP = { __CLS__1: CANARY }
const base = () => recordedPrompt('prompt.submit').e

function sending(on: Parameters<typeof project>[0]) {
  const p = project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  const sent: Fields[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e)
    return { text: e.text }
  })
  return { p, sent }
}

test("a prompt's text and context are masked", async ($, on) => {
  const { sent } = sending(on)
  await $.prompt.submit({ ...base(), text: `Fix ${CANARY}`, context: [`see ${CANARY}`] })
  expect(sent[0].text).toBe('Fix __CLS__1')
  expect(sent[0].context).toEqual(['see __CLS__1'])
})

test('a prompt delivered into a running turn unseen is masked the same', async ($, on) => {
  const { sent } = sending(on)
  await $.prompt.submit({ ...base(), isMeta: true, turnId: 't1', text: `Fix ${CANARY}` })
  expect(sent[0].text).toBe('Fix __CLS__1')
})

test('an unseen prompt that starts a turn and names a masked name is not sent', async ($, on) => {
  const { sent } = sending(on)
  const out = await $.prompt.submit({ ...base(), isMeta: true, text: `Fix ${CANARY}` })
  expect(sent).toHaveLength(0)
  expect(out.drop).toBe(
    'Veilio did not send this message: Claude Code does not let the guard mask a message it sends on its own at the start of a turn, and this one names 1 masked names.'
  )
})

test('an unseen prompt that starts a turn with nothing to mask is sent as it is', async ($, on) => {
  const { sent } = sending(on)
  const e = { ...base(), isMeta: true, text: 'Continue.' }
  await $.prompt.submit(e)
  expect(sent[0].text).toBe('Continue.')
  expect(sent[0].isMeta).toBe(true)
})

test("a prompt's metadata passes untouched", async ($, on) => {
  const { sent } = sending(on)
  const e = { ...base(), turnId: `turn-${CANARY}`, wait: true, text: `Fix ${CANARY}` }
  await $.prompt.submit(e)
  expect(sent[0].origin).toEqual(e.origin)
  expect(sent[0].turnId).toBe(e.turnId)
  expect(sent[0].wait).toBe(true)
})

test("a slash command's line is left to command.run, and no masked toast is shown", async ($, on) => {
  const { p, sent } = sending(on)
  const command = { name: 'review', args: '__CLS__1' }
  await $.prompt.submit({ ...base(), text: '/review __CLS__1', command })
  expect(sent[0].text).toBe('/review __CLS__1')
  expect(sent[0].command).toEqual(command)
  expect(p.toasts.join()).not.toContain('masked names in your prompt')
})

test("a slash command's context is still masked", async ($, on) => {
  const { sent } = sending(on)
  const command = { name: 'review', args: '' }
  await $.prompt.submit({ ...base(), text: '/review', command, context: [CANARY] })
  expect(sent[0].context).toEqual(['__CLS__1'])
})

test('an unknown field that holds text refuses the prompt and names it', async ($, on) => {
  const { sent } = sending(on)
  for (const [field, value] of [
    ['note', CANARY],
    ['extra', { body: 'x' }],
    ['parts', ['x']],
  ] as const) {
    const out = await $.prompt.submit({ ...base(), text: 'hello', [field]: value })
    expect(out.drop).toBe(
      `Veilio did not send this prompt: it carries \`${field}\`, which this version of the guard cannot check. Update the guard (\`claude plugin marketplace update veilio\`, then \`claude plugin update veilio-guard@veilio\`), then send it again.`
    )
  }
  expect(sent).toHaveLength(0)
})

test('an unknown field that holds no text passes', async ($, on) => {
  const { sent } = sending(on)
  await $.prompt.submit({ ...base(), text: 'hello', flag: true, count: 3, gone: null })
  expect(sent).toHaveLength(1)
  expect(sent[0].flag).toBe(true)
})

const ATTACHED =
  'Veilio cannot mask images, audio or documents: the 1 attached to this prompt went to the model as they are. Text you type is still masked.'

test('a prompt with an attachment is sent with its text masked, and the developer is told once', async ($, on) => {
  const { p, sent } = sending(on)
  const attachments = [{ type: 'image', mediaType: 'image/png', id: 'a1' }]
  await $.prompt.submit({ ...base(), text: `Look at ${CANARY}`, attachments })
  expect(sent[0].text).toBe('Look at __CLS__1')
  expect(p.toasts).toContain(ATTACHED)
  expect(p.logs).toContain(ATTACHED)
  await $.prompt.submit({ ...base(), text: 'And this one', attachments })
  expect(sent).toHaveLength(2)
  expect(p.toasts.filter((t) => t === ATTACHED)).toHaveLength(1)
})

test('a prompt with no attachment says nothing about attachments', async ($, on) => {
  const { p } = sending(on)
  await $.prompt.submit({ ...base(), text: `Look at ${CANARY}` })
  expect(p.toasts.join()).not.toContain('cannot mask images')
  expect(p.logs.join()).not.toContain('cannot mask images')
})

test('a new session names attachments again', async ($, on) => {
  const { p } = sending(on)
  on('session.end', () => ({ sessionId: 's1' }))
  const attachments = [{ type: 'image', mediaType: 'image/png', id: 'a1' }]
  await $.prompt.submit({ ...base(), text: 'Look', attachments })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  await $.prompt.submit({ ...base(), text: 'Look again', attachments })
  expect(p.toasts.filter((t) => t === ATTACHED)).toHaveLength(2)
})

// Second review of spec 083: the host applies no rewrite of a command's line,
// so a line that is not the command as command.run left it goes only when
// masking would not change it.
const LINE_REFUSED =
  'Veilio did not send this prompt: Claude Code does not let the guard mask the line of a slash command, and this one holds names the guard masks.'

test("a slash command's line that is more than the command is not sent when it names a masked name", async ($, on) => {
  const { sent } = sending(on)
  for (const text of [`/review ${CANARY}`, `hello ${CANARY}`, `/review __CLS__1 ${CANARY}`]) {
    const out = await $.prompt.submit({
      ...base(),
      text,
      command: { name: 'review', args: '__CLS__1' },
    })
    expect(out.drop).toBe(LINE_REFUSED)
  }
  expect(sent).toHaveLength(0)
})

test("a slash command's line that is more than the command goes when nothing in it is masked", async ($, on) => {
  const { sent } = sending(on)
  await $.prompt.submit({
    ...base(),
    text: '/review the diff',
    command: { name: 'review', args: 'hello' },
  })
  expect(sent[0].text).toBe('/review the diff')
})

test("a slash command's line as command.run left it goes as it is", async ($, on) => {
  const { sent } = sending(on)
  await $.prompt.submit({
    ...base(),
    text: '/review hello',
    command: { name: 'review', args: 'hello' },
  })
  await $.prompt.submit({ ...base(), text: '/clear', command: { name: 'clear', args: '' } })
  expect(sent.map((s) => s.text)).toEqual(['/review hello', '/clear'])
})

test('an unseen prompt that starts a turn is not sent when only its context names a masked name', async ($, on) => {
  const { sent } = sending(on)
  const out = await $.prompt.submit({
    ...base(),
    isMeta: true,
    text: 'Continue.',
    context: [CANARY],
  })
  expect(sent).toHaveLength(0)
  expect(out.drop).toContain('names 1 masked names')
})

test('an unseen prompt that already holds the placeholder of a name it names is not sent', async ($, on) => {
  const { sent } = sending(on)
  const out = await $.prompt.submit({ ...base(), isMeta: true, text: `Fix __CLS__1 and ${CANARY}` })
  expect(sent).toHaveLength(0)
  expect(out.drop).toContain('names 1 masked names')
})
