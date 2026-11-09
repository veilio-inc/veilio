#!/usr/bin/env node
// Before the CLI and the MCP server are published: everything their build
// imports from @veilio-inc/engine (and the MCP server from @veilio-inc/cli)
// must exist in the version their range resolves to on npm. The workspace
// links the local packages, so the build and the tests pass against exports
// npm may not have yet (spec 078 review rounds 1 and 2). Raising the range
// itself stays a release step (spec 078 T034).
//
//   node scripts/check-engine-exports.mjs [--root <repo>] [--engine <dir>] [--cli <dir>]
//
// --engine and --cli check against an unpacked package instead of npm (tests).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEPS = ['@veilio-inc/engine', '@veilio-inc/cli']
const args = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const root = option('--root') ?? process.cwd()
const fixed = { '@veilio-inc/engine': option('--engine'), '@veilio-inc/cli': option('--cli') }

/** Every .js file under `dir`. */
function scripts(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => join(e.parentPath ?? e.path, e.name))
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const names = (list) =>
  list
    .split(',')
    .map((p) =>
      p
        .trim()
        .split(/\s+as\s+|\s*:\s*/)[0]
        .trim()
    )
    .filter((n) => n && !n.startsWith('type '))

/** What a built file takes from `dep` or one of its subpaths: specifier ->
 *  the names it needs ('default' for a default import). The build has dropped
 *  type-only imports already. */
function importsOf(text, dep, into) {
  const spec = `['"](${esc(dep)}(?:/[^'"]*)?)['"]`
  const need = (s) => (into.has(s) ? into.get(s) : into.set(s, new Set()).get(s))
  const members = (ns, s) => {
    for (const m of text.matchAll(new RegExp(`\\b${esc(ns)}\\.([A-Za-z_$][\\w$]*)`, 'g')))
      need(s).add(m[1])
  }
  // import x, { a, b as c } from / export { d } from / import * as ns from
  for (const m of text.matchAll(
    new RegExp(
      `\\b(import|export)\\s*((?:(?!\\b(?:import|export)\\b)[^;'"])*?)\\s*from\\s*${spec}`,
      'g'
    )
  )) {
    const [, kind, clause, s] = m
    need(s)
    const braces = /\{([^}]*)\}/.exec(clause)
    if (braces) for (const n of names(braces[1])) need(s).add(n)
    const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause)
    if (ns && kind === 'import') members(ns[1], s)
    else if (ns) need(s).add(ns[1]) // export * as x from: the module only
    const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause.trim())
    if (kind === 'import' && def && def[1] !== 'type') need(s).add('default')
  }
  // import 'x' (side effect only)
  for (const m of text.matchAll(new RegExp(`\\bimport\\s*${spec}`, 'g'))) need(m[1])
  // import('x'), destructured or held in a variable
  for (const m of text.matchAll(
    new RegExp(
      `(?:\\{([^}]*)\\}|([A-Za-z_$][\\w$]*))\\s*=\\s*await\\s+import\\(\\s*${spec}\\s*\\)`,
      'g'
    )
  )) {
    if (m[1] !== undefined) for (const n of names(m[1])) need(m[3]).add(n)
    else members(m[2], m[3])
  }
  for (const m of text.matchAll(new RegExp(`\\bimport\\(\\s*${spec}\\s*\\)`, 'g'))) need(m[1])
}

/** The file a package's manifest serves for `sub` ('.' or './x'), or null. */
function entryOf(manifest, sub) {
  const exp = manifest.exports
  if (exp === undefined) return sub === '.' ? (manifest.main ?? 'index.js') : sub
  // An object with no `.`-keys is conditions alone: the `.` entry (round 3).
  const conditions = typeof exp === 'object' && !Object.keys(exp).some((k) => k.startsWith('.'))
  const target = typeof exp === 'string' || conditions ? (sub === '.' ? exp : undefined) : exp[sub]
  if (target === undefined || target === null) return null
  return typeof target === 'string' ? target : (target.import ?? target.default ?? null)
}

// The tools released together by changesets in the same run. The engine is
// released on its own (semantic-release), so it is always read from npm.
const SIBLINGS = { '@veilio-inc/cli': 'cli' }

/** Whether `version` satisfies a caret range `^x.y.z` (0.x keeps the minor). */
function caret(range, version) {
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range)
  const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '')
  if (!m || !v) return false
  const [a, b] = [m.slice(1).map(Number), v.slice(1).map(Number)]
  if (b[0] !== a[0] || (a[0] === 0 && b[1] !== a[1])) return false
  for (let i = 0; i < 3; i++) if (b[i] !== a[i]) return b[i] > a[i]
  return true
}

