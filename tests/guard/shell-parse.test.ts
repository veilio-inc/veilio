import { describe, expect, test } from 'vitest'
import {
  parseShell,
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
      const s = `${p.timed ? 'time ' : ''}${p.negated ? '! ' : ''}${stages}`
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
    ['a zsh glob qualifier after a word', 'cd ~/.kube(/)', 'W(cd) X(tilde,glob:~/.kube(/))'],
    ['a zsh alternation', 'cd ~/.ku(b|x)e', 'W(cd) X(tilde,glob:~/.ku(b|x)e)'],
    ['a zsh numeric glob', 'cd ~/.kub<->', 'W(cd) X(tilde,glob:~/.kub<->)'],
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
    ['a background job', 'ls & cd .aws', 'W(ls) & W(cd) W(.aws)'],
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
