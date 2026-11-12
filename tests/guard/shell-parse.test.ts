import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { CORPUS } from './fixtures/cd-corpus.ts'
import type { Verdict } from './fixtures/cd-project.ts'
import {
  parseShell,
  shellWords,
  splitChain,
  type List,
  type Node,
  type Word,
} from '../../plugins/veilio-guard/lib/shell.ts'

// Spec 086 contracts/tokenizer.md: each numbered case. The tree is printed
// compactly so a case reads as the contract does: W(text) a word with that
// literal text, X(kind:raw) one the shell expands, A(NAME=value) an
// assignment, R(op target) a redirection, N[...] a nested shell's command.

const word = (w: Word): string =>
  w.literal !== null
    ? `W(${w.literal})`
    : `X(${[...new Set(w.parts.filter((p) => p.kind !== 'lit').map((p) => p.kind))].join(',')}:${w.raw})`

function node(n: Node): string {
  switch (n.type) {
    case 'simple': {
      const out = [
        ...n.assigns.map(
          (a) =>
            `A(${a.name ?? '?'}${a.op}${Array.isArray(a.value) ? `(${a.value.map(word).join(' ')})` : word(a.value)})`
        ),
        ...n.words.map((w) => (w.assign ? `A(${w.assign.name ?? '?'}${w.assign.op}…)` : word(w))),
        ...n.redirects.map((r) => `R(${r.fd ?? ''}${r.op}${r.target ? ' ' + word(r.target) : ''})`),
      ]
      if (n.nested) out.push(`N[${list(n.nested)}]`)
      return out.join(' ')
    }
    case 'subshell':
      return `( ${list(n.list)} )`
    case 'group':
      return `{ ${list(n.list)} }`
    case 'if':
      return `if ${n.branches.map((b) => `[${list(b.cond)}] then [${list(b.body)}]`).join(' elif ')}${n.else ? ` else [${list(n.else)}]` : ''} fi`
    case 'loop':
      return `${n.kind} ${n.name ?? ''}${n.words ? ` in ${n.words.map(word).join(' ')}` : ''}${n.cond ? `[${list(n.cond)}]` : ''} do [${list(n.body)}]`
    case 'case':
      return `case ${word(n.word)} [${n.arms.map(list).join(' ;; ')}]`
    case 'function':
      return `function ${n.name} ${node(n.body)}`
  }
}

function list(l: List): string {
  return l.items
    .map(({ node: p, joinedBy }) => {
      const stages = p.stages.map(node).join(' | ')
      const s = `${p.timed ? 'time ' : ''}${p.negated ? '! ' : ''}${stages}${p.background ? ' &' : ''}`
      return joinedBy === null ? s : `${joinedBy === '\n' ? '⏎' : joinedBy} ${s}`
    })
    .join(' ')
}

const read = (command: string): string => {
  const r = parseShell(command, 'sh')
  return r.ok ? list(r.list) : `fail:${r.why}`
}

