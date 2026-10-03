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

test('a search over the project drops the lines and files of raw-only files', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/guard.json`]: JSON.stringify({ rawOnly: ['secrets/**'] }) })
  on('tool.call', (_: any, e: any) => {
    if (e.tool === 'Glob')
      return {
        result: {
          filenames: ['.env', 'src/a.ts', 'secrets/prod.yaml'],
          durationMs: 1,
          numFiles: 3,
          truncated: false,
        },
      }
    if (e.output_mode === 'files_with_matches') {
      return {
        result: { mode: 'files_with_matches', filenames: ['.env', 'src/a.ts'], numFiles: 2 },
      }
    }
    return {
      result: {
        mode: 'content',
        numFiles: 0,
        filenames: [],
        content:
          '.env:1:DB_PASSWORD=hunter2\nsrc/a.ts:3:const password = read()\nsecrets/prod.yaml:2:password: hunter2',
        numLines: 3,
      },
    }
  })
  const content: any = await $.tool.call({
    tool: 'Grep',
    pattern: 'password',
    glob: '.env*',
    output_mode: 'content',
  })
  const files: any = await $.tool.call({
    tool: 'Grep',
    pattern: 'password',
    output_mode: 'files_with_matches',
  })
  const glob: any = await $.tool.call({ tool: 'Glob', pattern: '**/*' })
  expect(content.result.content).toBe('src/a.ts:3:const password = read()')
  expect(JSON.stringify(content)).not.toContain('hunter2')
  expect(files.result.filenames).toEqual(['src/a.ts'])
  expect(glob.result.filenames).toEqual(['src/a.ts'])
})

test('an MCP tool asked for a raw-only file is refused before it runs', async ($, on) => {
  project(on, {})
  const seen: any[] = []
  on('tool.call', (_: any, e: any) => {
    seen.push(e)
    return { result: [{ type: 'text', text: 'ok' }] }
  })
  const a: any = await $.tool.call({ tool: 'mcp__filesystem__read_file', path: `${ROOT}/.env` })
  const b: any = await $.tool.call({
    tool: 'mcp__filesystem__read_file',
    path: '.veilio/guard.json',
  })
  await $.tool.call({
    tool: 'mcp__github__create_issue',
    title: 'see the .env docs',
    body: 'the .env file',
  })
  expect(a.deny).toContain('away from the model')
  expect(b.deny).toContain('away from the model')
  expect(seen.length).toBe(1)
  expect(seen[0].tool).toBe('mcp__github__create_issue')
})

test('prose that mentions a raw-only file is not a path: a subagent prompt or an issue body runs', async ($, on) => {
  project(on, {})
  const seen: any[] = []
  on('tool.call', (_: any, e: any) => {
    seen.push(e)
    return { result: [{ type: 'text', text: 'ok' }] }
  })
  const a: any = await $.tool.call({
    tool: 'Agent',
    prompt: 'look at config/.env.local please',
    description: 'x',
  })
  const b: any = await $.tool.call({
    tool: 'mcp__github__create_issue',
    title: 't',
    body: 'the config/.env.production file is stale',
  })
  expect(a.deny).toBeUndefined()
  expect(b.deny).toBeUndefined()
  expect(seen.length).toBe(2)
})
