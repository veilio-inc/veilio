// Spec 063 US1: the guard numbers new names inside the block of team numbers
// the CLI reserved for this member (.veilio/reserved.json), without a request.
// In spec 061's benchmark every member's guard numbered from the same pulled
// map, so two members gave one placeholder two meanings and 93 of 128
// publishes were refused.
import { expect, test } from 'claude-code/testing'
import { eventOf, mapFile, project, recorded, res, ROOT } from './helpers.ts'

const reservedFile = (blocks: Record<string, { start: number; end: number }>) =>
  JSON.stringify({
    version: 1,
    instance: 'https://veilio.test',
    account: 'me@example.test',
    teamId: 'team-1',
    blocks,
  })
const BLOCKS = {
  __CLS__: { start: 5001, end: 5500 },
  __FN__: { start: 7001, end: 7500 },
  __VAR__: { start: 9001, end: 9500 },
}

const numbersOf = (text: string, base: string): number[] =>
  [...text.matchAll(new RegExp(`${base}(\\d+)`, 'g'))].map((m) => Number(m[1]))

test('new names are numbered inside the member’s blocks', async ($, on) => {
  const read = recorded('Read')
  const p = project(on, { [`${ROOT}/.veilio/reserved.json`]: reservedFile(BLOCKS) })
  on('tool.call', () => read.r)
  const content = res(await $.tool.call(eventOf(read))).file.content as string
  for (const [base, b] of Object.entries(BLOCKS))
    for (const n of numbersOf(content, base)) {
      expect(n).toBeGreaterThanOrEqual(b.start)
      expect(n).toBeLessThanOrEqual(b.end)
    }
  expect(
    numbersOf(content, '__CLS__').length + numbersOf(content, '__FN__').length
  ).toBeGreaterThan(0)
  // The block is what the map holds now, and the file the CLI wrote is left alone.
  const saved = JSON.parse(p.files[`${ROOT}/.veilio/map.json`]).map as Record<string, string>
  expect(
    Object.keys(saved).every(
      (ph) => !/^__(CLS|FN|VAR)__\d+$/.test(ph) || Number(ph.match(/\d+$/)![0]) >= 5001
    )
  ).toBe(true)
  expect(p.files[`${ROOT}/.veilio/reserved.json`]).toBe(reservedFile(BLOCKS))
})

test('without a block, numbering is as it always was (signed out, Community Edition)', async ($, on) => {
  const read = recorded('Read')
  project(on, {})
  on('tool.call', () => read.r)
  const content = res(await $.tool.call(eventOf(read))).file.content as string
  expect(Math.max(...numbersOf(content, '__CLS__'), ...numbersOf(content, '__FN__'))).toBeLessThan(
    1000
  )
})

test('a block under a number the map already holds is not used: local numbering, and the band says so', async ($, on) => {
  const read = recorded('Read')
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({
      __CLS__6000: 'SomeoneElsesClass',
      __FN__8000: 'someoneElses',
    }),
    [`${ROOT}/.veilio/reserved.json`]: reservedFile(BLOCKS),
  })
  on('tool.call', () => read.r)
  const content = res(await $.tool.call(eventOf(read))).file.content as string
  const cls = numbersOf(content, '__CLS__').filter((n) => n !== 6000)
  expect(cls.every((n) => n > 6000)).toBe(true)
  const status = await $.command.run({ command: 'veilio', args: '' })
  expect(status.text).toMatch(/outside reserved team numbers/)
  expect(status.text).toMatch(/veilio maps pull/)
})

test('the band says how many reserved numbers are left', async ($, on) => {
  project(on, {
    [`${ROOT}/.veilio/reserved.json`]: reservedFile({ __CLS__: { start: 5001, end: 5500 } }),
  })
  const status = await $.command.run({ command: 'veilio', args: '' })
  expect(status.text).toMatch(/team numbers: 500 left/)
})

test('a malformed reservation file is not numbered from: local numbering, and the band says why', async ($, on) => {
  const read = recorded('Read')
  project(on, { [`${ROOT}/.veilio/reserved.json`]: '{"version": 2}' })
  on('tool.call', () => read.r)
  const content = res(await $.tool.call(eventOf(read))).file.content as string
  expect(Math.max(...numbersOf(content, '__CLS__'), ...numbersOf(content, '__FN__'))).toBeLessThan(
    1000
  )
  const status = await $.command.run({ command: 'veilio', args: '' })
  expect(status.text).toMatch(/reserved\.json/)
})
