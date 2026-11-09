// Spec 033 FR-004: files that must never reach the model are refused before
// the tool runs, whatever spelling reaches them.
import { expect, test } from 'claude-code/testing'
import { CANARY, mapFile, project, ROOT, STRIPE, res } from './helpers.ts'
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

// Spec 085 handover H17 (lead L17): a word after a cd is a path in the
// directory the cd moved to, in the same call and in the next one.
const SUB = { [`${ROOT}/sub/notes`]: '', [`${ROOT}/.env`]: 'DB_HOST=db.example.invalid\n' }
test('H17: cd sub && cat notes is refused when sub/notes is a link to .env', async ($, on) => {
  project(on, SUB, { links: { [`${ROOT}/sub/notes`]: `${ROOT}/.env` } })
  let ran = false
  on(
    'tool.call',
    () => ((ran = true), { result: { stdout: 'DB_HOST=db.example.invalid', stderr: '' } })
  )
  const out = await $.tool.call({ tool: 'Bash', command: 'cd sub && cat notes', description: 'x' })
  expect(out.deny).toContain('away from the model')
  expect(ran).toBe(false)
})

test('H17: after cd sub in one call, cat notes in the next is refused', async ($, on) => {
  project(on, SUB, { links: { [`${ROOT}/sub/notes`]: `${ROOT}/.env` } })
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  const first = await $.tool.call({ tool: 'Bash', command: 'cd sub', description: 'x' })
  expect(first.deny).toBeUndefined()
  const out = await $.tool.call({ tool: 'Bash', command: 'cat notes', description: 'x' })
  expect(out.deny).toContain('away from the model')
  expect(seen).toHaveLength(1)
})

// Spec 085 L17, what 078's H17 tests leave: a plain file after a cd still
// runs, and a cd outside the project is followed too (078 follows the shell
// anywhere, which refuses more than research R2b's "inside the root").
test('L17: after cd sub, cat readme.md (a plain file) runs', async ($, on) => {
  project(
    on,
    { ...SUB, [`${ROOT}/sub/readme.md`]: '# notes\n' },
    { links: { [`${ROOT}/sub/notes`]: `${ROOT}/.env` } }
  )
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  await $.tool.call({ tool: 'Bash', command: 'cd sub', description: 'x' })
  const out = await $.tool.call({ tool: 'Bash', command: 'cat readme.md', description: 'x' })
  expect(out.deny).toBeUndefined()
  const same = await $.tool.call({
    tool: 'Bash',
    command: 'cd sub && cat readme.md',
    description: 'x',
  })
  expect(same.deny).toBeUndefined()
  expect(seen).toHaveLength(3)
})

test('L17: after a cd outside the project, a link there to .env is still refused', async ($, on) => {
  project(on, { ...SUB, '/outside/notes': '' }, { links: { '/outside/notes': `${ROOT}/.env` } })
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  await $.tool.call({ tool: 'Bash', command: 'cd /outside', description: 'x' })
  const out = await $.tool.call({ tool: 'Bash', command: 'cat notes', description: 'x' })
  expect(out.deny).toContain('away from the model')
  expect(seen).toHaveLength(1)
})

// Review round 1 (T030) #9: a cd hidden from the chain split - a glob, a
// command substitution, backticks, a nested shell or eval - and (d) a Windows
// short name in a shell word.
for (const command of [
  'cd .a*s && cat credentials',
  'echo $(cd .aws && cat credentials)',
  'echo `cd .aws; cat credentials`',
  "bash -c 'cd .aws && cat credentials'",
  'eval "cd .aws && cat credentials"',
  // A glob after the hidden cd: only the cd itself can be judged.
  "bash -c 'cd .aws && cat cred*'",
  // Review round 2 #4: a quoted target, and `--`, inside a nested shell.
  `bash -c 'cd ".aws" && cat credentials'`,
  `sh -c "cd '.aws' && cat credentials"`,
  "bash -c 'cd -- .aws && cat credentials'",
  // Review round 2 #5: a glob target of a real cd, however nested.
  "bash -c 'cd .a*s && cat credentials'",
  'echo "$(cd .a*s && cat credentials)"',
  // Security review of round 2: wrappers, a shell by its path, process
  // substitution and a nested subshell.
  "env bash -c 'cd .a*s && cat credentials'",
  "command bash -c 'cd .a*s && cat credentials'",
  "exec bash -c 'cd .a*s && cat credentials'",
  "/bin/bash -c 'cd .a*s && cat credentials'",
  "nohup /usr/bin/zsh -c 'cd .aws && cat credentials'",
  "xargs sh -c 'cd .a*s && cat credentials'",
  'cat <(cd .a*s && cat credentials)',
  'echo $( (cd .a*s && cat credentials) )',
  // Second security review of round 2: quoted text is read as text only for
  // grep, rg, echo and printf with nothing the shell expands.
  "sudo bash -c 'cd .aws && cat credentials'",
  "xargs sh -c 'cd .kube; cat config'",
  "find . -exec sh -c 'cd .aws && cat credentials' \\;",
  "$x -c 'cd .aws && cat credentials'",
  "/bin/ba?h -c 'cd .aws && cat credentials'",
  `python -c "import os; os.system('cd .aws && cat credentials')"`,
  "su -c 'cd .aws && cat credentials'",
  "watch 'cd .a*s && cat credentials'",
  "grep 'x\\' ; cd .a*s ; cat credentials",
  'grep -n x README.md\ncd .a*s && cat credentials',
  'echo "$x" "cd .a*s && cat credentials"',
  'git commit -m "ci: cd [skip ci]"',
  // Round 3 security review: text piped into a shell, and substitutions,
  // braces or redirections beside a text-only program.
  'echo "cd .aws && cat credentials" | sh',
  "printf 'cd .kube\\ncat config' | bash",
  'echo <(cd .aws; cat credentials)',
  'grep -h "cd .aws" notes.txt > >(sh)',
  'echo "cd .aws" | { sh; }',
  // Round 3, second security review: options that run a program, and any
  // option off the per-program list.
  'grep -h "cd .aws" notes.txt | sort --compress-program=sh',
  'rg --pre=sh "cd .aws" notes.txt',
  'rg --pre-glob "*" "cd .aws" notes.txt',
  'grep --include=x "cd .a*s" notes.txt',
  'grep -h "cd .a*s" notes.txt | sort',
])
  test(`a hidden cd or a short name is refused: ${command}`, async ($, on) => {
    project(on, {})
    let ran = false
    on('tool.call', () => ((ran = true), { result: { stdout: '', stderr: '' } }))
    const out = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(out.deny).toContain('away from the model')
    expect(ran).toBe(false)
  })

// Review round 2 #2: a short name is refused on Windows only.
test('on Windows a short name in a shell word is refused', async ($, on) => {
  project(on, {}, { windows: true })
  let ran = false
  on('tool.call', () => ((ran = true), { result: { stdout: '', stderr: '' } }))
  const out = await $.tool.call({ tool: 'Bash', command: 'cat ENV~1', description: 'x' })
  expect(out.deny).toContain('away from the model')
  expect(ran).toBe(false)
})

