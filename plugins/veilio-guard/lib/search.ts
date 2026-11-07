// Search output (the Grep tool's content, `rg`/`grep` in a shell), cut into its
// files' lines (spec 074, research R1-R3, R6). Where a line's path ends cannot
// be told from the line: a path holds `:`, `-`, digits and spaces
// (`releases/2026-11-05/app-1-2.yaml`), and so does the text (`.pgpass`'s
// `host:5432:*:user:pw`). So a prefix is accepted only when the files on disk
// say so: exactly one candidate prefix must name a file, checked through
// `fileExists`, which the caller passes in. Anything else is `unresolved`, and
// the caller handles it as it always did.

export type SearchFormat = {
  /** Line numbers are printed (`path:N:text`, `N:text`). */
  numbered: boolean
  /** Context lines can be printed (`path-N-text`, `path-text`). */
  context: boolean
  /** The directory a relative path is read from. */
  base: string
  /** The one file searched (a file argument): no path is printed. */
  oneFile?: string
  /** Set by the caller once it no longer waits: no more file checks. */
  stop?: { aborted: boolean }
}

export type SearchLine = {
  text: string
  kind: 'match' | 'context' | 'separator' | 'unresolved'
  path?: string
  lineNumber?: number
  body?: string
  /** What the search printed before `body` (a resolved line only). */
  prefix?: string
}

/** Consecutive lines of one file, by index into `lines`. */
export type FileRun = { path: string; lines: number[] }

/** Per line, the separators tried and how far into it; per result, the file
 *  checks. Past them a line is unresolved (research R6). */
export const SEARCH_LIMITS = { prefix: 4096, separators: 16, checks: 512 }

type Candidate = { path: string; kind: 'match' | 'context'; lineNumber?: number; body: string }

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9'

/** The prefixes `line` could have: at each `:` (and `-` with context on), the
 *  text before it, followed by `N:` / `N-` when numbered. null: more than the
 *  limit allows, so no answer is safe. */
function candidates(line: string, format: SearchFormat): Candidate[] | null {
  const out: Candidate[] = []
  const end = Math.min(line.length, SEARCH_LIMITS.prefix)
  for (let i = 1; i < end; i++) {
    const c = line[i]
    if (c !== ':' && !(c === '-' && format.context)) continue
    const kind = c === ':' ? 'match' : 'context'
    if (format.numbered) {
      let j = i + 1
      while (isDigit(line[j])) j++
      if (j === i + 1 || line[j] !== c) continue
      out.push({
        path: line.slice(0, i),
        kind,
        lineNumber: Number(line.slice(i + 1, j)),
        body: line.slice(j + 1),
      })
    } else out.push({ path: line.slice(0, i), kind, body: line.slice(i + 1) })
    if (out.length > SEARCH_LIMITS.separators) return null
  }
  return out
}

const withPrefix = (l: SearchLine): SearchLine =>
  l.body === undefined ? l : { ...l, prefix: l.text.slice(0, l.text.length - l.body.length) }

/** A one-file search's line: `N:text` / `N-text` when numbered, else the text. */
function oneFileLine(text: string, format: SearchFormat & { oneFile: string }): SearchLine {
  if (!format.numbered) return { text, kind: 'match', path: format.oneFile, body: text }
  const m = /^(\d+)([:-])/.exec(text)
  if (!m || (m[2] === '-' && !format.context)) return { text, kind: 'unresolved' }
  return {
    text,
    kind: m[2] === ':' ? 'match' : 'context',
    path: format.oneFile,
    lineNumber: Number(m[1]),
    body: text.slice(m[0].length),
  }
}

/** Where a search's `path` is on disk: absolute as written, else under
 *  `base` (a leading `./` dropped); null for one that climbs with `..`. The
 *  one resolver for a line's path and a one-file search's (T024 review). */
export function searchPath(base: string, path: string): string | null {
  if (path.split(/[\\/]/).includes('..')) return null
  return path.startsWith('/') ? path : `${base.replace(/\/+$/, '')}/${path.replace(/^\.\//, '')}`
}

