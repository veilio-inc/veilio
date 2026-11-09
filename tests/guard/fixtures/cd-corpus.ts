// Spec 086 T004 (research R7): the cd differential corpus. Every entry is
// judged on the base (tests/guard/fixtures/cd-differential.base.json) and on
// the branch; tests/guard/cd-differential.test.ts compares them.
//
// - bench: the Bash calls of the 078 and 085 benchmark sessions, anonymised
//   in Cloud (specs/086-guard-cd-hardening/bench/extract-corpus.mjs) into
//   cd-bench-corpus.json: each with its session's earlier calls.
// - test-078: the cd commands of the guard's tests on main (078's, and 085's
//   H17/L17 that main kept); test-085: those only 085's round tests had (CE
//   7d4ac30, since reverted). A PowerShell-looking one is in both tools.
// - ordinary, attack: contracts/cd-verdicts.md and research R4.
// - hand: PowerShell, non-ASCII and two-call forms written for 086.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type CorpusEntry = {
  id: string
  command: string
  tool: 'Bash' | 'PowerShell'
  source: 'bench' | 'test-078' | 'test-085' | 'ordinary' | 'attack' | 'hand'
  /** Earlier calls of the same session, run before this one. */
  calls?: string[]
  /** The bench session it came from: its entries replay on one guard. */
  session?: number
}

const TEST_078 = [
  'cd .kube; cat config',
  'cd ~/.aws && cat credentials',
  'pushd .veilio && cat map.json',
  'cd secrets && cat db.txt',
  "cd .veilio && printf '{}' > guard.json",
  'cd .aws',
  'cd ~/.config && cat gcloud/credentials.db',
  'cd .docker',
  'pushd .kube',
  'cd ./secrets/',
  'cd x && cd ../.veilio',
  'ls; cd .azure/profiles',
  'ls & cd .aws',
  'ls\ncd .aws',
  '(cd .aws && ls)',
  'cd -P .aws',
  'cd /home/dev/.config/gcloud',
  'cd packages/cli && npm test',
  'cd src',
  'cd ..',
  'cd ~',
  'cd',
  'cd -',
  'cd sub && cat notes',
  'cd sub',
  'cd sub && cat readme.md',
  'cd /outside',
  'cd .a*s && cat credentials',
  'echo $(cd .aws && cat credentials)',
  'echo `cd .aws; cat credentials`',
  "bash -c 'cd .aws && cat credentials'",
  'eval "cd .aws && cat credentials"',
  "bash -c 'cd .aws && cat cred*'",
  'bash -c \'cd ".aws" && cat credentials\'',
  'sh -c "cd \'.aws\' && cat credentials"',
  "bash -c 'cd -- .aws && cat credentials'",
  "bash -c 'cd .a*s && cat credentials'",
  'echo "$(cd .a*s && cat credentials)"',
  "env bash -c 'cd .a*s && cat credentials'",
  "command bash -c 'cd .a*s && cat credentials'",
  "exec bash -c 'cd .a*s && cat credentials'",
  "/bin/bash -c 'cd .a*s && cat credentials'",
  "nohup /usr/bin/zsh -c 'cd .aws && cat credentials'",
  "xargs sh -c 'cd .a*s && cat credentials'",
  'cat <(cd .a*s && cat credentials)',
  'echo $( (cd .a*s && cat credentials) )',
  "sudo bash -c 'cd .aws && cat credentials'",
  "xargs sh -c 'cd .kube; cat config'",
  "find . -exec sh -c 'cd .aws && cat credentials' \\;",
  "$x -c 'cd .aws && cat credentials'",
  "/bin/ba?h -c 'cd .aws && cat credentials'",
  'python -c "import os; os.system(\'cd .aws && cat credentials\')"',
  "su -c 'cd .aws && cat credentials'",
  "watch 'cd .a*s && cat credentials'",
  "grep 'x\\' ; cd .a*s ; cat credentials",
  'grep -n x README.md\ncd .a*s && cat credentials',
  'echo "$x" "cd .a*s && cat credentials"',
  'git commit -m "ci: cd [skip ci]"',
  'echo "cd .aws && cat credentials" | sh',
  "printf 'cd .kube\\ncat config' | bash",
  'echo <(cd .aws; cat credentials)',
  'grep -h "cd .aws" notes.txt > >(sh)',
  'echo "cd .aws" | { sh; }',
  'grep -h "cd .aws" notes.txt | sort --compress-program=sh',
  'rg --pre=sh "cd .aws" notes.txt',
  'rg --pre-glob "*" "cd .aws" notes.txt',
  'grep --include=x "cd .a*s" notes.txt',
  'grep -h "cd .a*s" notes.txt | sort',
  'grep -rn "cd *" scripts/',
  'echo "next: cd [the folder]"',
  'grep "cd x" notes.txt | wc -l',
  'grep -h "cd *" notes.txt | uniq -c | head -n 3',
  'grep -rniw -e "cd *" scripts/',
  'rg -n -t sh "cd *" scripts/',
  'echo -n "cd [x]" | wc -l',
  "printf 'cd *' | wc -c",
  "cd .claude && echo '{}' > settings.json",
  'cd .claude',
  'echo $(cd /tmp && pwd)',
]