test('off Windows HEAD~1 and main~3 in a shell word run', async ($, on) => {
  project(on, {})
  const seen: string[] = []
  on('tool.call', (_, e) => (seen.push(String(e.command)), { result: { stdout: '', stderr: '' } }))
  for (const command of ['cat HEAD~1', 'ls main~3']) {
    const out = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(`${command} -> ${out.deny ?? 'ran'}`).toBe(`${command} -> ran`)
  }
  expect(seen).toEqual(['cat HEAD~1', 'ls main~3'])
})

// Review round 2 #5: a glob after the letters "cd" in quoted text is not a cd.
test('quoted text that holds "cd" and a glob is not read as a cd', async ($, on) => {
  project(on, {})
  const seen: string[] = []
  on('tool.call', (_, e) => (seen.push(String(e.command)), { result: { stdout: '', stderr: '' } }))
  const commands = [
    'grep -rn "cd *" scripts/',
    'echo "next: cd [the folder]"',
    'grep "cd x" notes.txt | wc -l',
    'grep -h "cd *" notes.txt | uniq -c | head -n 3',
    'grep -rniw -e "cd *" scripts/',
    'rg -n -t sh "cd *" scripts/',
    'echo -n "cd [x]" | wc -l',
    "printf 'cd *' | wc -c",
  ]
  for (const command of commands) {
    const out = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(`${command} -> ${out.deny ?? 'ran'}`).toBe(`${command} -> ran`)
  }
  expect(seen).toEqual(commands)
})

// Spec 085 L19: a kit Read of the audit's spellings, under the project root.
test('L19: a Read of .npmrc::$DATA, .npmrc. or .veilio::$INDEX_ALLOCATION/map.json is refused', async ($, on) => {
  project(on, { [`${ROOT}/.npmrc`]: 'registry=https://registry.example.invalid/\n' })
  let ran = false
  on('tool.call', () => ((ran = true), { result: 'x' }))
  for (const path of [
    `${ROOT}/.npmrc::$DATA`,
    `${ROOT}/.npmrc.`,
    `${ROOT}/.veilio::$INDEX_ALLOCATION/map.json`,
  ]) {
    const out = await $.tool.call({ tool: 'Read', file_path: path })
    expect(`${path} -> ${out.deny}`).toContain('away from the model')
  }
  expect(ran).toBe(false)
})

// ── spec 086: the cd read as the shell reads it ─────────────────────────────
// Each refusal pins its text (strings.md A1, A2, N1, N2). HOME is /home/dev,
// holding the cloud credentials the default raw-only list names.
const HOME = '/home/dev'
const A1 = (t: string) =>
  `Veilio keeps \`${t}\` away from the model, and a cd there would let a later command read it. Name the files you need by their full path, or ask the user.`
const A2 = (w: string) =>
  `Veilio keeps ${w} away from the model. Ask the user for what you need from it.`
const N1 = (t: string, form: string) =>
  `Veilio refused this call: Veilio cannot tell where \`${t}\` takes the shell (${form}), so a later command could read a file Veilio keeps away from the model. Use cd with a plain path, or name the files by their full path.`
const N2 =
  'Veilio refused this call: it sets HOME and names `~`, so Veilio cannot tell which files `~` stands for. Name the files by their full path, or ask the user.'
const HOME_FILES = {
  [`${HOME}/.kube/config`]: 'x\n',
  [`${HOME}/.aws/credentials`]: 'x\n',
  [`${HOME}/.config/gcloud/credentials.db`]: 'x\n',
  [`${HOME}/notes`]: '',
}
// `notes` is a link to .env in sub/, lib/deep/, HOME and /other/repo/sub/;
// a plain file at the root.
const TREE = {
  ...HOME_FILES,
  [`${ROOT}/.env`]: 'DB_HOST=db.example.invalid\n',
  [`${ROOT}/notes`]: 'plain\n',
  [`${ROOT}/sub/notes`]: '',
  [`${ROOT}/lib/deep/notes`]: '',
  ['/other/repo/.git']: 'gitdir: /elsewhere\n',
  ['/other/repo/notes']: '',
  ['/other/repo/sub/x']: '',
  ['/outside/x']: '',
}
const TREE_LINKS = {
  links: {
    [`${ROOT}/sub/notes`]: `${ROOT}/.env`,
    [`${ROOT}/lib/deep/notes`]: `${ROOT}/.env`,
    [`${HOME}/notes`]: `${ROOT}/.env`,
    ['/other/repo/notes']: `${ROOT}/.env`,
  },
  home: HOME,
}

/** Each command's refusal text, or undefined when it ran. */
async function verdicts(
  $: Parameters<Parameters<typeof test>[1]>[0],
  on: Parameters<Parameters<typeof test>[1]>[1],
  commands: readonly string[]
): Promise<(string | undefined)[]> {
  project(on, TREE, TREE_LINKS)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  const out: (string | undefined)[] = []
  for (const command of commands)
    out.push((await $.tool.call({ tool: 'Bash', command, description: 'x' })).deny)
  return out
}

