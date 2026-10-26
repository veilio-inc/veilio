import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The public docs, as one list that the engine, CLI and MCP contract tests all
 * read. A doc can promise something in any of these files, and npm or GitHub
 * shows each of them to a reader.
 *
 * The CHANGELOGs are left out on purpose. A past entry describes past
 * behaviour, and it is never rewritten.
 */
export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..')

const FIXED_DOCS = [
  'README.md',
  'ROADMAP.md',
  'packages/engine/README.md',
  'packages/cli/README.md',
  'packages/mcp/README.md',
  'plugins/veilio-guard/README.md',
  'plugins/veilio-guard/COVERAGE.md',
]

function markdownIn(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, dir))
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => `${dir}/${f}`)
}

/** Every public doc, by path relative to the repository root. Pending
 *  changesets count: each one becomes a changelog entry at the next release
 *  and describes the code as it is now. */
export function publicDocs(): string[] {
  return [...FIXED_DOCS, ...markdownIn('docs'), ...markdownIn('.changeset')]
}

export function readDoc(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8')
}

export interface FencedBlock {
  lang: string
  code: string
  /** 1-based line of the opening fence, for the failure message. */
  line: number
}

/** The fenced code blocks of a markdown text, optionally only those in the
 *  given languages. */
export function fencedBlocks(text: string, langs?: readonly string[]): FencedBlock[] {
  const blocks: FencedBlock[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*```(\w*)/.exec(lines[i])
    if (!open) continue
    const body: string[] = []
    let j = i + 1
    while (j < lines.length && !/^\s*```\s*$/.test(lines[j])) body.push(lines[j++])
    if (!langs || langs.includes(open[1])) {
      blocks.push({ lang: open[1], code: body.join('\n'), line: i + 1 })
    }
    i = j
  }
  return blocks
}

/** Every token written in single backticks outside fenced blocks. */
export function inlineCode(text: string): string[] {
  const prose = text.replace(/^\s*```[\s\S]*?^\s*```\s*$/gm, '')
  return [...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
}
