#!/usr/bin/env node
// Runs after `changeset version` (npm run version-packages): the GitHub Action's
// default `version` input is the CLI version being released, so adopters run the
// CLI this Action shipped with, not whatever `latest` is on the day.
//
//   node scripts/sync-action-version.mjs [--root <repo>]
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const i = process.argv.indexOf('--root')
const root = i >= 0 ? process.argv[i + 1] : process.cwd()
const { version } = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8'))
const file = join(root, 'packages/cli/action.yml')
const text = readFileSync(file, 'utf8')
const re = /(\n  version:\n(?:    .*\n)*?    default: )'[^']*'/
if (!re.test(text)) {
  console.error('sync-action-version: no `version` input with a default in packages/cli/action.yml')
  process.exit(1)
}
writeFileSync(file, text.replace(re, `$1'${version}'`))
