// What a file takes from outside the project, and what it declares itself.
//
// Spec 050 R4: a third-party package's name and the names imported from it are
// public - `vitest`, `describe`, `expect` - so masking them hides nothing
// of the user's and costs the model readability. A name the project declares is
// its own and is masked even when a package exports the same word. The guard and
// the CLI both use this, so it lives here; the tokenizer does not call it.
//
// Line-anchored patterns, not a parser. An import written inside a string
// literal at the start of a line (a code sample in a test fixture) is read as an
// import too, which can only leave more third-party names as written, never
// mask fewer of the project's: declarations win over imports.
import { isKeyword, type Language } from './languages.js'

export interface ImportEntry {
  specifier: string
  /** Names the file takes from the package and uses under the package's own
   *  spelling. A local alias the project chose is not included. */
  names: string[]
}

/** What decides that a specifier points inside the project. */
export interface ProjectShape {
  /** Workspace package names (TS/JS), matched whole or as `name/…`. */
  workspaces?: readonly string[]
  /** `tsconfig` path-alias prefixes such as `@/` (TS/JS). */
  pathAliases?: readonly string[]
  /** Top-level directories of the project, and of its `tsconfig` `baseUrl`
   *  (TS/JS): a bare specifier whose first segment is one of them is the
   *  project's own (`src/billing/ledger`). */
  baseDirs?: readonly string[]
  /** Top-level module and package names found in the project (Python). The
   *  caller must list every one: a missing name makes the project's own
   *  modules read as external. */
  pythonModules?: readonly string[]
  /** The `module` path from `go.mod` (Go). */
  goModule?: string
}

const IDENT = /^[A-Za-z_$][\w$]*$/

/** `import express from 'express'`: the binding is named after the package. */
function namedAfter(local: string, specifier: string): boolean {
  const last = specifier.split(/[/:]/).pop() ?? ''
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  return squash(local) !== '' && squash(local) === squash(last)
}

/** `a, b as c, type d` (TS) or `a, b: c` (destructuring) -> the exported names. */
function namedList(list: string, alias: RegExp): string[] {
  return list
    .split(',')
    .map((part) => part.trim().replace(/^type\s+/, ''))
    .map((part) => part.split(alias)[0].trim())
    .filter((name) => IDENT.test(name))
}