const TEST_085 = [
  'CDPATH=~/.config cd gcloud',
  'cd x .kube',
  'OLDPWD=~/.kube; cd -',
  'cd ~k',
  'pushd +1',
  'read CDPATH <<< ~/.config; cd gcloud',
  'CDPATH+=:~/.config; cd gcloud',
  ': ${CDPATH:=~/.config}; cd gcloud',
  'printf -v CDPATH ~/.config; cd gcloud',
  'HOME=~/.kube cd; cat config',
  'OLDPWD=~/.kube cd -',
  'env HOME=~/.kube cd',
  'exec cd src',
  'LC_ALL=C cd src',
  "bash -c 'HOME=~/.kube cd; cat config'",
  'HOME=~/.kube; cd ~; cat config',
  'OLDPWD=~/.aws cd -',
  'X= cd project .kube',
  'if cd project .kube; then cat config; fi',
  'if true; then cd -; fi',
  'time cd -',
  '! cd -',
  "bash -c 'cd - && cat config'",
  'cdpath+=(~/.config); cd gcloud',
  'DIRSTACK[1]=~/.kube; pushd +1',
  'dirstack=(~/.kube); cd ~1',
  'Microsoft.PowerShell.Management\\Set-Location ~\\.aws; gc credentials',
  'c""d ~/.kube; cat config',
  '\\cd ~/.kube; cat config',
  "c''d src",
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
  'cd ~/.kub{e..e}',
  'D=~/.kube; cd $D',
  "cd ~/.kub$'\\x65'",
  'cd .vei{l..l}io',
  'cd .ku\\be',
  'cd `echo .kube`',
  'cd src && ls',
  'cd C:\\work\\project\\src',
  'cd ~/.ku(b|x)e',
  'cd ~/.kube(/)',
  'cd ~/.kub<->',
  'cd ~/.k#ube',
  'cd ~/.k@(u)be',
  'cd ~/.kube~x',
  'cd ~/.ku^xbe',
  'cd node_modules/@types',
  'cd ~/work/project',
  'cd docs/Übersicht',
  'cd ../src',
  'Set-Location C:\\Users\\dev\\.aws; Get-Content credentials',
  'sl ~\\.kube; gc config',
  'Push-Location ~\\.aws; gc credentials',
  'Set-Location -Path ~\\.kube; gc config',
  'cd "my folder"',
  'cd "src/My Component"',
  "cd 'my folder'",
  "cd 'C:\\Program Files\\App'",
  'cd "C:\\Users\\me\\My Documents"',
  'cd ".kube"',
  "cd '.aws'",
  'cd "$HOME/x"',
  'Write-Output $(Set-Location ~\\.kube; gc config)',
  'echo "$(sl ~\\.aws)"',
  'cd gcloud',
  'cd ./gcloud',
  'cd ./src',
  'cd /abs/path',
  'builtin cd src',
  'Set-Location src -ErrorAction Stop',
  'Push-Location src > $null',
  'Set-Location src -ErrorVariable err',
  "cd 'C:\\Program Files (x86)\\App'",
  'DIRSTACK[1]=~/.kube; popd; cat config',
  'popd',
  'export C""DPATH=~/.config; cd gcloud',
  'export H""OME=~/.kube; cd ~',
  'export CD\\PATH=~/.config; cd gcloud',
  'Set-Location -Path src\nls',
  'cd x .kube\nls',
  'cd -\nls',
  'cd src\ncd -',
  'cd ~ && ls',
  'cd ~/code',
  'cd packages/cli',
  'echo $HOME && cd ~/code',
  'HOME=~/.kube; cd ~',
  'export CDPATH=~/.config; cd gcloud',
  '`echo cd` ~/.kube; cat config',
  "export $'CD'PATH=~/.config; cd gcloud",
  'declare "${x}"=~/.config; cd gcloud',
  'echo $DIRSTACK; popd',
]

