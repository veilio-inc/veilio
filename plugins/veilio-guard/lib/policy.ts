// What the guard does to each tool: spec 033, data-model tables A and B.
//
// Table A says which arguments get real names back before the tool runs. Edits
// are strict: a placeholder the map cannot resolve refuses the call, so a file
// never receives a token that means nothing. Web tools are never restored -
// real names must not leave in a request.
//
// Table B says which fields of the result the model reads, and how each is
// scrubbed. `source` runs the engine's tokenizer and adds new identifiers to
// the map; `apply` only replaces names the map already has (shell output fed
// to the tokenizer would fill the map with English). Every other string of a
// known tool's record has the map applied too, except the enum fields in
// `keep`: a changed enum makes Claude Code refuse the record. A tool with no row has
// every string of its result rewritten, so a tool added tomorrow is covered
// before anyone lists it.

import { languageOfPath } from '../vendor/engine/index.js'
import type { Language, LanguageOption } from '../vendor/engine/index.js'

export type ArgumentPolicy = {
  mode: 'strict' | 'lenient' | 'none'
  /** Argument paths restored before the tool runs (fields.ts syntax); `*` is every string. */
  restore: string[]
  /** Arguments that name a file, checked against the raw-only list. */
  paths: string[]
  /** The argument holding a shell command, whose path-like words are checked too. */
  command?: string
}

export type FieldMode = 'source' | 'apply'
export type ResultPolicy =
  | { kind: 'fields'; fields: { path: string; mode: FieldMode }[]; keep: string[] }
  | { kind: 'text' }
  | { kind: 'deep' }
  | { kind: 'withhold'; reason: string }

const NONE: ArgumentPolicy = { mode: 'none', restore: [], paths: [] }

const ARGUMENTS: Record<string, ArgumentPolicy> = {
  Read: { mode: 'strict', restore: ['file_path'], paths: ['file_path'] },
  NotebookRead: { mode: 'strict', restore: ['notebook_path'], paths: ['notebook_path'] },
  Edit: {
    mode: 'strict',
    restore: ['file_path', 'old_string', 'new_string'],
    paths: ['file_path'],
  },
  MultiEdit: {
    mode: 'strict',
    restore: ['file_path', 'edits[].old_string', 'edits[].new_string'],
    paths: ['file_path'],
  },
  Write: { mode: 'strict', restore: ['file_path', 'content'], paths: ['file_path'] },
  NotebookEdit: {
    mode: 'strict',
    restore: ['notebook_path', 'new_source'],
    paths: ['notebook_path'],
  },
  Grep: { mode: 'lenient', restore: ['pattern', 'path', 'glob'], paths: ['path'] },
  Glob: { mode: 'lenient', restore: ['pattern', 'path'], paths: ['path'] },
  Bash: { mode: 'lenient', restore: ['command'], paths: [], command: 'command' },
  // Claude Code's shell on Windows. It reads and writes files as Bash does
  // (Get-Content, Set-Content, Out-File, >), so it gets the same checks.
  PowerShell: { mode: 'lenient', restore: ['command'], paths: [], command: 'command' },
}

export function mcpServerOf(tool: string): string | null {
  const m = /^mcp__(.+?)__[^_].*$/.exec(tool)
  return m?.[1] ?? null
}

export function argumentPolicy(tool: string, mcpRestore: readonly string[]): ArgumentPolicy {
  const known = ARGUMENTS[tool]
  if (known) return known
  const server = mcpServerOf(tool)
  if (server !== null && mcpRestore.includes(server))
    return { mode: 'lenient', restore: ['*'], paths: [] }
  return NONE
}

// Files the tokenizer understands. Anything else read with Read (notes,
// configuration, logs) only has the known names replaced.
const SOURCE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'scala',
  'swift',
  'rb',
  'php',
  'cs',
  'fs',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'm',
  'mm',
  'dart',
  'lua',
  'sql',
  'vue',
  'svelte',
  'ex',
  'exs',
  'erl',
  'clj',
  'groovy',
  'r',
  'pl',
  'sh',
  'bash',
  'zsh',
  'ps1',
])

// The engine's languages, by extension (engine/imports.ts, shared with the
// CLI). A Read with offset and limit hands the engine a fragment, and
// detection on a fragment can be wrong (TypeScript full of query builders reads
// as SQL): the extension decides where it can.

export function languageOf(path: string): LanguageOption {
  return languageOfPath(path) ?? 'auto'
}

/** The language of one line of a Grep result (`path:12:text`, `path-12-text`
 *  for a context line, or a bare path), from its file's extension (spec 050 R2). */
export function languageOfGrepLine(line: string): Language | 'unknown' {
  const path = /^(.+?):\d+:/.exec(line)?.[1] ?? /^(.+?)-\d+-/.exec(line)?.[1] ?? line.trim()
  const language = languageOf(path)
  return language === 'auto' ? 'unknown' : language
}

/** Each line of a Grep result: its `path:N:` (a match) or `path-N-` (a
 *  context line) prefix, its text, and its file; `unplaced`, a context line
 *  it could not split. Where a context line's path
 *  ends cannot be told from the line (a dated directory has `-31-` in it), so
 *  it is one a match line of the same result names. A line it cannot place
 *  keeps its whole text and no file. */