describe('parseShell, contracts/tokenizer.md', () => {
  test.each([
    ['1', 'cd "my folder" 2>&1 && npm test', 'W(cd) W(my folder) R(2>& W(1)) && W(npm) W(test)'],
    ['2', 'c""d ~/.kube', 'W(cd) X(tilde:~/.kube)'],
    ['3', '\\cd src', 'W(cd) W(src)'],
    ['4', "cd 'a b'\\ c", 'W(cd) W(a b c)'],
    ['5a', 'cd $D', 'W(cd) X(param:$D)'],
    ['5b', 'cd "${D}"', 'W(cd) X(param:"${D}")'],
    ['5c', 'cd "$D/x"', 'W(cd) X(param:"$D/x")'],
    ['6a', 'cd ~/.kub{e,x}', 'W(cd) X(tilde,brace:~/.kub{e,x})'],
    ['6b', 'cd {1..3}', 'W(cd) X(brace:{1..3})'],
    ['7a', 'cd {}', 'W(cd) W({})'],
    ['7b', 'cd {', 'W(cd) W({)'],
    ['7c', 'cd a{b}', 'W(cd) W(a{b})'],
    ['8a', 'cd lib/*', 'W(cd) X(glob:lib/*)'],
    ['8b', 'cd lib/?', 'W(cd) X(glob:lib/?)'],
    ['8c', 'cd [ab]', 'W(cd) X(glob:[ab])'],
    ['10', "cd $'\\x63d'", "W(cd) X(ansic:$'\\x63d')"],
    ['11', 'HOME=/tmp/h cd', 'A(HOME=W(/tmp/h)) W(cd)'],
    ['12', 'export H""OME=~/.kube; cd ~', 'W(export) A(HOME=…) ; W(cd) X(tilde:~)'],
    ['13', '(cd sub && ls); cat notes', '( W(cd) W(sub) && W(ls) ) ; W(cat) W(notes)'],
    ['14', '{ cd sub; ls; }', '{ W(cd) W(sub) ; W(ls) }'],
    ['15', 'cd src # into src', 'W(cd) W(src)'],
    ['16', 'echo a#b', 'W(echo) W(a#b)'],
    ['17', 'cd src \\\n  && ls', 'W(cd) W(src) && W(ls)'],
    ['18', 'cd src\nls', 'W(cd) W(src) ⏎ W(ls)'],
    ['19', 'cat <<EOF\ncd .aws\nEOF', 'W(cat) R(<< W(EOF))'],
    [
      '20',
      "bash -c 'cd .aws && cat x'",
      'W(bash) W(-c) W(cd .aws && cat x) N[W(cd) W(.aws) && W(cat) W(x)]',
    ],
    ['21', 'eval "cd .aws"', 'W(eval) W(cd .aws) N[W(cd) W(.aws)]'],
    ['22', 'bash -c "$CMD"', 'W(bash) W(-c) X(param:"$CMD")'],
    ['23a', 'if cd src; then ls; fi', 'if [W(cd) W(src)] then [W(ls)] fi'],
    ['23b', 'time cd src', 'time W(cd) W(src)'],
    ['23c', '! cd src', '! W(cd) W(src)'],
    ['24', 'ls | cd sub', 'W(ls) | W(cd) W(sub)'],
    ['26a', 'cd "Wnioski/źródła"', 'W(cd) W(Wnioski/źródła)'],
    ['26b', 'cd Straße', 'W(cd) W(Straße)'],
    ['26c', 'cd έγγραφα', 'W(cd) W(έγγραφα)'],
    ['27', 'for HOME in /a /b; do cd; done', 'for HOME in W(/a) W(/b) do [W(cd)]'],
    ['28', 'printf -v CDPATH %s x; cd y', 'W(printf) W(-v) W(CDPATH) W(%s) W(x) ; W(cd) W(y)'],
  ])('%s: %j', (_, command, expected) => {
    expect(read(command)).toBe(expected)
  })

  test('9: a backtick and a $( ) are substitutions with the inner list read', () => {
    for (const c of ['cd `echo x`', 'cd $(echo x)']) {
      const r = parseShell(c, 'sh')
      if (!r.ok) throw new Error(r.why)
      const target = (r.list.items[0]!.node.stages[0] as Extract<Node, { type: 'simple' }>)
        .words[1]!
      expect(target.literal).toBeNull()
      const subst = target.parts[0]!
      expect(subst.kind).toBe('subst')
      expect(subst.kind === 'subst' && subst.list && list(subst.list)).toBe('W(echo) W(x)')
    }
  })

  test.each([['echo "unclosed'], ['$(cd x'], ["echo 'x"], ['(cd x'], ['if true; then ls']])(
    '25: %j does not close',
    (c) => expect(read(c)).toBe('fail:unbalanced')
  )

  test('35: shells nested deeper than 3 are not read', () => {
    expect(read(`bash -c "bash -c \\"bash -c 'bash -c x'\\""`)).toBe('fail:depth')
    expect(read(`bash -c "bash -c 'bash -c x'"`)).not.toMatch(/^fail/)
  })
})