// research.md R4: every form 085's review rounds reproduced (Bash; the
// PowerShell ones are in powershell.test.ts). `undefined`: runs, as on main
// (a wrapper that cannot move the shell, or a harmless one).
const ATTACKS: [string, string | undefined][] = [
  // Round 1 (S8)
  ['cd ~/.kub{e..e}', N1('~/.kub{e..e}', 'braces')],
  ['D=~/.kube; cd $D', N1('$D', 'a variable')],
  ['cd `printf .kube`', N1('`printf .kube`', 'a command substitution')],
  ['cd \\.kube', A1('.kube')],
  // Round 3 (#4): zsh's globs
  ['cd ~/.ku(b|x)e', N1('~/.ku(b|x)e', 'a glob')],
  ['cd ~/.kube(/)', N1('~/.kube(/)', 'a glob')],
  ['cd ~/.kub<->', N1('~/.kub<->', 'a glob')],
  ['cd ~/.k#ube', N1('~/.k#ube', 'a glob')],
  ['cd ~/.k@(u)be', N1('~/.k@(u)be', 'a glob')],
  ['cd ~/.kube~x', N1('~/.kube~x', 'a glob')],
  ['cd ~/.ku^xbe', N1('~/.ku^xbe', 'a glob')],
  // Round 4 (#4-#5)
  ['CDPATH=~/.config cd gcloud', A1('gcloud')],
  ['cd x .kube', N1('x .kube', 'more than one target')],
  ['OLDPWD=~/.kube; cd -', A1(`${HOME}/.kube`)],
  ['cd ~k', N1('~k', "another user's home (`~name`)")],
  ['pushd +1', N1('+1', 'a directory-stack entry')],
  // Round 5
  ['HOME=~/.kube cd; cat config', A1(`${HOME}/.kube`)],
  ['OLDPWD=~/.kube cd -', A1(`${HOME}/.kube`)],
  ['env HOME=~/.kube cd', undefined],
  ['exec cd src', undefined],
  ['LC_ALL=C cd src', undefined],
  ["bash -c 'HOME=~/.kube cd; cat config'", A1(`${HOME}/.kube`)],
  ["bash -c 'cd - && cat config'", undefined],
  [
    'read CDPATH <<< ~/.config; cd gcloud',
    N1('gcloud', 'CDPATH set in this command to a value Veilio cannot read'),
  ],
  ['CDPATH+=:~/.config; cd gcloud', A1('gcloud')],
  [
    ': ${CDPATH:=~/.config}; cd gcloud',
    N1('gcloud', 'CDPATH set in this command to a value Veilio cannot read'),
  ],
  [
    'printf -v CDPATH ~/.config; cd gcloud',
    N1('gcloud', 'CDPATH set in this command to a value Veilio cannot read'),
  ],
  ['cdpath+=(~/.config); cd gcloud', A1('gcloud')],
  ['DIRSTACK[1]=~/.kube; pushd +1', N1('+1', 'a directory-stack entry')],
  ['DIRSTACK[1]=~/.kube; popd; cat config', N1('popd', 'a directory-stack entry')],
  ['dirstack=(~/.kube); cd ~1', N1('~1', 'a directory-stack entry')],
  // Round 5b: a name split by quotes or a backslash
  ['export C""DPATH=~/.config; cd gcloud', A1('gcloud')],
  ['export H""OME=~/.kube; cd ~', A1('~')],
  ['export CD\\PATH=~/.config; cd gcloud', A1('gcloud')],
  ['c""d ~/.kube; cat config', A1('~/.kube')],
  ['\\cd ~/.kube; cat config', A1('~/.kube')],
  ["c''d src", undefined],
  // Round 6
  ['cd x .kube\nls', N1('x .kube', 'more than one target')],
  ['cd -\nls', undefined],
  ['cd src\ncd -', undefined],
  ["$'\\x63d' ~/.kube", A1('~/.kube')],
  ['`echo cd` ~/.kube; cat config', A1('~/.kube')],
  [
    "export $'CD'PATH=~/.config; cd gcloud",
    N1('gcloud', 'CDPATH set in this command to a value Veilio cannot read'),
  ],
  [
    'declare "${x}"=~/.config; cd gcloud',
    N1('gcloud', 'CDPATH set in this command to a value Veilio cannot read'),
  ],
  ['HOME=~/.kube; cat ~/credentials', A2('~/credentials')],
  ['HOME=~/.kube; cd ~; cat config', A1('~')],
  // COVERAGE #47's parked forms: zsh `cd old new` (the root is /work/project), AUTO_CD, a loop
  ['cd project .kube', A1('project .kube')],
  ['X= cd project .kube', A1('project .kube')],
  ['if cd project .kube; then cat config; fi', A1('project .kube')],
  ['~/.kube', A1('~/.kube')],
  ['.kube', undefined],
  ['for HOME in ~/.kube; do cd; cat config; done', N1('HOME=', 'a cd in a loop')],
  ["cd ~/.kub$'\\x65'", N1("~/.kub$'\\x65'", 'ANSI-C quoting')],
  ['cd .vei{l..l}io', N1('.vei{l..l}io', 'braces')],
  ['cd `echo .kube`', N1('`echo .kube`', 'a command substitution')],
  // FR-015: no move; 078's floor reads the cd in the text
  ['env cd ~/.aws', A1('~/.aws')],
  ['exec cd ~/.aws', A1('~/.aws')],
  ['sudo cd ~/.aws', A1('~/.aws')],
  ['nohup cd ~/.aws', A1('~/.aws')],
  ['timeout 1 cd ~/.aws', A1('~/.aws')],
  ['echo ~/.aws | xargs cd', undefined],
  ['/usr/bin/cd ~/.aws', undefined],
]
for (const [command, expected] of ATTACKS)
  test(`086 attack ${JSON.stringify(command)}: ${expected === undefined ? 'runs, as on main' : 'refused'}`, async ($, on) => {
    expect((await verdicts($, on, [command]))[0]).toBe(expected)
  })

