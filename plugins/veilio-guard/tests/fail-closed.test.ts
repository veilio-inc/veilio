// Spec 033 US2: when the guard cannot do its job, nothing unscrubbed reaches
// the model, and the developer is told why. A timeout takes the same .catch
// path as a throw (next.error.kind is 'timeout'); the kit cannot force one
// without a ten-second busy loop, so COVERAGE.md states it without a test.
import { expect, test } from 'claude-code/testing'
import { CANARY, eventOf, mapFile, project, recorded, ROOT, STRIPE } from './helpers.ts'

test('a scrub that throws after the tool ran withholds the result', async ($, on) => {
  // Saving the new names fails after the Read ran: the hook throws past next.
  const read = recorded('Read')
  project(on, {}, { failWrite: (p) => p.endsWith('map.json') })
  on('tool.call', () => read.r)
  const out: any = await $.tool.call(eventOf(read))
  expect(out.deny).toContain('Veilio withheld this result: the guard failed')
  expect(JSON.stringify(out)).not.toContain(CANARY)
})

test('a guard that cannot load refuses the call before it runs', async ($, on) => {
  const read = recorded('Read')
  project(
    on,
    { [`${ROOT}/.veilio/map.json`]: mapFile({}) },
    { failRead: (p) => p.endsWith('map.json') }
  )
  let ran = false
  on('tool.call', () => {
    ran = true
    return read.r
  })
  const out: any = await $.tool.call(eventOf(read))
  expect(ran).toBe(false)
  expect(out.deny).toContain('Veilio withheld')
})

test('a prompt the guard cannot check is not sent', async ($, on) => {
  project(
    on,
    { [`${ROOT}/.veilio/map.json`]: mapFile({}) },
    { failRead: (p) => p.endsWith('map.json') }
  )
  let sent = false
  on('prompt.submit', (_: any, e: any) => {
    sent = true
    return { text: e.text }
  })
  const out: any = await $.prompt.submit({
    text: `about ${CANARY}`,
    wait: false,
    origin: { kind: 'user' },
  })
  expect(sent).toBe(false)
  expect(out.drop).toContain('not sent')
})

test('a reminder the guard cannot check is left out', async ($, on) => {
  project(
    on,
    { [`${ROOT}/.veilio/map.json`]: mapFile({}) },
    { failRead: (p) => p.endsWith('map.json') }
  )
  on('prompt.attachment', (_: any, e: any) => ({ text: e.text }))
  const out: any = await $.prompt.attachment({ type: 'edited_text_file', text: CANARY })
  expect(out.text).toBe(null)
})

test('an unreadable map stops the guard: every call refused, prompts dropped, until it is fixed', async ($, on) => {
  const read = recorded('Read')
  project(on, { [`${ROOT}/.veilio/map.json`]: '{ not json' })
  let ran = false
  on('tool.call', () => {
    ran = true
    return read.r
  })
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  const out: any = await $.tool.call(eventOf(read))
  expect(ran).toBe(false)
  expect(out.deny).toContain('map at .veilio/map.json could not be read')
  const dropped: any = await $.prompt.submit({
    text: 'hello',
    wait: false,
    origin: { kind: 'user' },
  })
  expect(dropped.drop).toContain('stopped')
})

test('a map of an unknown version stops the guard rather than being read as empty', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: JSON.stringify({ version: 2, map: {} }) })
  on('tool.call', () => ({ result: 'x' }))
  const out: any = await $.tool.call({ tool: 'Bash', command: 'ls', description: 'x' })
  expect(out.deny).toContain('version')
})

test('a missing map is created on the first new name', async ($, on) => {
  const read = recorded('Read')
  const p = project(on)
  on('tool.call', () => read.r)
  await $.tool.call(eventOf(read))
  expect(p.files[`${ROOT}/.veilio/map.json`]).toContain(CANARY)
})

test('fields a tool list does not name are scrubbed too: a Bash edit diff', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }) })
  on('tool.call', () => ({
    ...bash.r,
    result: { ...bash.r.result, bashEditDiff: `- class ${CANARY} {` },
  }))
  const out: any = await $.tool.call(eventOf(bash))
  expect(out.result.bashEditDiff).toBe('- class __CLS__1 {')
})

test('a secret left where the guard does not rewrite (an enum field) is caught by the last scan', async ($, on) => {
  const bash = recorded('Bash')
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({}) })
  on('tool.call', () => ({ ...bash.r, result: { ...bash.r.result, gitOperation: STRIPE } }))
  const out: any = await $.tool.call(eventOf(bash))
  expect(out.deny).toContain('a secret remained after masking')
  expect(JSON.stringify(out)).not.toContain(STRIPE)
})

test('another writer giving our placeholder a different name: masked again, never two names', async ($, on) => {
  const read = recorded('Read')
  const mapPath = `${ROOT}/.veilio/map.json`
  // Between the guard loading (no map yet) and saving, another program writes
  // a map whose __CLS__1 is a different class.
  const p = project(
    on,
    {},
    {
      inject: { path: mapPath, beforeExistsCall: 2, text: mapFile({ __CLS__1: 'OtherClass' }) },
    }
  )
  on('tool.call', () => read.r)
  const out: any = await $.tool.call(eventOf(read))
  const saved = JSON.parse(p.files[mapPath]).map
  expect(saved.__CLS__1).toBe('OtherClass')
  const mine = Object.keys(saved).find((k) => saved[k] === CANARY)!
  expect(mine).toBe('__CLS__2')
  expect(out.result.file.content).toContain('__CLS__2')
  expect(out.result.file.content).not.toContain('__CLS__1')
})