describe('parseShell, the forms the cd rules read', () => {
  test.each([
    ['a zsh glob qualifier after a word', 'cd ~/.kube(/)', 'W(cd) X(tilde,zglob:~/.kube(/))'],
    ['a zsh alternation', 'cd ~/.ku(b|x)e', 'W(cd) X(tilde,zglob:~/.ku(b|x)e)'],
    ['a zsh numeric glob', 'cd ~/.kub<->', 'W(cd) X(tilde,zglob:~/.kub<->)'],
    [
      'an array assignment',
      'cdpath+=(~/.config); cd gcloud',
      'A(cdpath+=(X(tilde:~/.config))) ; W(cd) W(gcloud)',
    ],
    [
      'an indexed assignment',
      'DIRSTACK[1]=~/.kube; pushd +1',
      'A(DIRSTACK=X(tilde:~/.kube)) ; W(pushd) W(+1)',
    ],
    [
      'a tilde after a colon in an assignment',
      'CDPATH=.:~/x cd y',
      'A(CDPATH=X(tilde:.:~/x)) W(cd) W(y)',
    ],
    ['a built name', 'declare "${x}"=~/.config', 'W(declare) A(?=…)'],
    ['a here-string', 'read CDPATH <<< ~/.config', 'W(read) W(CDPATH) R(<<< X(tilde:~/.config))'],
    ['a process substitution', 'cat <(cd .aws && ls)', 'W(cat) X(subst:<(cd .aws && ls))'],
    ['a background job', 'ls & cd .aws', 'W(ls) & & W(cd) W(.aws)'],
    ['a trailing background job', 'cd x &', 'W(cd) W(x) &'],
    ['a pipe of stderr', 'ls |& cd x', 'W(ls) | W(cd) W(x)'],
    [
      'a case',
      'case $x in a) cd a;; *) cd b;; esac',
      'case X(param:$x) [W(cd) W(a) ;; W(cd) W(b)]',
    ],
    ['a function', 'f() { cd x; }; f', 'function f { W(cd) W(x) } ; W(f)'],
    [
      'a while loop',
      'while read d; do cd "$d"; done',
      'while [W(read) W(d)] do [W(cd) X(param:"$d")]',
    ],
    [
      'a [[ test with operators',
      '[[ -d x && a < b ]] && cd x',
      'W([[) W(-d) W(x) W(&&) W(a) W(<) W(b) W(]]) && W(cd) W(x)',
    ],
    ['an arithmetic command', '(( i++ )); cd x', 'X(arith:(( i++ ))) ; W(cd) W(x)'],
    [
      'a here-document to a shell',
      "bash <<'EOF'\ncd .aws\nEOF",
      'W(bash) R(<< W(EOF)) N[W(cd) W(.aws)]',
    ],
    [
      'a here-document body is not a command',
      'cat <<-EOF\n\tcd .aws\n\tEOF\nls',
      'W(cat) R(<<- W(EOF)) ⏎ W(ls)',
    ],
    [
      'a wrapper before a shell',
      "env bash -c 'cd .aws'",
      'W(env) W(bash) W(-c) W(cd .aws) N[W(cd) W(.aws)]',
    ],
    ['a short-flag cluster with c', "sh -ec 'cd .aws'", 'W(sh) W(-ec) W(cd .aws) N[W(cd) W(.aws)]'],
    ['a fd-numbered redirection', 'cd x 2>/dev/null', 'W(cd) W(x) R(2> W(/dev/null))'],
    ['an &> redirection', 'cd x &>/dev/null', 'W(cd) W(x) R(&> W(/dev/null))'],
    ['a comment after an operator', 'cd x;# y', 'W(cd) W(x)'],
    ['a dollar alone', 'echo $ x', 'W(echo) W($) W(x)'],
    ['a locale string', 'cd $"x"', 'W(cd) X(ansic:$"x")'],
    ['an arithmetic expansion', 'cd $((1+1))', 'W(cd) X(arith:$((1+1)))'],
    ['a subshell inside a substitution', 'echo $( (cd x) )', 'W(echo) X(subst:$( (cd x) ))'],
    ['a tilde user', 'cd ~k', 'W(cd) X(tilde:~k)'],
    ['a backslash in single quotes is literal', "cd 'a\\' x", 'W(cd) W(a\\) W(x)'],
    ['a stack tilde', 'cd ~+/x ~-', 'W(cd) X(tilde:~+/x) X(tilde:~-)'],
  ])('%s: %j', (_, command, expected) => {
    expect(read(command)).toBe(expected)
  })
})

