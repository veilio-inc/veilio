import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { publicDocs, readDoc } from './fixtures/public-docs.js'

/**
 * The README's API list against the types it describes.
 *
 * `options.style` was documented for seven published versions after the option
 * was deleted from `AnonymizeOptions` (a5c494b, before 1.0.0): every reader of
 * the npm page was told that `{ style: 'plain' }` produced legacy `__P<n>__`
 * placeholders, and it produced role-typed ones. In the other direction
 * `languageFallback` shipped in 1.3.0 — added to the result precisely so the web
 * app, the CLI and the MCP server report the same fact — and the documented
 * result shape never mentioned it.
 *
 * Neither is visible to the compiler, the linter or a reviewer reading a diff,
 * because the README is prose next to code that changed. Both are visible to a
 * string comparison, which is all this is.
 *
 * Types are read from the source rather than imported: a TypeScript interface
 * leaves nothing behind at runtime to enumerate.
 */
const TYPES = readFileSync(join(import.meta.dirname, '..', 'src', 'types.ts'), 'utf8')
const README = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8')

/** The top-level property names of one exported interface.
 *
 *  Brace-depth aware, so a nested object type contributes its own keys to
 *  nothing — only the interface's own surface is compared. */
function interfaceKeys(name: string): string[] {
  const start = TYPES.indexOf(`export interface ${name} {`)
  if (start === -1) throw new Error(`no exported interface ${name} in types.ts`)
  const keys: string[] = []
  let depth = 0
  for (const line of TYPES.slice(start).split('\n').slice(1)) {
    const opens = (line.match(/\{/g) ?? []).length
    const closes = (line.match(/\}/g) ?? []).length
    if (depth === 0 && closes > opens) break
    if (depth === 0) {
      const m = /^ {2}(\w+)\??:/.exec(line)
      if (m) keys.push(m[1])
    }
    depth += opens - closes
  }
  return keys.sort()
}

/** Every `options.<name>` the README names. */
function documentedOptions(): string[] {
  const names = [...README.matchAll(/`options\.(\w+)`/g)].map((m) => m[1])
  return [...new Set(names)].sort()
}

/** The result shape the README promises for one function, from its `→ { … }`. */
function documentedResult(fn: string): string[] {
  const m = new RegExp(`\`${fn}\\([^\`]*\\)\` → \`\\{([^}]*)\\}\``).exec(README)
  if (!m) throw new Error(`README states no result shape for ${fn}()`)
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()
}

describe('the README API list and the engine types', () => {
  const optionKeys = [...interfaceKeys('AnonymizeOptions'), ...interfaceKeys('RestoreOptions')]

  it('documents every option the engine accepts', () => {
    const undocumented = optionKeys.filter((k) => !documentedOptions().includes(k))
    expect(
      undocumented,
      `these options exist and the README never names them: ${undocumented.join(', ')}`
    ).toEqual([])
  })

  it('never documents an option the engine does not accept', () => {
    // The `options.style` failure. A promise a caller can act on is worse than
    // an omission: the code compiles against the README and silently does
    // something else.
    const invented = documentedOptions().filter((k) => !optionKeys.includes(k))
    expect(
      invented,
      `the README documents options that are in no options type: ${invented.join(', ')}`
    ).toEqual([])
  })

  it('states the result shapes the types actually return', () => {
    // Both directions at once: a field added to a result (languageFallback) and
    // a field the README still lists after a rename both fail here.
    expect(documentedResult('anonymize')).toEqual(interfaceKeys('AnonymizeResult'))
    expect(documentedResult('restore')).toEqual(interfaceKeys('RestoreResult'))
  })
})

/**
 * The names the README says the package exports, against what it exports.
 *
 * The `options.style` check above covers one kind of name. A function, a
 * constant, a class or a type the README lists can be renamed or deleted just
 * as quietly, and a reader who imports it gets a compile error from code the
 * README gave them. The export list comes from the TypeScript checker over
 * src/index.ts, so type-only exports (`SymbolMap`, `VeilioFile`) count too. A
 * runtime `Object.keys(import(...))` would not see them.
 */
