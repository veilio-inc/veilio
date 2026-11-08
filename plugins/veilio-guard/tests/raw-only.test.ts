// Spec 033 FR-004: files that must never reach the model are refused before
// the tool runs, whatever spelling reaches them.
import { expect, test } from 'claude-code/testing'
import { mapFile, ownEnv, project, ROOT, STRIPE, res } from './helpers.ts'
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
const SETS_HOME =
  'Veilio refused this call: it sets HOME and names `~`, so Veilio cannot tell which files `~` stands for. Name the files by their full path, or ask the user.'
// Review round 6 #3: each refused cd form with the reason it must be refused for.
const REASON: Record<string, string> = {
  'CDPATH=~/.config cd gcloud': 'Veilio refused this call: a cd Veilio cannot follow (`CDPATH`)',
  'cd x .kube': 'Veilio refused this call: a cd Veilio cannot follow (`x .kube`)',
  'OLDPWD=~/.kube; cd -': 'Veilio refused this call: a cd Veilio cannot follow (`-`)',
  'cd ~k': 'Veilio keeps `~k` away from the model',
  'pushd +1': 'Veilio refused this call: a cd Veilio cannot follow (`+1`)',
  'read CDPATH <<< ~/.config; cd gcloud':
    'Veilio refused this call: a cd Veilio cannot follow (`CDPATH`)',
  'CDPATH+=:~/.config; cd gcloud': 'Veilio refused this call: a cd Veilio cannot follow (`CDPATH`)',
  ': ${CDPATH:=~/.config}; cd gcloud':
    'Veilio refused this call: a cd Veilio cannot follow (`CDPATH`)',
  'printf -v CDPATH ~/.config; cd gcloud':
    'Veilio refused this call: a cd Veilio cannot follow (`CDPATH`)',
  'HOME=~/.kube cd; cat config': 'Veilio refused this call: it sets HOME and names `~`',
  'OLDPWD=~/.kube cd -': 'Veilio refused this call: a cd Veilio cannot follow (`-`)',
  'env HOME=~/.kube cd': 'Veilio refused this call: it sets HOME and names `~`',
  'exec cd src': 'Veilio refused this call: a cd Veilio cannot follow (`exec cd`)',
  'LC_ALL=C cd src': 'Veilio refused this call: a cd Veilio cannot follow (`LC_ALL=C cd`)',
  cd: 'Veilio refused this call: a cd Veilio cannot follow (`cd`)',
  "bash -c 'HOME=~/.kube cd; cat config'": 'Veilio refused this call: it sets HOME and names `~`',
  'HOME=~/.kube; cd ~; cat config': 'Veilio refused this call: it sets HOME and names `~`',
  'OLDPWD=~/.aws cd -': 'Veilio refused this call: a cd Veilio cannot follow (`-`)',
  'X= cd project .kube': 'Veilio refused this call: a cd Veilio cannot follow (`project .kube`)',
  'if cd project .kube; then cat config; fi':
    'Veilio refused this call: a cd Veilio cannot follow (`project .kube`)',
  'if true; then cd -; fi': 'Veilio refused this call: a cd Veilio cannot follow (`-`)',
  'time cd -': 'Veilio refused this call: a cd Veilio cannot follow (`-`)',
  '! cd -': 'Veilio refused this call: a cd Veilio cannot follow (`-`)',
  "bash -c 'cd - && cat config'": 'Veilio refused this call: a cd Veilio cannot follow (`-`)',
  'cdpath+=(~/.config); cd gcloud':
    'Veilio refused this call: a cd Veilio cannot follow (`CDPATH`)',
  'DIRSTACK[1]=~/.kube; pushd +1':
    'Veilio refused this call: a cd Veilio cannot follow (`DIRSTACK`)',
  'dirstack=(~/.kube); cd ~1': 'Veilio keeps `~1` away from the model',
  'Microsoft.PowerShell.Management\\Set-Location ~\\.aws; gc credentials':
    'Veilio keeps `~\\.aws` away from the model',
  'c""d ~/.kube; cat config': 'Veilio keeps `~/.kube` away from the model',
  '\\cd ~/.kube; cat config': 'Veilio keeps `~/.kube` away from the model',
  "c''d src": 'Veilio refused this call: a cd Veilio cannot follow (`cd`)',
}
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

