import { spawnSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'
import {
  ANY_TEXT as ANY,
  globMayBeRawOnly,
  namesRawOnlyFolder,
} from '../../plugins/veilio-guard/lib/paths.ts'
import {
  dataPositions,
  dotsMatch,
  pieces,
  namesVeilioFolder,
  readsStrictly,
  spellings,
  textPieces,
  textsOf,
  withoutData,
  wordsOf,
} from '../../plugins/veilio-guard/lib/reading.ts'
import { parseShell, type Word } from '../../plugins/veilio-guard/lib/shell.ts'
import { fixtureGuard } from './fixtures/cd-project.ts'
import { F1, F2, F8, INTERPRETER_ALLOWED, INTERPRETER_REFUSED } from './fixtures/reading-corpora.ts'
import { CLUSTERS, POSITIONS } from './fixtures/reading-grammar.ts'
import { guardAt, memoryFixture, verdict } from './fixtures/reading-shell.ts'

// Spec 091: the reader's parts, one test per row of the reading table
// (contracts/reading-table.md in the spec): wordsOf (every position),
// spellings (E1-E12), pieces and the text floor (§4), the wildcard judge (§3).

const words = (command: string): Word[] => {
  const p = parseShell(command, 'sh')
  if (!p.ok) throw new Error(`unreadable (${p.why}): ${command}`)
  return wordsOf(p.list)
}
/** The first argument of `cat WORD`. */
const arg = (word: string): Word => {
  const p = parseShell(`cat ${word}`, 'sh')
  if (!p.ok) throw new Error(`unreadable (${p.why}): ${word}`)
  const n = p.list.items[0]!.node.stages[0]!
  if (n.type !== 'simple') throw new Error('not a simple command')
  return n.words[1]!
}
const HOME = '/home/dev'
const spell = (word: string, o: { homeKnown?: boolean; strict?: boolean } = {}) =>
  spellings(arg(word), { home: HOME, homeKnown: o.homeKnown ?? true, strict: o.strict ?? false })

describe('wordsOf: a word is returned wherever it stands', () => {
  const W = ".e''nv"
  /** W is a word of the command, or the end of one that holds no command. */
  const holds = (command: string) =>
    words(command).some((w) => w.raw === W || (w.raw.endsWith(W) && !/\$\(|`|[<=]\(/.test(w.raw)))
  test.each(
    [...POSITIONS, ...CLUSTERS].filter((p) => p.executed).map((p) => [p.id, p.make(W)] as const)
  )('%s %s', (_, command) => {
    // Read where it stands, or the command is one Veilio does not read (refused).
    expect(!parseShell(command, 'sh').ok || holds(command), command).toBe(true)
  })

  test.each([
    ['a redirect on until', `until cat; do :; done < ${W}`],
    ['a here-string', `cat <<< ${W}`],
    ['a declared assignment', `declare -x F=${W}`],
    ['an array assignment', `a=(x ${W})`],
    ['a declared array', `declare -a f=(x ${W})`],
    ['a case word', `case ${W} in x) ;; esac`],
    ['a substitution in a case pattern', `case x in $(cat ${W})) ;; esac`],
    ['a substitution in an arithmetic for', `for (( i=$(cat ${W}); i<1; i++ )); do :; done`],
    ['a substitution in an arithmetic command', `(( $(cat ${W}) ))`],
    ['a nested default', `echo \${x:-\${y:-$(cat ${W})}}`],
    ['a backtick in a here-document', `cat <<EOF\n\`cat ${W}\`\nEOF`],
    ['a here-document under a quoted delimiter', `cat <<'EOF'\n$(cat ${W})\nEOF`],
    ['a here-document, after two backslashes', `cat <<EOF\n\\\\$(cat ${W})\nEOF`],
    ['a here-document, a backtick after two backslashes', `cat <<EOF\n\\\\\`cat ${W}\`\nEOF`],
    ['a here-document, $(( that is a command', `cat <<EOF\n$((cat ${W}); echo)\nEOF`],
    ['a here-document, inside arithmetic', `cat <<EOF\n$(( $(cat ${W}) ))\nEOF`],
    ['zsh =( )', `cat =(cat ${W})`],
    ['a group glued to a word in a for list', `for f in src/*(N) ${W}; do :; done`],
    ['a function body', `f() { cat ${W}; }`],
    ['a pipeline stage in the background', `cat ${W} | cat &`],
    ['[[ ]]', `[[ -f ${W} ]]`],
  ])('%s: %s', (_, command) => {
    expect(holds(command), command).toBe(true)
  })

  test('the parser still reads these as before', () => {
    for (const c of [
      '[[ a =~ ^(x|y)$ ]]',
      'f() { :; }',
      'a=(1 2)',
      'case x in (a) ;; esac',
      'echo $(cmd)',
      'cat <(cmd)',
      'echo "${MSG:-it\'s fine}"',
      'echo $(( (a + b) * 2 << 1 ))',
      "cat > notes.md <<'EOF'\nit's `unbalanced and $(not closed\nEOF",
    ])
      expect(parseShell(c, 'sh').ok, c).toBe(true)
  })

  // A nested shell: only an allow-list of invocation shapes is read; any
  // other shape that may run a script given in the command is unreadable.
  test.each(
    [
      `bash -c 'cat ${W}'`,
      `sh -ec 'cat ${W}'`,
      `bash -lc 'cat ${W}'`,
      `bash -xec 'cat ${W}' arg`,
      `bash -e -u -c 'cat ${W}'`,
      `bash -o pipefail -c 'cat ${W}'`,
      `bash -euo pipefail -c 'cat ${W}'`,
      `sh -euxo pipefail -c 'cat ${W}'`,
      `zsh -o errexit -o nounset -c 'cat ${W}'`,
      `env FOO=1 bash -c 'cat ${W}'`,
      `bash -c 'cat ${W}' -O dotglob`,
      `bash -e <<EOF\ncat ${W}\nEOF`,
      `bash <<< 'cat ${W}'`,
      // Addendum 2 (research D22): options that change neither the script word nor how words are read.
      `bash --norc -c 'cat ${W}'`,
      `bash --noprofile --norc -c 'cat ${W}'`,
      `bash --login -ec 'cat ${W}'`,
      `zsh -fc 'cat ${W}'`,
      `zsh -df -c 'cat ${W}'`,
      `zsh -f -o pipefail -c 'cat ${W}'`,
    ].map((c) => c.replace(/'cat \.e''nv'/, `"cat .e''nv"`))
  )('a nested shell in a known shape is read: %s', (command) => {
    expect(holds(command), command).toBe(true)
  })

  test.each([
    'bash -O dotglob -c "ls"',
    'bash -c -O dotglob "ls"',
    'bash -cO dotglob "ls"',
    'bash -Oc dotglob "ls"',
    'bash -oc pipefail "ls"',
    'bash -o posix -c "ls"',
    'bash +e -c "ls"',
    'bash -ac "ls"',
    // A long option after the letters is not in the shapes.
    'bash -e --norc -c "ls"',
    'bash --posix -c "ls"',
    'bash --rcfile /dev/null -c "ls"',
    'bash -c --norc "ls"',
    'bash -c -- "ls"',
    'bash -c - "ls"',
    'bash -- -c "ls"',
    'bash "$FLAGS" -c "ls"',
    'zsh -o globdots -c "ls"',
    'zsh -oglobdots -c "ls"',
    'zsh -Oc "ls"',
    'zsh -c4 "ls"',
    'zsh -bc "ls"',
    'zsh --emulate sh -c "ls"',
    "sh -c'ls src'",
    "zsh -o globdots <<'EOF'\nls\nEOF",
    "bash -O dotglob <<< 'ls'",
  ])('any other shape that may run a script from the command is unreadable: %s', (command) => {
    expect(parseShell(command, 'sh').ok, command).toBe(false)
  })

  test.each([
    'bash scripts/build.sh',
    'bash -x scripts/build.sh',
    'bash --norc scripts/build.sh',
    'bash -O extglob scripts/build.sh',
    'bash -n scripts/build.sh',
    'bash "$SCRIPT_DIR/build.sh" --release',
    'sh "$0" --help',
    'bash -c "$CMD"',
    'bash --version',
    'zsh --help',
  ])(
    'a shell that runs a file, or a script built at run time, is read as before: %s',
    (command) => {
      expect(parseShell(command, 'sh').ok, command).toBe(true)
    }
  )

  test('a here-document: an escaped substitution does not run and is not read as one', () => {
    // Not a substitution of this shell. (Since addendum 2 the body is also
    // read as text a program that is a shell under another name could run,
    // A5b; for `cat` it is data, A12 - both below.)
    for (const c of [`cat <<EOF\n\\$(cat ${W})\nEOF`, `cat <<EOF\n\\\\\\$(cat ${W})\nEOF`]) {
      const p = parseShell(c, 'sh')
      const n = p.ok ? p.list.items[0]!.node.stages[0]! : null
      expect(n?.type === 'simple' && n.redirects[0]!.substs, c).toBeUndefined()
    }
  })

  test('a here-document under a plain delimiter with a substitution that cannot be read is unreadable', () => {
    expect(parseShell('cat <<EOF\n$(cat "x\nEOF', 'sh').ok).toBe(false)
  })
})