export async function parseSearchOutput(
  text: string,
  format: SearchFormat & { fileExists: (path: string) => Promise<boolean> }
): Promise<{ lines: SearchLine[]; runs: FileRun[] }> {
  const checked = new Map<string, boolean>()
  const resolved = new Set<string>()
  let checks = 0
  /** Whether `path` names a file: true, false, or undefined past the cap. */
  const names = async (path: string): Promise<boolean | undefined> => {
    if (resolved.has(path)) return true
    // A path that climbs out of the base is never followed.
    const full = searchPath(format.base, path)
    if (full === null) return false
    const known = checked.get(full)
    if (known !== undefined) return known
    if (checks >= SEARCH_LIMITS.checks || format.stop?.aborted) return undefined
    checks++
    const is = await format.fileExists(full)
    checked.set(full, is)
    return is
  }

  const lines: SearchLine[] = []
  const all = text.split('\n')
  // A one-file search prints no path, or (`grep -r` on one file) the file's
  // path on every line: then that is cut off first (T024 review).
  const one = format.oneFile
  const named =
    one !== undefined &&
    all.every((l) => l === '--' || l === '' || l.startsWith(`${one}:`) || l.startsWith(`${one}-`))
  for (const line of all) {
    if (line === '--') {
      lines.push({ text: line, kind: 'separator' })
      continue
    }
    if (one !== undefined) {
      const rest = named ? line.slice(one.length + 1) : line
      const l = oneFileLine(rest, { ...format, oneFile: one })
      lines.push(withPrefix({ ...l, text: line }))
      continue
    }
    // A candidate that is a file this result already placed: the line is
    // that file's. Its shorter candidates are its own prefixes, all checked
    // when it was placed; a longer one - new text each line, a new check each
    // - is not (T024 review: the cap ran out in ~170 unnumbered lines).
    // shortcut: a file named like a placed one plus `:` or `-` and more is
    // then read as the placed one; checking a directory's listing once would
    // close it.
    const all = candidates(line, format)
    const placed = all?.find((c) => resolved.has(c.path))
    const found = placed ? [placed] : all
    let pick: Candidate | null = null
    let ok = found !== null && found.length > 0
    for (const c of found ?? []) {
      const is = await names(c.path)
      // Unknown, or a second file: no answer is safe.
      if (is === undefined || (is && pick)) ok = false
      if (!ok) break
      if (is) pick = c
    }
    if (ok && pick) {
      resolved.add(pick.path)
      lines.push(withPrefix({ text: line, ...pick }))
    } else lines.push({ text: line, kind: 'unresolved' })
  }

  // Runs: the same file, no `--` or unresolved line between, the next line
  // number when numbered. Unnumbered matches without context need not be
  // neighbours in the file, so each stands alone.
  const runs: FileRun[] = []
  let run: FileRun | null = null
  let last: number | undefined
  lines.forEach((l, i) => {
    if (l.kind === 'separator' || l.kind === 'unresolved' || l.path === undefined) {
      run = null
      return
    }
    const joins =
      run !== null &&
      run.path === l.path &&
      (format.numbered ? l.lineNumber === (last ?? NaN) + 1 : format.context)
    if (joins) run!.lines.push(i)
    else runs.push((run = { path: l.path, lines: [i] }))
    last = l.lineNumber
  })
  return { lines, runs }
}

// Research R5: the flags each program may carry for its output to keep the
// R1 shapes. Anything else (`-l`, `-c`, `-o`, `--json`, `--heading`, `-h`,
// `--column`, …) and the command is not read as search output. Fail closed:
// add a flag here only once its output is known.
const FLAGS = {
  rg: { plain: 'nNiSswFxvuUPH.L', valued: 'eABCmgt' },
  grep: { plain: 'rRniswFExvHIPa', valued: 'eABCm' },
} as const
const LONG_PLAIN = new Set([
  'line-number',
  'no-line-number',
  'ignore-case',
  'smart-case',
  'word-regexp',
  'fixed-strings',
  'hidden',
  'recursive',
  'with-filename',
  'no-heading',
  'multiline',
])
const LONG_VALUED = new Set([
  'context',
  'after-context',
  'before-context',
  'glob',
  'type',
  'include',
  'exclude',
  'exclude-dir',
  'max-count',
  'regexp',
])

