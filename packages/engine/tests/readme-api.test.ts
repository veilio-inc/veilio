import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The README's API list against the types it describes.
 *
 * `options.style` was documented for seven published versions after the option
 * was deleted from `AnonymizeOptions` (a5c494b, before 1.0.0): every reader of
 * the npm page was told that `{ style: 'plain' }` produced legacy `__P<n>__`
 * placeholders, and it produced role-typed ones. In the other direction
 * `languageFallback` shipped in 1.3.0 — added to the result precisely so the web
 * app, the CLI and the MCP server report the same fact — and the documented
 * result shape never mentioned it.
 *
 * Neither is visible to the compiler, the linter or a reviewer reading a diff,
 * because the README is prose next to code that changed. Both are visible to a
 * string comparison, which is all this is.
 *
 * Types are read from the source rather than imported: a TypeScript interface
 * leaves nothing behind at runtime to enumerate.
 */
const TYPES = readFileSync(join(import.meta.dirname, '..', 'src', 'types.ts'), 'utf8')
const README = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8')

/** The top-level property names of one exported interface.
 *
 *  Brace-depth aware, so a nested object type contributes its own keys to
 *  nothing — only the interface's own surface is compared. */
function interfaceKeys(name: string): string[] {
  const start = TYPES.indexOf(`export interface ${name} {`)
  if (start === -1) throw new Error(`no exported interface ${name} in types.ts`)
  const keys: string[] = []
  let depth = 0
  for (const line of TYPES.slice(start).split('\n').slice(1)) {
    const opens = (line.match(/\{/g) ?? []).length
    const closes = (line.match(/\}/g) ?? []).length
    if (depth === 0 && closes > opens) break
    if (depth === 0) {
      const m = /^ {2}(\w+)\??:/.exec(line)
      if (m) keys.push(m[1])
    }
    depth += opens - closes
  }
  return keys.sort()
}

/** Every `options.<name>` the README names. */
function documentedOptions(): string[] {
  const names = [...README.matchAll(/`options\.(\w+)`/g)].map((m) => m[1])
  return [...new Set(names)].sort()
}

/** The result shape the README promises for one function, from its `→ { … }`. */
function documentedResult(fn: string): string[] {
  const m = new RegExp(`\`${fn}\\([^\`]*\\)\` → \`\\{([^}]*)\\}\``).exec(README)
  if (!m) throw new Error(`README states no result shape for ${fn}()`)
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()
}

describe('the README API list and the engine types', () => {
  const optionKeys = [...interfaceKeys('AnonymizeOptions'), ...interfaceKeys('RestoreOptions')]

  it('documents every option the engine accepts', () => {
    const undocumented = optionKeys.filter((k) => !documentedOptions().includes(k))
    expect(
      undocumented,
      `these options exist and the README never names them: ${undocumented.join(', ')}`
    ).toEqual([])
  })

  it('never documents an option the engine does not accept', () => {
    // The `options.style` failure. A promise a caller can act on is worse than
    // an omission: the code compiles against the README and silently does
    // something else.
    const invented = documentedOptions().filter((k) => !optionKeys.includes(k))
    expect(
      invented,
      `the README documents options that are in no options type: ${invented.join(', ')}`
    ).toEqual([])
  })

  it('states the result shapes the types actually return', () => {
    // Both directions at once: a field added to a result (languageFallback) and
    // a field the README still lists after a rename both fail here.
    expect(documentedResult('anonymize')).toEqual(interfaceKeys('AnonymizeResult'))
    expect(documentedResult('restore')).toEqual(interfaceKeys('RestoreResult'))
  })
})
