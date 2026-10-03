#!/usr/bin/env node
// Copies the engine's build into the Claude Code guard plugin.
//
// A mod may only import files inside its own plugin directory - no npm
// packages - so plugins/veilio-guard/vendor/engine holds a copy of
// packages/engine/dist. The copy is committed, so installing the plugin from
// git needs no build. `--check` exits 1 when the copy differs from the build,
// so CI catches a plugin running an engine nobody tested.
//
//   node scripts/sync-guard-engine.mjs           copy the build in
//   node scripts/sync-guard-engine.mjs --check   compare only
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'packages/engine/dist'
const DEST = 'plugins/veilio-guard/vendor/engine'
const check = process.argv.includes('--check')

// Source maps point at files the plugin does not ship, so they stay behind,
// and so does the comment in each file that names one.
const wanted = (name) => name.endsWith('.js') || name.endsWith('.d.ts')
const copyOf = (name) =>
  Buffer.from(
    readFileSync(join(SRC, name), 'utf8').replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n')
  )

if (!existsSync(SRC)) {
  console.error(
    `sync-guard-engine: ${SRC} is missing - run npm run build --workspace=packages/engine first`
  )
  process.exit(2)
}
const built = readdirSync(SRC).filter(wanted).sort()
if (built.length === 0) {
  console.error(`sync-guard-engine: ${SRC} has no .js files`)
  process.exit(2)
}

if (check) {
  const copied = existsSync(DEST) ? readdirSync(DEST).sort() : []
  const differs = []
  for (const name of built) {
    const there = join(DEST, name)
    if (!existsSync(there) || !readFileSync(there).equals(copyOf(name))) differs.push(name)
  }
  for (const name of copied) if (!built.includes(name)) differs.push(name)
  if (differs.length) {
    console.error(`sync-guard-engine: ${DEST} differs from ${SRC}: ${differs.join(', ')}`)
    console.error('Run node scripts/sync-guard-engine.mjs and commit the result.')
    process.exit(1)
  }
  console.log(`sync-guard-engine: ${DEST} matches the build (${built.length} files)`)
  process.exit(0)
}

rmSync(DEST, { recursive: true, force: true })
mkdirSync(DEST, { recursive: true })
for (const name of built) writeFileSync(join(DEST, name), copyOf(name))
console.log(`sync-guard-engine: copied ${built.length} files to ${DEST}`)
