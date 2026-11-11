import { spawnSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'
import { ANY_TEXT as ANY, globMayBeRawOnly } from '../../plugins/veilio-guard/lib/paths.ts'
import {
  dotsMatch,
  pieces,
  quoteBlind,
  namesVeilioFolder,
  readsStrictly,
  spellings,
  textsOf,
  wordsOf,
} from '../../plugins/veilio-guard/lib/reading.ts'
import { parseShell, type Word } from '../../plugins/veilio-guard/lib/shell.ts'
import { fixtureGuard } from './fixtures/cd-project.ts'
import { F1, F2, F8, INTERPRETER_ALLOWED, INTERPRETER_REFUSED } from './fixtures/reading-corpora.ts'
import { POSITIONS } from './fixtures/reading-grammar.ts'

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
  test.each(POSITIONS.filter((p) => p.executed).map((p) => [p.id, p.make(W)] as const))(
    '%s %s',
    (_, command) => {
      expect(holds(command), command).toBe(true)
    }
  )

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
    ['a script after a shell option', `zsh -o extendedglob -c 'cat ${W.replace(/'/g, `'\\''`)}'`],
    ['zsh =( )', `cat =(cat ${W})`],
    ['a group glued to a word in a for list', `for f in src/*(N) ${W}; do :; done`],
    ['a script attached to -c', `sh -c'cat ${W.replace(/'/g, `'\\''`)}'`],
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

  test('a here-document: an escaped substitution does not run and is not read', () => {
    expect(words(`cat <<EOF\n\\$(cat ${W})\nEOF`).map((w) => w.raw)).not.toContain(W)
    expect(words(`cat <<EOF\n\\\\\\$(cat ${W})\nEOF`).map((w) => w.raw)).not.toContain(W)
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
    ['E8 a bracket range', `.e[m-o]v`, ['.emv', '.env', '.eov']],
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
    ['.e${Z}nv', ['.env']],
    ['$DIR/.env', ['**/.env']],
    ['$A/$B', []],
    ['$F', []],
    ['"$1"', []],
    ['secrets/$f', ['secrets/**']],
    ['id_ed$((25519))', ['id_ed*']],
    ['f$((i+1)).txt', ['f*.txt']],
    ['$((n))', []],
    ['logs/$((n))', ['logs/**']],
    ['.e$(echo n)v', ['.ev']],
    ['${x}nv', ['nv']],
    ['sec$X/customers.csv', ['sec/customers.csv']],
    ['"$(pwd)"/src', ['**/src']],
    ['`pwd`/.env', ['**/.env']],
  ])('E10, E12: %s is read as %j', (word, expected) => {
    expect(spell(word)).toEqual(expected)
  })

  test('E6, E7: with HOME set in the command, ~ and $HOME are any folder', () => {
    expect(spell('~/x', { homeKnown: false })).toEqual(['**/x'])
    expect(spell('$HOME/x', { homeKnown: false })).toEqual(['**/x'])
  })

  test('E6, E7: ~+, ~-, ~user, $PWD and $OLDPWD are any folder, not the session directory', () => {
    for (const w of ['~+/x', '~-/x', '~dev/x', '$PWD/x', '"$PWD"/x', '$OLDPWD/x'])
      expect(spell(w), w).toEqual(['**/x'])
  })

  test('E9: a wildcard stays a wildcard; a quoted one is an ordinary character', () => {
    expect(spell('.en?')).toEqual(['.en?'])
    expect(spell('.en[[:alpha:]]')).toEqual(['.en[[:alpha:]]'])
    expect(spell('.e[!x]v')).toEqual(['.e[!x]v'])
    expect(spell(`'.en*'`).some((s) => /[*?[]/.test(s))).toBe(false)
  })

  test('E4: locale quotes holding an expansion are a run-time value', () => {
    expect(spell('$"$x"/.env')).toEqual(['**/.env'])
  })
})

describe('spellings: zsh and strict reading (reading table Z1-Z6, §2)', () => {
  test.each([
    ['Z1 a group', '.e(n)v', [`.e${ANY}v`]],
    ['Z1 alternatives', '.e(n|x)v', [`.e${ANY}v`]],
    ['Z1 a group that starts the word', '(s)erver.pem', [`${ANY}erver.pem`]],
    ['Z1 ksh @( )', '.e@(n)v', [`.e${ANY}v`]],
    ['Z1 ksh ?( )', '.e?(x)nv', [`.e${ANY}nv`]],
    ['Z1 ksh +( )', '.e+(n)v', [`.e${ANY}v`]],
    ['Z2 a qualifier', '.e*(.)', ['.e**']],
    ['Z2 a qualifier after a name', '*.ts(om)', ['*.ts**']],
    ['Z2 a qualifier after a name it ends', 'server.pem(.)', ['server.pem**']],
    ['Z1 a group that ends the word', 'server.pe(m|x)', [`server.pe${ANY}`]],
    ['Z2 a qualifier on a bare wildcard', '*(.)', ['**']],
    ['Z3 a numeric range', 'id_ed<->', ['id_ed*']],
    ['Z3 a numeric range with bounds', 'f<1-9>.txt', ['f*.txt']],
  ])('%s: %s', (_, word, expected) => {
    expect(spell(word)).toEqual(expected)
  })

  test('Z1: a group alone is as before, and a function definition is not a group', () => {
    expect(spell('(.env|x)')).toEqual(['(.env|x)'])
    expect(parseShell('f() { cat x; }', 'sh').ok).toBe(true)
    expect(parseShell('f ( ) { cat x; }', 'sh').ok).toBe(true)
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

  test.each(['${(k)parameters}', '${(U)name}', '${(s:,:)list}', '${${x}/a/b}', '${x/a/b}'])(
    'Z5: %s holds no written value',
    (word) => {
      expect(spell(word)).toEqual([])
    }
  )

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
    'zsh -o extendedglob -c ls',
    'bash -O extglob -c ls',
    'bash +o posix -c ls',
    'zsh --globdots -c ls',
    'zsh -4 -c ls',
    'zsh -G -c ls',
    'zsh "$FLAGS" -c ls',
    'bash --noprofile -c ls',
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

describe('quoteBlind: the text floor', () => {
  test('a chunk is read with quotes, backslashes and line continuations removed', () => {
    expect(quoteBlind(`cat .e''nv x`)).toEqual([[`.e''nv`, '.env']])
    expect(quoteBlind('cat .e\\\nnv')).toEqual([['.e\\\nnv', '.env']])
    expect(quoteBlind(`dd if=".e"nv`)).toEqual([[`if=".e"nv`, 'if=.env']])
    expect(quoteBlind('cat src/index.ts')).toEqual([])
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
    ['x.veilio/y', false],
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

describe('the guard', () => {
  const refused = async (command: string) => {
    const g = await fixtureGuard()
    const v = await g.beforeTool({ tool: 'Bash', command, description: 'x' })
    return 'deny' in v ? v.deny : null
  }

  test('a command Veilio cannot read is refused', async () => {
    expect(await refused(`cat .e''nv "`)).toContain('a command Veilio cannot read')
    expect(await refused(`echo "unbalanced`)).toContain('a command Veilio cannot read')
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

  test('the text floor refuses a quote spelling the reader was not asked about', async () => {
    expect(await refused(`case x in .e''nv) ;; esac`)).toContain(".e''nv")
  })
})