describe('spellings: the reading table', () => {
  test.each([
    ['E1 empty quotes', `.e''nv`, ['.env']],
    ['E1 a quoted part', `'.e'nv`, ['.env']],
    ['E1 double quotes', `".env"`, ['.env']],
    ['E2 a backslash', `.e\\nv`, ['.env']],
    ['E2 a line continuation', `.e\\\nnv`, ['.env']],
    ['E3 ANSI-C', `$'.env'`, ['.env']],
    ['E3 ANSI-C hex', `.e$'\\x6e'v`, ['.env']],
    ['E3 ANSI-C octal', `$'\\056env'`, ['.env']],
    ['E4 locale quotes', `$".env"`, ['.env']],
    ['E5 a brace list', `{.e,x}nv`, ['.env', 'xnv']],
    ['E5 a brace sequence', `.en{v..v}`, ['.env']],
    ['E5 an empty member', `.e{n,}v`, ['.env', '.ev']],
    ['E5 nested braces', `.e{{n,y},x}v`, ['.env', '.eyv', '.exv']],
    ['E6 tilde', `~/x`, [`${HOME}/x`]],
    ['E7 $HOME', `$HOME/x`, [`${HOME}/x`]],
    ['E7 ${HOME}', `\${HOME}/x`, [`${HOME}/x`]],
    ['E11 a default', `\${x:-.env}`, ['.env']],
    ['E11 a default without the colon', `\${x-.env}`, ['.env']],
    ['E11 an assigned default', `\${x:=.env}`, ['.env']],
    ['E11 an alternate value', `\${HOME:+.env}`, ['.env']],
    ['E11 a nested default', `\${x:-\${y:-.env}}`, ['.env']],
    ['E11 a default in double quotes', `"\${x:-.env}"`, ['.env']],
    ['E11 a default for one letter', `.e\${x:-n}v`, ['.env']],
    ['E11 a run-time part in a default, read where it stands', `.e\${x:-\${Z}n}v`, ['.env']],
    ['E11b a replacement', `\${y/a/.env}`, ['.env']],
    ['E11b a replacement of every match', `\${y//a/.env}`, ['.env']],
    ['E11b a replacement at the start', `\${y/#a/.env}`, ['.env']],
    ['E11b a replacement at the end', `\${y/%a/.env}`, ['.env']],
    ['E11b a replacement for one letter', `.e\${y/a/n}v`, ['.env']],
    ['E11b a replacement beside text', `\${y/a/.e}nv`, ['.env']],
    ['E11b a replacement past a subscript', `\${a[0]/a/.env}`, ['.env']],
    ['E11b a pattern with an escaped slash', `\${y/a\\/b/.env}`, ['.env']],
  ])('%s: %s', (_, word, expected) => {
    const read = spell(word)
    for (const name of expected) expect(read, word).toContain(name)
    // What real bash makes of the word is among the spellings.
    const bash = spawnSync('bash', ['--noprofile', '--norc', '-c', `printf '%s\\n' ${word}`], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME },
      cwd: '/',
    })
    if (bash.status === 0 && process.platform !== 'win32')
      for (const line of bash.stdout.split('\n').filter(Boolean)) expect(read, word).toContain(line)
  })

  test.each([
    ['E8 a bracket list', `.e[n]v`, ['.env']],
    // A2: a range of letters stands for them in both cases (a collating locale folds them).
    ['E8 a bracket range', `.e[m-o]v`, ['.emv', '.env', '.eov', '.eMv', '.eNv', '.eOv']],
    ['E8 a bracket list of several', `server.pe[mx]`, ['server.pem', 'server.pex']],
  ])('%s: %s', (_, word, expected) => {
    expect([...spell(word)].sort()).toEqual([...expected].sort())
  })

  test.each([
    ['"$a.$b"', ['.']],
    ['$f.txt', ['.txt']],
    ['$BASE..$HEAD', ['..']],
    ['"$(pwd)":/app', [':/app']],
    [`$Z.e''nv`, ['.env']],
    // A4: the text on each side of an unquoted run-time part is read too.
    ['.e${Z}nv', ['.env', '.e', 'nv']],
    ['$DIR/.env', ['**/.env', '/.env']],
    ['$A/$B', ['/']],
    ['$F', []],
    ['"$1"', []],
    ['secrets/$f', ['secrets/**', 'secrets/']],
    ['id_ed$((25519))', ['id_ed*']],
    ['id_ed${x:-$((25519))}', ['id_ed', 'id_ed*']],
    ['id_ed${x:-${y:-$((25519))}}', ['id_ed', 'id_ed*']],
    ['f$((i+1)).txt', ['f*.txt']],
    ['$((n))', []],
    ['logs/$((n))', ['logs/**']],
    ['.e$(echo n)v', ['.ev', '.e', 'v']],
    ['${x}nv', ['nv']],
    ['sec$X/customers.csv', ['sec/customers.csv', 'sec', '/customers.csv']],
    ['"$(pwd)"/src', ['**/src']],
    ['`pwd`/.env', ['**/.env', '/.env']],
  ])('E10, E12: %s is read as %j', (word, expected) => {
    expect(spell(word)).toEqual(expected)
  })

  test('E6, E7: with HOME set in the command, ~ and $HOME are any folder', () => {
    expect(spell('~/x', { homeKnown: false })).toEqual(['**/x'])
    expect(spell('$HOME/x', { homeKnown: false })).toEqual(['**/x', '/x'])
  })

  test('E6, E7: ~+, ~-, ~user, $PWD and $OLDPWD are any folder, not the session directory', () => {
    for (const w of ['~+/x', '~-/x', '~dev/x', '"$PWD"/x']) expect(spell(w), w).toEqual(['**/x'])
    // Unquoted, the text after the variable is a word of its own too (A4).
    for (const w of ['$PWD/x', '$OLDPWD/x']) expect(spell(w), w).toEqual(['**/x', '/x'])
  })

  test('E9: a wildcard stays a wildcard; a quoted one is an ordinary character', () => {
    expect(spell('.en?')).toEqual(['.en?'])
    // A2: a bracket expression that is not expanded exactly is one character.
    expect(spell('.en[[:alpha:]]')).toEqual(['.en?'])
    expect(spell('.e[!x]v')).toEqual(['.e?v'])
    expect(spell(`'.en*'`).some((s) => /[*?[]/.test(s))).toBe(false)
  })

  test('E4: locale quotes holding an expansion are a run-time value', () => {
    expect(spell('$"$x"/.env')).toEqual(['**/.env'])
  })
})