export function grepLines(
  content: string
): { prefix: string; body: string; path: string; unplaced: boolean }[] {
  const lines = content.split('\n')
  const match = lines.map((line) => /^(.+?):\d+:/.exec(line))
  const paths = new Set(match.flatMap((m) => (m ? [m[1]!] : [])))
  return lines.map((line, i) => {
    const m = match[i]
    if (m) return { prefix: m[0], body: line.slice(m[0].length), path: m[1]!, unplaced: false }
    for (const c of line.matchAll(/-\d+-/g))
      if (paths.has(line.slice(0, c.index))) {
        const end = c.index + c[0].length
        const path = line.slice(0, c.index)
        return { prefix: line.slice(0, end), body: line.slice(end), path, unplaced: false }
      }
    // A context line whose path no match line names cannot be split: it is
    // masked whole, as before, and the guard learns nothing from it.
    // Unplaced only when what stands before `-N-` is shaped like a path (no
    // space, `=` or `:`): a date in a match line printed without `-n` is not.
    return { prefix: '', body: line, path: '', unplaced: /^[^\s=:]+?-\d+-/.test(line) }
  })
}

/** Whether a result shows a file of a known language: its path's, or for a
 *  command the one source file it prints (`cat src/a.py`). */
export function isCode(path: string, args?: Record<string, unknown>): boolean {
  if (path) return languageOf(path) !== 'auto'
  return typeof args?.command === 'string' && languageOfCommand(args.command) !== 'unknown'
}

// Commands whose output is the text of the one file they are given, and the
// filters that may follow them in a pipeline without changing what it is.
const READERS = new Set([
  'cat',
  'head',
  'tail',
  'sed',
  'nl',
  'less',
  'more',
  'bat',
  'get-content',
  'gc',
  'type',
])
const FILTERS = new Set([
  'head',
  'tail',
  'grep',
  'sed',
  'nl',
  'cut',
  'sort',
  'uniq',
  'less',
  'more',
])

/** The language of a command's output, when the command prints exactly one
 *  source file (`cat src/a.ts | head -50`); otherwise unknown (spec 050 R2). */
export function languageOfCommand(command: string): Language | 'unknown' {
  // `cd dir && cat file` is the one compound form worth reading: Claude writes it often.
  const body = command.replace(/^\s*cd\s+\S+\s*&&\s*/, '')
  if (/[;&]|\|\||`|\$\(/.test(body)) return 'unknown'
  const [first, ...rest] = body.split('|').map((s) => s.trim().split(/\s+/))
  if (!first?.[0] || !READERS.has(first[0].toLowerCase())) return 'unknown'
  if (rest.some((words) => !FILTERS.has((words[0] ?? '').toLowerCase()))) return 'unknown'
  let args = first.slice(1).filter((w) => !w.startsWith('-') && !/^\d+$/.test(w))
  // sed's first operand is its script unless -e gave one.
  if (first[0] === 'sed' && !first.includes('-e')) args = args.slice(1)
  const [file] = args
  if (args.length !== 1 || file === undefined || /[*?[\]]/.test(file)) return 'unknown'
  const language = languageOf(file.replace(/^['"]|['"]$/g, ''))
  return language === 'auto' ? 'unknown' : language
}

export function isSourcePath(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 && SOURCE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

const apply = (path: string) => ({ path, mode: 'apply' as const })
const PATCH = 'structuredPatch[].lines[]'

export function resultPolicy(tool: string, result: unknown, filePath: string): ResultPolicy {
  if (typeof result === 'string') return { kind: 'text' }
  const record = (result ?? {}) as Record<string, unknown>
  switch (tool) {
    case 'Read': {
      if (record.type === 'text') {
        return {
          kind: 'fields',
          fields: [
            { path: 'file.content', mode: isSourcePath(filePath) ? 'source' : 'apply' },
            apply('file.filePath'),
          ],
          keep: ['type'],
        }
      }
      if (record.type === 'image' || record.type === 'pdf') {
        return {
          kind: 'withhold',
          reason: `images and PDFs are not scrubbed yet (${String(record.type)})`,
        }
      }
      return { kind: 'deep' }
    }
    case 'Grep':
      return { kind: 'fields', fields: [apply('content'), apply('filenames[]')], keep: ['mode'] }
    case 'Glob':
      return { kind: 'fields', fields: [apply('filenames[]')], keep: [] }
    case 'Bash':
      return { kind: 'fields', fields: [apply('stdout'), apply('stderr')], keep: ['gitOperation'] }
    case 'Edit':
      return {
        kind: 'fields',
        fields: ['filePath', 'oldString', 'newString', 'originalFile', PATCH].map(apply),
        keep: [],
      }
    case 'MultiEdit':
      return {
        kind: 'fields',
        fields: ['filePath', 'edits[].old_string', 'edits[].new_string', 'originalFile', PATCH].map(
          apply
        ),
        keep: [],
      }
    case 'Write':
      return {
        kind: 'fields',
        fields: ['filePath', 'content', 'originalFile', PATCH].map(apply),
        keep: ['type'],
      }
  }
  if (mcpServerOf(tool) !== null) {
    const blocks = Array.isArray(result)
      ? result
      : Array.isArray(record.content)
        ? record.content
        : null
    if (blocks === null) return { kind: 'deep' }
    const other = blocks.find(
      (b) => !b || typeof b !== 'object' || (b as { type?: unknown }).type !== 'text'
    )
    if (other !== undefined) {
      return {
        kind: 'withhold',
        reason: `MCP results other than text are not scrubbed yet (${tool})`,
      }
    }
    return {
      kind: 'fields',
      fields: [apply(Array.isArray(result) ? '[].text' : 'content[].text')],
      keep: ['type'],
    }
  }
  return { kind: 'deep' }
}
