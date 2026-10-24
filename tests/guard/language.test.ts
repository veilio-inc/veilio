import { describe, expect, it } from 'vitest'
import { languageOfCommand, languageOfGrepLine } from '../../plugins/veilio-guard/lib/policy.ts'

// Spec 050 R2: the language of a text decides which map names are keywords in
// it. A Grep line and a command's output are in the language of the file they
// come from when there is exactly one; otherwise the language is unknown.

describe('languageOfGrepLine', () => {
  it.each([
    ['src/ledger.ts:12:export function settle() {', 'typescript'],
    ['src/ledger.ts-13-  return total', 'typescript'],
    ['app/models.py:4:class Invoice:', 'python'],
    ['cmd/main.go:9:func main() {', 'go'],
    ['packages/backend/src/lib/exchange-rate.ts:72:  for (let back = 1', 'typescript'],
    ['packages/backend/src/lib/exchange-rate.ts-73-    const day', 'typescript'],
    ['src/ledger.ts', 'typescript'],
    ['notes.md:3:the ledger settles nightly', 'unknown'],
    ['--', 'unknown'],
    ['', 'unknown'],
  ])('%s -> %s', (line, expected) => {
    expect(languageOfGrepLine(line)).toBe(expected)
  })
})

describe('languageOfCommand', () => {
  it.each([
    ['cat src/ledger.ts', 'typescript'],
    ['head -n 50 app/models.py', 'python'],
    ['tail -40 cmd/main.go', 'go'],
    ["sed -n '1,80p' src/lib/csv.ts", 'typescript'],
    ['nl -ba src/ledger.ts', 'typescript'],
    ['cat src/ledger.ts | head -50', 'typescript'],
    ['cat -n "src/ledger.ts" | grep -n settle', 'typescript'],
    ['cd packages/engine && cat src/engine.ts', 'typescript'],
    ['Get-Content src/ledger.ts', 'typescript'],
    ['gc -Path src/ledger.ts', 'typescript'],
    // More than one file, or a command whose output is not one file's text.
    ['cat src/a.ts src/b.py', 'unknown'],
    ['cat src/*.ts', 'unknown'],
    ['npx vitest run tests/ledger.test.ts', 'unknown'],
    ['grep -rn settle src', 'unknown'],
    ['cat src/ledger.ts; ls', 'unknown'],
    ['cat src/ledger.ts | node -e "x"', 'unknown'],
    ['cat README.md', 'unknown'],
    ['', 'unknown'],
  ])('%s -> %s', (command, expected) => {
    expect(languageOfCommand(command)).toBe(expected)
  })
})