/** The test commands above that read as PowerShell: judged as PowerShell too. */
const TEST_PS = [
  'Microsoft.PowerShell.Management\\Set-Location ~\\.aws; gc credentials',
  'cd C:\\work\\project\\src',
  'Set-Location C:\\Users\\dev\\.aws; Get-Content credentials',
  'sl ~\\.kube; gc config',
  'Push-Location ~\\.aws; gc credentials',
  'Set-Location -Path ~\\.kube; gc config',
  "cd 'C:\\Program Files\\App'",
  'cd "C:\\Users\\me\\My Documents"',
  'Write-Output $(Set-Location ~\\.kube; gc config)',
  'echo "$(sl ~\\.aws)"',
  'Set-Location src -ErrorAction Stop',
  'Push-Location src > $null',
  'Set-Location src -ErrorVariable err',
  "cd 'C:\\Program Files (x86)\\App'",
  'Set-Location -Path src\nls',
]

// contracts/cd-verdicts.md, the ordinary list (US4): each runs.
const ORDINARY = [
  'cd',
  'cd -',
  'cd ~',
  'cd ..',
  'cd src',
  'cd packages/cli && npm test',
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
]
const ORDINARY_PS = [
  'Set-Location src; npm test',
  'Set-Location -Path src -ErrorAction Stop',
  'Set-Location "C:\\Program Files (x86)\\App"',
  'Push-Location src; npm test; Pop-Location',
]

// research.md R4, every form 085's review rounds reproduced.
const ATTACK = [
  // Round 1 (S8)
  'cd ~/.kub{e..e}',
  'D=~/.kube; cd $D',
  'cd `printf .kube`',
  'cd \\.kube',
  // Round 3 (#4)
  'cd ~/.ku(b|x)e',
  'cd ~/.kube(/)',
  'cd ~/.kub<->',
  'cd ~/.k#ube',
  'cd ~/.k@(u)be',
  'cd ~/.kube~x',
  'cd ~/.ku^xbe',
  // Round 4 (#3-#5)
  'CDPATH=~/.config cd gcloud',
  'cd x .kube',
  'OLDPWD=~/.kube; cd -',
  'cd ~k',
  'pushd +1',
  // Round 5
  'HOME=~/.kube cd; cat config',
  'OLDPWD=~/.kube cd -',
  'env HOME=~/.kube cd',
  'exec cd src',
  'LC_ALL=C cd src',
  "bash -c 'HOME=~/.kube cd; cat config'",
  "bash -c 'cd - && cat config'",
  'read CDPATH <<< ~/.config; cd gcloud',
  'CDPATH+=:~/.config; cd gcloud',
  ': ${CDPATH:=~/.config}; cd gcloud',
  'printf -v CDPATH ~/.config; cd gcloud',
  'cdpath+=(~/.config); cd gcloud',
  'DIRSTACK[1]=~/.kube; pushd +1',
  // Round 5b
  'export C""DPATH=~/.config; cd gcloud',
  'export H""OME=~/.kube; cd ~',
  'export CD\\PATH=~/.config; cd gcloud',
  'c""d ~/.kube; cat config',
  '\\cd ~/.kube; cat config',
  "c''d src",
  // Round 6
  'cd x .kube\nls',
  'cd -\nls',
  'cd src\ncd -',
  "$'\\x63d' ~/.kube",
  '`echo cd` ~/.kube; cat config',
  "export $'CD'PATH=~/.config; cd gcloud",
  'declare "${x}"=~/.config; cd gcloud',
  'HOME=~/.kube; cat ~/credentials',
  // COVERAGE #47's parked forms
  'cd project .kube',
  '.kube',
  '~/.kube',
  'for HOME in ~/.kube; do cd; cat config; done',
  // Not moving the shell (FR-015): 078's floor decides
  'env cd ~/.aws',
  'exec cd ~/.aws',
  'sudo cd ~/.aws',
  'nohup cd ~/.aws',
  'timeout 1 cd ~/.aws',
  'echo ~/.aws | xargs cd',
  '/usr/bin/cd ~/.aws',
]
const ATTACK_PS = [
  'Set-Location C:\\Users\\dev\\.aws; Get-Content credentials',
  'sl ~\\.kube; gc config',
  'Push-Location ~\\.aws; gc credentials',
  'Write-Output $(Set-Location ~\\.kube; gc config)',
  'Microsoft.PowerShell.Management\\Set-Location ~\\.aws; gc credentials',
  'c`d ~\\.kube',
]

