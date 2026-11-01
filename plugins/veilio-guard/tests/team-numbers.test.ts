// Spec 063 US1: the guard numbers new names inside the block of team numbers
// the CLI reserved for this member (.veilio/reserved.json), without a request.
// In spec 061's benchmark every member's guard numbered from the same pulled
// map, so two members gave one placeholder two meanings and 93 of 128
// publishes were refused.
import { expect, test } from 'claude-code/testing'
import { eventOf, mapFile, project, recorded, recordedRaw, res, ROOT } from './helpers.ts'

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

// Security audit 2026-11-01 (round 4): a block is this member's alone, so a
// number above it - a teammate's, or planted - leaves it usable (was: every
// new name local, and the band said "outside reserved team numbers").
test('a block under a number the map already holds is still used', async ($, on) => {
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
  expect(cls.length).toBeGreaterThan(0)
  for (const n of cls) expect(n >= 5001 && n <= 5500, `__CLS__${n} outside the block`).toBe(true)
  expect(content).not.toMatch(/__LOCAL_[A-Z0-9]{6}_CLS__\d+/)
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

test('a planted reservation file cannot put control characters into the band', async ($, on) => {
  project(on, {
    [`${ROOT}/.veilio/reserved.json`]: JSON.stringify({
      version: 1,
      blocks: { '\u001b[2J\u001b[31mOWNED': { start: 1, end: 2 } },
    }),
  })
  const status = await $.command.run({ command: 'veilio', args: '' })
  expect(status.text).toMatch(/reserved\.json unreadable/)
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  expect(status.text).not.toMatch(/\u001b/)
})

// Security audit 2026-11-01 (round 4): a number above the block does not use
// it up (was: "no usable team numbers").
test('a number above the block leaves its numbers counted as left', async ($, on) => {
  project(on, {
    [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__6000: 'SomeoneElsesClass' }),
    [`${ROOT}/.veilio/reserved.json`]: reservedFile({ __CLS__: { start: 5001, end: 5500 } }),
  })
  const status = await $.command.run({ command: 'veilio', args: '' })
  expect(status.text).toMatch(/team numbers: 500 left/)
})

test('a distinctive name first seen in command output is numbered inside the block too (team bench, 2026-10-30)', async ($, on) => {
  // The guard masks shaped names it meets in output (maskShaped). That path
  // numbered above the map's highest - inside a teammate's block - and a
  // teammate's restore then named the teammate's own name.
  const bash = recordedRaw('Bash')
  project(on, { [`${ROOT}/.veilio/reserved.json`]: reservedFile(BLOCKS) })
  const r = bash.r as { result: Record<string, unknown> }
  on('tool.call', () => ({
    ...r,
    result: { ...r.result, stdout: 'FAIL QuaywardRebalancer: skerryHoldCount was 3' },
  }))
  const out = JSON.stringify(await $.tool.call(eventOf(bash)))
  expect(out).not.toContain('QuaywardRebalancer')
  for (const [base, b] of Object.entries(BLOCKS))
    for (const n of numbersOf(out, base)) {
      expect(n).toBeGreaterThanOrEqual(b.start)
      expect(n).toBeLessThanOrEqual(b.end)
    }
  expect(numbersOf(out, '__CLS__').length + numbersOf(out, '__VAR__').length).toBeGreaterThan(0)
})
