// An independent reading of where a text holds values, for the round 3
// differential (scripts/value-differential.mts, value-differential.test.ts).
// Written apart from the engine's tokenizer and ordinaryWords.ts on purpose:
// a checker that shares the engine's notion of a value shares its blind spots.
// A plain lexer - strings, comments - and the config lines of each kind.

export type Range = { start: number; end: number }

const C_LIKE = /\.(?:[cm]?[jt]sx?|java|cs|go|c|h|cpp|rs|php|kt|scala|swift)$/i
const HASH = /\.(?:py|rb|sh|bash|ya?ml|ini|cfg|conf|properties|toml|env)$|^\.env|(?:^|\/)\.env/i

/** String contents, outside comments. A module specifier or a path-shaped
 *  string is a path, not a value. */
function strings(text: string, path: string | undefined): Range[] {
  const slashes = path === undefined || C_LIKE.test(path)
  const hashes = path === undefined || HASH.test(path)
  const out: Range[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (slashes && text.startsWith('//', i) && text[i - 1] !== ':') {
      i = text.indexOf('\n', i)
      if (i === -1) break
      continue
    }
    if (slashes && text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
      continue
    }
    if (hashes && c === '#' && !/[\w$]/.test(text[i - 1] ?? '')) {
      i = text.indexOf('\n', i)
      if (i === -1) break
      continue
    }
    const triple = text.startsWith('"""', i) || text.startsWith("'''", i)
    if (triple || c === '"' || c === "'" || c === '`') {
      const quote = triple ? text.slice(i, i + 3) : c
      const start = i + quote.length
      let j = start
      while (j < text.length && !text.startsWith(quote, j)) {
        if (text[j] === '\\') j++
        else if (text[j] === '\n' && quote.length === 1 && quote !== '`') break
        j++
      }
      // A word right before a ' is an apostrophe (`don't`), not a string.
      if (!(c === "'" && /[A-Za-z]/.test(text[i - 1] ?? ''))) out.push({ start, end: j })
      i = j + (text.startsWith(quote, j) ? quote.length : 0)
      continue
    }
    i++
  }
  return out
}

/** After `=` or `:` in a config line, a shell `KEY=val`, XML element text. */
function configValues(text: string, path: string): Range[] {
  const out: Range[] = []
  const push = (re: RegExp) => {
    for (const m of text.matchAll(re)) {
      const v = m[m.length - 1]!
      const start = m.index! + m[0].length - v.length
      if (v.trim()) out.push({ start, end: start + v.length })
    }
  }
  if (/\.(?:ya?ml|ini|cfg|conf|properties|toml)$|\.env$|^\.env/i.test(path))
    push(/^[ \t]*(?:-[ \t]+)?[A-Za-z_"'][\w.$"'-]*[ \t]*[=:][ \t]*(?:[&!]\S+[ \t]+)*([^\n#]*)/gm)
  if (/\.ya?ml$/i.test(path)) push(/^[ \t]*-[ \t]+([^\n#]*)/gm)
  if (/\.(?:sh|bash)$/i.test(path))
    push(/(?:^|[ \t;])[A-Za-z_]\w*=("[^"\n]*"|'[^'\n]*'|[^\s;<>"']*)/gm)
  if (/\.(?:xml|config)$/i.test(path)) push(/>([^<]+)</g)
  return out
}

const PATHLIKE = /^[\w.@~+-]*[\\/][\w.@~+\\/-]*$/
const MODULE = /(?:\bfrom|\bimport|\brequire\s*\(|\brequire)\s*$/

const isPath = (text: string, r: Range) =>
  PATHLIKE.test(text.slice(r.start, r.end)) ||
  MODULE.test(text.slice(Math.max(0, r.start - 25), Math.max(0, r.start - 1)))

/** Value ranges of `text` (`paths: false`), or its path ranges (`true`). */
export function valueRanges(text: string, path?: string, paths = false): Range[] {
  const all = [...strings(text, path), ...(path ? configValues(text, path) : [])]
  return all.filter((r) => isPath(text, r) === paths)
}

const TOKEN = /(?<![\w$])[A-Za-z_$][\w$]*(?![\w$])/g

/** How often each word stands in `text`, or only inside `ranges`. */
export function wordCounts(text: string, ranges?: Range[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const r of ranges ?? [{ start: 0, end: text.length }])
    for (const [w] of text.slice(r.start, r.end).matchAll(TOKEN))
      if (!/^__[A-Z]/.test(w)) counts.set(w, (counts.get(w) ?? 0) + 1)
  return counts
}
