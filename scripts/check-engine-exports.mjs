#!/usr/bin/env node
// Before the CLI and the MCP server are published: every engine export their
// build imports must exist in the engine their range resolves to on npm. The
// workspace links the local engine, so the build and the tests pass against
// exports npm may not have yet (spec 078 review round 1 item 1). Raising the
// range itself stays a release step (spec 078 T034).
//
//   node scripts/check-engine-exports.mjs [--root <repo>] [--engine <dir>]
//
// --engine checks against an unpacked engine instead of npm (tests).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ENGINE = '@veilio-inc/engine'
const args = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const root = option('--root') ?? process.cwd()
const fixed = option('--engine')

/** Every .js file under `dir`. */
function scripts(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => join(e.parentPath ?? e.path, e.name))
}

/** The names a built file takes from the engine (`import { a, b as c }` and
 *  `export { d } from`); the build has dropped type-only imports already. */
function engineImports(text) {
  const out = new Set()
  const re = /\b(?:import|export)\s*\{([^}]*)\}\s*from\s*['"]@veilio-inc\/engine['"]/g
  for (const m of text.matchAll(re))
    for (const part of m[1].split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]
        .trim()
      if (name && !name.startsWith('type ')) out.add(name)
    }
  return out
}

/** The engine's runtime exports, from an unpacked package directory. */
async function exportsOf(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const dot = manifest.exports?.['.']
  const entry = (typeof dot === 'string' ? dot : (dot?.import ?? dot?.default)) ?? manifest.main
  const mod = await import(pathToFileURL(join(dir, entry)).href)
  return { version: manifest.version ?? '(fixture)', names: new Set(Object.keys(mod)) }
}

/** The engine npm installs for `range`, unpacked under a temporary prefix. */
function installed(range, temps) {
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
      `${ENGINE}@${range}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  )
  return join(prefix, 'node_modules', ENGINE)
}

const temps = []
let failed = false
try {
  for (const pkg of ['cli', 'mcp']) {
    const dir = join(root, 'packages', pkg)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const range = manifest.dependencies?.[ENGINE]
    const dist = join(dir, 'dist')
    if (!range || !existsSync(dist)) {
      console.error(`${manifest.name}: no ${ENGINE} range or no dist/ to check; build it first.`)
      failed = true
      continue
    }
    const wanted = new Set()
    for (const file of scripts(dist))
      for (const name of engineImports(readFileSync(file, 'utf8'))) wanted.add(name)
    const engine = await exportsOf(fixed ?? installed(range, temps))
    const missing = [...wanted].filter((n) => !engine.names.has(n)).sort()
    for (const name of missing)
      console.error(
        `${manifest.name} imports ${name}, which ${ENGINE}@${engine.version} (its range ${range}) does not export. Release the engine and raise the range first.`
      )
    if (missing.length) failed = true
    else
      console.log(
        `${manifest.name}: ${wanted.size} engine imports, all in ${ENGINE}@${engine.version} (${range}).`
      )
  }
} finally {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