describe('spellings: zsh and strict reading (reading table Z1-Z6, §2)', () => {
  test.each([
    // Addendum 3 (contract §8.1, A3): a group of plain alternatives is read
    // exactly, as a brace list; any other group is any text, as before.
    ['Z1 a group', '.e(n)v', ['.env', '.ev']],
    ['Z1 alternatives', '.e(n|x)v', ['.env', '.exv']],
    ['Z1 a group that starts the word', '(s)erver.pem', ['server.pem', 'erver.pem']],
    ['Z1 a group with a wildcard', '.e(n*)v', [`.e${ANY}v`]],
    ['Z1 a group in a group', '.e((n)|x)v', [`.e${ANY}v`]],
    ['Z1 alternatives with an empty one', 's(r|)c/x', ['src/x', 'sc/x']],
    ['Z1 ksh @( )', '.e@(n)v', [`.e${ANY}v`]],
    ['Z1 ksh ?( )', '.e?(x)nv', [`.e${ANY}nv`]],
    ['Z1 ksh +( )', '.e+(n)v', [`.e${ANY}v`]],
    ['Z2 a qualifier', '.e*(.)', ['.e**']],
    ['Z2 a qualifier after a name', '*.ts(om)', ['*.ts**']],
    ['Z2 a qualifier after a name it ends', 'server.pem(.)', ['server.pem**']],
    ['Z1 a group that ends the word', 'server.pe(m|x)', ['server.pem', 'server.pex']],
    ['Z2 a qualifier on a bare wildcard', '*(.)', ['**']],
    ['Z1 a group after * inside the word', 'serv*(.)pem', [`serv*${ANY}pem`]],
    ['Z1 a group before a qualifier', 'server.pe(m)(.)', ['server.pem**', 'server.pe**']],
    [
      'Z1 a group after = that the word goes on from',
      'if=(s)erver.pem',
      ['if=server.pem', 'if=erver.pem'],
    ],
    ['Z3 a numeric range', 'id_ed<->', ['id_ed*']],
    ['Z3 a numeric range with bounds', 'f<1-9>.txt', ['f*.txt']],
  ])('%s: %s', (_, word, expected) => {
    expect(spell(word)).toEqual(expected)
  })

  test('A3: a group alone is read too, and a function definition is not a group', () => {
    expect(spell('(.env|x)')).toEqual(['.env', 'x'])
    expect(spell('(.en*|x)')).toEqual([ANY])
    expect(parseShell('f() { cat x; }', 'sh').ok).toBe(true)
    expect(parseShell('f ( ) { cat x; }', 'sh').ok).toBe(true)
  })

  test('E11b: zsh ::=, :/, :s and :gs hold written text; a pattern alone does not', () => {
    for (const w of ['${x::=.env}', '${y:/a/.env}', '${y:s/a/.env/}', '${y:gs/a/.env/}'])
      expect(spell(w), w).toContain('.env')
    expect(spell('${y/.env}')).toEqual([])
    expect(spell('${y/.env/}')).toEqual([])
    expect(spell('${${x}/a/.env}')).toBe('any')
  })

  test.each([
    // A quoted wildcard character is an ordinary one: shown as \u0001.
    ['a ] first in the list', '.[]e]nv', ['.\u0001nv', '.env']],
    ['a ] after a backslash', '.[e\\]]nv', ['.env', '.\u0001nv']],
    ['a backslash first', '.[\\]e]nv', ['.\u0001nv', '.env']],
    ['a quoted member', `.e["n"]v`, ['.env']],
    ['a range of digits', 'f[1-3]', ['f1', 'f2', 'f3']],
    ['a range of capitals', 'f[A-B]', ['fA', 'fa', 'fB', 'fb']],
  ])('A2: %s is a member: %s', (_, word, expected) => {
    expect([...spell(word)].sort()).toEqual([...expected].sort())
  })

  test.each([
    ['negated', '.[!\\]]nv'],
    ['negated with ^', '.[^x]nv'],
    ['a collating symbol', '.[[.e.]]nv'],
    ['an equivalence class', '.[[=e=]]nv'],
    ['a class', '.[[:alpha:]]nv'],
    ['a range with mixed ends', '.[d-F]nv'],
    ['a range from a capital to a small letter', '.[E-e]nv'],
    ['a range of other characters', '.[+-z]nv'],
    ['more than 64 characters', `.[a-zA-Z0-9_${"'"}!@#$%${"'"}]nv`],
  ])('A2: a bracket expression that is %s is one character: %s', (_, word) => {
    expect(spell(word)).toEqual(['.?nv'])
  })

  test('A2: a [ with no closing ] is text, as the shells read it', () => {
    expect(spell('a[b')).toEqual(['a[b'])
    expect(parseShell('[ -f x ] && echo [', 'sh').ok).toBe(true)
  })

  test.each([
    ['((.e)nv)', [ANY]],
    ['(.(e)nv)', [ANY]],
    ['(.e(n|x)v|y)', [ANY]],
    ['.e((n))v', [`.e${ANY}v`]],
    ['.e(((n|x))|y)v', [`.e${ANY}v`]],
    // After `name=` too: an array's words hold no group.
    ['if=((.e)nv)', [`if=${ANY}`]],
    ['if=(.e(n|x)v|x)', [`if=${ANY}`]],
  ])('A3: groups inside groups are any text: %s', (word, expected) => {
    expect(spell(word)).toEqual(expected)
  })

  test.each([
    `sub(e:'REPLY=.env':)`,
    // `e` with another delimiter than the colon.
    `sub(e{'x=.env'})`,
    'sub(+f)',
    '*(P:.env:)',
    'sub(:s/sub/.env/)',
    'sub(P:.env:)',
  ])('A3: a qualifier that writes the name or runs code makes the word any name: %s', (word) => {
    expect(spell(word)).toBe('any')
  })

  test('A3: a qualifier that only filters or sorts is as before', () => {
    expect(spell('*.ts(om)')).toEqual(['*.ts**'])
    expect(spell('*(.)')).toEqual(['**'])
    expect(spell('src/*(N)')).toEqual(['src/**'])
  })

  test('A3: !(...) is *, which matches no leading dot', () => {
    expect(spell('!(node_modules)')).toEqual(['*'])
    expect(spell('.e!(x)')).toEqual(['.e*'])
    expect(spell('src/!(a|b).ts')).toEqual(['src/*.ts'])
    expect(dotsMatch(arg('!(node_modules)'), false)).toBe(false)
  })

  test.each([
    ['cat$IFS.env', '.env'],
    [`cat$IFS'.env'`, '.env'],
    ['cat${IFS%?}.env', '.env'],
    ['a$(true).env', '.env'],
    ['a`true`.env', '.env'],
  ])('A4: the text beside an unquoted run-time part is a word of its own: %s', (text, expected) => {
    const p = parseShell(text, 'sh')
    if (!p.ok) throw new Error(p.why)
    const read = spellings(wordsOf(p.list)[0]!, { home: HOME, homeKnown: true, strict: false })
    expect(read).toContain(expected)
  })

  test('A4: inside double quotes the word is not broken; arithmetic and ~ break nothing', () => {
    expect(spell('"a$x.env"')).toEqual(['a.env'])
    expect(spell('"$a.$b"')).toEqual(['.'])
    expect(spell('id_ed$((1))x')).toEqual(['id_ed*x'])
    expect(spell('~/x')).toEqual([`${HOME}/x`])
  })

  test('Z4: ${:-x} is a written value', () => {
    expect(spell('${:-.env}')).toEqual(['.env'])
    expect(spell('.e${:-n}v')).toContain('.env')
    expect(spell('${${:-.env}}')).toContain('.env')
  })

  test.each(['${${:-.eXnv}/X}', '${(L):-.ENV}', '${(j::)${:-.env}}', 'x${${:-.ENV}:l}'])(
    'Z5: %s rewrites written text, so it could be any name',
    (word) => {
      expect(spell(word)).toBe('any')
    }
  )

  test.each([
    '${(k)parameters}',
    '${(U)name}',
    '${(s:,:)list}',
    '${${x}/a}',
    '${x/a}',
    '${x#a}',
    '${x%.txt}',
  ])('Z5: %s holds no written value', (word) => {
    expect(spell(word)).toEqual([])
  })

  test.each([
    ['#', '.eq#nv', `.e${ANY}nv`],
    ['##', '.eq##nv', `.e${ANY}nv`],
    ['# after a class', '.e[a-z]#v', `.e${ANY}v`],
    ['^', '.e^xnv', `.e${ANY}`],
    ['^ in a folder', 'se^x/customers.csv', `se${ANY}/customers.csv`],
    ['~', '.env~x', `.env${ANY}`],
    ['braceccl', '.e{n}v', `.e${ANY}v`],
    ['a brace list', '{.e,x}nv', `${ANY}nv`],
  ])('Z6 strict reading: %s in %s', (_, word, expected) => {
    expect(spell(word, { strict: true })).toEqual([expected])
  })

  test('Z6: a leading ~ and a quoted # are themselves under strict reading', () => {
    expect(spell('~/x', { strict: true })).toEqual([`${HOME}/x`])
    expect(spell(`'a#b'`, { strict: true })).toEqual(['a#b'])
  })

  const list = (command: string) => {
    const p = parseShell(command, 'sh')
    if (!p.ok) throw new Error(command)
    return p.list
  }
  test.each([
    'setopt extendedglob; ls',
    'unsetopt nomatch; ls',
    'emulate sh; ls',
    'builtin setopt braceccl; ls',
    'shopt -s extglob; ls',
    'shopt -s dotglob; ls',
    'shopt -s "$opt"; ls',
    'set -o globdots; ls',
    'set -o extendedglob; ls',
    'set -G; ls',
    'set -4; ls',
    'command -p $S globdots; ls',
    'builtin - $S globdots; ls',
    'exec -a x $S globdots',
    '- $S globdots; ls',
    'eval $S globdots; ls',
    'eval "$S globdots"; ls',
    'options[globdots]=on; ls',
    'options=(globdots on); ls',
    'typeset options[globdots]=on; ls',
    'S=setopt; $S globdots; ls',
    'noglob builtin $S globdots; ls',
    '"$(echo setopt)" globdots; ls',
    'echo "$(setopt globdots; ls)"',
    '{ setopt globdots; }; ls',
  ])('§2: %s is read strictly', (command) => {
    expect(readsStrictly(list(command))).toBe(true)
  })

  test.each([
    'set -euo pipefail; ls src',
    'set -x; npm test',
    'set +e; ls',
    'set -- a b',
    'shopt -s nullglob; rm -f *.o',
    'shopt -s globstar; ls **/*.ts',
    'shopt -u failglob; ls',
    'bash -c "ls"',
    'bash -lc "ls"',
    'sh -ec "ls"',
    'bash -x script.sh',
    'bash -- script.sh',
    'bash script.sh --globdots',
    'bash -c "ls" -O dotglob',
    'command -v node',
    'exec node server.js',
    'eval "ls src"',
    'echo "$x"',
    'F=1 ls',
    'npm config set registry https://example.test',
    'git remote set-url origin x',
    'ls',
  ])('§2: %s is not', (command) => {
    expect(readsStrictly(list(command))).toBe(false)
  })

  test('a word beside a group or qualifier, and every word under strict reading, may match a leading dot', () => {
    expect(dotsMatch(arg('*nv(D)'), false)).toBe(true)
    expect(dotsMatch(arg('*nv'), false)).toBe(false)
    expect(dotsMatch(arg('*nv'), true)).toBe(true)
    expect(globMayBeRawOnly('*nv', [], true)).toBe(true)
    expect(globMayBeRawOnly('*nv', [], false)).toBe(false)
    expect(globMayBeRawOnly('*.o', [], true)).toBe(false)
    expect(globMayBeRawOnly('*.ts**', [], true)).toBe(false)
  })
})

