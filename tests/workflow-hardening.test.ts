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