// `cd -` left this list in review round 4 #5 (it goes to OLDPWD), and a bare
// `cd` in round 5 (exactly one target; HOME may have been set before it).
// Round 5 additions #1: redirections and comments are not targets.
for (const command of [
  'cd packages/cli && npm test',
  'cd src',
  'cd ..',
  'cd ~',
  'cd src 2>/dev/null || exit 1',
  'cd packages/cli > /dev/null && npm test',
  'pushd packages/cli > /dev/null && npm test && popd > /dev/null',
  'cd src >/dev/null 2>&1',
  'cd src </dev/null',
  'cd src # into src',
  'cd "my folder" 2>&1',
  'if cd src; then ls; fi',
  'time cd src',
  // Review round 6 #1: a newline ends a command; a backslash-newline joins two lines.
  'cd src\nls',
  'set -e\ncd packages/cli\nnpm test',
  'cd ..\nnpm test',
  'cd src \\\n  && ls',
])
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

// Review round 1 (security) #8: a cd target the shell would still expand -
// braces, a variable, ANSI-C quoting, an escape - cannot be judged by its
// words, so it is refused, as a glob is. An allow-list of plain targets.
test('R1#8: a cd whose target the shell expands is refused', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  for (const command of [
    'cd ~/.kub{e..e}',
    'D=~/.kube; cd $D',
    "cd ~/.kub$'\\x65'",
    'cd .vei{l..l}io',
    'cd .ku\\be',
    'cd `echo .kube`',
  ]) {
    const out = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(`${command} -> ${out.deny}`).toContain('a cd there would let a later command read it')
  }
  expect(seen).toHaveLength(0)
})

test('R1#8: a plain cd still runs, and a PowerShell cd with backslashes too', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  const bash = await $.tool.call({ tool: 'Bash', command: 'cd src && ls', description: 'x' })
  expect(bash.deny).toBeUndefined()
  const ps = await $.tool.call({
    tool: 'PowerShell',
    command: 'cd C:\\work\\project\\src',
    description: 'x',
  })
  expect(ps.deny).toBeUndefined()
  expect(seen).toHaveLength(2)
})

// Review round 3 #4: zsh qualifiers and alternation, extglob and zsh's
// extended glob expand too: a cd target is judged only when every character
// is on a short list (letters, digits, marks, _ . / + @ -, a leading ~).
test('R3#4: a cd whose target zsh or extglob would expand is refused', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  for (const command of [
    'cd ~/.ku(b|x)e',
    'cd ~/.kube(/)',
    'cd ~/.kub<->',
    'cd ~/.k#ube',
    'cd ~/.k@(u)be',
    'cd ~/.kube~x',
    'cd ~/.ku^xbe',
  ]) {
    const out = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(`${command} -> ${out.deny}`).toContain('a cd there would let a later command read it')
  }
  expect(seen).toHaveLength(0)
})

test('R3#4: plain cd targets still run: a scoped package folder, a home path, a non-ASCII folder', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  for (const command of [
    'cd node_modules/@types',
    'cd ~/work/project',
    'cd docs/Übersicht',
    'cd ../src',
  ])
    expect((await $.tool.call({ tool: 'Bash', command, description: 'x' })).deny).toBeUndefined()
  expect(seen).toHaveLength(4)
})

// Review round 4 #3: PowerShell's own cd commands, with `\` a separator.
test('R4#3: PowerShell Set-Location, sl and Push-Location into a raw-only folder are refused', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  for (const [command, shown] of [
    ['Set-Location C:\\Users\\dev\\.aws; Get-Content credentials', 'C:\\Users\\dev\\.aws'],
    ['sl ~\\.kube; gc config', '~\\.kube'],
    ['Push-Location ~\\.aws; gc credentials', '~\\.aws'],
    ['Set-Location -Path ~\\.kube; gc config', '~\\.kube'],
  ] as const) {
    const out = await $.tool.call({ tool: 'PowerShell', command, description: 'x' })
    expect(`${command} -> ${out.deny}`).toBe(`${command} -> ${CD(shown)}`)
  }
  expect(seen).toHaveLength(0)
})