// T029, the independent security review: forms that move the shell from text
// the guard cannot read, an option that changes cd, a name that stands for a
// command, a link made and entered in the same call.
const REVIEWED: [string, string | undefined][] = [
  ['x=/home/dev/.kub; eval cd "${x}e"; cat config', N1('eval cd "${x}e"', 'code run from text')],
  [
    'eval "$(printf "cd /home/dev/.ku%s" be)"; cat config',
    N1('eval "$(printf "cd /home/dev/.ku%s" be)"', 'code run from text'),
  ],
  // A script's own commands are outside what the guard promises (N6): sourced, it runs.
  ['. ./go.sh; cat config', undefined],
  ['builtin source go.sh; cat config', undefined],
  ['eval "$X"', N1('eval "$X"', 'code run from text')],
  // Any trap with an action, as it appears: DEBUG, RETURN and ERR fire within the call.
  ["trap 'cd ..' EXIT", N1("trap 'cd ..' EXIT", 'code run from text')],
  // A cleanup trap: one literal action that cannot move the shell or run text
  ["trap 'rm -f /tmp/x' EXIT; npm test", undefined],
  ["trap 'cd src' EXIT", N1("trap 'cd src' EXIT", 'code run from text')],
  ["trap 'python3 x.py' EXIT", N1("trap 'python3 x.py' EXIT", 'code run from text')],
  // only on EXIT, and only readers or rm on literal paths
  ["trap 'ls; rm -rf build' EXIT", undefined],
  ["trap 'rm -f /tmp/x' DEBUG", N1("trap 'rm -f /tmp/x' DEBUG", 'code run from text')],
  ["trap 'rm -f /tmp/x' INT", N1("trap 'rm -f /tmp/x' INT", 'code run from text')],
  ["trap 'curl x' EXIT", N1("trap 'curl x' EXIT", 'code run from text')],
  ["trap 'X=1' EXIT", N1("trap 'X=1' EXIT", 'code run from text')],
  ['trap "rm $f" EXIT', N1('trap "rm $f" EXIT', 'code run from text')],
  // Physical resolution, so the `..`/`-` exemption cannot run under it
  ['set -P; cd ..', N1('set -P', 'an option that changes cd')],
  ['set -o physical; cd ..', N1('set -o physical', 'an option that changes cd')],
  ['setopt chase_links; cd ..', N1('setopt chase_links', 'an option that changes cd')],
  ['setopt CHASEDOTS; cd ..', N1('setopt CHASEDOTS', 'an option that changes cd')],
  [
    'x=.kub; trap -- "cd ~/${x}e" DEBUG; cat config',
    N1('trap -- "cd ~/${x}e" DEBUG', 'code run from text'),
  ],
  [
    'x=.kub; trap "cd ~/${x}e; cat config" DEBUG',
    N1('trap "cd ~/${x}e; cat config" DEBUG', 'code run from text'),
  ],
  ['trap - INT; ls', undefined],
  ['trap -p', undefined],
  // Text the call builds is not a script's own: refused, sourced or not.
  [
    'x=.kub; source /dev/stdin <<< "cd ~/${x}e"; cat config',
    N1('source /dev/stdin', 'code run from text'),
  ],
  ['x=.kub; . <(echo cd ~/${x}e); cat config', N1('. <(echo cd ~/${x}e)', 'code run from text')],
  [
    'x=.kub; emulate zsh -c "cd ~/${x}e"; cat config',
    N1('emulate zsh -c "cd ~/${x}e"', 'code run from text'),
  ],
  // cdable_vars by any spelling, pattern or value the shell builds
  ['o=cdable_vars; shopt -s $o; cd k', N1('shopt -s $o', 'an option that changes cd')],
  ["setopt -m 'cdable*'; cd k", N1("setopt -m 'cdable*'", 'an option that changes cd')],
  ['options[cdablevars]=on; cd k', N1('options=', 'an option that changes cd')],
  ['setopt -T; cd k', N1('setopt -T', 'an option that changes cd')],
  ['set -eT; cd k', N1('set -eT', 'an option that changes cd')],
  ['set -e; cd src', undefined],
  // links, by any program that can make one
  [
    'x=.kub; /bin/ln -s ~/${x}e k && cd k',
    N1('/bin/ln -s ~/${x}e k', 'a link made in this command'),
  ],
  ['x=.kub; ln --sym ~/${x}e k && cd k', N1('ln --sym ~/${x}e k', 'a link made in this command')],
  ['x=.kub; cp -rs ~/${x}e/ k && cd k', N1('cp -rs ~/${x}e/ k', 'a link made in this command')],
  [
    'python3 -c "import os; os.symlink(1, 2)" && cd k',
    N1('python3 -c "import os; os.symlink(1, 2)"', 'a cd after code this command ran'),
  ],
  ['mkdir build && cd build && cmake ..', undefined],
  // Past the reader's bounds with no quote, backslash, $, backtick, paren or
  // newline: nothing in it builds text, so 078's verdict.
  [`echo ${'{'.repeat(201)} ls`, undefined],
  [
    `echo ${'{'.repeat(201)}; foo`,
    N1(`echo ${'{'.repeat(201)}; foo`, 'a command Veilio cannot read'),
  ],
  [
    `echo ${'{'.repeat(201)}; cd src`,
    N1(`echo ${'{'.repeat(201)}; cd src`, 'a command Veilio cannot read'),
  ],
  // After an interpreter or a shell ran, every cd but a logical `cd ..` and
  // `cd -` is refused (coordinator's rule (b)): a link it made is not entered.
  ['perl -e 1; cd k', N1('perl -e 1', 'a cd after code this command ran')],
  ["python3 - <<'E'\nprint(1)\nE\ncd src", N1('python3 -', 'a cd after code this command ran')],
  ['bash -c true && cd src', N1('bash -c true', 'a cd after code this command ran')],
  // (b2): a file the call did not write is the script's own (N6/P7)
  ['python3 tool.py; cd src', undefined],
  ['ruby -I lib test/w27.rb 2>&1 | tail -5; cd w1 2>/dev/null; ruby w1/test/w27.rb', undefined],
  [
    "python3 -c 'import os'; cd src",
    N1("python3 -c 'import os'", 'a cd after code this command ran'),
  ],
  [
    'cat > x.py <<E\nimport os\nE\npython3 x.py; cd src',
    N1('python3 x.py', 'a cd after code this command ran'),
  ],
  ['cat x.py | python3; cd src', N1('python3', 'a cd after code this command ran')],
  ['python3 <(cat x.py); cd src', N1('python3 <(cat x.py)', 'a cd after code this command ran')],
  ['python3 tool.py > out.txt; cd src', undefined],
  // Only a plain file after allowed options is the script's own
  ['python3 -m pytest; cd src', N1('python3 -m pytest', 'a cd after code this command ran')],
  ['node --inspect x.js; cd src', N1('node --inspect x.js', 'a cd after code this command ran')],
  ['python3 -u tool.py; cd src', undefined],
  // each interpreter's own option table; anything else, or code anywhere, refused
  ['python3 -X dev tool.py; cd src', undefined],
  ['python3 -I tool.py; cd src', undefined],
  ['python3 -Q tool.py; cd src', N1('python3 -Q tool.py', 'a cd after code this command ran')],
  ['python3 tool.py -c x; cd src', N1('python3 tool.py -c x', 'a cd after code this command ran')],
  ['bash -O extglob s.sh; cd src', undefined],
  // a value attached only where the parser reads one; a shell cluster per letter
  ["bash -xc 'true'; cd src", N1("bash -xc 'true'", 'a cd after code this command ran')],
  ['sh -ec true; cd src', N1('sh -ec true', 'a cd after code this command ran')],
  ['bash -lc true; cd src', N1('bash -lc true', 'a cd after code this command ran')],
  ['bash -eu s.sh; cd src', undefined],
  ['python3 -Wignore tool.py; cd src', undefined],
  ['python3 -Ix tool.py; cd src', N1('python3 -Ix tool.py', 'a cd after code this command ran')],
  ['bash --rcfile x s.sh; cd src', N1('bash --rcfile x s.sh', 'a cd after code this command ran')],
  ['ruby -I lib test/x.rb; cd src', undefined],
  // after any command but a plain reader, a file run is code the call gave
  ['make; python3 tool.py; cd src', N1('python3 tool.py', 'a cd after code this command ran')],
  ['ls; python3 tool.py; cd src', undefined],
  ['ruby -e 1; cd ../x', N1('ruby -e 1', 'a cd after code this command ran')],
  ['ruby -e 1; cd -P ..', N1('ruby -e 1', 'a cd after code this command ran')],
  ["sed -i 's/a/b/' x && ruby -Ilib test/x.rb 2>&1 | tail -4; cd .. && ruby y.rb", undefined],
  ["python3 - <<'E'\nprint(1)\nE\ncd ../../..", undefined],
  ["python3 - <<'E'\nprint(1)\nE\ncd - >/dev/null", undefined],
  ['cd src && python3 -c 1', undefined],
  // A sourced file the call builds: by a pipe, a redirection, or one it writes
  ['echo cd x | source /dev/stdin', N1('source /dev/stdin', 'code run from text')],
  ['echo cd x | . ./s.sh', N1('. ./s.sh', 'code run from text')],
  ['echo "cd x" > s.sh; . ./s.sh', N1('. ./s.sh', 'code run from text')],
  ['. /proc/self/fd/0', N1('. /proc/self/fd/0', 'code run from text')],
  ['source /tmp/../dev/stdin', N1('source /tmp/../dev/stdin', 'code run from text')],
  ['source x.sh <> y', N1('source x.sh', 'code run from text')],
  // Anything written before a source in the call (no path tracking)
  ['echo x > out.txt; . ./env.sh', N1('. ./env.sh', 'code run from text')],
  ['cp a b && source ./env.sh', N1('source ./env.sh', 'code run from text')],
  ["sed -i 's/a/b/' x; . ./env.sh", N1('. ./env.sh', 'code run from text')],
  ['ls x | tee y; . ./env.sh', N1('. ./env.sh', 'code run from text')],
  ['. ./env.sh > log.txt', undefined],
  ['ls 2>&1; . ./env.sh', undefined],
  // any writing redirection, whatever its target; any command not a plain reader
  ['echo x > 1; . ./env.sh', N1('. ./env.sh', 'code run from text')],
  ['ls >& out; . ./env.sh', N1('. ./env.sh', 'code run from text')],
  [`python3 -c "open('g','w')"; . ./g`, N1('. ./g', 'code run from text')],
  ['base64 -d -o g <<< eA==; . ./g', N1('. ./g', 'code run from text')],
  // the everyday venv line, exactly: its activate script, as the next command
  ['python3 -m venv .venv && source .venv/bin/activate', undefined],
  // joined by && only, with nothing written before it
  ['python -m venv env; . env/bin/activate', N1('. env/bin/activate', 'code run from text')],
  [
    'echo x > a; python3 -m venv .venv && source .venv/bin/activate',
    N1('source .venv/bin/activate', 'code run from text'),
  ],
  [
    'python3 -m pip .venv && source .venv/bin/activate',
    N1('source .venv/bin/activate', 'code run from text'),
  ],
  [
    'python3 -m venv .venv && source other/bin/activate',
    N1('source other/bin/activate', 'code run from text'),
  ],
  [
    'python3 -m venv .venv; pip install x; . .venv/bin/activate',
    N1('. .venv/bin/activate', 'code run from text'),
  ],
  [
    'python3 -m pip install x && source .venv/bin/activate',
    N1('source .venv/bin/activate', 'code run from text'),
  ],
  // rg runs a program with --pre: not a plain reader
  ['rg --pre x foo; . ./env.sh', N1('. ./env.sh', 'code run from text')],
  ['ls; grep x y; . ./env.sh', undefined],
  ["cd src; perl -pi -e 's/a/b/' x.rb", undefined],
  // past the reader's bounds, anything that could move the shell: refused
  [
    `echo ${'{'.repeat(201)}; x=.kub; eval cd "~/\${x}e"; cat config`,
    N1(
      `echo ${'{'.repeat(201)}; x=.kub; eval cd "~/\${x}e"; cat config`,
      'a command Veilio cannot read'
    ),
  ],
  [
    'x=.kub; trap "cd ~/${x}e" DEBUG; cat config',
    N1('trap "cd ~/${x}e" DEBUG', 'code run from text'),
  ],
  ['source .venv/bin/activate', undefined],
  ["trap '' INT; ls", undefined],
  [
    'shopt -s cdable_vars; k=/home/dev/.kube; cd k; cat config',
    N1('shopt -s cdable_vars', 'an option that changes cd'),
  ],
  ['setopt CDABLE_VARS; cd k', N1('setopt CDABLE_VARS', 'an option that changes cd')],
  ['set -o cdablevars; cd k', N1('set -o cdablevars', 'an option that changes cd')],
  ['shopt -s globstar; ls', undefined],
  [
    'x=.kub; alias go="cd ~/${x}e"\ngo; cat config',
    N1('alias go="cd ~/${x}e"', 'a new name for a command'),
  ],
  [
    'x=.kub; ln -s ~/${x}e k && cd k && cat config',
    N1('ln -s ~/${x}e k', 'a link made in this command'),
  ],
  ['ln -s ../src k && ls k', undefined],
]
for (const [command, expected] of REVIEWED)
  test(`086 reviewed: ${JSON.stringify(command)}`, async ($, on) => {
    expect((await verdicts($, on, [command]))[0]).toBe(expected)
  })
