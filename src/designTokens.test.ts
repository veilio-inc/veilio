import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Colour lives in the token layer, and nowhere else.
 *
 * ROADMAP F step 1, and the prerequisite for everything after it. The number
 * the plan records — 59 hardcoded hex values across 4 `.tsx` files, plus 21
 * `rgba()` calls and another 42 literals below the token block in `global.css`
 * — is not a tidiness metric. Those pixels do not move when a token does, so a
 * light palette laid over them produces dark text on dark chips, worst in the
 * components that carry warnings.
 *
 * Two rules, and they fail for opposite reasons.
 *
 * 1. EVERY `var(--x)` RESOLVES. An undefined custom property makes the whole
 *    declaration invalid at computed-value time, so `color: var(--typo)`
 *    silently inherits instead of erroring. With a fallback it is worse:
 *    `var(--warning, #D9A441)` renders correctly forever while the token it
 *    names does not exist. Which is why this checks the REFERENCE and not the
 *    pixels — Veilio Cloud had four of these and one was live in its checkout
 *    flow.
 *
 * 2. NO COLOUR LITERAL IN A `.tsx`. A literal in a component is a colour
 *    decided twice, and the second decision is invisible until somebody
 *    photographs it.
 *
 * `.css` is exempt: the palette has to be written down somewhere.
 *
 * Paths resolve from the vitest root.
 */

const SRC_DIR = 'src'
const TOKEN_SOURCE = 'src/global.css'

function walk(dir: string, ext: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path, ext))
    else if (entry.name.endsWith(ext)) out.push(path)
  }
  return out
}

/**
 * Token names DECLARED — in the palette, or on an element.
 *
 * The second kind is real and is not a palette entry: a per-element index set
 * inline and read back in a `calc()` is a custom property used as a parameter,
 * correctly scoped to the element rather than to `:root`.
 */
function declaredTokens(): Set<string> {
  const names = [
    ...readFileSync(TOKEN_SOURCE, 'utf8').matchAll(/(?:^|[;{])\s*(--[a-z0-9-]+)\s*:/gim),
  ].map((m) => m[1])
  for (const file of walk(SRC_DIR, '.tsx')) {
    const text = readFileSync(file, 'utf8')
    names.push(...[...text.matchAll(/['"](--[a-z0-9-]+)['"]\s*:/gi)].map((m) => m[1]))
  }
  return new Set(names)
}

function referencedTokens(text: string): string[] {
  return [...text.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1])
}

describe('design tokens', () => {
  it('every referenced token is actually declared', () => {
    const declared = declaredTokens()
    // Sanity: a parse that silently found nothing would make this vacuous.
    expect(declared.size).toBeGreaterThan(20)

    const missing: string[] = []
    for (const file of [...walk(SRC_DIR, '.tsx'), ...walk(SRC_DIR, '.css')]) {
      for (const token of referencedTokens(readFileSync(file, 'utf8'))) {
        if (!declared.has(token)) missing.push(`${file} → ${token}`)
      }
    }
    expect([...new Set(missing)].sort()).toEqual([])
  })

  it('no component paints its own colour', () => {
    const HEX = /#[0-9a-fA-F]{3,8}\b/g
    // `rgba(var(--accent-rgb), 0.35)` is allowed and the nesting is the point:
    // the COLOUR comes from the palette and only the alpha is local. Alpha is a
    // compositing decision that belongs at the call site — a glow is 35% of the
    // accent whatever the accent is — and keeping it there is what lets one
    // token change carry every glow with it.
    const BARE_FUNC = /\brgba?\(\s*(?!var\()/g

    const offenders: string[] = []
    for (const file of walk(SRC_DIR, '.tsx')) {
      // `&#123;` / `&#125;` are HTML entities for braces, not colours — the
      // demo code block is full of them.
      const text = readFileSync(file, 'utf8')
        .replace(/&#\d+;/g, '')
        // Prose about this rule quotes the very thing it forbids. Comments are
        // blanked rather than removed so reported positions stay true.
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/^\s*\/\/.*$/gm, '')
      const found = [...(text.match(HEX) ?? []), ...(text.match(BARE_FUNC) ?? [])]
      if (found.length) offenders.push(`${file}: ${found.join(' ')}`)
    }
    expect(offenders).toEqual([])
  })
})
