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

// The engine's languages, by extension. A Read with offset and limit hands the
// engine a fragment, and detection on a fragment can be wrong (TypeScript full
// of query builders reads as SQL): the extension decides where it can.
const LANGUAGE_BY_EXTENSION: Record<string, Language> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'typescript',
  jsx: 'typescript',
  mjs: 'typescript',
  cjs: 'typescript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'java',
  kts: 'java',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cc: 'c',
  cpp: 'c',
  hpp: 'c',
  sql: 'sql',
}

export function languageOf(path: string): LanguageOption {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return (dot > 0 && LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()]) || 'auto'
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