const HAND_PS = ['Set-Location έγγραφα', 'Set-Location "Wnioski\\źródła"; ls', 'cd Straße']
// contracts/cd-verdicts.md "Scope", the two-call rows.
const HAND_CALLS: [string[], string][] = [
  [['cd sub'], 'cat notes'],
  [['cd packages/cli'], 'cat .npmrc'],
  [['export CDPATH=~/.config'], 'cd gcloud'],
  [['cd /tmp'], 'cat notes'],
  [['cd sub', 'cd ..'], 'cat notes'],
]

type Raw = { tool: 'Bash' | 'PowerShell'; command: string }[][]
const BENCH: Raw = JSON.parse(
  readFileSync(join(import.meta.dirname, 'cd-bench-corpus.json'), 'utf8')
)

const entries: CorpusEntry[] = []
const seen = new Set<string>()
const add = (e: Omit<CorpusEntry, 'id'>, id: string) => {
  // One entry per tool and command (single calls): the first source wins,
  // and the lists are added attack first, so an attack form keeps its source.
  const key = `${e.tool}\0${e.calls?.join('\0') ?? ''}\0${e.command}`
  if (e.source !== 'bench' && seen.has(key)) return
  seen.add(key)
  entries.push({ id, ...e })
}
ATTACK.forEach((c, i) => add({ command: c, tool: 'Bash', source: 'attack' }, `attack:${i}`))
ATTACK_PS.forEach((c, i) =>
  add({ command: c, tool: 'PowerShell', source: 'attack' }, `attack-ps:${i}`)
)
ORDINARY.forEach((c, i) => add({ command: c, tool: 'Bash', source: 'ordinary' }, `ordinary:${i}`))
ORDINARY_PS.forEach((c, i) =>
  add({ command: c, tool: 'PowerShell', source: 'ordinary' }, `ordinary-ps:${i}`)
)
HAND_PS.forEach((c, i) => add({ command: c, tool: 'PowerShell', source: 'hand' }, `hand-ps:${i}`))
HAND_CALLS.forEach(([calls, c], i) =>
  add({ command: c, tool: 'Bash', source: 'hand', calls }, `hand-calls:${i}`)
)
TEST_078.forEach((c, i) => add({ command: c, tool: 'Bash', source: 'test-078' }, `test-078:${i}`))
TEST_085.forEach((c, i) => add({ command: c, tool: 'Bash', source: 'test-085' }, `test-085:${i}`))
TEST_PS.forEach((c, i) =>
  add(
    { command: c, tool: 'PowerShell', source: TEST_078.includes(c) ? 'test-078' : 'test-085' },
    `test-ps:${i}`
  )
)
BENCH.forEach((calls, s) =>
  calls.forEach((c, i) =>
    add(
      {
        command: c.command,
        tool: c.tool,
        source: 'bench',
        calls: calls.slice(0, i).map((x) => x.command),
        session: s,
      },
      `bench:${s}:${i}`
    )
  )
)

export const CORPUS: readonly CorpusEntry[] = entries