// contracts/cd-verdicts.md "Evaluable targets": each form is followed into
// the directory it names, so `cat notes` there (a link to .env) is refused,
// and at the root (a plain file) runs.
const NOTES = A2('notes')
const FOLLOWED: [string, string | undefined][] = [
  ['cd ./sub && cat notes', NOTES],
  ['cd ../project/sub && cat notes', NOTES],
  [`cd ${ROOT}/sub && cat notes`, NOTES],
  ['cd ~ && cat notes', NOTES],
  ['cd && cat notes', NOTES],
  ['cd -- && cat notes', NOTES],
  ['cd ~+/sub && cat notes', NOTES],
  ['cd sub && cd - && cat notes', undefined],
  ['cd sub && cd .. && cd - && cat notes', NOTES],
  ['cd sub && cd ~- && cd ~- && cat notes', NOTES],
  ['pushd sub && cat notes', NOTES],
  ['pushd sub && popd && cat notes', undefined],
  ['pushd sub && pushd .. && pushd && cat notes', NOTES],
  ['CDPATH=lib cd deep && cat notes', NOTES],
  ['cd -P sub && cat notes', NOTES],
  ['cd -- sub && cat notes', NOTES],
  ['cd sub 2>/dev/null && cat notes', NOTES],
  ['cd sub # into sub\ncat notes', NOTES],
  ['sub && cat notes', NOTES],
  ['cd /work/a && cd a project/sub && cat notes', NOTES],
  ['cd /work/a && cd b c && cat notes', N1('b c', 'more than one target')],
  ['builtin cd sub && cat notes', NOTES],
  ['command cd sub && cat notes', NOTES],
  ['command -v cd sub && cat notes', undefined],
  // A cd in a substitution in a redirection lands too, in its subshell.
  ['echo x > "$(cd ~/.kube && pwd)/y"', A1('~/.kube')],
]
for (const [command, expected] of FOLLOWED)
  test(`086 followed: ${JSON.stringify(command)}`, async ($, on) => {
    expect((await verdicts($, on, [command]))[0]).toBe(expected)
  })

