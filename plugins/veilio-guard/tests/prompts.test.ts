// Spec 033 US1: what the developer types, and what Claude Code adds by itself,
// reach the model with known names as placeholders and secrets removed.
import { expect, test } from 'claude-code/testing'
import { CANARY, mapFile, project, recordedPrompt, ROOT, STRIPE } from './helpers.ts'
import { MODEL_NOTE } from '../lib/ui.ts'

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

// Guard follow-up d08: the note is the guard's own constant and holds no
// project information, but it reached the model masked word by word
// (`__STR__28 guard is on in this project`) wherever the project's map held
// one of its words. Only the note is exempt: the text around it is masked.
test("the guard's own note reaches the model as written, and the text around it is masked", async ($, on) => {
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({
      ...MAP,
      __STR__28: 'Veilio',
      __VAR__48: 'files',
      __VAR__249: 'user',
      __FN__18: 'match',
    }),
  })
  on('prompt.attachment', (_: any, e: any) => ({ text: e.text }))
  const text = `# claudeMd\nThe user files name ${CANARY}.\n\n# veilioGuard\n${MODEL_NOTE}\n\nThis is ambient context for the user.`
  const out: any = await $.prompt.attachment({ type: 'context_sections', text })
  expect(out.text).toContain(MODEL_NOTE)
  expect(out.text).not.toContain(CANARY)
  expect(out.text).toContain('The __VAR__249 __VAR__48 name __CLS__1.')
  expect(out.text).toContain('ambient context for the __VAR__249.')
})

test('a text that only resembles the note is masked as usual', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...MAP, __VAR__48: 'files' }) })
  on('prompt.attachment', (_: any, e: any) => ({ text: e.text }))
  const near = MODEL_NOTE.replace('Veilio guard is on', `${CANARY} guard is on`)
  const out: any = await $.prompt.attachment({ type: 'context_sections', text: near })
  expect(out.text).not.toContain(CANARY)
  expect(out.text).toContain('__VAR__48')
})

// Review of d18b5c5: cutting a text at a copy of the note let a secret or a
// name laid across a planted copy escape. The whole text is masked, secret
// scan included, with the note held as one opaque mark.
test('a secret laid across a planted copy of the note is still redacted', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  on('prompt.attachment', (_: any, e: any) => ({ text: e.text }))
  const text = `password = "Tr0ub${MODEL_NOTE}4dor3xzQ"`
  const out: any = await $.prompt.attachment({ type: 'context_sections', text })
  expect(out.text).not.toContain('Tr0ub')
  expect(out.text).not.toContain('4dor3xzQ')
  expect(out.text).toContain('__REDACTED_')
})

test('a name written against a planted copy of the note is still masked', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  on('prompt.attachment', (_: any, e: any) => ({ text: e.text }))
  const text = `${CANARY}${MODEL_NOTE}${CANARY}`
  const out: any = await $.prompt.attachment({ type: 'context_sections', text })
  expect(out.text).not.toContain(CANARY)
})

test("a skill's text holding a copy of the note is masked in full", async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...MAP, __STR__28: 'Veilio' }) })
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  const out: any = await $.skill.prompt({ skill: 'review', text: MODEL_NOTE })
  expect(out.text).toContain('__STR__28')
})

test('a reminder holding a copy of the note is masked in full', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...MAP, __STR__28: 'Veilio' }) })
  on('prompt.attachment', (_: any, e: any) => ({ text: e.text }))
  const out: any = await $.prompt.attachment({ type: 'edited_text_file', text: MODEL_NOTE })
  expect(out.text).toContain('__STR__28')
})

test('a secret a rule only partly took is redacted whole in a reminder', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  on('prompt.attachment', (_: any, e: any) => ({ text: e.text }))
  // 41 characters; the AWS rule takes 40, and the last one was left beside its token.
  const text = 'aws_secret_access_key = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY123"'
  const out: any = await $.prompt.attachment({ type: 'edited_text_file', text })
  expect(out.text).toMatch(/= "__REDACTED_[A-Z_]+_\d+__"$/)
})

// Second review of 1a48240: secrets are judged on the text as written, before
// names are replaced, so a credential whose key is a project name is caught.
test('a typed password under a key that is a project name is redacted', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ ...MAP, __VAR__4: 'db_password' }) })
  const sent: any[] = []
  on('prompt.submit', (_: any, e: any) => {
    sent.push(e)
    return { text: e.text }
  })
  await $.prompt.submit({
    ...recordedPrompt('prompt.submit').e,
    text: 'Why does db_password = "Xk9!mQ2vLp7" fail?',
  })
  expect(sent[0].text).not.toContain('Xk9!mQ2vLp7')
  expect(sent[0].text).toContain('__VAR__4')
})

test("an earlier build's context type carries the note as written too", async ($, on) => {
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({ ...MAP, __STR__28: 'Veilio', __VAR__249: 'user' }),
  })
  on('prompt.attachment', (_: any, e: any) => ({ text: e.text }))
  const text = `# gitStatus\nbranch of the user: ${CANARY}\n\n# veilioGuard\n${MODEL_NOTE}`
  const out: any = await $.prompt.attachment({ type: 'session_context', text })
  expect(out.text).toContain(MODEL_NOTE)
  expect(out.text).toContain('branch of the __VAR__249: __CLS__1')
})

test('a credential with its key in the context is removed from the typed prompt too', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  const sent: any[] = []
  on('prompt.submit', (_: any, e: any) => {
    sent.push(e)
    return { text: e.text, context: e.context }
  })
  await $.prompt.submit({
    ...recordedPrompt('prompt.submit').e,
    text: 'use xk9mq2vlp7rz on staging',
    context: ['DB_PASSWORD = "xk9mq2vlp7rz"'],
  })
  expect(JSON.stringify(sent)).not.toContain('xk9mq2vlp7rz')
})

test('a credential with its key in one context block is removed from the others', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(MAP) })
  on('prompt.context', () => ({
    blocks: [
      { name: 'claudeMd', text: 'DB_PASSWORD = "xk9mq2vlp7rz"' },
      { name: 'gitStatus', text: 'last commit: rotate xk9mq2vlp7rz' },
    ],
  }))
  const out: any = await $.prompt.context(recordedPrompt('prompt.context').e)
  expect(JSON.stringify(out.blocks)).not.toContain('xk9mq2vlp7rz')
})