// Review round 4 #4: a target quoted so that nothing in it expands is read as
// its text, spaces included, and judged as any other.
test('R4#4: literally quoted cd targets run, and a quoted raw-only folder is still refused', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  for (const [tool, command] of [
    ['Bash', 'cd "my folder"'],
    ['Bash', 'cd "src/My Component"'],
    ['Bash', "cd 'my folder'"],
    ['PowerShell', "cd 'C:\\Program Files\\App'"],
    ['PowerShell', 'cd "C:\\Users\\me\\My Documents"'],
  ] as const)
    expect(`${command} -> ${(await $.tool.call({ tool, command, description: 'x' })).deny}`).toBe(
      `${command} -> undefined`
    )
  expect(seen).toHaveLength(5)
  for (const command of ['cd ".kube"', "cd '.aws'", 'cd "$HOME/x"'])
    expect((await $.tool.call({ tool: 'Bash', command, description: 'x' })).deny).toBeDefined()
  expect(seen).toHaveLength(5)
})

// Review round 4 #5: cd forms whose directory the words do not give.
test('R4#5: CDPATH, two targets, cd - and ~name are refused', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  for (const command of [
    'CDPATH=~/.config cd gcloud',
    'cd x .kube',
    'OLDPWD=~/.kube; cd -',
    'cd ~k',
    'pushd +1',
  ]) {
    const out = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(`${command} -> ${out.deny}`).toContain(`${command} -> ${REASON[command]}`)
  }
  expect(seen).toHaveLength(0)
})

test('R4#3: a Set-Location inside a subexpression is refused too', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  for (const command of [
    'Write-Output $(Set-Location ~\\.kube; gc config)',
    'echo "$(sl ~\\.aws)"',
  ]) {
    const out = await $.tool.call({ tool: 'PowerShell', command, description: 'x' })
    expect(`${command} -> ${out.deny}`).toContain('a cd there would let a later command read it')
  }
  expect(seen).toHaveLength(0)
})

// Review round 5: a cd is followed only in the one form whose directory its
// words give - the cd program first (or after builtin/command), one plain
// target, and a bare relative one only while CDPATH is known to be unset.
// Anything else that runs a cd, and any mention of CDPATH, is refused (#44).
test('R5: cd forms that set CDPATH or prefix the cd are refused', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  for (const command of [
    'read CDPATH <<< ~/.config; cd gcloud',
    'CDPATH+=:~/.config; cd gcloud',
    ': ${CDPATH:=~/.config}; cd gcloud',
    'printf -v CDPATH ~/.config; cd gcloud',
    'HOME=~/.kube cd; cat config',
    'OLDPWD=~/.kube cd -',
    'env HOME=~/.kube cd',
    'exec cd src',
    'LC_ALL=C cd src',
    'cd',
    // Not among the reviewer's: a cd inside another command, and HOME set
    // beside a `~` target.
    "bash -c 'HOME=~/.kube cd; cat config'",
    'HOME=~/.kube; cd ~; cat config',
  ]) {
    const out = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(`${command} -> ${out.deny}`).toContain(`${command} -> ${REASON[command]}`)
  }
  expect(seen).toHaveLength(0)
})

test('R5: with CDPATH in the environment, a bare relative cd is refused and ./ is followed', async ($, on) => {
  project(on, SECRETS, { shellEnv: { CDPATH: '/home/dev/.config' } })
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  expect(
    (await $.tool.call({ tool: 'Bash', command: 'cd gcloud', description: 'x' })).deny
  ).toBeDefined()
  expect(seen).toHaveLength(0)
  expect(
    (await $.tool.call({ tool: 'Bash', command: 'cd ./gcloud', description: 'x' })).deny
  ).toBeUndefined()
  expect(seen).toHaveLength(1)
})

test('R5: plain cds still run while CDPATH is unset', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  const commands = [
    'cd src',
    'cd ./src',
    'cd /abs/path',
    'cd "my folder"',
    'builtin cd src',
    'cd ~',
  ]
  for (const command of commands)
    expect(
      `${command} -> ${(await $.tool.call({ tool: 'Bash', command, description: 'x' })).deny}`
    ).toBe(`${command} -> undefined`)
  expect(seen).toHaveLength(commands.length)
})

test('R5: an environment the guard cannot read may set CDPATH: a bare relative cd is refused', async ($, on) => {
  ownEnv(on)
  on('env.get', () => ({ deny: 'no environment' }))
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  expect(
    (await $.tool.call({ tool: 'Bash', command: 'cd src', description: 'x' })).deny
  ).toBeDefined()
  expect(
    (await $.tool.call({ tool: 'Bash', command: 'cd ./src', description: 'x' })).deny
  ).toBeUndefined()
  expect(seen).toHaveLength(1)
})

