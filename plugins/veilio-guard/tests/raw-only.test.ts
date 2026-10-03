// Spec 033 FR-004: files that must never reach the model are refused before
// the tool runs, whatever spelling reaches them.
import { expect, test } from 'claude-code/testing'
import { mapFile, project, ROOT, STRIPE } from './helpers.ts'

const ENV = { [`${ROOT}/.env`]: `STRIPE_SECRET_KEY=${STRIPE}\n` }

for (const path of [
  `${ROOT}/.env`,
  'config/.env.local',
  `${ROOT}/keys/id_rsa`,
  `${ROOT}/.veilio/map.json`,
]) {
  test(`Read of ${path} is refused before it runs`, async ($, on) => {
    project(on, ENV)
    let ran = false
    on('tool.call', () => {
      ran = true
      return {
        result: {
          type: 'text',
          file: { filePath: path, content: STRIPE, numLines: 1, startLine: 1, totalLines: 1 },
        },
      }
    })
    const out: any = await $.tool.call({ tool: 'Read', file_path: path })
    expect(ran).toBe(false)
    expect(out.deny).toContain('away from the model')
    expect(JSON.stringify(out)).not.toContain(STRIPE)
  })
}

test('a shell command that names .env is refused', async ($, on) => {
  project(on, ENV)
  let ran = false
  on('tool.call', () => {
    ran = true
    return { result: { stdout: STRIPE, stderr: '' } }
  })
  const out: any = await $.tool.call({
    tool: 'Bash',
    command: 'cat .env | head -1',
    description: 'x',
  })
  expect(ran).toBe(false)
  expect(out.deny).toContain('.env')
})

test('a placeholder path that restores to a raw-only file is refused', async ($, on) => {
  project(on, { ...ENV, [`${ROOT}/.veilio/map.json`]: mapFile({ __STR__1: '.env' }) })
  let ran = false
  on('tool.call', () => {
    ran = true
    return { result: 'x' }
  })
  const out: any = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/__STR__1` })
  expect(ran).toBe(false)
  // The refusal shows the placeholder, not the name it stands for.
  expect(out.deny).toContain('__STR__1')
})

test('a link to .env under another name is refused', async ($, on) => {
  project(
    on,
    { ...ENV, [`${ROOT}/notes.txt`]: 'x' },
    { links: { [`${ROOT}/notes.txt`]: `${ROOT}/.env` } }
  )
  let ran = false
  on('tool.call', () => {
    ran = true
    return { result: 'x' }
  })
  const out: any = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes.txt` })
  expect(ran).toBe(false)
  expect(out.deny).toContain('away from the model')
})

test("a project's own pattern is refused too", async ($, on) => {
  project(on, { [`${ROOT}/.veilio/guard.json`]: JSON.stringify({ rawOnly: ['secrets/**'] }) })
  let ran = false
  on('tool.call', () => {
    ran = true
    return { result: 'x' }
  })
  const out: any = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/secrets/prod.yaml` })
  expect(ran).toBe(false)
  expect(out.deny).toContain('away from the model')
})