// T013, contracts/cd-verdicts.md "Assignments": what a command sets is used
// for what follows it in that command; naming a variable sets nothing.
const ASSIGNED: [string, string | undefined][] = [
  // prefix: that command only
  ['CDPATH=lib cd deep && cat notes', NOTES],
  ['CDPATH=lib true; cd deep && cat notes', undefined],
  // for the rest of the call
  ['CDPATH=lib; cd deep && cat notes', NOTES],
  ['export CDPATH=lib; cd deep && cat notes', NOTES],
  ['declare CDPATH=lib; cd deep && cat notes', NOTES],
  ['typeset CDPATH=lib; cd deep && cat notes', NOTES],
  ['readonly CDPATH=lib; cd deep && cat notes', NOTES],
  ['CDPATH+=lib; cd deep && cat notes', NOTES],
  ['cdpath=(lib); cd deep && cat notes', NOTES],
  ['HOME=/work/project/sub; cd && cat notes', NOTES],
  ['HOME=/work/project/sub cd && cat notes', NOTES],
  ['unset CDPATH; cd deep && cat notes', undefined],
  // a value or a name the shell builds
  ['CDPATH=$X cd deep', N1('deep', 'CDPATH set in this command to a value Veilio cannot read')],
  [
    'export CDPATH="$(pwd)/lib"; cd deep',
    N1('deep', 'CDPATH set in this command to a value Veilio cannot read'),
  ],
  [
    'read -r CDPATH; cd deep',
    N1('deep', 'CDPATH set in this command to a value Veilio cannot read'),
  ],
  ['for CDPATH in lib; do cd deep; done', N1('CDPATH=', 'a cd in a loop')],
  [
    'declare -n CDPATH=X; cd deep',
    N1('deep', 'CDPATH set in this command to a value Veilio cannot read'),
  ],
  // HOME unknown and `~` anywhere: N2; no `~`, nothing to tell
  ['HOME=$X; cd ~', N2],
  ['HOME=$X; cat ~/notes', N2],
  ['read HOME; ls ~', N2],
  ['HOME=$X; ls', undefined],
  // naming without setting changes nothing
  ['echo $HOME && cd ~ && cat notes', NOTES],
  ['ls ${HOME:-/tmp} && cd ~ && cat notes', NOTES],
  ['grep -r CDPATH scripts/; cd deep && cat notes', undefined],
  ['echo $CDPATH; cd sub && cat notes', NOTES],
]
for (const [command, expected] of ASSIGNED)
  test(`086 assignment: ${JSON.stringify(command)}`, async ($, on) => {
    expect((await verdicts($, on, [command]))[0]).toBe(expected)
  })

// T015 (Q1 = A): the variable forms a cd target may hold.
const VARIABLE: [string, string | undefined][] = [
  ['cd "$PWD/sub" && cat notes', NOTES],
  ['cd sub && cd "$PWD" && cat notes', NOTES],
  ['cd ${HOME} && cat notes', NOTES],
  ['cd "$HOME" && cat notes', NOTES],
  ['cd sub && cd "$OLDPWD" && cat notes', undefined],
  ['cd sub && cd .. && cd "$OLDPWD" && cat notes', NOTES],
  ['cd $(pwd)/sub && cat notes', NOTES],
  ['cd sub && cd "$(git rev-parse --show-toplevel)" && cat notes', undefined],
  ['cd "$(git rev-parse --show-toplevel)/sub" && cat notes', NOTES],
  // .git a file, in a directory above the one the shell is in
  ['cd /other/repo/sub && cd "$(git rev-parse --show-toplevel)" && cat notes', NOTES],
  [
    'cd /outside && cd "$(git rev-parse --show-toplevel)"',
    N1('"$(git rev-parse --show-toplevel)"', 'no repository above this directory'),
  ],
  [
    'cd "$(git rev-parse --show-prefix)"',
    N1('"$(git rev-parse --show-prefix)"', 'a command substitution'),
  ],
  ['cd "$D"', N1('"$D"', 'a variable')],
]
for (const [command, expected] of VARIABLE)
  test(`086 variable: ${JSON.stringify(command)}`, async ($, on) => {
    expect((await verdicts($, on, [command]))[0]).toBe(expected)
  })

// T018, contracts/cd-verdicts.md "Scope": where each word is read from, the
// shell's own scoping of `&&`, `||`, `;`, subshells, `$( )` and pipelines.
const SCOPE: [string, string | undefined][] = [
  ['cd sub; cat notes', NOTES],
  ['cd sub || true; cat notes', NOTES],
  ['(cd sub && ls); cat notes', undefined],
  ['echo $(cd sub); cat notes', undefined],
  ['echo `cd sub`; cat notes', undefined],
  // bash runs a pipeline's last stage in a subshell, zsh does not: both kept
  ['ls | cd sub; cat notes', NOTES],
  ['cd sub | ls; cat notes', undefined],
  ['cd sub & cat notes', undefined],
  ['cd /tmp && cat notes', undefined],
  ['cd sub && cd .. && cat notes', undefined],
  ['false && cd sub; cat notes', undefined],
  ['cd sub 2>/dev/null || exit 1; cat notes', NOTES],
  ['if cd sub; then ls; fi; cat notes', NOTES],
  // A loop or a function that moves the shell is not followed (security review).
  ['for x in 1 2; do cd sub; done; cat notes', N1('cd sub', 'a cd in a loop')],
  ['for x in 1 2 3; do cd ..; done; cat notes', N1('cd ..', 'a cd in a loop')],
  ['while true; do cd sub || break; done', N1('cd sub', 'a cd in a loop')],
  ['until false; do CDPATH=lib; done; cd deep', N1('CDPATH=', 'a cd in a loop')],
  ['for x in 1 2; do ls $x; done; cat notes', undefined],
  // A shell function is refused, whatever it does (security review 3).
  ['f() { cd sub; }; f; cat notes', N1('f', 'a shell function')],
  ['function f { HOME=/x; }; f; cd', N1('f', 'a shell function')],
  ['f() { cd sub; }; ls', N1('f', 'a shell function')],
  ['f() { ls; }; f; cat notes', N1('f', 'a shell function')],
  ['g() { ls; }; f() { g; }; g() { cd sub; }; f; cat notes', N1('g', 'a shell function')],
  ['f() { cd sub; }; builtin f', N1('f', 'a shell function')],
  ['f() { cd sub; }; command f', N1('f', 'a shell function')],
  ['f() { f; cd sub; }; f', N1('f', 'a shell function')],
  ['for x in 1 2; do f() { cd sub; }; f; done', N1('f', 'a shell function')],
  ["bash -c 'f() { cd ..; }; f'", N1('f', 'a shell function')],
  ['echo $(f() { :; })', N1('f', 'a shell function')],
  // `command` and `builtin` before a cd: the cd path
  ['for x in 1; do command -p cd ..; done', N1('command -p cd ..', 'a cd in a loop')],
  ['for x in 1; do builtin cd ..; done', N1('builtin cd ..', 'a cd in a loop')],
  ['command -p cd sub && cat notes', NOTES],
  ['command -- cd sub && cat notes', NOTES],
  ['for x in 1; do command -v cd; done', undefined],
  // zsh AUTO_CD: a lone word naming a directory, in a loop
  ['for x in 1; do sub; done', N1('sub', 'a cd in a loop')],
  ['for x in 1; do ls; done', undefined],
  // pushd's failure keeps the stack it had: a popd after `;` may pop either
  ['pushd sub; ls; popd; cat notes', NOTES],
  ['pushd sub; popd && cat notes', NOTES],
  // a subshell's cd in a loop moves nothing out here
  ['for x in 1; do (cd sub && ls); done; cat notes', undefined],
  // more than two targets: refused, not read as an error
  ['cd a b c', N1('a b c', 'more than one target')],
  ['pushd a b c', N1('a b c', 'more than one target')],
  // zsh `pushd old new`, as `cd old new`
  ['cd /work/a && pushd a project/sub && cat notes', NOTES],
  ['pushd x .kube', N1('x .kube', 'more than one target')],
  ["bash -c 'cd sub'; cat notes", undefined],
  ["bash -c 'cd sub && cat notes'", NOTES],
  ['eval "cd sub"; cat notes', NOTES],
  // FR-015: a program run by a wrapper is /usr/bin/cd, in a child
  ['env cd sub && cat notes', undefined],
  ['nohup cd sub && cat notes', undefined],
  // bash's reading of the pipeline: the shell stays where it was
  ['cd /other/repo && ls | cd sub; cat notes', NOTES],
  ['cd /other/repo && ls | cd sub && cat notes', NOTES],
  // every directory the shell may be in, not only one of them
  ['cd /other/repo; cd /zzz; cat notes', NOTES],
]
for (const [command, expected] of SCOPE)
  test(`086 scope: ${JSON.stringify(command)}`, async ($, on) => {
    expect((await verdicts($, on, [command]))[0]).toBe(expected)
  })