describe('pieces: the parts of a word a program may take as a file name', () => {
  test.each([
    ['if=.env', '.env'],
    ['--file=.env', '.env'],
    ['HEAD:.env', '.env'],
    ['-f.env', '.env'],
    ['@.env', '.env'],
    ['-d@.env', '.env'],
    ['a:.env', '.env'],
    ['.env:/x', '.env'],
    ['a,.env', '.env'],
    ['.env', '.env'],
  ])('%s holds %s', (word, piece) => {
    expect(pieces(word)).toContain(piece)
  })

  test('the whole word is a piece too, and an option is not taken apart twice', () => {
    expect(pieces('--mode=dev')).toEqual(['--mode=dev', '--mode', 'dev'])
    expect(pieces('-la')).toEqual(['-la', 'a'])
  })
})

describe('textPieces: the text floor (reading table A8)', () => {
  const floor = (command: string) => {
    const p = parseShell(command, 'sh')
    return textPieces(p.ok ? p.list : null, command)
  }
  test('a chunk is read with quotes, backslashes and line continuations removed', () => {
    expect(floor(`cat .e''nv x`)).toEqual([[`.e''nv`, '.env']])
    expect(floor('cat .e\\\nnv')).toEqual([['.e\\\nnv', '.env']])
    expect(floor(`dd if=".e"nv`)).toEqual([[`if=".e"nv`, 'if=.env']])
    expect(floor('cat src/index.ts')).toEqual([])
  })

  test('quoted text is split at blanks and at the operators of the shell, each piece shown as typed', () => {
    expect(floor(`watch 'cat .en[v]'`)).toEqual([
      [`'cat`, 'cat'],
      [`.en[v]'`, '.en[v]'],
    ])
    expect(floor(`x 'a;b|c&d<e>f(g)h\`i$j'`).map(([, read]) => read)).toEqual([
      'a;b|c&d<e>f(g)h`i$j',
      ...'abcdefghij',
    ])
  })

  test('an ANSI-C string is read by its value', () => {
    expect(floor(`su -c $'cat .e\\x6ev'`).map(([, read]) => read)).toContain('.env')
  })

  test('a here-document body and a here-string are pieces too', () => {
    expect(floor('python3 <<E\ncat .en[v] x\nE').map(([, read]) => read)).toEqual([
      'cat',
      '.en[v]',
      'x',
    ])
    expect(floor(`python3 <<< 'cat .en[v]'`).map(([, read]) => read)).toContain('.en[v]')
  })

  test('a command the reader cannot read still has its chunks', () => {
    expect(floor(`cat .e''nv "`)).toContainEqual([`.e''nv`, '.env'])
  })
})

