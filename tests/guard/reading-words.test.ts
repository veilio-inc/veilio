import { spawnSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'
import { globMayBeRawOnly } from '../../plugins/veilio-guard/lib/paths.ts'
import { pieces, quoteBlind, spellings, wordsOf } from '../../plugins/veilio-guard/lib/reading.ts'
import { parseShell, type Word } from '../../plugins/veilio-guard/lib/shell.ts'
import { fixtureGuard } from './fixtures/cd-project.ts'
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
  test.each(
    POSITIONS.filter((p) => p.executed && p.shell !== 'zsh').map((p) => [p.id, p.make(W)] as const)
  )('%s %s', (_, command) => {
    expect(holds(command), command).toBe(true)
  })

  test.each([
    ['a redirect on until', `until cat; do :; done < ${W}`],
    ['a here-string', `cat <<< ${W}`],
    ['a declared assignment', `declare -x F=${W}`],
    ['an array assignment', `a=(x ${W})`],
    ['a case word', `case ${W} in x) ;; esac`],
    ['a substitution in a case pattern', `case x in $(cat ${W})) ;; esac`],
    ['a substitution in an arithmetic for', `for (( i=$(cat ${W}); i<1; i++ )); do :; done`],
    ['a substitution in an arithmetic command', `(( $(cat ${W}) ))`],
    ['a nested default', `echo \${x:-\${y:-$(cat ${W})}}`],
    ['a backtick in a here-document', `cat <<EOF\n\`cat ${W}\`\nEOF`],
    ['a here-document under a quoted delimiter', `cat <<'EOF'\n$(cat ${W})\nEOF`],
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

  test('a bracket list is each of its characters', () => {
    expect(spell('serve[r].pem')).toEqual(['server.pem'])
    expect(spell('server.pe[m]')).toEqual(['server.pem'])
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