test('R5b#1: PowerShell cds with a common parameter or a redirection still run', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  const commands = [
    'Set-Location src -ErrorAction Stop',
    'Push-Location src > $null',
    'Set-Location src -ErrorVariable err',
    "cd 'C:\\Program Files (x86)\\App'",
  ]
  for (const command of commands)
    expect(
      `${command} -> ${(await $.tool.call({ tool: 'PowerShell', command, description: 'x' })).deny}`
    ).toBe(`${command} -> undefined`)
  expect(seen).toHaveLength(commands.length)
})

// Round 5 additions #2-#5: a cd behind a prefix, a shell keyword or a module
// name is still a cd, and DIRSTACK is CDPATH's kin.
test('R5b#2: a cd behind NAME=, if, time, ! or bash -c, a module-qualified Set-Location, and DIRSTACK are refused', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  for (const [tool, command] of [
    ['Bash', 'OLDPWD=~/.aws cd -'],
    ['Bash', 'X= cd project .kube'],
    ['Bash', 'if cd project .kube; then cat config; fi'],
    ['Bash', 'if true; then cd -; fi'],
    ['Bash', 'time cd -'],
    ['Bash', '! cd -'],
    ['Bash', "bash -c 'cd - && cat config'"],
    ['Bash', 'cdpath+=(~/.config); cd gcloud'],
    ['Bash', 'DIRSTACK[1]=~/.kube; pushd +1'],
    ['Bash', 'dirstack=(~/.kube); cd ~1'],
    ['PowerShell', 'Microsoft.PowerShell.Management\\Set-Location ~\\.aws; gc credentials'],
  ] as const) {
    const out = await $.tool.call({ tool, command, description: 'x' })
    expect(`${command} -> ${out.deny}`).toContain(`${command} -> ${REASON[command]}`)
  }
  expect(seen).toHaveLength(0)
})

// A shell keeps what a command exports: CDPATH or HOME set in one call is
// still set in the next, so the guard stops trusting either from then on.
test('R5b#3: CDPATH or HOME exported in one call does not carry to the next (the Bash tool keeps no environment)', async ($, on) => {
  // Round 6 #2 replaces round 5's session-wide distrust: the Bash tool runs
  // each call in a fresh shell, so an export ends with its call.
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  const run = (command: string) => $.tool.call({ tool: 'Bash', command, description: 'x' })
  for (const command of [
    'export CDPATH=~/.config',
    'cd gcloud',
    'export HOME=/tmp/elsewhere',
    'cd ~',
  ])
    expect(`${command} -> ${(await run(command)).deny}`).toBe(`${command} -> undefined`)
  expect(seen).toHaveLength(4)
})

test('R5b#3: a path under /home does not count as naming HOME', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  const run = (command: string) => $.tool.call({ tool: 'Bash', command, description: 'x' })
  expect((await run('ls /home/dev/work')).deny).toBeUndefined()
  expect((await run('cd ~')).deny).toBeUndefined()
  expect(seen).toHaveLength(2)
})

test('R5b#5: a DIRSTACK assignment is refused with no cd in the command, and a plain popd runs', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  const run = (command: string) => $.tool.call({ tool: 'Bash', command, description: 'x' })
  expect((await run('DIRSTACK[1]=~/.kube; popd; cat config')).deny).toBeDefined()
  expect(seen).toHaveLength(0)
  expect((await run('popd')).deny).toBeUndefined()
  expect(seen).toHaveLength(1)
})

// Review round 5b: the shell removes quotes and backslashes before it runs a
// word, so the checks read the words that way too, as well as the text.
test('R5c: CDPATH or HOME set with quotes or a backslash in the same command is still judged set', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  const run = (command: string) => $.tool.call({ tool: 'Bash', command, description: 'x' })
  expect((await run('export C""DPATH=~/.config; cd gcloud')).deny).toContain(
    'a cd Veilio cannot follow (`CDPATH`)'
  )
  expect((await run('export H""OME=~/.kube; cd ~')).deny).toBe(SETS_HOME)
  expect(seen).toHaveLength(0)
})

test('R5c: CDPATH set with a backslash inside in the same command is still judged set', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  const out = await $.tool.call({
    tool: 'Bash',
    command: 'export CD\\PATH=~/.config; cd gcloud',
    description: 'x',
  })
  expect(out.deny).toContain('a cd Veilio cannot follow (`CDPATH`)')
  expect(seen).toHaveLength(0)
})