describe('addendum 2: scripts and settings', () => {
  const READ = { home: HOME, homeKnown: true, strict: false }
  /** Whether some word of the command, wherever the reader found it, can be `.env`. */
  const reads = (command: string) =>
    words(command).some((w) => {
      const s = spellings(w, READ)
      return s === 'any' || s.includes('.env')
    })

  test.each([
    [`read 'a[$(cat .e[n]v >&2)]' <<< x`],
    [`: $(( 'a[$(cat .e[n]v >&2)]' ))`],
    [`[[ 'a[$(cat .e[n]v >&2)]' -eq 0 ]]`],
    [`declare -a 'a=($(cat .e[n]v >&2))'`],
    [`PS4='$(cat .e[n]v >&2)'; set -x; :`],
    [`BASH_ENV='$(cat .e[n]v >&2)' bash -c :`],
    ['printf -v x \\$\\(cat\\ .e[n]v\\)'],
    [`echo 'a \`cat .e[n]v\` b'`],
    [`echo 'diff <(cat .e[n]v) x'`],
    [`echo '=(cat .e[n]v)'`],
    [`echo '\${ cat .e[n]v; }'`],
    [`echo "\\$(cat .e[n]v)"`],
    [`echo $'$(cat .e\\x6ev)'`],
    // The text around it is no script (a quote does not close): the substitution is still read.
    [`echo 'then $(cat .e[n]v) fi "'`],
  ])('A9: a substitution written inside quotes or after a backslash is read: %s', (command) => {
    expect(reads(command), command).toBe(true)
  })

  test('A9: quoted text that is no command is passed over, never unreadable', () => {
    for (const c of [
      `awk '{ print $(NF-1) }' f`,
      `echo 'a $( b'`,
      `echo 'x \` y'`,
      `sed 's/=(/x/' f`,
    ])
      expect(parseShell(c, 'sh').ok, c).toBe(true)
    // wordsWithin walks the tree's shape: `again` needed no change there.
    // (The substitution, then the whole text read as a script: both under `again`.)
    expect(words(`echo '$(cat a)'`).map((w) => w.raw)).toEqual([
      'echo',
      `'$(cat a)'`,
      'cat',
      'a',
      '$(cat a)',
      'cat',
      'a',
    ])
    // The text a pipe or a program hands to a shell, whatever it is spelled with.
    expect(reads(`echo 'cat .e'"'"'n'"'"'v' | ./mysh`)).toBe(true)
    expect(reads(`./mysh < <(echo $'cat .e$\\'\\\\x6e\\'v')`)).toBe(true)
    expect(reads(`( $SHELL ) <<< 'cat .e"n"v'`)).toBe(true)
    expect(reads("./mysh <<E\ncat .e\\$'\\x6e'v\nE")).toBe(true)
  })

  test.each([
    'GLOBIGNORE=x; ls *',
    'export GLOBIGNORE=x; ls',
    'declare GLOBIGNORE=x',
    'typeset -x GLOBIGNORE=x',
    'env GLOBIGNORE=x bash -c ls',
    'read GLOBIGNORE <<< x',
    'printf -v GLOBIGNORE x',
    'GLOBIGNORE+=x ls',
    'BASHOPTS=dotglob bash -c ls',
    'SHELLOPTS=x ls',
    'POSIXLY_CORRECT=1 ls',
    'export BASH_COMPAT=3.1',
  ])(
    'A10: an assignment to a variable that changes how words are read is read strictly: %s',
    (c) => {
      const p = parseShell(c, 'sh')
      expect(p.ok && readsStrictly(p.list), c).toBe(true)
    }
  )

  test('text read again as a script sets no option by looking built, and names a folder only with a slash', async () => {
    const p = parseShell(`awk 'NR==1{print $0}' f`, 'sh')
    expect(p.ok && readsStrictly(p.list)).toBe(false)
    // An option really set there still counts.
    const q = parseShell(`$SHELL -c 'setopt globdots; cat *nv'`, 'sh')
    expect(q.ok && readsStrictly(q.list)).toBe(true)
    const g = await fixtureGuard()
    const refused = async (command: string) =>
      'deny' in (await g.beforeTool({ tool: 'Bash', command, description: 'x' }))
    expect(await refused(`npm test -- -t '.veilio folder'`)).toBe(false)
    expect(await refused(`npm test -- -t 'cat .veilio/map.json'`)).toBe(true)
    expect(await refused(`$SHELL -c 'cat .e"n"v'`)).toBe(true)
    // A shell the guard knows runs the text: there the folder is a word.
    expect(await refused(`bash -c 'ls .veilio'`)).toBe(true)
  })

  test('A10: IFS and LC_ALL trigger nothing', () => {
    for (const c of ['IFS=, read -r a b', 'LC_ALL=C sort x', 'export LANG=C', 'GLOBIGNORED=x ls']) {
      const p = parseShell(c, 'sh')
      expect(p.ok && readsStrictly(p.list), c).toBe(false)
    }
  })
})

