#!/usr/bin/env node
// Spec 083 (research R4): the marketplace names the guard by a release tag and
// its commit, so an install gets that release, never whatever main holds.
//
//   node scripts/pin-guard.mjs --check          the pin is a tag whose commit is the
//                                               pinned sha, with plugin.json at that
//                                               version
//   node scripts/pin-guard.mjs --pin <commit>   tag <commit> veilio-guard@<its version>
//                                               (locally, if missing) and pin to it
//
// Run from the repository root. The tag is pushed by a person, never by this script.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const MARKETPLACE = '.claude-plugin/marketplace.json'
const PATH = 'plugins/veilio-guard'
const URL = 'https://github.com/veilio-inc/veilio.git'
const PREFIX = 'veilio-guard@'

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tryGit = (...args) => {
  try {
    return git(...args)
  } catch {
    return undefined
  }
}
const versionAt = (commit) =>
  JSON.parse(git('show', `${commit}:${PATH}/.claude-plugin/plugin.json`)).version

function readMarketplace() {
  const m = JSON.parse(readFileSync(MARKETPLACE, 'utf8'))
  const entry = m.plugins?.find((p) => p.name === 'veilio-guard')
  if (!entry) throw new Error(`${MARKETPLACE} has no veilio-guard entry`)
  return { m, entry }
}

function check() {
  const { source } = readMarketplace().entry
  if (typeof source === 'string' || source?.source !== 'git-subdir')
    return `veilio-guard is not pinned: its source is ${JSON.stringify(source)}, not a git-subdir with ref and sha`
  const { url, path, ref, sha } = source
  if (url !== URL) return `the pin's url is ${url}, not ${URL}`
  if (path !== PATH) return `the pin's path is ${path}, not ${PATH}`
  if (typeof ref !== 'string' || !ref.startsWith(PREFIX))
    return `the pin's ref ${ref} is not a ${PREFIX}<version> tag`
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha))
    return `the pin's sha ${sha} is not a full commit id`
  const tagged = tryGit('rev-parse', '-q', '--verify', `refs/tags/${ref}^{commit}`)
  if (!tagged) return `there is no tag ${ref}`
  if (tagged !== sha) return `the tag ${ref} points at ${tagged}, not the pinned ${sha}`
  const version = versionAt(sha)
  if (`${PREFIX}${version}` !== ref)
    return `plugin.json is ${version} at ${sha}, but the pin names ${ref}`
  return undefined
}

function pin(commit) {
  const sha = git('rev-parse', '--verify', `${commit}^{commit}`)
  const ref = `${PREFIX}${versionAt(sha)}`
  const tagged = tryGit('rev-parse', '-q', '--verify', `refs/tags/${ref}^{commit}`)
  if (tagged && tagged !== sha) throw new Error(`the tag ${ref} already points at ${tagged}`)
  if (!tagged) git('tag', '-a', ref, '-m', ref, sha)
  const { m, entry } = readMarketplace()
  entry.source = { source: 'git-subdir', url: URL, path: PATH, ref, sha }
  writeFileSync(MARKETPLACE, `${JSON.stringify(m, null, 2)}\n`)
  console.log(`Pinned veilio-guard to ${ref} (${sha}). Push the tag, then open the pin PR.`)
}

const [flag, arg] = process.argv.slice(2)
try {
  if (flag === '--check') {
    const problem = check()
    if (problem) throw new Error(problem)
  } else if (flag === '--pin' && arg) pin(arg)
  else throw new Error('usage: pin-guard.mjs --check | --pin <commit>')
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