const PIPE = '|'
/** A command's words, unquoted, cut into its pipeline's commands; null for
 *  anything a shell would expand, redirect, chain or continue (T024 review:
 *  every quote kind read, never skipped by a pattern). Single quotes hold
 *  anything; double quotes hold anything but `$`, a backquote and `\`. */
function shellWords(command: string): string[][] | null {
  const segments: string[][] = [[]]
  let word: string | null = null
  const end = () => {
    if (word !== null) segments.at(-1)!.push(word)
    word = null
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (c === ' ' || c === '\t') end()
    else if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1)
      if (close === -1) return null
      const inner = command.slice(i + 1, close)
      if (c === '"' && /[$`\\]/.test(inner)) return null
      word = (word ?? '') + inner
      i = close
    } else if (c === PIPE) {
      // `||` leaves an empty command between: refused below.
      end()
      segments.push([])
    } else if (/[;&<>`$\\\n\r(){}#]/.test(c)) return null
    else word = (word ?? '') + c
  }
  end()
  return segments.some((seg) => seg.length === 0) ? null : segments
}

/** How a shell command's output is laid out, when the command is one plain
 *  `rg` or `grep` (optionally into `head`/`tail` by lines); null otherwise.
 *  Piped, as the Bash tool's output is, ripgrep prints no line numbers
 *  unless asked. `oneFile`: the one path operand, which prints no path when
 *  it is a file (the caller checks). */
export function searchCommand(
  command: string
): (Omit<SearchFormat, 'base' | 'oneFile'> & { oneFile?: string }) | null {
  const segments = shellWords(command)
  if (!segments) return null
  for (const seg of segments.slice(1))
    if (
      !/^(?:head|tail)$/.test(seg[0] ?? '') ||
      !seg
        .slice(1)
        .every(
          (a, k, all) => /^-\d+$|^-n$|^-n\d+$/.test(a) || (/^\d+$/.test(a) && all[k - 1] === '-n')
        )
    )
      return null
  const [program, ...args] = segments[0] ?? []
  if (program !== 'rg' && program !== 'grep') return null
  const flags = FLAGS[program]
  let numbered = false
  let context = false
  let withFilename = false
  let recursive = program === 'rg'
  let pattern = false
  const operands: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--') {
      operands.push(...args.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const [name, value] = a.slice(2).split(/=(.*)/s)
      if (LONG_PLAIN.has(name!)) {
        if (name === 'line-number') numbered = true
        if (name === 'no-line-number') numbered = false
        if (name === 'with-filename') withFilename = true
        if (name === 'recursive') recursive = true
        continue
      }
      if (!LONG_VALUED.has(name!)) return null
      const v = value ?? args[++i]
      if (v === undefined) return null
      if (/context$/.test(name!) && Number(v) > 0) context = true
      if (name === 'regexp') pattern = true
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const f = a[k]!
        if ((flags.valued as string).includes(f)) {
          const v = a.length > k + 1 ? a.slice(k + 1) : args[++i]
          if (v === undefined) return null
          if ('ABC'.includes(f) && Number(v) > 0) context = true
          if (f === 'e') pattern = true
          break
        }
        if (!(flags.plain as string).includes(f)) return null
        if (f === 'n') numbered = true
        if (f === 'N') numbered = false
        if (f === 'H') withFilename = true
        if (f === 'r' || f === 'R') recursive = true
      }
      continue
    }
    operands.push(a)
  }
  const paths = pattern ? operands : operands.slice(1)
  if (!pattern && operands.length === 0) return null
  // grep without -r and no file reads its input: not a file's lines.
  if (!recursive && paths.length === 0) return null
  return {
    numbered,
    context,
    ...(paths.length === 1 && !withFilename ? { oneFile: paths[0]! } : {}),
  }
}