describe('the wildcard judge (reading table §3)', () => {
  test.each([
    '.en[[:alpha:]]',
    'server.pe?',
    'ser*r.pem',
    '?.pem',
    'id_*',
    '.en*',
    'secr*/customers.csv',
  ])('%s could name a raw-only file', (word) => {
    expect(globMayBeRawOnly(word, ['secrets/**'])).toBe(true)
  })

  test.each([
    'server.p*',
    '*.ts',
    'src/in*',
    'lib/*/*.rb',
    '*',
    '*/customers.csv',
    'src/a*',
    '*.o',
    '**/*.ts',
  ])('%s is not refused', (word) => {
    expect(globMayBeRawOnly(word, ['secrets/**'])).toBe(false)
  })

  test("any text from a group or an option is not the word's own *: it may stand for a pattern's text", () => {
    expect(globMayBeRawOnly(`server.pe${ANY}`, [])).toBe(true)
    expect(globMayBeRawOnly('server.pe*', [])).toBe(false)
    expect(globMayBeRawOnly(`${ANY}*`, [])).toBe(true)
    expect(globMayBeRawOnly('***', [])).toBe(false)
    expect(globMayBeRawOnly('*.md**', [], true)).toBe(false)
    expect(globMayBeRawOnly(`*.md${ANY}`, [], true)).toBe(true)
  })

  test('a bracket list is each of its characters', () => {
    expect(spell('serve[r].pem')).toEqual(['server.pem'])
    expect(spell('server.pe[m]')).toEqual(['server.pem'])
  })
})

describe("text that names Veilio's folder as a path (reading table §4, FR-011)", () => {
  const names = (command: string) => {
    const p = parseShell(command, 'sh')
    return p.ok ? textsOf(p.list).some(namesVeilioFolder) : namesVeilioFolder(command)
  }
  test.each([...INTERPRETER_REFUSED, ...F1, ...F2])('refused: %s', (command) => {
    expect(names(command)).toBe(true)
  })

  test.each([
    ...INTERPRETER_ALLOWED,
    ...F8,
    'ls ~/.veilio',
    'cat ~/.veilio/map.json',
    `cat ~/.veil''io/map.json`,
    'git commit -m "veilio: read .veilio lazily"',
    `node -e "fetch('https://veilio.dev/x.veilio')"`,
    `node -e "fetch('https://veilio.dev/docs')"`,
    'echo "see .veilio docs"',
    'cat notes/.veilio-x.txt',
    'cd ~/.veilio',
    'ls -d ~/.veilio',
    'curl -s https://api.veilio.dev/x',
    'cat "$DIR/.veilio/map.json"',
    'docker run --env-file=~/.veilio/x img',
  ])('not text that names the folder: %s', (command) => {
    expect(names(command)).toBe(false)
  })

  test('a word is text unless every part of it is path text', () => {
    const texts = (command: string) => {
      const p = parseShell(command, 'sh')
      return p.ok ? textsOf(p.list) : null
    }
    // Paths, and what stands for path text.
    for (const w of [
      'src/a.ts',
      '~/x',
      '$DIR/x',
      '"$(pwd)"/x',
      '*.ts',
      'a{b,c}.ts',
      'x[ab]',
      '--file=a:b,c',
      'f*(.)',
      '(a|b)x',
    ])
      expect(texts(`cmd ${w}`), w).toEqual([])
    // Text: anything else, whatever part of the word holds it.
    for (const w of [
      '"a b"',
      '{"a b",x}',
      '{x,y()}"z w"',
      '*"a b"',
      '("a b")',
      'x("a b")',
      '$((1+2))',
      '${x:-"a b"}',
      `$'a b'`,
      'a+b',
      'a$b;c'.replace(';', '\\;'),
    ])
      expect(texts(`cmd ${w}`)?.length, w).toBeGreaterThan(0)
  })

  test.each([
    [`'.vei'+'lio/x'`, true],
    [`"/.vei"."lio"`, true],
    [`".vei" "lio/x"`, true],
    [`~/.veil""io/x`, true],
    [`join(home, '.veilio', 'map.json')`, true],
    ['~/.vei\\\nlio/map.json', true],
    ['https://api.veilio.dev/health', false],
    ['notes/.veilio-x.txt', false],
    ['see .veilio docs', false],
    // A11: `.veilio/` is a path whatever stands before it.
    ['x.veilio/y', true],
    ['w.veilio\\\\x', true],
    ['x.veilio', false],
    ["open('C:\\\\Users\\\\me\\\\.veilio\\\\map.json')", true],
    ["home + '\\\\.vei' + 'lio\\\\x'", true],
    ['`${h}/.veilio/x`', true],
    ['const d = `.veilio`', true],
    ['h + `/.vei` + `lio/x`', true],
    ['open$f,$ENV{HOME}.q{/.veilio/map.json}', true],
    ['https://api.veilio.dev/v1/x?a=.veilio', false],
  ])('%s -> %s', (text, expected) => {
    expect(namesVeilioFolder(text)).toBe(expected)
  })
})