test('R5c: a cd spelled with quotes or a backslash is refused', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  for (const command of ['c""d ~/.kube; cat config', '\\cd ~/.kube; cat config', "c''d src"]) {
    const out = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(`${command} -> ${out.deny}`).toContain(`${command} -> ${REASON[command]}`)
  }
  expect(seen).toHaveLength(0)
})

test('R6#1: a PowerShell Set-Location then a command on the next line runs, and cd forms across lines stay refused', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  const ps = await $.tool.call({
    tool: 'PowerShell',
    command: 'Set-Location -Path src\nls',
    description: 'x',
  })
  expect(ps.deny).toBeUndefined()
  for (const command of ['cd x .kube\nls', 'cd -\nls', 'cd src\ncd -'])
    expect((await $.tool.call({ tool: 'Bash', command, description: 'x' })).deny).toContain(
      'a cd Veilio cannot follow'
    )
  expect(seen).toHaveLength(1)
})

// Review round 6 #2: the Bash tool keeps no environment between calls, so
// HOME and CDPATH are judged per command, and only where a command sets them.
test('R6#2: naming HOME or CDPATH without setting them breaks no later cd', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  const commands = [
    'echo $HOME',
    'cd ~ && ls',
    'export PATH="$HOME/.local/bin:$PATH"',
    'cd ~/code',
    'ls ${HOME}/.npm ${HOME:-/tmp}',
    'grep -r CDPATH scripts/',
    'cd packages/cli',
    'echo $HOME && cd ~/code',
    'ls ~/.npm; echo ${HOME:-none}',
  ]
  for (const command of commands)
    expect(
      `${command} -> ${(await $.tool.call({ tool: 'Bash', command, description: 'x' })).deny}`
    ).toBe(`${command} -> undefined`)
  expect(seen).toHaveLength(commands.length)
})

test('R6#2: a command that sets HOME or CDPATH is judged with them set', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  const run = (command: string) => $.tool.call({ tool: 'Bash', command, description: 'x' })
  for (const command of [
    'HOME=~/.kube; cd ~',
    'export HOME=/tmp/x; cat ~/credentials',
    'read HOME <<< /tmp/x; ls ~',
    ': ${HOME:=/tmp/x}; cat ~/config',
  ])
    expect(`${command} -> ${(await run(command)).deny}`).toBe(`${command} -> ${SETS_HOME}`)
  for (const command of ['export CDPATH=~/.config; cd gcloud', 'cdpath+=(~/.config); cd gcloud'])
    expect((await run(command)).deny).toContain('a cd Veilio cannot follow (`CDPATH`)')
  expect(seen).toHaveLength(0)
})

// Round 6 additions: a program word the shell still expands could be cd;
// PowerShell's backtick escape is read as PowerShell reads it; an assignment
// whose name the shell builds may set CDPATH, HOME or DIRSTACK.
test('R6b: a cd spelled with ANSI-C quoting or a PowerShell backtick, or a built variable name, is refused', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  const bash = (command: string) => $.tool.call({ tool: 'Bash', command, description: 'x' })
  expect((await bash("$'\\x63d' ~/.kube; cat config")).deny).toContain('a cd Veilio cannot follow')
  expect((await bash('`echo cd` ~/.kube; cat config')).deny).toContain('a cd Veilio cannot follow')
  expect((await bash("export $'CD'PATH=~/.config; cd gcloud")).deny).toContain(
    'a cd Veilio cannot follow (`CDPATH`)'
  )
  expect((await bash('declare "${x}"=~/.config; cd gcloud')).deny).toContain(
    'a cd Veilio cannot follow (`CDPATH`)'
  )
  const ps = await $.tool.call({
    tool: 'PowerShell',
    command: 'c`d ~\\.kube; gc config',
    description: 'x',
  })
  expect(ps.deny).toBeDefined()
  expect(seen).toHaveLength(0)
})

test('R6b: a program word that is a path built at run time still runs, and reading DIRSTACK is fine', async ($, on) => {
  project(on, SECRETS)
  const seen: Fields[] = []
  on(
    'tool.call',
    (_, e) => (seen.push(e), { result: { stdout: '', stderr: '', interrupted: false } })
  )
  for (const command of ['"$(npm bin)/jest" src', 'echo $DIRSTACK; popd'])
    expect(
      `${command} -> ${(await $.tool.call({ tool: 'Bash', command, description: 'x' })).deny}`
    ).toBe(`${command} -> undefined`)
  expect(seen).toHaveLength(2)
})