// The word property: letters of several scripts, digits and `_ . / -`, joined
// by operators, are read back as the same words in order.
describe('parseShell, the word property', () => {
  const LETTERS = 'abcxyzABCźżąęłśćńóßäöüÄÖÜαβγδέήΩ0123456789_./-'
  const OPS = [' ', ' && ', ' || ', '; ', ' | ', '\n', ' & ']
  let seed = 86
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)
  const words = (k: number) =>
    Array.from({ length: k }, () => {
      let w = ''
      const len = 1 + rand(8)
      // A word never starts with `-` or a digit run that could read as an fd or an option.
      while (w.length < len) w += LETTERS[rand(LETTERS.length)]
      return w.replace(/^[-\d]+/, 'w')
    })
  test('500 random commands', () => {
    for (let n = 0; n < 500; n++) {
      const ws = words(1 + rand(6))
      let command = ws[0]!
      for (const w of ws.slice(1)) command += OPS[rand(OPS.length)] + w
      const r = parseShell(command, 'sh')
      if (!r.ok) throw new Error(`${command}: ${r.why}`)
      const got: string[] = []
      for (const { node: p } of r.list.items)
        for (const s of p.stages)
          if (s.type === 'simple') got.push(...s.words.map((w) => w.literal ?? '?'))
      expect(got, JSON.stringify(command)).toEqual(ws)
    }
  })
})

// T009 (FR-004): the views 078's restore check reads give, over the whole
// corpus, what they gave on main. (cd-differential.test.ts checks them too,
// beside the guard's verdicts; this one runs without a guard.) Their bodies
// are main's: a view over the tree would have to rebuild the text it drops.
test("the views: shellWords and splitChain over the corpus are main's", () => {
  const base: Verdict[] = JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/cd-differential.base.json'), 'utf8')
  )
  const differ = CORPUS.filter((e, i) => {
    const chain = splitChain(e.command)
    const words = chain ? chain.map(shellWords) : [shellWords(e.command)]
    return JSON.stringify([chain, words]) !== JSON.stringify([base[i]!.chain, base[i]!.words])
  }).map((e) => e.id)
  expect(differ).toEqual([])
})

// contracts/tokenizer.md 29-34: PowerShell.
describe('parseShell, PowerShell', () => {
  const ps = (command: string): string => {
    const r = parseShell(command, 'ps')
    return r.ok ? list(r.list) : `fail:${r.why}`
  }
  test.each([
    [
      '29',
      'Set-Location "C:\\Program Files (x86)\\App"',
      'W(Set-Location) W(C:\\Program Files (x86)\\App)',
    ],
    ['30', 'c`d ~\\.kube', 'W(cd) X(tilde:~\\.kube)'],
    [
      '31',
      'Set-Location -Path src -ErrorAction Stop; npm test',
      'W(Set-Location) W(-Path) W(src) W(-ErrorAction) W(Stop) ; W(npm) W(test)',
    ],
    [
      '32',
      'Microsoft.PowerShell.Management\\Set-Location C:\\x',
      'W(Microsoft.PowerShell.Management\\Set-Location) W(C:\\x)',
    ],
    ['33', 'cd $env:USERPROFILE\\.aws', 'W(cd) X(param:$env:USERPROFILE\\.aws)'],
    [
      '34',
      '$(Set-Location .aws); gc credentials',
      'W((expression)) X(subst:$(Set-Location .aws)) ; W(gc) W(credentials)',
    ],
    ['single quotes doubled', "echo 'it''s'", "W(echo) W(it's)"],
    ['a backtick-newline joins lines', 'Set-Location `\n  src', 'W(Set-Location) W(src)'],
    ['a pipeline', 'ls | Set-Location', 'W(ls) | W(Set-Location)'],
    ['an assignment', '$p = "x"; cd $p', 'A(p=W(x)) ; W(cd) X(param:$p)'],
    ['a script block', 'ls | % { cd x }', 'W(ls) | W(%) X(subst:{ cd x })'],
    ['a block comment', 'cd <# c #> src', 'W(cd) W(src)'],
    ['a redirection', 'Push-Location src > $null', 'W(Push-Location) W(src) R(> X(param:$null))'],
    [
      'an if',
      'if ($a) { cd x } else { cd y }',
      'if [W((expression)) X(subst:($a))] then [W(cd) W(x)] else [W(cd) W(y)] fi',
    ],
    ['a foreach is not read', 'foreach ($d in $ds) { cd $d }', 'fail:unknown'],
    ['a switch is not read', 'switch ($x) { 1 { cd a } }', 'fail:unknown'],
    ['a hashtable is not read', '$h = @{ a = 1 }', 'fail:unknown'],
    ['a double-quoted backtick', 'cd "a`"b"', 'W(cd) W(a"b)'],
    [
      'a parameter with a colon',
      'Set-Location -LiteralPath:src',
      'W(Set-Location) W(-LiteralPath:) W(src)',
    ],
  ])('%s: %j', (_, command, expected) => expect(ps(command)).toBe(expected))
  test.each([['echo "x'], ["echo 'x"], ['cd $(x'], ['{ cd x']])('%j does not close', (c) =>
    expect(ps(c)).toBe('fail:unbalanced')
  )
})