describe('addendum 2, A11: a folder that holds only raw-only files', () => {
  test.each([
    '.veilio',
    '~/.veilio',
    '/home/dev/.veilio/',
    'sub/../.veilio',
    './.veilio/.',
    '.VEILIO',
    '.kube',
    '~/.azure',
    '.config/gcloud',
    '~/.config/gcloud/',
    'a/b/.kube',
  ])('%s names one', (word) => {
    expect(namesRawOnlyFolder(word, [])).toBe(true)
  })

  test("a project's dir/** pattern gives its folder", () => {
    for (const word of ['secrets', './secrets/', 'x/secrets', '/p/secrets'])
      expect(namesRawOnlyFolder(word, ['secrets/**']), word).toBe(true)
    expect(namesRawOnlyFolder('secrets', [])).toBe(false)
    expect(namesRawOnlyFolder('keys/prod', ['keys/prod/**'])).toBe(true)
    expect(namesRawOnlyFolder('keys', ['keys/prod/**'])).toBe(false)
  })

  test.each([
    '.aws',
    '.docker',
    '.config',
    '~',
    '.',
    'src',
    '.veilio-x',
    'my.veilio',
    '.config/gcloud2',
    'gcloud',
    '.veilio/map.json',
    '.kube/config',
    'secretsx',
  ])(
    '%s does not: a file in one, a longer name, or a folder that holds other files too',
    (word) => {
      expect(namesRawOnlyFolder(word, ['secrets/**'])).toBe(false)
    }
  )

  test('a wildcard word that could name one is refused; a part of only wildcards is not', () => {
    for (const word of ['.veil?o', '.v*', '~/.k*', 'sec*', 's*', 'se[c]rets', '.config/g*'])
      expect(namesRawOnlyFolder(word, ['secrets/**']), word).toBe(true)
    for (const word of ['*', '*/', '?', 'src*', '*.ts', 'lib/*', '*veilio', '.config/*'])
      expect(namesRawOnlyFolder(word, ['secrets/**']), word).toBe(false)
    // With a setting that lets a wildcard match a leading dot.
    expect(namesRawOnlyFolder('*veilio', [], true)).toBe(true)
  })
})

