// Spec 033 US3 (this delivery's part): a team map pulled by the CLI is used as
// it is, and a guard the organisation runs cannot be switched off here.
import { expect, test } from 'claude-code/testing'
import { CANARY, eventOf, mapFile, project, recorded, ROOT } from './helpers.ts'

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
  const out: any = await $.tool.call(eventOf(read))
  expect(out.result.file.content).toContain('__CLS__14')
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
  const status: any = await $.command.run({ command: 'veilio', args: '' })
  expect(status.text).toContain("by your organisation's managed settings")
  const off: any = await $.command.run({ command: 'veilio', args: 'off' })
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
  const out: any = await $.tool.call(eventOf(read))
  expect(JSON.stringify(out)).not.toContain(CANARY)
})