// Across calls: where the shell is after one call is where the next starts
// (the top-level commands only, success or failure); the stack and the
// environment are not kept (research R0, T003).
const CALLS: [string[], string | undefined][] = [
  [['cd sub', 'cat notes'], NOTES],
  [['cd sub; ls', 'cat notes'], NOTES],
  // A test host reports the root at every call: a report that never moves
  // is not trusted, so every directory a call may have left the shell in is
  // carried, the cd that may have failed too (tests/guard/cd-host.test.ts).
  [['cd sub', 'cd /tmp', 'cat notes'], NOTES],
  [['cd /tmp', 'cat notes'], undefined],
  [['echo $(cd sub)', 'cat notes'], undefined],
  [['(cd sub)', 'cat notes'], undefined],
  [['export CDPATH=lib', 'cd deep && cat notes'], undefined],
  [['pushd sub', 'popd; cat notes'], NOTES],
  // The stack is not kept: this popd finds it empty, so cat never runs.
  [['cd sub && pushd /tmp', 'popd && cat notes'], undefined],
  [['cd sub', 'cd - && cat notes'], undefined],
]
for (const [calls, expected] of CALLS)
  test(`086 across calls: ${JSON.stringify(calls)}`, async ($, on) => {
    const out = await verdicts($, on, calls)
    expect(out.slice(0, -1)).toEqual(calls.slice(0, -1).map(() => undefined))
    expect(out[out.length - 1]).toBe(expected)
  })

test('086 across calls: a failed call moves the shell too', async ($, on) => {
  project(on, TREE, TREE_LINKS)
  on('tool.call', (_, e) =>
    e.command === 'cd sub && false'
      ? { result: { stdout: '', stderr: 'exit 1', interrupted: false }, isError: true }
      : { result: { stdout: '', stderr: '', interrupted: false } }
  )
  await $.tool.call({ tool: 'Bash', command: 'cd sub && false', description: 'x' })
  const out = await $.tool.call({ tool: 'Bash', command: 'cat notes', description: 'x' })
  expect(out.deny).toBe(NOTES)
})

// Q3 = A: more than 16 possible directories refuses the call.
const fan = (n: number) => Array.from({ length: n }, (_, k) => `cd d${k}`).join(' || ')
// A chain of n `||` cds may leave the shell in n directories, or where it
// was if all fail: 15 run, 16 and 17 do not.
for (const [n, expected] of [
  [15, undefined],
  [16, N1(fan(16), 'too many possible directories')],
  [17, N1(fan(17), 'too many possible directories')],
] as const)
  test(`086 the bound: ${n} cds joined by || ${expected ? 'are refused' : 'run'}`, async ($, on) => {
    expect((await verdicts($, on, [fan(n)]))[0]).toBe(expected)
  })

test('086 N1 masks its target: a name from the map reaches the model as its placeholder', async ($, on) => {
  project(on, { [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }) }, { home: HOME })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  const out = await $.tool.call({ tool: 'Bash', command: `cd "$D/${CANARY}"`, description: 'x' })
  expect(out.deny).toBe(N1('"$D/__CLS__1"', 'a variable'))
})

// T021 (US4, FR-014): contracts/cd-verdicts.md's ordinary list, each form its
// own test, beside 078's six above; with HOME known and the tree's links.
for (const command of [
  'cd src 2>/dev/null || exit 1',
  'cd packages/cli > /dev/null && npm test',
  'pushd packages/cli > /dev/null && npm test && popd > /dev/null',
  'cd src >/dev/null 2>&1',
  'cd src </dev/null',
  'cd src # into src',
  'cd "my folder" 2>&1',
  'if cd src; then ls; fi',
  'time cd src',
  'cd src\nls',
  'set -e\ncd packages/cli\nnpm test',
  'cd ..\nnpm test',
  'cd src \\\n  && ls',
  'cd /tmp/x/repo 2>/dev/null || cd "$PWD"; ls',
  'cd /tmp/x/repo 2>/dev/null || cd "$(git rev-parse --show-toplevel)"; ls',
  'echo $HOME && cd ~/code',
  'export PATH="$HOME/.local/bin:$PATH"; cd ~/code',
  'ls ${HOME}/.npm ${HOME:-/tmp}',
  'grep -r CDPATH scripts/; cd packages/cli',
  '"$(npm bin)/jest" src',
  'cd "Wnioski/źródła" && ls',
  'cd Straße',
  'cd έγγραφα',
])
  test(`an ordinary cd still runs: ${JSON.stringify(command)}`, async ($, on) => {
    let ran = false
    project(on, TREE, TREE_LINKS)
    on('tool.call', () => {
      ran = true
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })
    const out = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(out.deny).toBeUndefined()
    expect(ran).toBe(true)
  })

// FR-011 (T003): where Claude Code says the shell is as each call starts.
test('086 host: after cd sub the host reports sub, and the next short name is read there', async ($, on) => {
  let at = ROOT
  project(on, TREE, { ...TREE_LINKS, cwd: () => at })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'Bash', command: 'cd sub', description: 'x' })
  at = `${ROOT}/sub`
  const out = await $.tool.call({ tool: 'Bash', command: 'cat notes', description: 'x' })
  expect(out.deny).toBe(NOTES)
})

test('086 host: proved live, then reset to the root after a cd outside the project - both read, logged once', async ($, on) => {
  let at = ROOT
  const p = project(on, TREE, { ...TREE_LINKS, cwd: () => at })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'Bash', command: 'cd sub', description: 'x' })
  at = `${ROOT}/sub`
  await $.tool.call({ tool: 'Bash', command: 'cd /other/repo', description: 'x' })
  at = ROOT
  // /other/repo/notes is a link to .env: the guard's reading is checked too.
  const out = await $.tool.call({ tool: 'Bash', command: 'cat notes', description: 'x' })
  expect(out.deny).toBe(NOTES)
  expect(
    p.logs.filter((l) => l.startsWith('Veilio guard: Claude Code says the shell is in'))
  ).toEqual([
    `Veilio guard: Claude Code says the shell is in ${ROOT}, where Veilio's reading of the last command left it in /other/repo. Both are checked for this call.`,
  ])
})

