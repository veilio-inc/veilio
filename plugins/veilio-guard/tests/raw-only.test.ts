// Spec 033 FR-004: files that must never reach the model are refused before
// the tool runs, whatever spelling reaches them.
import { expect, test } from 'claude-code/testing'
import { mapFile, project, ROOT, STRIPE, res } from './helpers.ts'
import type { Fields } from './fixtures/recorded.ts'

const ENV = { [`${ROOT}/.env`]: `STRIPE_SECRET_KEY=${STRIPE}\n` }

for (const path of [
  `${ROOT}/.env`,
  'config/.env.local',
  `${ROOT}/keys/id_rsa`,
  `${ROOT}/.veilio/map.json`,
  `${ROOT}/.git-credentials`,
  `${ROOT}/deploy/kubeconfig`,
  `${ROOT}/.docker/config.json`,
  `${ROOT}/.kube/config`,
  '/home/dev/.aws/credentials',
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
    const out = await $.tool.call({ tool: 'Read', file_path: path })
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
  const out = await $.tool.call({
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
  const out = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/__STR__1` })
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
  const out = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes.txt` })
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
  const out = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/secrets/prod.yaml` })
  expect(ran).toBe(false)
  expect(out.deny).toContain('away from the model')
})

test('a search over the project drops the lines and files of raw-only files', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/guard.json`]: JSON.stringify({ rawOnly: ['secrets/**'] }) })
  on('tool.call', (_, e) => {
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
          '.env:1:DB_PASSWORD=hunter2\nsrc/a.ts:3:if (password) check()\nsecrets/prod.yaml:2:password: hunter2',
        numLines: 3,
      },
    }
  })
  const content = await $.tool.call({
    tool: 'Grep',
    pattern: 'password',
    glob: '.env*',
    output_mode: 'content',
  })
  const files = await $.tool.call({
    tool: 'Grep',
    pattern: 'password',
    output_mode: 'files_with_matches',
  })
  const glob = await $.tool.call({ tool: 'Glob', pattern: '**/*' })
  expect(res(content).content).toBe('src/a.ts:3:if (password) check()')
  expect(JSON.stringify(content)).not.toContain('hunter2')
  expect(res(files).filenames).toEqual(['src/a.ts'])
  expect(res(glob).filenames).toEqual(['src/a.ts'])
})

test('an MCP tool asked for a raw-only file is refused before it runs', async ($, on) => {
  project(on, {})
  const seen: Fields[] = []
  on('tool.call', (_, e) => {
    seen.push(e)
    return { result: [{ type: 'text', text: 'ok' }] }
  })
  const a = await $.tool.call({ tool: 'mcp__filesystem__read_file', path: `${ROOT}/.env` })
  const b = await $.tool.call({
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
  const seen: Fields[] = []
  on('tool.call', (_, e) => {
    seen.push(e)
    return { result: [{ type: 'text', text: 'ok' }] }
  })
  const a = await $.tool.call({
    tool: 'Agent',
    prompt: 'look at config/.env.local please',
    description: 'x',
  })
  const b = await $.tool.call({
    tool: 'mcp__github__create_issue',
    title: 't',
    body: 'the config/.env.production file is stale',
  })
  expect(a.deny).toBeUndefined()
  expect(b.deny).toBeUndefined()
  expect(seen.length).toBe(2)
})

// Spec 078 US3 (A#4, research R4): `..` is resolved before the raw-only
// check, and a cd or pushd toward a raw-only directory is refused, so no later
// command - in the same call or the next - can read it by a short name.
const CD = (dir: string) =>
  `Veilio keeps \`${dir}\` away from the model, and a cd there would let a later command read it. Name the files you need by their full path, or ask the user.`
const SECRETS = { [`${ROOT}/.veilio/guard.json`]: JSON.stringify({ rawOnly: ['secrets/**'] }) }

const CD_REFUSED: [string, string][] = [
  ['cd .kube; cat config', '.kube'],
  ['cd ~/.aws && cat credentials', '~/.aws'],
  ['pushd .veilio && cat map.json', '.veilio'],
  ['cd secrets && cat db.txt', 'secrets'],
  ["cd .veilio && printf '{}' > guard.json", '.veilio'],
  ['cd .aws', '.aws'],
  ['cd ~/.config && cat gcloud/credentials.db', '~/.config'],
  ['cd .docker', '.docker'],
  ['pushd .kube', '.kube'],
  ['cd ./secrets/', './secrets/'],
  ['cd x && cd ../.veilio', '../.veilio'],
  ['ls; cd .azure/profiles', '.azure/profiles'],
  ['ls & cd .aws', '.aws'],
  ['ls\ncd .aws', '.aws'],
  ['(cd .aws && ls)', '.aws'],
  ['cd -P .aws', '.aws'],
  ['cd /home/dev/.config/gcloud', '/home/dev/.config/gcloud'],
]
test('a cd or pushd toward a raw-only directory is refused, wherever it stands in the command', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on('tool.call', (_, e) => {
    seen.push(e)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  for (const [command, dir] of CD_REFUSED) {
    const out = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(`${JSON.stringify(command)} -> ${out.deny}`).toBe(
      `${JSON.stringify(command)} -> ${CD(dir)}`
    )
  }
  expect(seen.length).toBe(0)
})

test('the two-call form: the cd is refused, so the next short name cannot inherit it', async ($, on) => {
  project(on, {})
  const seen: Fields[] = []
  on('tool.call', (_, e) => {
    seen.push(e)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  const first = await $.tool.call({ tool: 'Bash', command: 'cd .aws', description: 'x' })
  expect(first.deny).toBe(CD('.aws'))
  expect(seen.length).toBe(0)
})

for (const command of ['cd packages/cli && npm test', 'cd src', 'cd ..', 'cd ~', 'cd', 'cd -'])
  test(`an ordinary cd still runs: ${command}`, async ($, on) => {
    project(on, SECRETS)
    let ran = false
    on('tool.call', () => {
      ran = true
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })
    const out = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(out.deny).toBeUndefined()
    expect(ran).toBe(true)
  })

for (const command of [
  'cat .aws/sso/../credentials',
  'cat a/../.aws/credentials',
  'cat ./.kube/./config',
  'cat src/../.veilio/./map.json',
])
  test(`a path with . or .. is checked as resolved too: ${command}`, async ($, on) => {
    project(on, {})
    let ran = false
    on('tool.call', () => {
      ran = true
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })
    const out = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(ran).toBe(false)
    expect(out.deny).toContain('away from the model')
  })

test('a Read of a path with .. that resolves to a raw-only file is refused', async ($, on) => {
  project(on, {})
  let ran = false
  on('tool.call', () => {
    ran = true
    return { result: 'x' }
  })
  const out = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/.aws/sso/../credentials` })
  expect(ran).toBe(false)
  expect(out.deny).toContain('away from the model')
})

// Security review of the MCP raw-only refusal (the same gap in the guard's
// file tools): NTFS streams, trailing dots and 8.3 short names.
test('a Read of a Windows spelling of a raw-only file is refused', async ($, on) => {
  project(on, ENV)
  let ran = false
  on('tool.call', () => {
    ran = true
    return { result: 'x' }
  })
  for (const path of [
    '.env::$DATA',
    '.env:x',
    '.env.',
    'ENV~1',
    'C:\\work\\project\\.env::$DATA',
  ]) {
    const out = await $.tool.call({ tool: 'Read', file_path: path })
    expect(`${path} -> ${out.deny}`).toContain('away from the model')
  }
  expect(ran).toBe(false)
})
