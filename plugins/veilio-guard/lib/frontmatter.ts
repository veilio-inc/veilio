// The `description` of a skill's, command's or agent's frontmatter, as YAML
// reads it (guard decision 1, code review of d705b14). A mod cannot import a
// YAML library, and Claude Code exposes no parser, so this reads the one
// top-level key the listing rule needs, for the scalar forms YAML 1.2 has:
// plain, single-quoted and double-quoted (with its escapes) on one line,
// and literal or folded blocks with their chomping. Anything else (an alias, a tag, a flow
// collection, a malformed scalar) is undefined: the entry is then masked.

/** The frontmatter's `description`, or undefined when the file has none or
 *  it is not a form this reader takes. */
export function frontmatterDescription(file: string): string | undefined {
  const text = file.replace(/\r\n?/g, '\n')
  if (!text.startsWith('---\n')) return undefined
  const end = text.indexOf('\n---', 3)
  if (end === -1) return undefined
  const lines = text.slice(4, end + 1).split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  let found: number | undefined
  for (let i = 0; i < lines.length; i++) {
    if (/^description\s*:(\s|$)/.test(lines[i]!)) {
      // A key given twice is an error in YAML: nothing is trusted.
      if (found !== undefined) return undefined
      found = i
    }
  }
  if (found === undefined) return undefined
  const first = lines[found]!.replace(/^description\s*:/, '')
  const rest: string[] = []
  for (let i = found + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line !== '' && !/^\s/.test(line)) break
    rest.push(line)
  }
  return scalar(first, rest)
}

// What a plain value cannot start with, or carry on a later line, without
// meaning something else to YAML.
const INDICATOR = /^[-?:,[\]{}#&*!|>'"%@`]/
const MAPPING = /:(\s|$)|\s#/

function scalar(first: string, rest: readonly string[]): string | undefined {
  const head = first.trim()
  if (head === '') return plain('', rest)
  const c = head[0]
  // A quoted value is taken on one line only: across lines, YAML's folding
  // of the spaces around a break is more than this reader does.
  if (c === '"' || c === "'") {
    if (rest.some((l) => l.trim() !== '')) return undefined
    return c === '"' ? doubleQuoted(first.trimStart()) : singleQuoted(first.trimStart())
  }
  if (c === '|' || c === '>') return block(head, rest)
  if (INDICATOR.test(head) || MAPPING.test(head)) return undefined
  return plain(head, rest)
}

/** A plain scalar: its lines folded with single spaces; a blank line is a
 *  newline. A comment after a space ends it. */
function plain(head: string, rest: readonly string[]): string | undefined {
  const parts = [head, ...rest.map((l) => l.trim())]
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  const cut = (s: string) => s.replace(/(^|\s)#.*$/, '').trimEnd()
  let out = ''
  let blank = 0
  for (const [i, part] of parts.entries()) {
    const p = cut(part)
    if (p !== part && i < parts.length - 1) return undefined
    if (p === '') {
      if (i > 0) blank++
      continue
    }
    if (i > 0 && (INDICATOR.test(p) || MAPPING.test(p))) return undefined
    out += out === '' ? p : blank > 0 ? '\n'.repeat(blank) + p : ` ${p}`
    blank = 0
  }
  return out === '' ? undefined : out
}

function singleQuoted(text: string): string | undefined {
  let i = 1
  let body = ''
  for (;;) {
    const q = text.indexOf("'", i)
    if (q === -1) return undefined
    if (text[q + 1] === "'") {
      body += text.slice(i, q) + "'"
      i = q + 2
      continue
    }
    body += text.slice(i, q)
    if (!/^\s*(#.*)?$/.test(text.slice(q + 1))) return undefined
    return body.includes('\n') ? undefined : body
  }
}

const ESCAPES: Readonly<Record<string, string>> = {
  '0': '\0',
  a: '\x07',
  b: '\b',
  t: '\t',
  '\t': '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  e: '\x1b',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  N: '\u0085',
  _: ' ',
  L: ' ',
  P: ' ',
}

function doubleQuoted(text: string): string | undefined {
  const raw = text.slice(1)
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (ch === '"') {
      if (!/^\s*(#.*)?$/.test(raw.slice(i + 1))) return undefined
      return out
    }
    if (ch !== '\\') {
      out += ch
      continue
    }
    const e = raw[++i]
    if (e === undefined) return undefined
    const simple = ESCAPES[e]
    if (simple !== undefined && Object.hasOwn(ESCAPES, e)) {
      out += simple
      continue
    }
    const width = e === 'x' ? 2 : e === 'u' ? 4 : e === 'U' ? 8 : 0
    if (width === 0) return undefined
    const hex = raw.slice(i + 1, i + 1 + width)
    if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) return undefined
    const code = parseInt(hex, 16)
    if (code > 0x10ffff) return undefined
    out += String.fromCodePoint(code)
    i += width
  }
  return undefined
}

/** A literal (`|`) or folded (`>`) block, with its chomping (`-`, `+`) and
 *  an optional indentation digit. */
function block(head: string, rest: readonly string[]): string | undefined {
  const m = /^([|>])([1-9])?([-+])?([1-9])?\s*(#.*)?$/.exec(head)
  if (!m || (m[2] && m[4])) return undefined
  const literal = m[1] === '|'
  const chomp = m[3] ?? ''
  const given = Number(m[2] ?? m[4] ?? 0)
  const firstText = rest.find((l) => l.trim() !== '')
  if (firstText === undefined) return ''
  const indent = given || firstText.length - firstText.trimStart().length
  if (indent === 0) return undefined
  const body: string[] = []
  for (const line of rest) {
    // A line of spaces alone is content or not by its width: not taken.
    if (line !== '' && line.trim() === '') return undefined
    if (line === '') {
      body.push('')
      continue
    }
    if (line.length - line.trimStart().length < indent) return undefined
    body.push(line.slice(indent))
  }
  let trailing = 0
  while (body.length > 0 && body[body.length - 1] === '') {
    body.pop()
    trailing++
  }
  let content: string
  if (literal) content = body.join('\n')
  else {
    content = ''
    let blank = 0
    let prevMore = false
    for (const [i, line] of body.entries()) {
      if (line === '') {
        blank++
        continue
      }
      const more = /^\s/.test(line)
      if (i === 0) content = line
      else if (blank > 0) content += '\n'.repeat(more || prevMore ? blank + 1 : blank) + line
      else content += (more || prevMore ? '\n' : ' ') + line
      blank = 0
      prevMore = more
    }
  }
  if (chomp === '-') return content
  if (chomp === '+') return `${content}\n${'\n'.repeat(trailing)}`
  return `${content}\n`
}
