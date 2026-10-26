import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/**
 * The public docs, as one list that the engine, CLI and MCP contract tests all
 * read. A doc can promise something in any of these files, and npm or GitHub
 * shows each of them to a reader.
 *
 * The CHANGELOGs are left out on purpose. A past entry describes past
 * behaviour, and it is never rewritten.
 */
export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..')

const FIXED_DOCS = [
  'README.md',
  'ROADMAP.md',
  'packages/engine/README.md',
  'packages/cli/README.md',
  'packages/mcp/README.md',
  'plugins/veilio-guard/README.md',
  'plugins/veilio-guard/COVERAGE.md',
]

function markdownIn(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, dir))
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => `${dir}/${f}`)
}

/** Every public doc, by path relative to the repository root. Pending
 *  changesets count: each one becomes a changelog entry at the next release
 *  and describes the code as it is now. */
export function publicDocs(): string[] {
  return [...FIXED_DOCS, ...markdownIn('docs'), ...markdownIn('.changeset')]
}

export function readDoc(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8')
}

export interface FencedBlock {
  lang: string
  code: string
  /** 1-based line of the opening fence, for the failure message. */
  line: number
}

/** The fenced code blocks of a markdown text, optionally only those in the
 *  given languages. */
export function fencedBlocks(text: string, langs?: readonly string[]): FencedBlock[] {
  const blocks: FencedBlock[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*```(\w*)/.exec(lines[i])
    if (!open) continue
    const body: string[] = []
    let j = i + 1
    while (j < lines.length && !/^\s*```\s*$/.test(lines[j])) body.push(lines[j++])
    if (!langs || langs.includes(open[1])) {
      blocks.push({ lang: open[1], code: body.join('\n'), line: i + 1 })
    }
    i = j
  }
  return blocks
}

/** Every token written in single backticks outside fenced blocks. */
export function inlineCode(text: string): string[] {
  const prose = text.replace(/^\s*```[\s\S]*?^\s*```\s*$/gm, '')
  return [...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
}

/*
 * The engine's public surface, read by the TypeScript checker.
 *
 * One host with a source-file cache, and one program over src/index.ts, shared
 * by every test that asks what the engine exports. The engine source and the
 * lib files are parsed once per test file. A program for a README example is
 * built on the same host, so it reuses those parsed files and parses only the
 * example.
 */
export const ENGINE_INDEX = join(REPO_ROOT, 'packages', 'engine', 'src', 'index.ts')

export const COMPILER_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.es2022.d.ts'],
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  paths: { '@veilio-inc/engine': [ENGINE_INDEX] },
}

const sourceCache = new Map<string, ts.SourceFile | undefined>()
const baseHost = ts.createCompilerHost(COMPILER_OPTIONS)

/** The shared host. `extra` adds in-memory files (a README example), which
 *  are parsed fresh each time; every other file comes from the cache. */
export function cachedHost(extra: ReadonlyMap<string, string> = new Map()): ts.CompilerHost {
  return {
    ...baseHost,
    fileExists: (f) => extra.has(f) || baseHost.fileExists(f),
    readFile: (f) => extra.get(f) ?? baseHost.readFile(f),
    getSourceFile: (f, lang, onError, create) => {
      const text = extra.get(f)
      if (text !== undefined) return ts.createSourceFile(f, text, lang, true, ts.ScriptKind.TS)
      if (!sourceCache.has(f)) sourceCache.set(f, baseHost.getSourceFile(f, lang, onError, create))
      return sourceCache.get(f)
    },
  }
}

let engine: { program: ts.Program; exports: Map<string, ts.Symbol> } | undefined

function engineSurface(): { program: ts.Program; exports: Map<string, ts.Symbol> } {
  if (engine) return engine
  const program = ts.createProgram([ENGINE_INDEX], COMPILER_OPTIONS, cachedHost())
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(ENGINE_INDEX)
  const moduleSymbol = source && checker.getSymbolAtLocation(source)
  if (!moduleSymbol) throw new Error('could not read the exports of src/index.ts')
  engine = {
    program,
    exports: new Map(checker.getExportsOfModule(moduleSymbol).map((s) => [s.name, s])),
  }
  return engine
}

/** Every name `@veilio-inc/engine` exports, values and types alike. */
export function engineExports(): Set<string> {
  return new Set(engineSurface().exports.keys())
}

/** The property names of an exported engine type (`AnonymizeOptions`). */
export function optionKeys(typeName: string): string[] {
  const { program, exports } = engineSurface()
  const symbol = exports.get(typeName)
  if (!symbol) throw new Error(`@veilio-inc/engine does not export ${typeName}`)
  return program
    .getTypeChecker()
    .getDeclaredTypeOfSymbol(symbol)
    .getProperties()
    .map((p) => p.name)
}
