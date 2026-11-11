// The reading oracle's grammar (the reading table's §6): the canaries, the
// spelling operators O1-O29 and the positions P1-P49. A reviewer's new idea is
// one more operator or one more position here; the generator then tries it in
// every position, alone and combined with the others.
//
// A spelling is built from a canary's name one character at a time: an
// operator rewrites one character (or a run), puts a folder in front, a
// qualifier behind, or wraps the whole name. Operators on different characters
// combine freely, which is how the seeded combinations are made.
import { existsSync } from 'node:fs'
import type { CanaryId, Locale, Shell } from './reading-shell.ts'

export type Canary = {
  id: CanaryId
  /** What stands before the name and is not spelled (`~/`). */
  front: string
  /** The name, relative to the project (or to the home). */
  name: string
  /** In the project (so `cd sub && cat ../NAME` names it). */
  project: boolean
  /** A folder that holds only raw-only files (A11): its own pivot characters. */
  folder?: number[]
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

/** `carried`: a character a variable's value or a command's output supplies
 *  (limit L1 or L2: the command is then outside the promise). */
type Atom = { text: string; kind: 'plain' | 'spelled' | 'wild' | 'gone' | 'carried' }
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
  /** Also run under a collating locale (a bracket range reads differently). */
  collates: boolean
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
  collates: false,
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

const pivots = (c: Canary): number[] => c.folder ?? PIVOTS[c.id]

/** An edit of one character, where `fits` allows it. */
function perChar(
  fits: (c: Canary, i: number) => boolean,
  make: (ch: string, c: Canary, i: number) => string[],
  kind: Atom['kind'],
  also: (s: Spelling) => void = () => {}
): Operator['edits'] {
  return (c, everywhere) => {
    const out: Edit[] = []
    const at = everywhere ? [...c.name].map((_, i) => i) : pivots(c)
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
  const at = everywhere ? [...c.name].map((_, i) => i) : pivots(c)
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

/** A replacement written in a substitution: `Y=a` is set first, and the
 *  expansion puts the written text where `a` stood (bash and zsh), or zsh
 *  assigns it. One per spelling (they set the command's start). */
const substituted = (pre: string, forms: ((text: string) => string)[], ...shells: Shell[]) => {
  const set = (s: Spelling) => {
    s.pre = pre
    if (shells.length) only(...shells)(s)
  }
  const perLetter = perChar(any, (ch) => forms.map((f) => f(ch)), 'spelled', set)
  return (slashes: boolean): Operator['edits'] =>
    (c, everywhere) => [
      ...perLetter(c, everywhere).map((e) => (s: Spelling) => s.pre === '' && e(s)),
      // The whole name as the written text (not behind a front such as `~/`).
      ...(c.front !== '' || (!slashes && c.name.includes('/'))
        ? []
        : forms.map((f): Edit => (s) => {
            if (s.pre !== '' || s.wrap.length > 0 || s.whole !== null) return false
            s.wrap.push(f)
            set(s)
            return true
          })),
    ]
}

/** zsh glob qualifiers that filter or sort and match a plain file of the
 *  user's (zshexpn, "Glob Qualifiers"). */
const QUALIFIERS = [
  ...'.rwAIRUGNDn',
  '-.',
  '^/',
  '^@',
  '^*',
  'om',
  'On',
  'oL',
  'Oa',
  '[1]',
  '[1,2]',
  'L+0',
  'm-1',
  'a-1',
  'c-1',
  'Y1',
  'l1',
  'f600',
  'f:u+r:',
  '#q.',
  ':a',
  ':A',
  ':P',
]

/** zsh's modifiers (zshexpn, "Modifiers"), alone and joined (`&`, which
 *  repeats a substitution, cannot be written in a word the oracle runs). */
const MODIFIERS = [
  ...'aAcehlpPqQrtuxw',
  'h1',
  't1',
  't:r',
  'r:t',
  'h:t',
  'a:h',
  's/bak/pem/',
  'gs/x/y/',
]

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
  {
    id: 'O23',
    // Also inside a written default: read where it stands, it is still digits.
    edits: digitRun(
      (d) => [`$((${d}))`, `$(( ${d} + 0 ))`, `\${x:-$((${d}))}`, `\${x:-\${y:-$((${d}))}}`],
      'spelled'
    ),
  },
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
    // Text written inside a substitution expansion (reading table E11b).
    id: 'O30',
    edits: both(
      substituted('Y=a; ', [
        (t) => `\${Y/a/${t}}`,
        (t) => `\${Y//a/${t}}`,
        (t) => `\${Y/#a/${t}}`,
        (t) => `\${Y/%a/${t}}`,
        (t) => `"\${Y/a/${t}}"`,
      ])(true),
      substituted(
        '',
        [(t) => `\${x/#/${t}}`, (t) => `\${x/%/${t}}`, (t) => `\${x::=${t}}`],
        'zsh'
      )(true),
      substituted('Y=a; ', [(t) => `\${Y:/a/${t}}`], 'zsh')(true),
      substituted('Y=a; ', [(t) => `\${Y:s/a/${t}/}`, (t) => `\${Y:gs/a/${t}/}`], 'zsh')(false)
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
  // ── addendum 2 (contract §7.8) ──
  {
    // Old arithmetic, alone and inside a written default (A1).
    id: 'O31',
    edits: digitRun((d) => [`$[${d}]`, `$[ ${d} + 0 ]`, `\${x:-$[${d}]}`, `"$[${d}]"`], 'spelled'),
  },
  {
    // Arithmetic inside a written default.
    id: 'O32',
    edits: digitRun(
      (d) => [
        `\${x:-$((${d}))}`,
        `\${x-$((${d}))}`,
        `\${x:=$((${d}))}`,
        `\${HOME:+$((${d}))}`,
        `"\${x:-$((${d}))}"`,
      ],
      'spelled'
    ),
  },
  {
    // Each operator of A1 whose operand the shell puts into the word, with a
    // number as the operand (a spelled name there is O21, O27 and O30; a
    // command there is the positions OPERANDS).
    id: 'O33',
    edits: both(
      digitRun(
        (d) =>
          [`$((${d}))`, `$[${d}]`].flatMap((n) => [
            `\${x=${n}}`,
            `\${HOME+${n}}`,
            `\${x:-\${y:-${n}}}`,
          ]),
        'spelled'
      ),
      (c) =>
        digitRun(
          (d) =>
            [`$((${d}))`, `$[${d}]`].flatMap((n) => [
              `\${Y/a/${n}}`,
              `\${Y//a/${n}}`,
              `\${Y/#a/${n}}`,
              `\${Y/%a/${n}}`,
            ]),
          'spelled'
        )(c).map((e): Edit => (s) => {
          if (s.pre !== '' || !e(s)) return false
          s.pre = 'Y=a; '
          return true
        }),
      (c) =>
        digitRun((d) => [`$((${d}))`, `$[${d}]`].map((n) => `\${x::=${n}}`), 'spelled', 'zsh')(c)
    ),
  },
  {
    // zsh: something before the name that is not `#` or `!`, with written text.
    id: 'O34',
    edits: (c) =>
      wrapped(
        [
          (b) => `\${~x:-${b}}`,
          (b) => `\${=x:-${b}}`,
          (b) => `\${==x:-${b}}`,
          (b) => `\${^x:-${b}}`,
          (b) => `\${^^x:-${b}}`,
          (b) => `\${+x:-${b}}`,
          (b) => `\${~~x:-${b}}`,
          (b) => `\${=~x:-${b}}`,
          (b) => `\${~:-${b}}`,
          (b) => `\${"\${:-${b}}"}`,
          (b) => `\${"$Z":-${b}}`,
        ],
        'zsh'
      )().map(
        (e): Edit =>
          (s) =>
            c.front === '' && e(s)
      ),
  },
  {
    // Bracket expressions by the POSIX grammar (A2). `[[.x.]]` and `[[=x=]]`
    // are bash's; a range whose ends differ in case reads by the locale.
    id: 'O35',
    edits: both(
      perChar(
        globbable,
        (ch) => [`[\\]${ch}]`, `[]${ch}]`, `[${ch}\\]]`, `[!\\]]`, `[!]]`],
        'wild',
        (s) => void (s.collates = true)
      ),
      perChar(
        globbable,
        (ch) => [`[[.${ch}.]]`, `[[=${ch}=]]`],
        'wild',
        (s) => {
          s.collates = true
          only('bash')(s)
        }
      ),
      perChar(
        (c, i) => /[b-y]/.test(c.name[i]!),
        (ch) => {
          const lo = String.fromCharCode(ch.charCodeAt(0) - 1)
          const hi = String.fromCharCode(ch.charCodeAt(0) + 1)
          // `[M-o]` holds `n` by its code; `[m-O]` only where a locale collates.
          return [`[${lo.toUpperCase()}-${hi}]`, `[${lo}-${hi.toUpperCase()}]`]
        },
        'wild',
        (s) => void (s.collates = true)
      )
    ),
  },
  {
    // zsh: groups inside groups, with alternatives.
    id: 'O36',
    edits: both(
      perChar(
        globbable,
        (ch) => [`((${ch}))`, `(((${ch})))`, `((${ch}|x)|x)`, `(((${ch}|x))|x)`],
        'wild',
        only('zsh')
      ),
      wholeName(
        (c) =>
          c.name.includes('/')
            ? []
            : [
                `((${c.name.slice(0, 2)})${c.name.slice(2)})`,
                `(${c.name.slice(0, 1)}(${c.name.slice(1, 2)})${c.name.slice(2)})`,
                `(${c.name.slice(0, 2)}(${c.name.slice(2)}))`,
                `(${c.name.slice(0, 2)}(${c.name.slice(2, 3)}|x)${c.name.slice(3)}|x)`,
                `(((${c.name.slice(0, 1)})${c.name.slice(1, 2)})${c.name.slice(2)})`,
              ],
        'zsh'
      )
    ),
  },
  {
    // zsh: glob qualifiers. Those that only filter or sort (each letter of
    // the manual that takes no argument, and a few that take one) stand
    // behind a word with a `?`; `e`, `P` and a `:s` modifier write the name.
    id: 'O37',
    edits: both(
      (c, everywhere) =>
        perChar(
          globbable,
          () => ['?'],
          'wild'
        )(c, everywhere).flatMap((e) =>
          QUALIFIERS.map((tail): Edit => (s) => {
            if (s.tail !== '' || s.wrap.length > 0 || !e(s)) return false
            s.tail = `(${tail})`
            only('zsh')(s)
            return true
          })
        ),
      (c) =>
        !c.project
          ? []
          : wholeName(
              (c) => [
                `sub(e:'REPLY=${c.name}':)`,
                `sub(P:${c.name}:)`,
                ...(c.name.includes('/') ? [] : [`sub(:s/sub/${c.name}/)`]),
              ],
              'zsh'
            )(c)
    ),
  },
  {
    // zsh: each history modifier of the manual as a glob qualifier
    // (coordinator ruling, 2026-11-11): `:t`, `:h`, `:a` and `:A` give back
    // a part, or the absolute form, of a name the word matched, so the word
    // is judged as written; every other one may write another name
    // (`server.pem.bak(:r)` is `server.pem`). Real zsh checks the split.
    id: 'O41',
    edits: both(
      () =>
        MODIFIERS.map((m): Edit => (s) => {
          if (s.tail !== '' || s.wrap.length > 0 || s.whole !== null) return false
          s.tail = `(:${m})`
          only('zsh')(s)
          return true
        }),
      wholeName(
        (c) =>
          c.id !== 'PEM'
            ? []
            : MODIFIERS.flatMap((m) => [`${c.name}.bak(:${m})`, `${c.name}.bak(.:${m})`]),
        'zsh'
      )
    ),
  },
  {
    // Limit L1, to show where it starts: one character of the name is a
    // variable's value. Outside the promise; counted, never a miss.
    id: 'O40',
    edits: (c, everywhere) =>
      perChar(
        (c, i) => isAlnum(c.name[i]!),
        () => ['${C}'],
        'carried'
      )(c, everywhere).map((e, k) => (s: Spelling) => {
        if (s.pre !== '' || !e(s)) return false
        const at = (everywhere ? [...c.name].map((_, i) => i) : pivots(c)).filter((i) =>
          isAlnum(c.name[i]!)
        )[k]!
        s.pre = `C=${c.name[at]}; `
        return true
      }),
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
  /** bash from 4.0 only. */
  bash4?: true
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
  // zsh reports the error without the text: its own row below.
  run('P20', (w) => `: $(( $(cat ${w}) ))`, { shell: 'bash' }),
  run('P20b', (w) => `: $(( $(cat ${w} >&2) + 0 ))`),
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
  // A shell behind a program that runs it.
  run('P64', (w) => `env X=1 sh -c "cat ${dq(w)}"`, { inner: true }),
  run('P65', (w) => `nice -n 5 bash -c "cat ${dq(w)}"`, { inner: true }),
  run('P66', (w) => `echo x | xargs -I{} sh -c "cat ${dq(w)}"`, { inner: true }),
  run('P67', (w) => `command bash -c "cat ${dq(w)}"`, { inner: true }),
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
  // Addendum 2. A command in an operand of an expansion (all of them: OPERANDS).
  run('P70', (w) => `Y=a; echo \${Y:0:$(cat ${w} >&2)}`),
  run('P71', (w) => `Y=a; : \${Y#$(cat ${w} >&2)}`),
  run('P72', (w) => `: \${Y[\`cat ${bt(w)} >&2\`]}`),
  // A word break at an unquoted run-time part (A4): bash splits the word.
  run('P73', (w) => `cat\${IFS}${w}`, { shell: 'bash' }),
  run('P74', (w) => `cat\${IFS%?}${w}`, { shell: 'bash' }),
  run('P75', (w) => `cat\${IFS:0:1}${w}`, { shell: 'bash' }),
  run('P76', (w) => (/^[A-Za-z0-9_]/.test(w) ? `cat\${IFS}${w}` : `cat$IFS${w}`), {
    shell: 'bash',
  }),
  // Quoted text the shell evaluates again (A9).
  run('P77', (w) => `read 'a[$(cat ${sq(w)} >&2)]' <<< x`),
  run('P78', (w) => `: $(( 'a[$(cat ${sq(w)} >&2)]' ))`),
  run('P79', (w) => `[[ 'a[$(cat ${sq(w)} >&2)]' -eq 0 ]]`, { shell: 'bash' }),
  run('P80', (w) => `declare -a 'a=($(cat ${sq(w)} >&2))'`, { shell: 'bash' }),
  run('P81', (w) => `PS4='$(cat ${sq(w)} >&2)'; set -x; :`, { shell: 'bash' }),
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

// ── addendum 2: a folder that holds only raw-only files (A11) ──

export const FOLDERS: readonly Canary[] = [
  { id: 'DIR', front: '', name: 'secrets', project: true, folder: [2, 5] },
  { id: 'HOME', front: '~/', name: '.veilio', project: false, folder: [3, 5] },
]
/** W is the folder: read as a whole (executed), or copied, linked, moved,
 *  archived or deleted (judged only: these would change the fixture). */
export const FOLDER_POSITIONS: readonly Position[] = [
  run('A11:grep -r', (w) => `grep -r VEILIO ${w}`),
  run('A11:find -exec', (w) => `find ${w} -type f -exec cat {} +`),
  run('A11:tar', (w) => `tar cf - ${w} | tar xOf -`),
  judged('A11:cp -R', (w) => `cp -R ${w} v2`),
  judged('A11:ln -s', (w) => `ln -s ${w} v`),
  judged('A11:rm -rf', (w) => `rm -rf ${w}`),
  judged('A11:mv', (w) => `mv ${w} x`),
  judged('A11:tar czf', (w) => `tar czf s.tgz ${w}`),
  judged('A11:git -C', (w) => `git -C ${w} init`),
  judged('A11:rsync', (w) => `rsync -a src/ ${w}/`),
  judged('A11:find -delete', (w) => `find ${w} -delete`),
  judged('A11:ls', (w) => `ls ${w}`),
]

// ── addendum 2: a command inside each operand of an expansion (A1, O33) ──

/** Each expansion operator of A1 and each of its operands, as text with the
 *  operand's place marked: `Y` is set to `a`, `x` is unset. `shells`: where
 *  the operand is evaluated (measured in bash 3.2 and zsh 5.9); `bash4`:
 *  bash from 4.0 only. */
const EXPANSIONS: readonly {
  id: string
  make: (operand: string) => string
  shells?: Shell[]
  bash4?: true
}[] = [
  { id: ':-', make: (o) => `\${x:-${o}}` },
  { id: '-', make: (o) => `\${x-${o}}` },
  { id: ':=', make: (o) => `\${x:=${o}}` },
  { id: '=', make: (o) => `\${x=${o}}` },
  { id: ':+', make: (o) => `\${HOME:+${o}}` },
  { id: '+', make: (o) => `\${HOME+${o}}` },
  { id: ':?', make: (o) => `\${x:?${o}}`, shells: ['bash'] },
  { id: '?', make: (o) => `\${x?${o}}`, shells: ['bash'] },
  { id: '#', make: (o) => `\${Y#${o}}` },
  { id: '##', make: (o) => `\${Y##${o}}` },
  { id: '%', make: (o) => `\${Y%${o}}` },
  { id: '%%', make: (o) => `\${Y%%${o}}` },
  { id: '/pattern', make: (o) => `\${Y/${o}/z}` },
  { id: '//pattern', make: (o) => `\${Y//${o}/z}` },
  { id: '/#pattern', make: (o) => `\${Y/#${o}/z}` },
  { id: '/%pattern', make: (o) => `\${Y/%${o}/z}` },
  { id: '/text', make: (o) => `\${Y/a/${o}}` },
  { id: '//text', make: (o) => `\${Y//a/${o}}` },
  { id: ':offset', make: (o) => `\${Y:${o}}` },
  { id: ':length', make: (o) => `\${Y:0:${o}}` },
  { id: '[subscript]', make: (o) => `\${Y[${o}]}` },
  { id: '#[subscript]', make: (o) => `\${#Y[${o}]}` },
  { id: '![subscript]', make: (o) => `\${!x[${o}]}`, shells: ['bash'] },
  { id: '^', make: (o) => `\${Y^${o}}`, shells: ['bash'], bash4: true },
  { id: ',', make: (o) => `\${Y,${o}}`, shells: ['bash'], bash4: true },
  { id: '::=', make: (o) => `\${Y::=${o}}` },
  { id: ':/pattern', make: (o) => `\${Y:/${o}/z}` },
  { id: ':/text', make: (o) => `\${Y:/a/${o}}` },
]
const PAYLOADS: readonly { id: string; make: (w: string) => string }[] = [
  { id: '$()', make: (w) => `$(cat ${w} >&2)` },
  { id: '``', make: (w) => `\`cat ${bt(w)} >&2\`` },
  { id: '$[$()]', make: (w) => `$[ $(cat ${w} >&2) ]` },
]
/** bash's major version, told by the oracle before it generates (3 until then). */
let bashMajor = 3
export const bashIs = (major: number): void => void (bashMajor = major)

/** Every operand of every expansion holding a command that names W: tried
 *  with a sample of the spellings, as the option clusters are. */
export const OPERANDS: readonly Position[] = EXPANSIONS.flatMap((x) =>
  PAYLOADS.map((p) =>
    run(`P:\${${x.id}}${p.id}`, (w) => `Y=a; : ${x.make(p.make(w))}`, {
      sample: true,
      ...(x.shells ? { shell: x.shells[0]! } : {}),
      ...(x.bash4 ? { bash4: true as const } : {}),
    })
  )
)

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
  'find tar cat head tail dd grep sed awk printf echo read : true test [ [[ cd pwd export declare typeset local eval exec source . for while until if case setopt unsetopt shopt set alias bash sh zsh xargs env command nice mapfile'.split(
    ' '
  )
)
/** Words of the templates that are not programs: keywords, arguments, names. */
const FILLERS = new Set(
  'then fi do done in esac x l i f F a r s c e if EOF dev null src index ts sub PWD W extendedglob braceccl extglob dotglob globdots O o S options on builtin Y X n I cO co c4 oglobdots Oc OOc cOe oOc oc pipefail ecoglobdots'.split(
    ' '
  )
)
for (const p of CLUSTERS)
  for (const m of p.make('W').matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) FILLERS.add(m[0])
FILLERS.add('rcfile').add('emulate')
for (const w of 'Y z HOME IFS a q PS4 Z eq C VEILIO type cf xOf'.split(' ')) FILLERS.add(w)
const MARK = 'W'

/** Throws unless an executed command is made of the closed vocabulary and its
 *  word W can run nothing but `pwd`, write nothing and end no command. */
export function assertVocabulary(pre: string, position: Position, word: string): void {
  // O40 sets `C` to one character of the name.
  const skeleton = pre.replace(/^C=[A-Za-z0-9]; /, 'C=x; ') + position.make(MARK)
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
  /** The locales it is run under (C; a bracket range also where one collates). */
  locales: Locale[]
  /** The grammar values it shows alive (rule R5): an operator applied alone,
   *  the position, each axis value of a delivery, a trigger's kind. */
  values: string[]
  /** A variable's value or a command's output supplies a character of the
   *  canary's path: outside the promise (limits L1 and L2). */
  carried: boolean
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
        (sh) =>
          (!p.shell || p.shell === sh) &&
          (!p.inner || s.shells.has('bash')) &&
          !(p.bash4 && bashMajor < 4)
      )
  // The proof is run too, so the word is checked for every position.
  const first = s.canary.folder ? FOLDER_POSITIONS[0]! : POSITIONS[0]!
  assertVocabulary(s.pre, p.executed ? p : first, word)
  return {
    id,
    operatorIds,
    positionId: p.id,
    canary: s.canary.id,
    command: s.pre + p.make(word),
    plain: p.make(at(plainName(s.canary), proj)),
    proof: s.pre + first.make(word),
    proofShells: [...s.shells],
    shells,
    locales: s.collates ? ['C', 'en_US.UTF-8'] : ['C'],
    values: [...(operatorIds.length === 1 ? [operatorIds[0]!] : []), p.id],
    carried: s.atoms.some((a) => a.kind === 'carried'),
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
          for (const p of [...CLUSTERS, ...OPERANDS]) {
            const g = command(`F:${c.id}:${o.id}.${k}:${p.id}`, [o.id], s, p, proj)
            if (g) out.push(g)
          }
      })
  return out
}

/** The whole folders of A11 (canary DIR is in `secrets`, HOME in `~/.veilio`),
 *  by every operator at their pivot characters, in the folder positions. */
export function folders(proj: string): Generated[] {
  const out: Generated[] = []
  for (const c of FOLDERS)
    for (const o of OPERATORS)
      o.edits(c, false).forEach((edit, k) => {
        const s = fresh(c)
        if (!edit(s) || !partsKeepText(s)) return
        for (const p of FOLDER_POSITIONS) {
          const g = command(`A11:${c.name}:${o.id}.${k}:${p.id}`, [o.id], s, p, proj)
          if (g) out.push({ ...g, values: [p.id] })
        }
      })
  // The folder by its plain name.
  for (const c of FOLDERS)
    for (const p of FOLDER_POSITIONS) {
      const g = command(`A11:${c.name}:plain:${p.id}`, [], fresh(c), p, proj)
      if (g) out.push(g)
    }
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

// ── addendum 2: how a script reaches a shell (contract §7.8, G2) ──
//
// A delivery is one value from each of six axes: a wrapper, the word that is
// the shell, its options, the form the script is written in, the channel it
// arrives by, and the command it holds - which may be a delivery again.

/** What runs the script: a shell by its kind, any program that is one
 *  (`$SHELL`), or the shell the command itself runs in (`eval`). */
type Kind = 'sh' | 'bash' | 'zsh' | 'csh' | 'any' | 'eval' | 'source'
type Value = { id: string; outer?: Shell[] }
type ShellWord = Value & { word: string; kind: Kind }
const onMac = process.platform === 'darwin'
const SHELL_WORDS: readonly ShellWord[] = [
  { id: 'sh', word: 'sh', kind: 'sh' },
  { id: 'bash', word: 'bash', kind: 'bash' },
  { id: 'zsh', word: 'zsh', kind: 'zsh' },
  { id: '/bin/sh', word: '/bin/sh', kind: 'sh' },
  { id: '/bin/bash', word: '/bin/bash', kind: 'bash' },
  // A file system that folds case runs these (macOS).
  ...(onMac
    ? ([
        { id: 'SH', word: 'SH', kind: 'sh' },
        { id: '/BIN/SH', word: '/BIN/SH', kind: 'sh' },
        { id: '/bin/Bash', word: '/bin/Bash', kind: 'bash' },
      ] as const)
    : []),
  // bash sets SHELL and BASH itself; zsh sets neither.
  { id: '$SHELL', word: '$SHELL', kind: 'any', outer: ['bash'] },
  { id: '"$BASH"', word: '"$BASH"', kind: 'bash', outer: ['bash'] },
  { id: '$0', word: '$0', kind: 'any' },
  { id: '"${SHELL:-bash}"', word: '"${SHELL:-bash}"', kind: 'any' },
  { id: '/bin/b?sh', word: '/bin/b?sh', kind: 'bash' },
  { id: './mysh', word: './mysh', kind: 'sh' },
  ...(existsSync('/bin/csh') ? ([{ id: 'csh', word: 'csh', kind: 'csh' }] as const) : []),
  ...(existsSync('/bin/tcsh') ? ([{ id: 'tcsh', word: 'tcsh', kind: 'csh' }] as const) : []),
  { id: 'eval', word: 'eval', kind: 'eval' },
  { id: 'source /dev/stdin', word: 'source /dev/stdin', kind: 'source' },
]

type Wrapper = Value & { wrap: (command: string) => string; kinds?: Kind[]; argument?: true }
const SHELLS_ONLY: Kind[] = ['sh', 'bash', 'zsh', 'csh', 'any']
const WRAPPERS: readonly Wrapper[] = [
  { id: 'none', wrap: (c) => c },
  { id: 'env X=1', wrap: (c) => `env X=1 ${c}`, kinds: SHELLS_ONLY },
  { id: 'env -u sh', wrap: (c) => `env -u sh ${c}`, kinds: SHELLS_ONLY },
  { id: 'env -i PATH=$PATH', wrap: (c) => `env -i PATH=$PATH ${c}`, kinds: SHELLS_ONLY },
  { id: 'exec', wrap: (c) => `exec ${c}`, kinds: SHELLS_ONLY },
  { id: 'exec -a sh', wrap: (c) => `exec -a sh ${c}`, kinds: SHELLS_ONLY },
  { id: 'command', wrap: (c) => `command ${c}`, kinds: SHELLS_ONLY },
  { id: 'command (eval)', wrap: (c) => `command ${c}`, kinds: ['eval'], outer: ['bash'] },
  { id: 'builtin', wrap: (c) => `builtin ${c}`, kinds: ['eval', 'source'] },
  { id: 'nice', wrap: (c) => `nice ${c}`, kinds: SHELLS_ONLY },
  { id: 'nohup', wrap: (c) => `nohup ${c}`, kinds: SHELLS_ONLY },
  ...(existsSync('/usr/bin/timeout')
    ? [{ id: 'timeout 5', wrap: (c: string) => `timeout 5 ${c}`, kinds: SHELLS_ONLY }]
    : []),
  { id: 'time', wrap: (c) => `time ${c}` },
  // The script is an argument of the wrapped command: xargs gives it no input.
  {
    id: 'xargs -I{}',
    wrap: (c) => `echo x | xargs -I{} ${c}`,
    kinds: SHELLS_ONLY,
    argument: true,
  },
  {
    id: 'xargs -I sh',
    wrap: (c) => `echo x | xargs -I sh ${c}`,
    kinds: ['bash', 'zsh', 'csh', 'any'],
    argument: true,
  },
  { id: 'noglob', wrap: (c) => `noglob ${c}`, outer: ['zsh'] },
  { id: 'nocorrect', wrap: (c) => `nocorrect ${c}`, outer: ['zsh'] },
  { id: 'exec (eval)', wrap: (c) => `exec ${c}`, kinds: ['eval'], outer: ['zsh'] },
  // zsh's `-`: the program is started as a login shell is.
  { id: '-', wrap: (c) => `- ${c}`, kinds: ['bash', 'zsh'], outer: ['zsh'] },
]

/** `scripted`: the options end in `c`, the script is the next word. */
type Options = Value & { text: string; kinds: Kind[]; scripted: boolean }
const SH3: Kind[] = ['sh', 'bash', 'zsh']
const OPTIONS: readonly Options[] = [
  { id: '-c', text: '-c', kinds: [...SH3, 'csh', 'any'], scripted: true },
  { id: '-ec', text: '-ec', kinds: [...SH3, 'any'], scripted: true },
  { id: '-e -c', text: '-e -c', kinds: SH3, scripted: true },
  { id: '-uxc', text: '-uxc', kinds: SH3, scripted: true },
  { id: '-o pipefail -c', text: '-o pipefail -c', kinds: SH3, scripted: true },
  { id: '-fc (csh)', text: '-fc', kinds: ['csh'], scripted: true },
  // The allow-list entries of research D22.
  { id: '--norc -c', text: '--norc -c', kinds: ['bash'], scripted: true },
  { id: '--noprofile --norc -c', text: '--noprofile --norc -c', kinds: ['bash'], scripted: true },
  { id: '--login -c', text: '--login -c', kinds: ['bash'], scripted: true },
  { id: '-fc', text: '-fc', kinds: ['zsh'], scripted: true },
  { id: '-f -c', text: '-f -c', kinds: ['zsh'], scripted: true },
  { id: '-df -c', text: '-df -c', kinds: ['zsh'], scripted: true },
  { id: '(none)', text: '', kinds: [...SH3, 'csh', 'any', 'eval', 'source'], scripted: false },
  { id: '-e', text: '-e', kinds: SH3, scripted: false },
  { id: '--norc', text: '--norc', kinds: ['bash'], scripted: false },
  { id: '-f', text: '-f', kinds: ['zsh', 'csh'], scripted: false },
]

/** The script as one word of the command; null when the form cannot hold it. */
type Form = Value & { write: (script: string) => string | null }
const ansi = (t: string) => t.replace(/[\\']/g, '\\$&').replace(/\n/g, '\\n')
/** One letter of the text as `\xNN` (the first after a blank or a dot). */
const oneHex = (t: string) => t.replace(/(?<=[ .])[a-z]/, (ch) => `\\x${hex(ch)}`)
const FORMS: readonly Form[] = [
  { id: `'…'`, write: (t) => `'${sq(t)}'` },
  { id: `"…"`, write: (t) => `"${dq(t)}"` },
  { id: `$'…'`, write: (t) => `$'${ansi(t)}'` },
  { id: `$'…\\xNN…'`, write: (t) => `$'${oneHex(ansi(t))}'` },
  {
    id: 'backslash-blank',
    write: (t) => (t.includes('\n') ? null : t.replace(/[^A-Za-z0-9_./[\]-]/g, '\\$&')),
  },
  { id: `"…$x"`, write: (t) => `"${dq(t)}$x"` },
  {
    id: `'…'""'…'`,
    write: (t) => {
      const at = Math.ceil(t.length / 2)
      return `'${sq(t.slice(0, at))}'""'${sq(t.slice(at))}'`
    },
  },
]

type Channel = Value & {
  /** The script is the word after the options (they must end in `c`). */
  argument?: true
  /** The script is written by the channel itself, not as a word in a form. */
  body?: true
  kinds: Kind[]
  build: (x: { shell: string; word: string; script: string; wrap: (c: string) => string }) => string
}
/** A here-document's body under a plain delimiter, where `$`, a backtick and
 *  a backslash are still read. */
const plainBody = (t: string) => t.replace(/[\\$`]/g, '\\$&')
const INPUT: Kind[] = [...SH3, 'any', 'source']
const STDIN: Kind[] = [...SH3, 'any']
const CHANNELS: readonly Channel[] = [
  {
    id: 'the word after -c',
    argument: true,
    kinds: [...SH3, 'csh', 'any', 'eval'],
    build: (x) => x.wrap(`${x.shell} ${x.word}`),
  },
  { id: '<<<', kinds: INPUT, build: (x) => `${x.wrap(x.shell)} <<< ${x.word}` },
  {
    id: '<<E',
    body: true,
    kinds: INPUT,
    build: (x) => `${x.wrap(x.shell)} <<E\n${plainBody(x.script)}\nE`,
  },
  {
    id: `<<'E'`,
    body: true,
    kinds: INPUT,
    build: (x) => `${x.wrap(x.shell)} <<'E'\n${x.script}\nE`,
  },
  {
    id: '<<-E',
    body: true,
    kinds: INPUT,
    build: (x) => `${x.wrap(x.shell)} <<-E\n\t${plainBody(x.script)}\n\tE`,
  },
  { id: 'two <<<', kinds: STDIN, build: (x) => `${x.wrap(x.shell)} <<< 'true' <<< ${x.word}` },
  {
    id: 'two <<',
    body: true,
    kinds: STDIN,
    build: (x) => `${x.wrap(x.shell)} <<'E' <<'F'\ntrue\nE\n${x.script}\nF`,
  },
  { id: '{ } <<<', kinds: STDIN, build: (x) => `{ ${x.wrap(x.shell)}; } <<< ${x.word}` },
  { id: '( ) <<<', kinds: STDIN, build: (x) => `( ${x.wrap(x.shell)} ) <<< ${x.word}` },
  {
    id: 'if <<<',
    kinds: STDIN,
    build: (x) => `if true; then ${x.wrap(x.shell)}; fi <<< ${x.word}`,
  },
  {
    id: 'while <<<',
    kinds: STDIN,
    build: (x) => `while ${x.wrap(x.shell)}; do break; done <<< ${x.word}`,
  },
  {
    id: '{ { } } <<E',
    body: true,
    kinds: STDIN,
    build: (x) => `{ { ${x.wrap(x.shell)}; }; } <<'E'\n${x.script}\nE`,
  },
  { id: 'exec <<<', kinds: STDIN, build: (x) => `exec <<< ${x.word}; ${x.wrap(x.shell)}` },
  { id: '/dev/stdin', kinds: STDIN, build: (x) => `${x.wrap(x.shell)} /dev/stdin <<< ${x.word}` },
  {
    id: '/dev/fd/3',
    kinds: STDIN,
    build: (x) => `${x.wrap(x.shell)} /dev/fd/3 3<<< ${x.word}`,
  },
  { id: '-s arg', kinds: SH3, build: (x) => `${x.wrap(x.shell)} -s arg <<< ${x.word}` },
  { id: 'echo |', kinds: INPUT, build: (x) => `echo ${x.word} | ${x.wrap(x.shell)}` },
  {
    id: 'echo | { }',
    kinds: STDIN,
    build: (x) => `echo ${x.word} | { ${x.wrap(x.shell)}; }`,
  },
  // zsh's echo reads `\xNN` with no option; bash's with -e.
  {
    id: 'echo \\xNN |',
    body: true,
    kinds: STDIN,
    outer: ['zsh'],
    build: (x) => `echo '${sq(oneHex(x.script))}' | ${x.wrap(x.shell)}`,
  },
  {
    id: 'echo -e |',
    body: true,
    kinds: STDIN,
    build: (x) => `echo -e '${sq(oneHex(x.script))}' | ${x.wrap(x.shell)}`,
  },
  {
    id: 'printf %s |',
    kinds: STDIN,
    build: (x) => `printf '%s\\n' ${x.word} | ${x.wrap(x.shell)}`,
  },
  {
    id: `cat <<'E' |`,
    body: true,
    kinds: INPUT,
    build: (x) => `cat <<'E' | ${x.wrap(x.shell)}\n${x.script}\nE`,
  },
  {
    id: '< <(echo)',
    kinds: STDIN,
    build: (x) => `${x.wrap(x.shell)} < <(echo ${x.word})`,
  },
  // Values the shell reads as code: the script stands in a `$(...)` there.
  {
    id: 'PS4= -x',
    body: true,
    kinds: ['sh', 'bash'],
    build: (x) => `PS4='$(${sq(x.script)} >&2)' ${x.wrap(`${x.shell} -xc :`)}`,
  },
  {
    id: 'ENV= sh -i',
    body: true,
    kinds: ['sh'],
    build: (x) => `ENV='$(${sq(x.script)} >&2)' ${x.wrap(`${x.shell} -ic :`)}`,
  },
  {
    id: 'BASH_ENV=',
    body: true,
    kinds: ['bash'],
    build: (x) => `BASH_ENV='$(${sq(x.script)} >&2)' ${x.wrap(`${x.shell} -c :`)}`,
  },
  // Run by the shell the command itself runs in.
  { id: 'trap EXIT', kinds: ['eval'], build: (x) => `trap ${x.word} EXIT` },
  {
    id: 'alias',
    kinds: ['eval'],
    outer: ['zsh'],
    build: (x) => `alias a=${x.word}; ${x.wrap(`${x.shell} a`)}`,
  },
  {
    id: 'alias (bash)',
    kinds: ['eval'],
    outer: ['bash'],
    build: (x) => `shopt -s expand_aliases\nalias a=${x.word}\na`,
  },
]

type Inner = Value & { spell: (c: Canary) => string; kinds?: Kind[] }
const pivot = (c: Canary) => pivots(c)[0]!
const spelt = (c: Canary, make: (ch: string) => string) =>
  c.front + c.name.slice(0, pivot(c)) + make(c.name[pivot(c)]!) + c.name.slice(pivot(c) + 1)
const INNERS: readonly Inner[] = [
  { id: 'plain', spell: plainName },
  { id: 'quote', spell: (c) => spelt(c, (ch) => `${ch}''`) },
  { id: 'bracket', spell: (c) => spelt(c, (ch) => `[${ch}]`) },
  // csh has no `$'…'`.
  {
    id: 'hex',
    spell: (c) => spelt(c, (ch) => `$'\\x${hex(ch)}'`),
    kinds: [...SH3, 'any', 'eval', 'source'],
  },
]

const AXES = {
  wrapper: WRAPPERS,
  shell: SHELL_WORDS,
  options: OPTIONS,
  form: FORMS,
  channel: CHANNELS,
  inner: INNERS,
} as const
type AxisName = keyof typeof AXES
const AXIS_NAMES = Object.keys(AXES) as AxisName[]
type Choice = { [A in AxisName]: (typeof AXES)[A][number] }

/** The delivery of a script, or null when the values do not go together. */
function deliver(ch: Choice, script: string): { command: string; outer: Shell[] } | null {
  const { wrapper, shell, options, form, channel } = ch
  if (!channel.kinds.includes(shell.kind) || !options.kinds.includes(shell.kind)) return null
  if (wrapper.kinds && !wrapper.kinds.includes(shell.kind)) return null
  if (wrapper.argument && !channel.argument) return null
  // The options end in `c` exactly when the script is the word after them;
  // eval and source take none.
  const none = shell.kind === 'eval' || shell.kind === 'source'
  if (none ? options.id !== '(none)' : options.scripted !== !!channel.argument) return null
  // A channel that writes the script itself goes with the first form only.
  if (channel.body && form !== FORMS[0]) return null
  const word = form.write(script)
  if (word === null) return null
  let outer: Shell[] = ['bash', 'zsh']
  for (const v of [wrapper, shell, channel] as Value[])
    if (v.outer) outer = outer.filter((s) => v.outer!.includes(s))
  if (outer.length === 0) return null
  const sh = options.text === '' ? shell.word : `${shell.word} ${options.text}`
  return { command: channel.build({ shell: sh, word, script, wrap: wrapper.wrap }), outer }
}

/** `n` deliveries after every pair: each pair of values of each two axes at
 *  least once (those that go together), then seeded draws from the whole
 *  product; one in four holds a delivery as its script (depth 2). */
export function deliveries(seed: number, n: number): Generated[] {
  const rnd = mulberry32(seed ^ 0x0a2)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!
  const out: Generated[] = []
  const seen = new Set<string>()
  const draw = (fixed: Partial<Choice>): Choice =>
    Object.fromEntries(AXIS_NAMES.map((a) => [a, fixed[a] ?? pick(AXES[a])])) as Choice
  const make = (ch: Choice, deep: boolean): boolean => {
    const c = pick(CANARIES)
    if (ch.inner.kinds && !ch.inner.kinds.includes(ch.shell.kind)) return false
    const scriptOf = (w: string): string | null => {
      if (!deep) return `cat ${w}`
      // The script is itself a delivery, by an argument or a here-string.
      const inside = draw({
        wrapper: WRAPPERS[0]!,
        shell: pick(SHELL_WORDS.filter((s) => s.kind === 'sh' || s.kind === 'bash')),
        channel: pick([CHANNELS[0]!, CHANNELS[1]!]),
      })
      return deliver(inside, `cat ${w}`)?.command ?? null
    }
    const script = scriptOf(ch.inner.spell(c))
    const plain = scriptOf(plainName(c))
    if (script === null || plain === null) return false
    const d = deliver(ch, script)
    const p = deliver(ch, plain)
    if (!d || !p || seen.has(d.command)) return false
    seen.add(d.command)
    const word = ch.inner.spell(c)
    out.push({
      id: `D:${seed}:${out.length}`,
      operatorIds: [],
      positionId: 'delivery',
      canary: c.id,
      command: d.command,
      plain: p.command,
      proof: `cat ${word}`,
      proofShells: ['bash', 'zsh'],
      shells: d.outer,
      locales: ['C'],
      values: AXIS_NAMES.map((a) => `${a}: ${ch[a].id}`),
      carried: false,
    })
    return true
  }
  for (let i = 0; i < AXIS_NAMES.length; i++)
    for (let j = i + 1; j < AXIS_NAMES.length; j++) {
      const [a, b] = [AXIS_NAMES[i]!, AXIS_NAMES[j]!]
      for (const va of AXES[a])
        for (const vb of AXES[b])
          for (let tries = 0; tries < 40; tries++)
            if (make(draw({ [a]: va, [b]: vb } as Partial<Choice>), false)) break
    }
  const pairs = out.length
  for (let tries = 0; out.length < pairs + n && tries < n * 200; tries++)
    make(draw({}), rnd() < 0.25)
  return out
}

// ── addendum 2: triggers named by the shells themselves (O39) ──

/** What the running shells list: bash's `shopt` and `set -o` names, zsh's
 *  option names and the modules it can load. */
export type Listed = { shopt: string[]; set: string[]; setopt: string[]; modules: string[] }
/** Variables whose assignment changes how bash reads words (contract A10). */
export const A10_VARIABLES = [
  'GLOBIGNORE',
  'BASHOPTS',
  'SHELLOPTS',
  'POSIXLY_CORRECT',
  'BASH_COMPAT',
]
const GLOBS = ['cat *nv', 'cat ?env']

/** Each listed name set and unset, each module loaded, each variable of A10
 *  assigned in each form, then a wildcard that reads `.env` only if the
 *  trigger lets wildcards match a leading dot. */
export function triggers(listed: Listed): Generated[] {
  const out: Generated[] = []
  // Shown alive (rule R5) only by the kinds that can let a wildcard match a
  // leading dot in the shells at hand; the others are run to catch a surprise.
  const live = new Set(['shopt', 'setopt', 'GLOBIGNORE=', 'zsh/mapfile'])
  const add = (kind: string, shells: Shell[], pre: string, glob: string) =>
    out.push({
      id: `T:${kind}:${out.length}`,
      operatorIds: [],
      positionId: 'trigger',
      canary: 'ENV',
      command: pre + glob,
      plain: 'cat .env',
      proof: pre + glob,
      proofShells: shells,
      shells,
      locales: ['C'],
      values: live.has(kind) ? [`O39: ${kind}`] : [],
      carried: false,
    })
  for (const glob of GLOBS) {
    for (const name of listed.shopt)
      for (const flag of ['-s', '-u']) add('shopt', ['bash'], `shopt ${flag} ${name}; `, glob)
    for (const name of listed.set)
      for (const sign of ['-', '+']) add('set -o', ['bash'], `set ${sign}o ${name}; `, glob)
    for (const name of listed.setopt)
      for (const verb of ['setopt', 'unsetopt']) add('setopt', ['zsh'], `${verb} ${name}; `, glob)
    for (const name of listed.modules) add('zmodload', ['zsh'], `zmodload ${name}; `, glob)
    for (const name of A10_VARIABLES)
      for (const pre of [
        `${name}=x; `,
        `export ${name}=x; `,
        `declare ${name}=x; `,
        `typeset ${name}=x; `,
        `read ${name} <<< x; `,
        `printf -v ${name} x; `,
      ])
        add(`${name}=`, ['bash'], pre, glob)
  }
  // The module of the review's class B6: a subscript that is a file's name.
  if (listed.modules.includes('zsh/mapfile'))
    add('zsh/mapfile', ['zsh'], 'zmodload zsh/mapfile; ', 'echo $mapfile[.env]')
  return out
}