describe('addendum 2, A12: text a program only prints, stores or searches for', () => {
  /** The command with its data positions blanked. */
  const seen = (command: string) => {
    const p = parseShell(command, 'sh')
    if (!p.ok) throw new Error(`unreadable (${p.why}): ${command}`)
    return withoutData(command, dataPositions(p.list))
      .replace(/ +/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .trim()
  }

  test.each([
    ['echo ".env" x', 'echo'],
    ['echo .env >> .gitignore', 'echo >> .gitignore'],
    [`printf '%s\\n' .env '*.pem'`, 'printf'],
    ['git commit -m "load .env"', 'git commit -m'],
    ['git commit -am "load .env" src', 'git commit -am src'],
    ['git commit --message "load .env"', 'git commit --message'],
    ['git commit --message=".env"', 'git commit'],
    ['git commit -m".env"', 'git commit'],
    ["git log -S'.env' --oneline", 'git log --oneline'],
    ['git tag -a v1 -m ".env"', 'git tag -a v1 -m'],
    ['git merge -m ".env" topic', 'git merge -m topic'],
    ['git stash push -m ".env"', 'git stash push -m'],
    ['git notes add -m ".env"', 'git notes add -m'],
    ['git log --grep .env -S .pem -G id_rsa -- src', 'git log --grep -S -G -- src'],
    ['git log --grep=.env', 'git log'],
    [
      'gh pr create --title ".env" --body "~/.veilio" -t a -b b',
      'gh pr create --title --body -t -b',
    ],
    ['grep .env src', 'grep src'],
    ['grep -rn --include=*.ts .env src', 'grep -rn --include=*.ts src'],
    ['grep -e .env -e .pem src', 'grep -e -e src'],
    ['grep --regexp .env src', 'grep --regexp src'],
    ['grep -A 3 -m 1 .env src', 'grep -A 3 -m 1 src'],
    ['grep -- .env src', 'grep -- src'],
    ['egrep .env src', 'egrep src'],
    ['fgrep -r .env src', 'fgrep -r src'],
    ['rg -n -t ts .env src', 'rg -n -t ts src'],
    ['ag -i .env src', 'ag -i src'],
    ['git grep -n .env -- src', 'git grep -n -- src'],
    ['git ls-files | grep -v .env', 'git ls-files | grep -v'],
    [`cat > a.md <<'E'\n.env\nE`, `cat > a.md <<'E'\n\nE`],
    [`tee a.md <<E\n.env\nE`, `tee a.md <<E\n\nE`],
    ['echo "$(cat <<E\n.env\nE\n)"', 'echo'],
  ])('data: %s', (command, expected) => {
    expect(seen(command)).toBe(expected)
  })

  test.each([
    // (1) and (4) are voided by a pipe or a substitution.
    'echo .env | xargs cat',
    'echo .env | sh',
    'cat $(echo .env)',
    'cat `echo .env`',
    'cat <(echo .env)',
    '{ echo .env; } | sh',
    'if true; then echo .env; fi | sh',
    `cat <<'E' | bash\n.env\nE`,
    'x=$(cat <<E\n.env\nE\n)',
    // Not a data position: the place beside it.
    'printf -v x .env',
    'git commit -F .env',
    'git commit -m',
    'git log --grep',
    'git show -m .env',
    'git --no-such-option x commit -m .env',
    'git -C x commit -F .env',
    'gh pr create --body-file .env',
    'grep -f .env x',
    'grep --file .env x',
    'grep --file=.env x',
    'grep -zzf .env x',
    'grep --new-option .env x',
    'grep -K .env x',
    'grep --context .env x',
    'grep $OPTS .env x',
    'sudo grep .env x',
    'sed .env x',
    'cat .env',
    'cat <<< .env',
    'python3 <<E\n.env\nE',
  ])('not data: %s', (command) => {
    expect(seen(command)).toBe(command.replace(/ +/g, ' '))
  })

  test('the files after the pattern, the redirect target and the other words are left', () => {
    expect(seen('grep x .env')).toBe('grep .env')
    expect(seen('grep -e x .env')).toBe('grep -e .env')
    // Addendum 3: the pattern by the program's own options.
    expect(seen('grep --color x .env')).toBe('grep --color .env')
    expect(seen('grep -n --colour x .env')).toBe('grep -n --colour .env')
    expect(seen('grep --color=auto x .env')).toBe('grep --color=auto .env')
    expect(seen('grep -ex .env')).toBe('grep .env')
    expect(seen('grep -iex .env')).toBe('grep .env')
    expect(seen('grep --regexp=x .env')).toBe('grep .env')
    expect(seen('grep -C2 x .env')).toBe('grep -C2 .env')
    expect(seen('grep -C 2 x .env')).toBe('grep -C 2 .env')
    // The word after `-C` is its number, never the pattern.
    expect(seen('grep -C .env x')).toBe('grep -C .env')
    expect(seen('grep -J x .env')).toBe('grep -J .env')
    expect(seen('git grep --color -e x .env')).toBe('git grep --color -e .env')
    expect(seen('rg --pretty x .env')).toBe('rg --pretty .env')
    expect(seen('ag --after=2 x .env')).toBe('ag --after=2 .env')
    expect(seen('git -C app commit -m x .env')).toBe('git -C app commit -m .env')
    expect(seen('git --no-pager -c a.b=c tag -m x .env')).toBe(
      'git --no-pager -c a.b=c tag -m .env'
    )
    expect(seen('gh -R o/r release create v1 --notes x .env')).toBe(
      'gh -R o/r release create v1 --notes .env'
    )
    expect(seen('gh release create v1 -n x --notes-file .env')).toBe(
      'gh release create v1 -n --notes-file .env'
    )
    expect(seen('echo x > .env')).toBe('echo > .env')
    expect(seen('git commit -m x .env')).toBe('git commit -m .env')
    expect(seen('cat .env <<E\nx\nE')).toBe('cat .env <<E\n\nE')
    expect(seen('rg --pre .env x')).toBe('rg --pre .env')
    // With the patterns in a file, every operand is a file.
    expect(seen('grep -f patterns.txt .env')).toBe('grep -f patterns.txt .env')
    expect(seen('rg --file=patterns.txt .env')).toBe('rg --file=patterns.txt .env')
  })

  test('a substitution in a data word is still a command; its own data is data', () => {
    const p = parseShell('echo "$(cat .env)" \'$(cat .pem)\'', 'sh')
    if (!p.ok) throw new Error(p.why)
    const data = dataPositions(p.list)
    const judged = wordsOf(p.list)
      .filter((w) => !data.words.has(w))
      .map((w) => w.raw)
    expect(judged).toContain('.env')
    // Quoted text read again (A9) is not, for a data word.
    expect(data.inside.size).toBe(2)
  })
})

describe('the guard', () => {
  const refused = async (command: string) => {
    const g = await fixtureGuard()
    const v = await g.beforeTool({ tool: 'Bash', command, description: 'x' })
    return 'deny' in v ? v.deny : null
  }

  test.each([
    'ls .veilio',
    'ls -d ~/.veilio',
    'cp -R ~/.veilio v2',
    'rm -rf .veilio',
    'tar czf s.tgz secrets',
    'grep -r KEY secrets',
    'ln -s secrets s',
    'ls latestdir',
    'ls ~/.kube',
    'git -C .veilio init',
    `awk -v d=.veilio '{print > (d "/x")}' src/index.ts`,
    'ls sec?ets',
  ])('A11: a whole raw-only folder is refused like a file in it: %s', async (command) => {
    const fixture = { ...memoryFixture(), links: { '/p/latestdir': '/p/secrets' } }
    const v = await verdict(await guardAt(fixture, ['secrets/**']), command)
    expect(v.text).toContain('away from the model')
  })

  test('A11: a folder that holds a raw-only file among others is not refused as a word', async () => {
    for (const command of ['ls ~/.aws', 'ls ~/.config', 'ls .docker', 'cp -R ~/.aws a', 'ls src'])
      expect(await refused(command), command).toBeNull()
  })

  test.each([
    ['echo "path is ~/.veilio"', 'echo "path is ~/.veilio" | sh'],
    ['echo ".env" >> .gitignore', 'echo x > .env'],
    ['git commit -m "fix: load .env before config"', 'git commit -F .env'],
    [`grep -rn '\\.veilio/' docs`, 'grep -rn x .env'],
    [`grep -rn "home, '.veilio'" src`, 'grep -f .env x'],
    [`printf '%s\\n' '*.pem' >> .gitignore`, `printf -v PS4 '$(cat .en[v])'`],
    [
      `cat > src/paths.ts <<'EOF'\nexport const dir = join(home, '.veilio')\nEOF`,
      `cat <<'EOF' | bash\ncat .en[v]\nEOF`,
    ],
    [`echo '$(cat .env)'`, 'echo "$(cat .env)"'],
  ])('A12: %s runs, and beside it %s is refused', async (data, twin) => {
    expect(await refused(data), data).toBeNull()
    expect(await refused(twin), twin).not.toBeNull()
  })

  test('A12: PowerShell is not read by these positions', async () => {
    const g = await fixtureGuard()
    // Judged as before addendum 2: text that names Veilio's folder as a path.
    const command = 'echo "see ~/.veilio/ docs"'
    expect('deny' in (await g.beforeTool({ tool: 'PowerShell', command, description: 'x' }))).toBe(
      true
    )
    expect('deny' in (await g.beforeTool({ tool: 'Bash', command, description: 'x' }))).toBe(false)
  })

  test('a command Veilio cannot read is refused', async () => {
    expect(await refused(`cat .e''nv "`)).toBe(
      "Veilio refused this call: Veilio cannot read `cat .e''nv \"` as a shell command, so it cannot tell whether it names a file Veilio keeps away from the model. Write it more simply, or ask the user to run it."
    )
    expect(await refused(`echo "unbalanced`)).toContain('as a shell command')
  })

  test('a refusal shows the word as typed, and the piece of a plain word', async () => {
    expect(await refused(`while read l; do echo $l; done < .e''nv`)).toBe(
      "Veilio keeps .e''nv away from the model. Ask the user for what you need from it."
    )
    expect(await refused('grep -f.env x')).toBe(
      'Veilio keeps .env away from the model. Ask the user for what you need from it.'
    )
    expect(await refused('cat ${x:-.env}')).toBe(
      'Veilio keeps ${x:-.env} away from the model. Ask the user for what you need from it.'
    )
  })

  test('a word the cd walk does not read is judged where the command around it runs', async () => {
    // sub/notes leads to .env; notes at the root is a plain file.
    expect(await refused('cd sub; if true; then cat; fi < notes')).toContain('notes')
    expect(await refused('cd sub; cat ${x:-notes}')).toContain('${x:-notes}')
    expect(await refused('cd sub; : $(( $(cat notes) ))')).toContain('notes')
    expect(await refused('if true; then cat; fi < notes')).toBeNull()
    expect(await refused('cd sub && cd .. && cat ${x:-notes}')).toBeNull()
  })

  test('a remembered raw-only answer is forgotten when the list changes', async () => {
    const g = await fixtureGuard()
    const ask = async () =>
      'deny' in
      (await g.beforeTool({ tool: 'Bash', command: 'cat build/out.txt', description: 'x' }))
    expect(await ask()).toBe(false)
    g.extraRawOnly.push('build/**')
    expect(await ask()).toBe(true)
    g.extraRawOnly = []
    expect(await ask()).toBe(false)
  })

  test('the text floor refuses a quote spelling the reader was not asked about', async () => {
    expect(await refused(`case x in .e''nv) ;; esac`)).toContain(".e''nv")
  })
})
