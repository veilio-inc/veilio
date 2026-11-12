// /veilio off lasts for the session and is held in memory: nothing about on or
// off is stored on disk, so no file the agent writes can switch the guard off,
// and every new session starts on (security audit 2026-11-11, H1).
import { expect, test } from 'claude-code/testing'
import { CANARY, eventOf, mapFile, project, recorded, ROOT } from './helpers.ts'

const HOME = '/home/dev'
const STATE = `${HOME}/.veilio/guard-state.json`
const SECRET_FILE = `${HOME}/.veilio/guard-secret`
const MAP = { [`${ROOT}/.veilio/map.json`]: mapFile({}) }
const LEGACY = JSON.stringify({
  version: 1,
  projects: { [ROOT]: { enabled: false, changedAt: '2026-11-07', mac: 'ab'.repeat(32) } },
})

test('/veilio off holds for the session: later results reach the model as they are', async ($, on) => {
  const read = recorded('Read')
  project(on, MAP, { home: HOME })
  on('tool.call', () => read.r)
  await $.command.run({ command: 'veilio', args: 'off' })
  expect(JSON.stringify(await $.tool.call(eventOf(read)))).toContain(CANARY)
  const status = await $.command.run({ command: 'veilio', args: '' })
  expect(status.text.split('\n')[0]).toBe(
    'Veilio guard OFF until this session ends: Claude reads raw code. /veilio on'
  )
})

test('/veilio off writes nothing to disk', async ($, on) => {
  const p = project(on, MAP, { home: HOME })
  await $.command.run({ command: 'veilio', args: 'off' })
  expect(p.files[STATE]).toBeUndefined()
  expect(p.files[SECRET_FILE]).toBeUndefined()
  expect(p.writes.filter((w) => w.path.startsWith(`${HOME}/.veilio/`))).toEqual([])
})

test('/veilio on after /veilio off is on again', async ($, on) => {
  const read = recorded('Read')
  project(on, MAP, { home: HOME })
  on('tool.call', () => read.r)
  await $.command.run({ command: 'veilio', args: 'off' })
  await $.command.run({ command: 'veilio', args: 'on' })
  expect(JSON.stringify(await $.tool.call(eventOf(read)))).not.toContain(CANARY)
})

test('an older version’s off record is not honoured, is removed, and the band says so', async ($, on) => {
  const read = recorded('Read')
  const p = project(on, { ...MAP, [STATE]: LEGACY, [SECRET_FILE]: 'ab'.repeat(32) }, { home: HOME })
  on('tool.call', () => read.r)
  expect(JSON.stringify(await $.tool.call(eventOf(read)))).not.toContain(CANARY)
  const band = (await $.command.run({ command: 'veilio', args: '' })).text.split('\n')[0]
  expect(band).toMatch(/^Veilio guard on/)
  expect(band).toContain(' · /veilio off now lasts for one session, so the guard is on')
  expect(p.files[STATE]).toBeUndefined()
  expect(p.files[SECRET_FILE]).toBeUndefined()
})

test('a guard-state.json of any content, or one that does not name this project, is removed without a note', async ($, on) => {
  const p = project(
    on,
    {
      ...MAP,
      [STATE]: JSON.stringify({ version: 1, projects: { '/work/other': { enabled: false } } }),
    },
    { home: HOME }
  )
  const band = (await $.command.run({ command: 'veilio', args: '' })).text.split('\n')[0]
  expect(band).not.toContain('lasts for one session')
  expect(p.files[STATE]).toBeUndefined()
})

test('a guard-state.json an agent wrote leaves the guard on', async ($, on) => {
  const read = recorded('Read')
  project(
    on,
    { ...MAP, [STATE]: JSON.stringify({ version: 1, projects: { [ROOT]: { enabled: false } } }) },
    { home: HOME }
  )
  on('tool.call', () => read.r)
  expect(JSON.stringify(await $.tool.call(eventOf(read)))).not.toContain(CANARY)
})

test('the managed install still refuses /veilio off', async ($, on) => {
  const read = recorded('Read')
  project(on, MAP, { home: HOME, policy: { prependPlugins: ['veilio-guard@veilio'] } })
  on('tool.call', () => read.r)
  const off = await $.command.run({ command: 'veilio', args: 'off' })
  expect(off.text).toContain("can't be switched off here")
  expect(JSON.stringify(await $.tool.call(eventOf(read)))).not.toContain(CANARY)
})

test('the session ending (a /clear included) puts the guard back on', async ($, on) => {
  const read = recorded('Read')
  project(on, MAP, { home: HOME })
  on('tool.call', () => read.r)
  on('session.end', () => ({ sessionId: 's1' }))
  await $.command.run({ command: 'veilio', args: 'off' })
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  expect(JSON.stringify(await $.tool.call(eventOf(read)))).not.toContain(CANARY)
})

test('on Windows an older record is removed with Remove-Item on a literal path, not through cmd', async ($, on) => {
  // A Windows home: the path given to Remove-Item is that path, literally.
  const home = 'C:\\Users\\dev'
  // The record, under either separator the host may hand the home back with.
  const states = [`${home}/.veilio/guard-state.json`, 'C:/Users/dev/.veilio/guard-state.json']
  const p = project(
    on,
    { ...MAP, ...Object.fromEntries(states.map((f) => [f, LEGACY])) },
    { home, windows: true }
  )
  const band = (await $.command.run({ command: 'veilio', args: '' })).text.split('\n')[0]
  expect(p.ops).toContain(
    "run powershell -NoProfile -Command Remove-Item -LiteralPath 'C:\\Users\\dev\\.veilio\\guard-state.json' -Force"
  )
  expect(p.ops.some((o) => o.includes('cmd'))).toBe(false)
  expect(Object.keys(p.files).filter((f) => f.includes('guard-state'))).toEqual([])
  expect(band).toContain('lasts for one session')
})

test('when the older record cannot be removed the guard is still on and the band stays silent', async ($, on) => {
  const read = recorded('Read')
  const p = project(on, { ...MAP, [STATE]: LEGACY }, { home: HOME, rmFails: true })
  on('tool.call', () => read.r)
  expect(JSON.stringify(await $.tool.call(eventOf(read)))).not.toContain(CANARY)
  const band = (await $.command.run({ command: 'veilio', args: '' })).text.split('\n')[0]
  expect(p.files[STATE]).toBeDefined()
  expect(band).not.toContain('lasts for one session')
})