// T029 review: unclosed braces cost a scan each; past a bound the command is
// unreadable (FR-003: 078's verdict) instead of seconds of work.
test('20,000 unclosed braces are not read, and fast', () => {
  const t = Date.now()
  expect(parseShell(`echo ${'{'.repeat(20_000)}`, 'sh')).toEqual({ ok: false, why: 'depth' })
  expect(parseShell(`echo ${'a{'.repeat(20_000)}`, 'sh')).toEqual({ ok: false, why: 'depth' })
  expect(Date.now() - t).toBeLessThan(2_000)
})

// Spec 091 addendum 2, reading table A1: what stands between `${` and `}` is
// read by one grammar - something before the name, the name, subscripts, an
// operator and its operands - and text it has no row for is unreadable.
describe('addendum 2, A1: an expansion is read by a grammar, in every operand', () => {
  const part = (text: string) => {
    const p = parseShell(`cat ${text}`, 'sh')
    if (!p.ok) throw new Error(`unreadable (${p.why}): ${text}`)
    const n = p.list.items[0]!.node.stages[0]!
    if (n.type !== 'simple') throw new Error('not a simple command')
    return n.words[1]!.parts[0]!
  }
  const param = (text: string) => {
    const p = part(text)
    if (p.kind !== 'param') throw new Error(`${text} is read as ${p.kind}`)
    return p
  }

  test.each([
    ['an offset', '${x:$(a)}'],
    ['a length', '${x:0:$(a)}'],
    ['a prefix pattern', '${x#$(a)}'],
    ['a longest prefix pattern', '${x##$(a)}'],
    ['a suffix pattern', '${x%$(a)}'],
    ['a longest suffix pattern', '${x%%$(a)}'],
    ['a pattern to replace', '${x/$(a)/z}'],
    ['a pattern to replace everywhere', '${x//$(a)/z}'],
    ['a pattern at the start', '${x/#$(a)/z}'],
    ['a pattern at the end', '${x/%$(a)/z}'],
    ['a subscript', '${x[$(a)]}'],
    ['a subscript, in backticks', '${x[`a`]}'],
    ['a subscript of a length', '${#x[$(a)]}'],
    ['a subscript behind !', '${!x[$(a)]}'],
    ['a case pattern', '${x^$(a)}'],
    ['a lower-case pattern', '${x,,$(a)}'],
    ['old arithmetic in an offset', '${x:$[ $(a) ]}'],
    ['a zsh :s pattern', '${x:s/$(a)/z/}'],
    ['a zsh :/ pattern', '${x:/$(a)/z}'],
    ['zsh flags', '${(j:$(a):)x}'],
  ])('the command inside %s is read: %s', (_, text) => {
    expect((param(text).substs ?? []).map(list)).toEqual(['W(a)'])
  })

  test.each([
    ['a default', '${x:-.env}'],
    ['a default without the colon', '${x-.env}'],
    ['an assigned default', '${x:=.env}'],
    ['an alternate value', '${x:+.env}'],
    ['an error text', '${x:?.env}'],
    ['a replacement', '${x/a/.env}'],
    ['a replacement behind an escaped /', '${x/a\\/b/.env}'],
    ['a zsh ::= value', '${x::=.env}'],
    ['a zsh :s replacement', '${x:s/a/.env/}'],
    ['a zsh :s replacement between commas', '${x:s,a,.env,}'],
    ['a zsh :gs replacement', '${x:gs/a/.env/}'],
    ['a zsh :/ replacement', '${x:/a/.env}'],
    ['a default behind a subscript', '${x[1]:-.env}'],
  ])('text the expansion can put into the word is its operand: %s %s', (_, text) => {
    expect(param(text).operand?.map((w) => w.literal)).toEqual(['.env'])
    expect(param(text).transforms).toBeUndefined()
  })

  test('text in a pattern, an offset or a subscript is not the word', () => {
    for (const text of ['${x#.env}', '${x%.env}', '${x/.env/}', '${x:.env}', '${x[.env]}'])
      expect(param(text).operand?.map((w) => w.literal) ?? [], text).toEqual([])
  })

  test.each([
    '${~x:-.env}',
    '${=x:-.env}',
    '${==x:-.env}',
    '${^x:-.env}',
    '${^^x:-.env}',
    '${+x:-.env}',
    '${~~x:-.env}',
    '${=~x:-.env}',
    '${~:-.env}',
    '${(L)x:-.ENV}',
    '${"${:-.env}"}',
    '${"$(true)":-.env}',
    `\${'x':-.env}`,
    '${${:-.eXnv}/X}',
    '${x:l:s/a/.env/}',
    '${x:s/a/.ENV/:l}',
  ])(
    'zsh: something before the name, or a second operator, with written text rewrites it: %s',
    (text) => {
      expect(param(text).transforms).toBe(true)
    }
  )

  test.each(['${~x}', '${=x}', '${^x}', '${+x}', '${(f)x}', '${(P)x}', '${${x}:t}'])(
    'zsh: with no written text it is a value like any other: %s',
    (text) => {
      expect(param(text).transforms).toBeUndefined()
    }
  )

  test('$[...] is arithmetic, wherever it stands, and the commands inside it are read', () => {
    expect(part('$[25519]')).toEqual({ kind: 'arith', text: '$[25519]' })
    const p = part('$[ $(a) + 1 ]')
    expect(p.kind === 'arith' && (p.substs ?? []).map(list)).toEqual(['W(a)'])
    const inside = param('${x:-$[25519]}').operand![0]!.parts[0]!
    expect(inside.kind).toBe('arith')
    expect(part('"$[1]"').kind).toBe('arith')
    // With no closing bracket it is text.
    expect(part('$[1').kind).toBe('lit')
  })

  test('${ cmd; } and ${|cmd;} are command substitutions (bash 5.3)', () => {
    for (const text of ['${ cat a; }', '${|cat a;}']) {
      const p = part(text)
      expect(p.kind === 'subst' && p.list && list(p.list), text).toBe('W(cat) W(a)')
    }
  })

  test.each(['${x.y}', '${x }', '${x*}', '${x[1}', '${x!}', '${(Lx}', '${x@}', "${'x:-a}"])(
    'text the grammar has no row for makes the command unreadable: %s',
    (text) => {
      expect(parseShell(`echo ${text}`, 'sh')).toEqual({ ok: false, why: 'unknown' })
    }
  )

  test.each([
    '${x}',
    '${10}',
    '${#}',
    '${#x}',
    '${#x[@]}',
    '${##}',
    '${?}',
    '${$}',
    '${!}',
    '${-}',
    '${@}',
    '${*}',
    '${#@}',
    '${!x}',
    '${!x[@]}',
    '${!prefix*}',
    '${!prefix@}',
    '${x[@]}',
    '${x[$i]}',
    '${x[i+1]}',
    '${x[${#x[@]}-1]}',
    '${BASH_REMATCH[1]}',
    '${x:1:2}',
    '${x: -1}',
    '${@:2}',
    '${x^^}',
    '${x,,}',
    '${x~~}',
    '${x@Q}',
    '${x//a/b}',
    '${x//\\//-}',
    '${x%%.*}',
    '${x##*/}',
    '${x:-}',
    '${1:-default}',
    '${x:+"$y"}',
    '${x+"$@"}',
    '${x:=${y:-z}}',
    '${x?}',
    '${x:h}',
    '${x:t:r}',
    '${x:#pattern}',
    '${(f)x}',
    '${(s:,:)x}',
    '${x[(r)a*]}',
    '${=x}',
    '${${x%.*}##*/}',
    '${#${x}}',
  ])('an ordinary expansion is still read: %s', (text) => {
    expect(parseShell(`echo ${text}`, 'sh').ok).toBe(true)
    expect(parseShell(`echo "${text}"`, 'sh').ok).toBe(true)
  })
})

