// Spec 033 contracts/mod.md: /veilio reports the state, and switches the guard
// off for this project only by name, with a warning that stays.
import { expect, test } from 'claude-code/testing'
import { CANARY, eventOf, mapFile, project, recorded, ROOT } from './helpers.ts'

test('/veilio reports state, the map and coverage', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }) })
  const out: any = await $.command.run({ command: 'veilio', args: '' })
  expect(out.text).toMatch(/Veilio guard on/)
  expect(out.text).toContain(`${ROOT}/.veilio/map.json (1 entries)`)
  expect(out.text).toContain('COVERAGE.md')
  expect(out.text).toContain('by you (personal)')
})

test('/veilio off: written for the project, and the next result reaches the model as it is', async ($, on) => {
  const read = recorded('Read')
  const p = project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({}) })
  on('tool.call', () => read.r)
  const out: any = await $.command.run({ command: 'veilio', args: 'off' })
  expect(out.text).toContain('OFF for this project')
  expect(JSON.parse(p.files[`${ROOT}/.veilio/guard.json`]).enabled).toBe(false)
  const r: any = await $.tool.call(eventOf(read))
  expect(JSON.stringify(r)).toContain(CANARY)
})

test('/veilio on: back on, and scrubbing again', async ($, on) => {
  const read = recorded('Read')
  project(on, { [`${ROOT}/.veilio/guard.json`]: JSON.stringify({ enabled: false }) })
  on('tool.call', () => read.r)
  await $.command.run({ command: 'veilio', args: 'on' })
  const r: any = await $.tool.call(eventOf(read))
  expect(JSON.stringify(r)).not.toContain(CANARY)
})

test("/veilio off and on keep the project's own lists in guard.json", async ($, on) => {
  const p = project(on, {
    [`${ROOT}/.veilio/guard.json`]: JSON.stringify({
      rawOnly: ['secrets/**'],
      mcpRestore: ['local_db'],
    }),
  })
  let ran = false
  on('tool.call', () => {
    ran = true
    return { result: 'x' }
  })
  await $.command.run({ command: 'veilio', args: 'off' })
  await $.command.run({ command: 'veilio', args: 'on' })
  const saved = JSON.parse(p.files[`${ROOT}/.veilio/guard.json`])
  expect(saved.rawOnly).toEqual(['secrets/**'])
  expect(saved.mcpRestore).toEqual(['local_db'])
  const out: any = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/secrets/prod.yaml` })
  expect(ran).toBe(false)
  expect(out.deny).toContain('away from the model')
})
