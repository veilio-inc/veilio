// Spec 033 US3 (this delivery's part): a team map pulled by the CLI is used as
// it is, and a guard the organisation runs cannot be switched off here.
import { expect, test } from 'claude-code/testing'
import { CANARY, eventOf, mapFile, project, recorded, ROOT, res } from './helpers.ts'

const TEAM = mapFile(
  { __CLS__14: CANARY },
  {
    remote: {
      id: 'team-map-1',
      updatedAt: '2026-10-01T10:00:00.000Z',
      pulledAt: '2026-10-03T09:00:00.000Z',
    },
  }
)

test("a pulled team map's placeholders are the ones the model sees, and its origin is kept on save", async ($, on) => {
  const read = recorded('Read')
  const p = project(on, { [`${ROOT}/.veilio/map.json`]: TEAM })
  on('tool.call', () => read.r)
  const out = await $.tool.call(eventOf(read))
  expect(res(out).file.content).toContain('__CLS__14')
  const saved = JSON.parse(p.files[`${ROOT}/.veilio/map.json`])
  expect(saved.remote).toEqual(JSON.parse(TEAM).remote)
  expect(saved.map.__CLS__14).toBe(CANARY)
})

test('/veilio says when the organisation runs the guard, and refuses to switch it off', async ($, on) => {
  const p = project(
    on,
    { [`${ROOT}/.veilio/map.json`]: TEAM },
    { policy: { prependPlugins: ['veilio-guard@acme-tools'] } }
  )
  const status = await $.command.run({ command: 'veilio', args: '' })
  expect(status.text).toContain("by your organisation's managed settings")
  const off = await $.command.run({ command: 'veilio', args: 'off' })
  expect(off.text).toContain("can't be switched off here")
  expect(p.files[`${ROOT}/.veilio/guard.json`]).toBeUndefined()
})

test("a project's guard.json cannot switch off the organisation's guard", async ($, on) => {
  const read = recorded('Read')
  project(
    on,
    { [`${ROOT}/.veilio/guard.json`]: JSON.stringify({ enabled: false }) },
    { policy: { prependPlugins: ['veilio-guard@acme-tools'] } }
  )
  on('tool.call', () => read.r)
  const out = await $.tool.call(eventOf(read))
  expect(JSON.stringify(out)).not.toContain(CANARY)
})

// Spec 085 part 3, R2-19 (security audit run-2): a failed read of the
// organisation's policy counted as "not managed", so /veilio off or an off
// record switched the organisation's guard off. Unknown is treated as managed.
const POLICY_UNREAD =
  "Veilio couldn't read your organisation's managed settings, so it stays on. It can't be switched off here until they can be read."

test('R2-19: with the policy unreadable, /veilio off is refused and the guard stays on', async ($, on) => {
  const read = recorded('Read')
  project(on, { [`${ROOT}/.veilio/map.json`]: TEAM }, { failPolicy: true, home: '/home/dev' })
  on('tool.call', () => read.r)
  const off = await $.command.run({ command: 'veilio', args: 'off' })
  expect(off.text).toBe(POLICY_UNREAD)
  const out = await $.tool.call(eventOf(read))
  expect(JSON.stringify(out)).not.toContain(CANARY)
})

test('R2-19: with the policy unreadable, an off record is ignored', async ($, on) => {
  const read = recorded('Read')
  const state = { version: 1, projects: { [ROOT]: { enabled: false, changedAt: '2026-11-07' } } }
  project(
    on,
    {
      [`${ROOT}/.veilio/map.json`]: TEAM,
      '/home/dev/.veilio/guard-state.json': JSON.stringify(state),
    },
    { failPolicy: true, home: '/home/dev' }
  )
  on('tool.call', () => read.r)
  const out = await $.tool.call(eventOf(read))
  expect(JSON.stringify(out)).not.toContain(CANARY)
})

test('R2-19: a policy that reads as not managed still lets /veilio off work', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: TEAM }, { home: '/home/dev' })
  const off = await $.command.run({ command: 'veilio', args: 'off' })
  expect(off.text).toContain('OFF for this project')
})
