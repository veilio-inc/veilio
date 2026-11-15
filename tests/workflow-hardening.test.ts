import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Security audit 2026-11-01 (LOW): release.yml declared no permissions (the
// repository default token), and both publish jobs installed a floating
// npm@12 right before publishing with the OIDC identity. Kept here: every
// workflow scopes its token, every action is pinned by SHA, global tools are
// pinned exactly.
const WF = join(import.meta.dirname, '..', '.github', 'workflows')
const workflows = readdirSync(WF).filter((f) => /\.ya?ml$/.test(f))

describe.each(workflows)('%s', (f) => {
  const text = readFileSync(join(WF, f), 'utf8')

  it('declares workflow-level permissions', () => {
    expect(text).toMatch(/^permissions:/m)
  })
  it('pins every action by commit SHA', () => {
    const refs = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)].map((m) => m[1]!)
    for (const ref of refs) {
      if (ref.startsWith('./')) continue
      expect(ref, `${ref} is not SHA-pinned`).toMatch(/@[0-9a-f]{40}$/)
    }
  })
  it('installs global tools at exact versions', () => {
    for (const m of text.matchAll(/npm (?:install|i) -g ([^\n]+)/g)) {
      for (const spec of m[1]!.trim().split(/\s+/)) {
        expect(spec, `${spec} floats`).toMatch(/@\d+\.\d+\.\d+$/)
      }
    }
  })
})

// The public image is built only from reviewed code: the job that publishes
// it runs for main and version tags alone, in an environment whose allowed
// refs are the same two (set in the repository's settings), and `latest`
// moves only with main - never with a tag or a manual run from another ref.
describe('release.yml publishes the image only from main and version tags', () => {
  const text = readFileSync(join(WF, 'release.yml'), 'utf8')
  const job = text.slice(text.indexOf('\n  release:\n'))

  it('the publishing job runs only for main and v* tags', () => {
    const condition = /^ {4}if:\s*(.+(?:\n {6}.+)*)/m.exec(job)?.[1] ?? ''
    expect(condition).toContain("needs.changes.outputs.build == 'true'")
    expect(condition).toContain("github.ref == 'refs/heads/main'")
    expect(condition).toContain("startsWith(github.ref, 'refs/tags/v')")
  })

  it('the publishing job names the image environment', () => {
    expect(job).toMatch(/^ {4}environment: image$/m)
  })

  it('latest is applied only on the default branch', () => {
    const latest = job.split('\n').filter((line) => /type=raw,value=latest/.test(line))
    expect(latest).toHaveLength(1)
    expect(latest[0]).toContain('enable={{is_default_branch}}')
  })
})