function scriptImports(text: string): ImportEntry[] {
  const found: { at: number; entry: ImportEntry }[] = []
  const add = (at: number, specifier: string, names: string[]) =>
    found.push({ at, entry: { specifier, names } })

  // The clause crosses a line only inside braces, and holds no quote or
  // semicolon: `import 'x'`, or a statement with no semicolon, must not run on
  // into the next statement's `from` and lend it its names.
  const fromClause =
    /^[ \t]*(import|export)\s+(?:type\s+)?((?:[^'";{}\n]|\{[^'";{}]*\})*?)\s+from\s+['"]([^'"]+)['"]/gm
  for (const m of text.matchAll(fromClause)) {
    const [, keyword, clause, specifier] = m
    const names: string[] = []
    const braces = clause.match(/\{([\s\S]*)\}/)
    if (braces) names.push(...namedList(braces[1], /\s+as\s+/))
    const outside = clause
      .replace(/\{[\s\S]*\}/, '')
      .replace(/,/g, ' ')
      .trim()
    const star = outside.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/)
    const binding = star ? star[1] : keyword === 'import' ? outside.split(/\s+/)[0] : ''
    if (binding && IDENT.test(binding) && namedAfter(binding, specifier)) names.unshift(binding)
    add(m.index!, specifier, names)
  }
  for (const m of text.matchAll(/^[ \t]*import\s+['"]([^'"]+)['"]/gm)) add(m.index!, m[1], [])

  const required =
    /^[ \t]*(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/gm
  for (const m of text.matchAll(required)) {
    const [, target, specifier] = m
    const names = target.startsWith('{')
      ? namedList(target.slice(1, -1), /\s*:\s*/)
      : namedAfter(target, specifier)
        ? [target]
        : []
    add(m.index!, specifier, names)
  }
  for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m.index!, m[1], [])

  return found.sort((a, b) => a.at - b.at).map((f) => f.entry)
}

function pythonImports(text: string): ImportEntry[] {
  const found: { at: number; entry: ImportEntry }[] = []
  for (const m of text.matchAll(/^[ \t]*import\s+([^\n#]+)/gm)) {
    for (const part of m[1].split(',')) {
      const specifier = part
        .trim()
        .split(/\s+as\s+/)[0]
        .trim()
      if (specifier) found.push({ at: m.index!, entry: { specifier, names: [] } })
    }
  }
  const from = /^[ \t]*from\s+(\.*[\w.]*)\s+import\s+(\([^)]*\)|[^\n#]+)/gm
  for (const m of text.matchAll(from)) {
    const list = m[2].replace(/^\(|\)$/g, '')
    found.push({
      at: m.index!,
      entry: { specifier: m[1], names: namedList(list.replace(/\n/g, ' '), /\s+as\s+/) },
    })
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.entry)
}

/** `name` is declared in Go source: a parameter, a `var`, or `:=`. */
function boundInGo(text: string, name: string): boolean {
  return (
    new RegExp(`[(,]\\s*${name}\\s+[*\\[\\]\\w.]`).test(text) ||
    new RegExp(`\\bvar\\s+${name}\\b`).test(text) ||
    new RegExp(`\\b${name}\\s*(?:,\\s*\\w+\\s*)*:=`).test(text)
  )
}

function goImports(text: string): ImportEntry[] {
  const specs: { alias: string | null; specifier: string }[] = []
  const one = /^[ \t]*import\s+(?:([A-Za-z_]\w*|\.)\s+)?"([^"]+)"/gm
  for (const m of text.matchAll(one)) specs.push({ alias: m[1] ?? null, specifier: m[2] })
  for (const block of text.matchAll(/^[ \t]*import\s*\(([\s\S]*?)\)/gm)) {
    for (const m of block[1].matchAll(/^[ \t]*(?:([A-Za-z_]\w*|\.)\s+)?"([^"]+)"/gm))
      specs.push({ alias: m[1] ?? null, specifier: m[2] })
  }
  return specs.map(({ alias, specifier }) => {
    const last = specifier.split('/').pop() ?? ''
    const local = alias ?? last
    // Go reaches into a package by `pkg.Name`, and those names are the
    // package's - unless `local` is also bound in this file (a parameter or a
    // variable named like the package), when `local.Field` may be the project's.
    // A dot or blank import has no qualifier to follow.
    const harvest = IDENT.test(local) && local !== '_' && !boundInGo(text, local)
    const selectors = harvest
      ? [...text.matchAll(new RegExp(`(?<![\\w.$])${local}\\.([A-Z]\\w*)`, 'g'))].map((m) => m[1])
      : []
    const names = [...(alias ? [] : [last]), ...new Set(selectors)]
    return { specifier, names }
  })
}

/** The import statements of `text`, in order. Languages other than
 *  TypeScript/JavaScript, Python and Go return none. */
export function parseImports(text: string, language: Language): ImportEntry[] {
  if (language === 'typescript') return scriptImports(text)
  if (language === 'python') return pythonImports(text)
  if (language === 'go') return goImports(text)
  return []
}

function scriptDeclarations(text: string): string[] {
  const out: string[] = []
  const patterns = [
    /^[ \t]*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm,
    /^[ \t]*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
    /^[ \t]*(?:export\s+)?(?:declare\s+)?(?:interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm,
    /^[ \t]*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/gm,
    // Class members: `settle(batch: Batch): void {`, with modifiers.
    /^[ \t]+(?:(?:public|private|protected|static|readonly|async|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::[^{;]+)?\{/gm,
  ]
  for (const re of patterns) for (const m of text.matchAll(re)) out.push(m[1])
  // Class fields and object keys (`private secretKey: string`, `rotateAfter = 30`,
  // `retentionDays: 7`). Over-counting here only masks more.
  const members =
    /^[ \t]+(?:(?:public|private|protected|static|readonly|declare|override)\s+)*([A-Za-z_$][\w$]*)\s*[?!]?\s*[:=](?![=>])/gm
  for (const m of text.matchAll(members)) out.push(m[1])
  for (const m of text.matchAll(/\{([^{}]*)\}\s*(?::[^=)]*)?\s*(?:[,)=]|$)/gm))
    out.push(...namedList(m[1], /\s*[:=]\s*/))
  // Parameters of functions, methods and arrows.
  for (const m of text.matchAll(/\(([^()]*)\)\s*(?::[^{=]+)?\s*(?:\{|=>)/g))
    out.push(...params(m[1]))
  const variables =
    /^[ \t]*(?:export\s+)?(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([^\n]*)/gm
  for (const m of text.matchAll(variables)) {
    if (/^require\(/.test(m[2].trim())) continue
    if (m[1].startsWith('{')) out.push(...namedList(m[1].slice(1, -1), /\s*:\s*/))
    else out.push(m[1])
  }
  return out
}

function pythonDeclarations(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/^[ \t]*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/gm)) {
    out.push(m[1], ...params(m[2]))
  }
  for (const m of text.matchAll(/^[ \t]*class\s+([A-Za-z_]\w*)/gm)) out.push(m[1])
  // Assignments at any depth, annotated or not: module names, class attributes
  // and locals. Over-counting here only masks more.
  for (const m of text.matchAll(/^[ \t]*([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)/gm)) out.push(m[1])
  for (const m of text.matchAll(/^[ \t]*([A-Za-z_]\w*)\s*:\s*[A-Za-z_][\w.[\], ]*$/gm))
    out.push(m[1])
  return out
}

function goDeclarations(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm)) out.push(m[1])
  for (const m of text.matchAll(/^(?:type|var|const)\s+([A-Za-z_]\w*)/gm)) out.push(m[1])
  for (const block of text.matchAll(/^(?:type|var|const)\s*\(([\s\S]*?)^\)/gm))
    for (const m of block[1].matchAll(/^[ \t]*([A-Za-z_]\w*)\b/gm)) out.push(m[1])
  // Struct fields, and function and method parameters.
  for (const block of text.matchAll(/\bstruct\s*\{([^}]*)\}/g))
    for (const m of block[1].matchAll(/^[ \t]*([A-Za-z_]\w*)\s+\S/gm)) out.push(m[1])
  for (const m of text.matchAll(/^func\s+(?:\(([^)]*)\)\s*)?[A-Za-z_]\w*\s*\(([^)]*)\)/gm))
    out.push(...params(m[1] ?? ''), ...params(m[2]))
  return out
}

/** The names in a parameter list, in any of the three languages: `a: T = 1`,
 *  `...rest`, `{ x, y }: Opts`, `self, batch_ref`, `l *Ledger`, `a, b string`. */
function params(list: string): string[] {
  const out: string[] = []
  for (const brace of list.matchAll(/\{([^}]*)\}/g)) out.push(...namedList(brace[1], /\s*[:=]\s*/))
  for (const part of list.replace(/\{[^}]*\}/g, '').split(',')) {
    const name = /^\s*(?:\.\.\.|\*{1,2})?([A-Za-z_$][\w$]*)/.exec(part)?.[1]
    if (name) out.push(name)
  }
  return out
}

/** The names `text` declares: functions, classes, types, module variables and,
 *  for TypeScript, class members. Keywords are left out. */
export function parseDeclarations(text: string, language: Language): string[] {
  const raw =
    language === 'typescript'
      ? scriptDeclarations(text)
      : language === 'python'
        ? pythonDeclarations(text)
        : language === 'go'
          ? goDeclarations(text)
          : []
  return [...new Set(raw)].filter((name) => !isKeyword(name, language))
}

/** True when `specifier` names something outside the project. Unsupported
 *  languages answer false: nothing of theirs is exempted. */
export function isExternalSpecifier(
  specifier: string,
  language: Language,
  project: ProjectShape
): boolean {
  if (language === 'typescript') {
    // Relative, absolute, and package.json `imports` (`#internal/…`).
    if (/^[./#]/.test(specifier)) return false
    // A scope can be a company's private registry (`@acme/ledger`): what it
    // names is not public, so it is never exempt (review of 9355866).
    if (specifier.startsWith('@')) return false
    if ((project.baseDirs ?? []).includes(specifier.split('/')[0])) return false
    if ((project.workspaces ?? []).some((w) => specifier === w || specifier.startsWith(`${w}/`)))
      return false
    return !(project.pathAliases ?? []).some((a) => specifier.startsWith(a))
  }
  if (language === 'python') {
    if (specifier.startsWith('.')) return false
    return !(project.pythonModules ?? []).includes(specifier.split('.')[0])
  }
  if (language === 'go') {
    // Only the standard library: a path whose first element has a dot is a
    // module someone hosts - a company's own, as likely as a public one.
    return !specifier.split('/')[0]!.includes('.')
  }
  return false
}

/** Everything in `text` that comes from outside the project: each external
 *  specifier, its path segments, and the names imported from it - less any name
 *  the same text declares. */
export function externalNames(
  text: string,
  language: Language,
  project: ProjectShape
): Set<string> {
  const declared = new Set(parseDeclarations(text, language))
  const out = new Set<string>()
  for (const { specifier, names } of parseImports(text, language)) {
    if (!isExternalSpecifier(specifier, language, project)) continue
    out.add(specifier)
    for (const segment of specifier.split(/[/:.@]/)) if (IDENT.test(segment)) out.add(segment)
    for (const name of names) out.add(name)
  }
  for (const name of declared) out.delete(name)
  return out
}
