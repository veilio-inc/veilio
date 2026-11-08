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
  const target = typeof exp === 'string' ? (sub === '.' ? exp : undefined) : exp[sub]
  if (target === undefined || target === null) return null
  return typeof target === 'string' ? target : (target.import ?? target.default ?? null)
}

/** `dep` as npm installs it for `range`, unpacked under a temporary prefix. */
function installed(dep, range, temps) {
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
      `${dep}@${range}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  )
  return join(prefix, 'node_modules', dep)
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
      const at = fixed[dep] ?? installed(dep, range, temps)
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