/** The workspace copy of a sibling tool when its version satisfies `range`. */
function sibling(dep, range) {
  const dir = SIBLINGS[dep] && join(root, 'packages', SIBLINGS[dep])
  if (!dir || !existsSync(join(dir, 'package.json'))) return undefined
  const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
  return caret(range, version) ? dir : undefined
}

/**
 * The one version of `dep` to check (spec 085 R2-1): an allow-list of exact
 * versions, never a range npm resolves at run time. The engine: the version
 * packages/engine/package.json records, which the release job has confirmed is
 * npm's latest. Another package: the highest version npm lists for `range`.
 * Null, with the reason said, when there is none.
 */
function exactVersion(dep, range, tool) {
  if (dep === '@veilio-inc/engine') {
    const version = JSON.parse(
      readFileSync(join(root, 'packages', 'engine', 'package.json'), 'utf8')
    ).version
    if (caret(range, version)) return version
    say(
      `${dep} ${version} (packages/engine/package.json) is outside ${range}, the range ${tool} declares.`
    )
    return null
  }
  const listed = JSON.parse(
    execFileSync('npm', ['view', `${dep}@${range}`, 'version', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }) || 'null'
  )
  const versions = [listed].flat().filter((v) => typeof v === 'string' && caret(range, v))
  if (versions.length === 0) {
    say(`npm lists no ${dep} version in ${range}, the range ${tool} declares.`)
    return null
  }
  const parts = (v) => v.split('.').map(Number)
  return versions
    .sort((x, y) => {
      const [a, b] = [parts(x), parts(y)]
      return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
    })
    .at(-1)
}

/** `dep` at exactly `version`, unpacked under a temporary prefix. */
function installed(dep, version, temps) {
  const prefix = mkdtempSync(join(tmpdir(), 'engine-exports-'))
  temps.push(prefix)
  execFileSync(
    'npm',
    [
      'install',
      '--prefix',
      prefix,
      '--no-save',
      '--no-package-lock',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `${dep}@${version}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  )
  const at = join(prefix, 'node_modules', dep)
  const got = JSON.parse(readFileSync(join(at, 'package.json'), 'utf8')).version
  if (got !== version) throw new Error(`npm installed ${dep}@${got}, not ${version}`)
  return at
}

const temps = []
let failed = false
const say = (text) => {
  console.error(text)
  failed = true
}
try {
  for (const pkg of ['cli', 'mcp']) {
    const dir = join(root, 'packages', pkg)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const dist = join(dir, 'dist')
    const deps = DEPS.filter((d) => manifest.dependencies?.[d])
    if (!deps.includes('@veilio-inc/engine') || !existsSync(dist)) {
      say(`${manifest.name}: no @veilio-inc/engine range or no dist/ to check; build it first.`)
      continue
    }
    const files = scripts(dist).map((f) => readFileSync(f, 'utf8'))
    for (const dep of deps) {
      const range = manifest.dependencies[dep]
      const wanted = new Map()
      for (const text of files) importsOf(text, dep, wanted)
      if (wanted.size === 0) continue
      let at = fixed[dep] ?? sibling(dep, range)
      if (at === undefined) {
        const exact = exactVersion(dep, range, manifest.name)
        if (exact === null) continue
        at = installed(dep, exact, temps)
      }
      const target = JSON.parse(readFileSync(join(at, 'package.json'), 'utf8'))
      const version = target.version ?? '(fixture)'
      let count = 0
      const before = failed
      failed = false
      for (const [spec, need] of wanted) {
        const sub = spec === dep ? '.' : `.${spec.slice(dep.length)}`
        const entry = entryOf(target, sub)
        if (entry === null) {
          say(
            `${manifest.name} imports ${spec}, which ${dep}@${version} (its range ${range}) does not export. Release it and raise the range first.`
          )
          continue
        }
        const mod = await import(pathToFileURL(join(at, entry)).href)
        for (const name of [...need].sort()) {
          count++
          if (!(name in mod))
            say(
              `${manifest.name} imports ${name} from ${spec}, which ${dep}@${version} (its range ${range}) does not export. Release it and raise the range first.`
            )
        }
      }
      if (!failed)
        console.log(`${manifest.name}: ${count} imports, all in ${dep}@${version} (${range}).`)
      failed ||= before
    }
  }
} finally {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
