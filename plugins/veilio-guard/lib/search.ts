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
}

export type SearchLine = {
  text: string
  kind: 'match' | 'context' | 'separator' | 'unresolved'
  path?: string
  lineNumber?: number
  body?: string
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
    if (path.split(/[\\/]/).includes('..')) return false
    const full = path.startsWith('/')
      ? path
      : `${format.base.replace(/\/+$/, '')}/${path.replace(/^\.\//, '')}`
    const known = checked.get(full)
    if (known !== undefined) return known
    if (checks >= SEARCH_LIMITS.checks) return undefined
    checks++
    const is = await format.fileExists(full)
    checked.set(full, is)
    return is
  }

  const lines: SearchLine[] = []
  for (const line of text.split('\n')) {
    if (line === '--') {
      lines.push({ text: line, kind: 'separator' })
      continue
    }
    if (format.oneFile !== undefined) {
      lines.push(oneFileLine(line, { ...format, oneFile: format.oneFile }))
      continue
    }
    const found = candidates(line, format)
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
      lines.push({ text: line, ...pick })
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