// Spec 091 addendum 2, reading table A5-A7 and A10: which commands start a
// shell, the script by its value, and every way it reaches the shell.
describe('addendum 2, A5-A7: text a shell will run', () => {
  const tree = (command: string) => {
    const p = parseShell(command, 'sh')
    if (!p.ok) throw new Error(`unreadable (${p.why}): ${command}`)
    return list(p.list)
  }
  const SCRIPT = 'N[W(cat) W(x)]'

  test.each([
    ['a decoy name before it (env -u)', `env -u sh bash -c 'cat x'`],
    ['a decoy name before it (exec -a)', `exec -a sh bash -c 'cat x'`],
    ['a decoy name before it (xargs -I)', `xargs -I sh bash -c 'cat x'`],
    ['capitals', `SH -c 'cat x'`],
    ['a path in capitals', `/BIN/SH -c 'cat x'`],
    ['mixed case', `/bin/Bash -c 'cat x'`],
    ['csh', `csh -c 'cat x'`],
    ['mksh', `mksh -c 'cat x'`],
    ['fish', `fish -c 'cat x'`],
    ['eval behind builtin', `builtin eval 'cat x'`],
    ['eval behind command', `command eval 'cat x'`],
    ['eval behind noglob', `noglob eval 'cat x'`],
    ['eval behind nocorrect', `nocorrect eval 'cat x'`],
    ['eval behind exec', `exec eval 'cat x'`],
    ['eval behind -', `- eval 'cat x'`],
    ['--norc', `bash --norc -c 'cat x'`],
    ['--noprofile --norc', `bash --noprofile --norc -c 'cat x'`],
    ['--login', `bash --login -c 'cat x'`],
    ['zsh -f', `zsh -fc 'cat x'`],
    ['zsh -d -f', `zsh -df -c 'cat x'`],
  ])('A5: a shell is read behind %s: %s', (_, command) => {
    expect(tree(command)).toContain(SCRIPT)
  })

  test.each([
    ['an ANSI-C string', `bash -c $'cat x'`],
    ['an ANSI-C string with a hex escape', `bash -c $'cat \\x78'`],
    ['a backslash before the blank', 'bash -c cat\\ x'],
    ['a run-time part, read as empty', 'sh -c "cat x$y"'],
    ['two quoted halves', `sh -c 'cat'" x"`],
  ])('A6: the script word is read by its value: %s: %s', (_, command) => {
    expect(tree(command)).toContain(SCRIPT)
  })

  test('A6: a script that does not parse makes the command unreadable; one that is all run-time is not read', () => {
    expect(parseShell(`bash -c 'if'`, 'sh')).toEqual({ ok: false, why: 'unbalanced' })
    expect(parseShell(`sh <<< $'cat "x'`, 'sh').ok).toBe(false)
    expect(tree('bash -c "$CMD"')).toBe('W(bash) W(-c) X(param:"$CMD")')
  })

  test.each([
    ['a here-string', `sh <<< 'cat x'`],
    ['a here-string, ANSI-C', `sh <<<$'cat x'`],
    ['a here-string, backslash', 'sh <<< cat\\ x'],
    ['a here-document', 'sh <<E\ncat x\nE'],
    ['a quoted here-document', `sh <<'E'\ncat x\nE`],
    ['the second of two here-strings', `bash <<< 'true' <<< 'cat x'`],
    ['the second of two here-documents', `bash <<'E' <<'F'\ntrue\nE\ncat x\nF`],
    ['a here-string on the group around it', `{ bash; } <<< 'cat x'`],
    ['a here-document on the subshell around it', '(bash) <<E\ncat x\nE'],
    ['a here-string on the if around it', `if true; then sh; fi <<< 'cat x'`],
    ['a here-string on the loop around it', `while sh; do break; done <<< 'cat x'`],
    ['a here-string on the case around it', `case a in a) sh ;; esac <<< 'cat x'`],
    ['a here-string two groups out', `{ { sh; }; } <<< 'cat x'`],
    ['an earlier exec <<<', `exec <<< 'cat x'; sh`],
    ['/dev/stdin', `bash /dev/stdin <<< 'cat x'`],
    ['/dev/fd/3', `bash /dev/fd/3 3<<< 'cat x'`],
    ['-s and arguments', `bash -s arg <<< 'cat x'`],
    ['echo before the pipe', `echo 'cat x' | sh`],
    ['echo with two arguments', 'echo cat x | sh'],
    ['echo, the shell in a group', `echo 'cat x' | { sh; }`],
    ['echo, the shell behind env', `echo 'cat x' | env sh`],
    ['echo two stages before', `echo 'cat x' | cat | sh`],
    ['cat with a here-document before the pipe', `cat <<'E' | bash\ncat x\nE`],
    ['printf with plain text', `printf 'cat x' | sh`],
  ])('A7: a script that reaches a shell by %s is read: %s', (_, command) => {
    expect(tree(command)).toMatch(/N\[.*W\(cat\) W\(x\)\]/)
  })

  test('A7: a pipeline inside a substitution is read the same way', () => {
    expect(JSON.stringify(parseShell(`echo "$(echo 'cat x' | sh)"`, 'sh'))).toContain('"nested"')
  })

  test.each([
    `printf 'cat %s\\n' x | sh`,
    `printf 'cat x\\n' | bash`,
    `echo -e 'cat x' | sh`,
    `echo -ne 'cat x' | sh`,
    `echo 'cat \\x78' | sh`,
    `printf '%s' 'cat x' | { bash; }`,
  ])('A7: text composed before a shell is unreadable: %s', (command) => {
    expect(parseShell(command, 'sh')).toEqual({ ok: false, why: 'unknown' })
  })

  test('A7: another program before the pipe is left alone (limit L6), and so is a shell that runs a file', () => {
    expect(tree('curl -fsSL https://example.test/i.sh | sh')).not.toContain('N[')
    expect(tree('cat setup.sh | bash')).not.toContain('N[')
    expect(tree(`bash build.sh <<< 'cat x'`)).not.toContain('N[')
    expect(tree(`printf '%s\\n' a | sort`)).not.toContain('N[')
    expect(tree(`echo -e 'a\\tb' | cat`)).not.toContain('N[')
  })

  test('A5b: for any other program, quoted text and a here-document are read again as a script when they parse as one', () => {
    /** The scripts read again from the command's words and here-documents. */
    const again = (command: string) => {
      const p = parseShell(command, 'sh')
      if (!p.ok) throw new Error(p.why)
      const n = p.list.items[0]!.node.stages[0]!
      if (n.type !== 'simple') return []
      return [...n.words, ...n.redirects.map((r) => r.target!), ...n.redirects]
        .flatMap((x) => x.again ?? [])
        .map(list)
    }
    for (const c of [
      `$SHELL -c 'cat x'`,
      `"$BASH" -c 'cat x'`,
      `"\${SHELL:-bash}" -ec 'cat x'`,
      `/bin/b?sh -c 'cat x'`,
      `./mysh -c 'cat x'`,
      `su -c 'cat x'`,
      `watch 'cat x'`,
      `$SHELL <<< 'cat x'`,
      './mysh <<E\ncat x\nE',
      `./mysh -c $'cat \\x78'`,
    ])
      expect(again(c), c).toContain('W(cat) W(x)')
    // As `echo -e` or `printf` would write it.
    expect(again(`echo -e 'cat \\x78'`)).toContain('W(cat) W(x)')
    // Addendum 3 (contract §8.1, A5 (b)): text that parses is read whatever
    // it holds. A parenthesised group in a word no longer drops the whole
    // script: its other words and commands are judged (the guard leaves the
    // word that holds the group to the text floor).
    expect(again(`python3 -c 'print(open("x").read())'`).length).toBe(1)
    expect(again(`psql -c 'select max(price) from t'`)).toEqual([])
    expect(again(`python3 -c 'print(len(x)); import os'`).length).toBe(1)
    expect(again(`./mysh -c 'cat x\necho a(b)'`).join(' ')).toContain('W(cat) W(x)')
    expect(again(`python3 -c 'if x:'`)).toEqual([])
    expect(again(`psql -c 'delete from t'`)).toEqual(['W(delete) W(from) W(t)'])
    // A single plain word has nothing to read again.
    expect(again(`grep -c '.env' x`)).toEqual([])
  })

  test('A5b: a here-document on a compound command is read again too', () => {
    const p = parseShell(`{ { $SHELL; }; } <<'E'\ncat x\nE`, 'sh')
    expect(JSON.stringify(p)).toContain('"again"')
  })

  test('A10: zmodload makes the command unreadable, behind a modifier too', () => {
    for (const c of ['zmodload zsh/mapfile', 'builtin zmodload zsh/mapfile; ls', 'zmodload'])
      expect(parseShell(c, 'sh'), c).toEqual({ ok: false, why: 'unknown' })
    expect(parseShell('echo zmodload', 'sh').ok).toBe(true)
  })
})
