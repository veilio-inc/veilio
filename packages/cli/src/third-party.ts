// Which names a file takes from a public package, so they are left as written
// (spec 050 FR-006, FR-007). One rule for `veilio scrub <file>` and the MCP
// server's `anonymize_file`, so the two give the same placeholders for the same
// file (spec 030 FR-005, as amended by spec 050 T033-T036).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  externalNames,
  type Language,
  type LanguageOption,
  languageOfPath,
  parseDeclarations,
  parseShellDeclarations,
  type ProjectShape,
} from '@veilio-inc/engine'

/** The names each input takes from a public package, to leave as written
 *  (spec 050 FR-006, FR-007). Declarations are read from every input first, so
 *  a word one input imports and another declares stays masked; and nothing is
 *  kept when an input is in a language whose declarations are not read.
 *
 *  Narrower than the guard: the guard knows every file the project declares
 *  names in, scrub knows only its inputs. A word an input imports from a public
 *  package and a file NOT given here declares is left as written; scrub the
 *  files that declare it in the same call to keep it masked. */
export function thirdPartyNames(
  inputs: { name: string | null; text: string }[],
  /** The project map and the team's namespace, kept apart: merged by key, one
   *  placeholder in both would drop a name (security review of ec0cb00). */
  known: Record<string, string>[],
  cwd: string
): Map<object, Set<string>> {
  const out = new Map<object, Set<string>>()
  // Each file by its OWN extension: --language overrides how a file is masked,
  // never whether scrub can read what it declares (security review of #149).
  const languageFor = (name: string | null): LanguageOption =>
    (name ? languageOfPath(name) : null) ?? 'auto'
  // Only from a project root: from anywhere else scrub cannot see the
  // project's shape, and a project's own module would read as a package.
  if (!existsSync(join(cwd, '.git')) && !existsSync(join(cwd, 'package.json'))) return out
  const parsed = (l: LanguageOption): l is 'typescript' | 'python' | 'go' =>
    l === 'typescript' || l === 'python' || l === 'go'
  // Text that declares no code (notes, data) does not count; a source file in
  // a language whose declarations are not read does, and keeps everything.
  // Shell scripts count as prose here; what they declare is still read below.
  const prose = (name: string) =>
    /\.(txt|md|markdown|rst|json|ya?ml|toml|csv|log|ini|sh|bash|zsh|ps1)$/i.test(name)
  const unknown = inputs.some(
    (i) => i.name === null || (!prose(i.name) && !parsed(languageFor(i.name)))
  )
  if (unknown) return out
  const declared = new Set<string>()
  const code = inputs.filter((i) => parsed(languageFor(i.name)))
  for (const i of code) {
    for (const name of parseDeclarations(i.text, languageFor(i.name) as Language))
      declared.add(name)
  }
  // A shell script counts as prose above, but what it declares is the project's.
  for (const i of inputs)
    if (i.name && /\.(sh|bash|zsh|ps1)$/i.test(i.name))
      for (const name of parseShellDeclarations(i.text)) declared.add(name)
  const shape = projectShape(cwd, inputs)
  for (const i of code) {
    const names = externalNames(i.text, languageFor(i.name) as Language, shape)
    // Nor a name the map already holds as code (a variable, function or class):
    // another file, or an earlier scrub, found it to be the project's.
    const held = new Set(
      known
        .flatMap((map) => Object.entries(map))
        .filter(([placeholder]) => /^__(VAR|FN|CLS)__\d+$/.test(placeholder))
        .map(([, name]) => name)
    )
    out.set(i, new Set([...names].filter((n) => !declared.has(n) && !held.has(n))))
  }
  return out
}

/** What the CLI can see of the project's shape from where it runs: the
 *  top-level directories, the package names in package.json files near the
 *  root, tsconfig path aliases and baseUrl, and the Python module names on the
 *  inputs' paths. */
export function projectShape(cwd: string, inputs: { name: string | null }[]): ProjectShape {
  const dirs = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
        .map((d) => d.name)
    } catch {
      return []
    }
  }
  const json = (path: string): any => {
    try {
      return JSON.parse(
        readFileSync(path, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '')
          .replace(/,(\s*[}\]])/g, '$1')
      )
    } catch {
      return undefined
    }
  }
  const top = dirs(cwd)
  const workspaces: string[] = []
  for (const dir of [
    '',
    ...top,
    ...top.flatMap((t) => dirs(join(cwd, t)).map((d) => `${t}/${d}`)),
  ]) {
    const name = json(join(cwd, dir, 'package.json'))?.name
    if (typeof name === 'string') workspaces.push(name)
  }
  const tsconfig = json(join(cwd, 'tsconfig.json'))?.compilerOptions
  const baseDirs = new Set(top)
  if (typeof tsconfig?.baseUrl === 'string')
    for (const d of dirs(join(cwd, tsconfig.baseUrl))) baseDirs.add(d)
  const pathAliases = Object.keys(tsconfig?.paths ?? {})
    .map((k) => k.replace(/\*.*$/, ''))
    .filter(Boolean)
  const pythonModules = new Set(top)
  for (const i of inputs)
    if (i.name?.endsWith('.py'))
      for (const part of i.name.replace(/\.py$/, '').split('/')) pythonModules.add(part)
  return { baseDirs: [...baseDirs], workspaces, pathAliases, pythonModules: [...pythonModules] }
}