function engineExports(): Set<string> {
  const index = join(import.meta.dirname, '..', 'src', 'index.ts')
  const program = ts.createProgram([index], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    noEmit: true,
  })
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(index)
  const moduleSymbol = source && checker.getSymbolAtLocation(source)
  if (!moduleSymbol) throw new Error('could not read the exports of src/index.ts')
  return new Set(checker.getExportsOfModule(moduleSymbol).map((s) => s.name))
}

/** The `## API` section, up to the next top-level heading. */
function apiSection(): string {
  const start = README.indexOf('## API')
  if (start === -1) throw new Error('README has no "## API" section')
  const end = README.indexOf('\n## ', start + 1)
  return README.slice(start, end === -1 ? undefined : end)
}

/**
 * The names the README presents as exports. There are three shapes:
 *
 * - the head of each top-level list item in `## API`, before the first ` — `
 *   or ` → `, with its wrapped lines joined (`- \`parseSymbolMap(raw)\` → …`);
 * - names written as a pair, `` `a` / `b` ``, the README's way of listing two
 *   exports together;
 * - any PascalCase or SCREAMING_SNAKE name in backticks in that section. These
 *   are types, classes and constants. A result field is camelCase, so it is
 *   not picked up.
 */
function documentedExports(): string[] {
  const names = new Set<string>()
  const items: string[] = []
  for (const line of apiSection().split('\n')) {
    if (line.startsWith('- ')) items.push(line)
    else if (/^ {2}\S/.test(line) && !/^ {2}- /.test(line) && items.length > 0)
      items[items.length - 1] += ' ' + line.trim()
    else if (!line.startsWith(' ')) items.push('')
  }
  for (const item of items) {
    const head = item.split(/ [—→] /)[0]
    for (const m of head.matchAll(/`([A-Za-z_]\w*)/g)) names.add(m[1])
  }
  const api = apiSection()
  for (const m of api.matchAll(/`([A-Za-z_]\w*)(?:\([^`]*\))?` \/ `([A-Za-z_]\w*)/g)) {
    names.add(m[1])
    names.add(m[2])
  }
  for (const m of api.matchAll(/`([A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*|[A-Z][A-Z0-9]*_[A-Z0-9_]+)`/g))
    names.add(m[1])
  return [...names].sort()
}

describe('the README API list and the engine exports', () => {
  const exported = engineExports()
  const documented = documentedExports()

  it('finds the names it is checking', () => {
    // A guard on the extraction, not on the README. If a reformat of the API
    // list made the parser above see nothing, the next test would pass on an
    // empty list.
    expect(documented.length).toBeGreaterThan(40)
    expect(documented).toEqual(expect.arrayContaining(['anonymize', 'restore', 'SymbolMap']))
  })

  it('documents only names the package exports', () => {
    const missing = documented.filter((name) => !exported.has(name))
    expect(
      missing,
      `the README presents these as exports of @veilio-inc/engine, and src/index.ts does not export them: ${missing.join(', ')}`
    ).toEqual([])
  })
})

describe('options named in any public doc', () => {
  // The engine README is checked above. The ROADMAP, the guides and the other
  // READMEs mention options too (`options.manual`), and a stale one there
  // misleads a reader just as much.
  const optionKeys = [...interfaceKeys('AnonymizeOptions'), ...interfaceKeys('RestoreOptions')]

  it.each(publicDocs())('%s names only options the engine accepts', (doc) => {
    const named = [...readDoc(doc).matchAll(/`options\.(\w+)`/g)].map((m) => m[1])
    const invented = [...new Set(named)].filter((k) => !optionKeys.includes(k))
    expect(
      invented,
      `${doc} names options that are in no options type: ${invented.join(', ')}`
    ).toEqual([])
  })
})
