import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// `@veilio` on npm belongs to an unrelated third party (docs/PUBLISHING.md).
// A file we ship that tells someone to install `@veilio/<anything>` sends them
// to install a stranger's code. The pre-commit hook did exactly that until
// 2026-10-26. Every tracked file is checked except this test and the manifest
// test that asserts the same rule.
const ALLOWED = new Set(['tests/npm-scope-in-shipped-files.test.ts', 'tests/package-graph.test.ts'])

describe('npm scope in shipped files', () => {
  it('no tracked file names the third-party @veilio/ scope', () => {
    const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
      .split('\n')
      .filter((f) => f !== '' && !ALLOWED.has(f) && !f.endsWith('package-lock.json'))
    const wrong: string[] = []
    for (const f of files) {
      let text: string
      try {
        text = readFileSync(f, 'utf8')
      } catch {
        continue
      }
      text.split('\n').forEach((line, i) => {
        if (/@veilio\/[a-z]/.test(line)) wrong.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(wrong).toEqual([])
  })
})