test('086 host: a report never proved is not discarded - sub reported with no cd is read too', async ($, on) => {
  let at = ROOT
  project(on, TREE, { ...TREE_LINKS, cwd: () => at })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'x' })
  at = `${ROOT}/sub`
  expect((await $.tool.call({ tool: 'Bash', command: 'cat notes', description: 'x' })).deny).toBe(
    NOTES
  )
})

test('086 CDPATH the host cannot answer: a bare cd is refused', async ($, on) => {
  project(on, TREE, { ...TREE_LINKS, ownEnv: true })
  on('env.get', (_, e) =>
    e.name === 'CDPATH'
      ? { deny: 'no environment' }
      : { value: e.name === 'HOME' ? HOME : undefined }
  )
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  expect((await $.tool.call({ tool: 'Bash', command: 'cd sub', description: 'x' })).deny).toBe(
    N1('sub', 'CDPATH set in this command to a value Veilio cannot read')
  )
  expect(
    (await $.tool.call({ tool: 'Bash', command: 'cd ./sub', description: 'x' })).deny
  ).toBeUndefined()
})

test('086 CDPATH from the environment: a bare name is looked up under it', async ($, on) => {
  project(on, TREE, { ...TREE_LINKS, cdpath: `${ROOT}/lib` })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  const out = await $.tool.call({ tool: 'Bash', command: 'cd deep && cat notes', description: 'x' })
  expect(out.deny).toBe(NOTES)
})

// Spec 085 part 3, R2-13 (security audit run-2): for an MCP or unknown tool
// the raw-only check skipped an argument with a space, one of 4096 characters
// or more, an object key, and Windows short names. Every string and key is
// checked now; prose that only mentions a raw-only name still passes.
test('R2-13: an MCP tool asked for a raw-only file by an odd path is refused', async ($, on) => {
  project(on, { [`${ROOT}/.env`]: 'DB_HOST=db.example.invalid\n' })
  const seen: Fields[] = []
  on('tool.call', (_, e) => (seen.push(e), { result: [{ type: 'text', text: 'ok' }] }))
  for (const args of [
    { path: '/tmp/My Project/.env' },
    { path: 'x y/../.env' },
    { path: './'.repeat(2100) + '.env' },
    { files: { '.env': true } },
  ]) {
    const out = await $.tool.call({ tool: 'mcp__files__read_file', ...args })
    expect(out.deny, JSON.stringify(args).slice(0, 60)).toContain('away from the model')
  }
  const prose = await $.tool.call({
    tool: 'mcp__files__read_file',
    query: 'how do I load a .env file',
  })
  expect(prose.deny).toBeUndefined()
  expect(seen).toHaveLength(1)
})

// Spec 085 part 3, R2-15: a pattern written from the root, with `/`, protects
// the file, for a Read and for a cd; one that climbs out is reported once.
test('R2-15: a rawOnly pattern written with a leading / protects the file', async ($, on) => {
  project(on, {
    [`${ROOT}/.veilio/guard.json`]: JSON.stringify({ rawOnly: ['/config/prod.yml'] }),
    [`${ROOT}/config/prod.yml`]: 'DB_HOST=db.example.invalid\n',
  })
  on('tool.call', () => ({ result: { type: 'text', file: { content: 'x' } } }))
  const read = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/config/prod.yml` })
  expect(read.deny).toContain('away from the model')
  const cd = await $.tool.call({ tool: 'Bash', command: 'cd config && ls', description: 'x' })
  expect(cd.deny).toBeDefined()
})

test('R2-15: a rawOnly pattern that climbs out is reported once', async ($, on) => {
  const p = project(on, {
    [`${ROOT}/.veilio/guard.json`]: JSON.stringify({ rawOnly: ['../x'] }),
  })
  on('tool.call', () => ({ result: [{ type: 'text', text: 'ok' }] }))
  await $.tool.call({ tool: 'mcp__a__b', q: 'x' })
  await $.tool.call({ tool: 'mcp__a__b', q: 'y' })
  expect(
    p.logs.filter(
      (l) =>
        l ===
        'Veilio: rawOnly pattern `../x` in .veilio/guard.json can never match a file, so it protects nothing. Write it relative to the project root, such as `config/prod.yml` or `secrets/**`.'
    )
  ).toHaveLength(1)
})

// Spec 085 part 3, R2-14 (security audit run-2): a search through a link to a
// raw-only folder printed its files under the link's name, and the result
// filter matched them as printed. Result paths are now read through the link.
const LINK_FILES = {
  [`${ROOT}/.veilio/guard.json`]: JSON.stringify({ rawOnly: ['secrets/**'] }),
  [`${ROOT}/secrets/db.yml`]: 'DB_HOST=db.example.invalid\n',
  [`${ROOT}/docs/readme.md`]: '# docs\n',
}
const LINK_OPTS = { links: { [`${ROOT}/docs/s`]: `${ROOT}/secrets` } }

test('R2-14: a Grep through a link to a raw-only folder returns none of its lines', async ($, on) => {
  project(on, LINK_FILES, LINK_OPTS)
  on('tool.call', () => ({
    result: {
      mode: 'content',
      content: 'docs/s/db.yml:1:DB_HOST=db.example.invalid',
      numFiles: 1,
      filenames: [],
      numLines: 1,
    },
  }))
  const out = await $.tool.call({ tool: 'Grep', path: 'docs/s', pattern: 'DB_HOST' })
  expect(JSON.stringify(out)).not.toContain('db.example.invalid')
})

test('R2-14: a Glob through the link lists none of its files', async ($, on) => {
  project(on, LINK_FILES, LINK_OPTS)
  on('tool.call', () => ({
    result: { filenames: [`${ROOT}/docs/s/db.yml`], numFiles: 1, truncated: false, durationMs: 1 },
  }))
  const out = await $.tool.call({ tool: 'Glob', path: `${ROOT}/docs/s`, pattern: '*.yml' })
  expect(JSON.stringify(out)).not.toContain('db.yml')
})

test('R2-14: a Grep of a plain folder keeps its lines', async ($, on) => {
  project(on, LINK_FILES, LINK_OPTS)
  on('tool.call', () => ({
    result: {
      mode: 'content',
      content: 'docs/readme.md:1:# docs',
      numFiles: 1,
      filenames: [],
      numLines: 1,
    },
  }))
  const out = await $.tool.call({ tool: 'Grep', path: 'docs', pattern: 'docs' })
  expect(JSON.stringify(out)).toContain('readme.md')
})
