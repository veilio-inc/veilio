import { describe, it, expect } from 'vitest'
import { TOOLS } from '../src/tools.js'
import { CLOUD_TOOLS } from '../src/cloud-tools.js'
import { contextFromArgv } from '../src/index.js'
import {
  fencedBlocks,
  inlineCode,
  publicDocs,
  readDoc,
} from '../../engine/tests/fixtures/public-docs.js'

/**
 * The MCP tools, tool arguments and server flags the public docs name, against
 * the server's own definitions.
 *
 * An agent is told about tools by `tools/list`, but a person is told by the
 * READMEs and the guide, and writes the name into a CLAUDE.md or a rules file.
 * A tool renamed in code and not in the docs fails there, at the moment the
 * reader trusted the doc.
 */
const ALL = [...TOOLS, ...CLOUD_TOOLS]
const NAMES = new Set(ALL.map((t) => t.name))
const ARGS = new Map(
  ALL.map((t) => [t.name, new Set(Object.keys(t.inputSchema.properties ?? {}))] as const)
)

/** A tool name has the shape `verb_noun`: lowercase words joined by
 *  underscores, with no digit. Placeholders (`__fn__1`), environment names
 *  (`VEILIO_PROJECT`) and real identifiers in examples (`tmp_fn_1`) never
 *  match it. */
const TOOL_SHAPE = /^[a-z]+(?:_[a-z]+)+$/

/** Snake-case words in docs that are not tool names. Each one is here for a
 *  stated reason, so the list cannot quietly grow into a way around the
 *  test. */
const NOT_TOOLS = new Set([
  // Example identifiers in plugins/veilio-guard/COVERAGE.md: names the guard
  // masks, quoted to show their shape.
  'snake_case_identifier_name',
  'team_layers',
])

describe('MCP tools named in the public docs', () => {
  const named = publicDocs().flatMap((doc) =>
    inlineCode(readDoc(doc))
      .filter((t) => TOOL_SHAPE.test(t) && !NOT_TOOLS.has(t))
      .map((name) => ({ doc, name }))
  )

  it('documents every tool the server defines', () => {
    // Also the guard on the extraction: if it found nothing, this fails.
    const documented = new Set(named.map((n) => n.name))
    const undocumented = [...NAMES].filter((n) => !documented.has(n))
    expect(undocumented, `no public doc names these tools: ${undocumented.join(', ')}`).toEqual([])
  })

  it('names only tools the server defines', () => {
    const unknown = named.filter((n) => !NAMES.has(n.name)).map((n) => `${n.doc}: ${n.name}`)
    expect(unknown, `the docs name tools the server does not have:\n${unknown.join('\n')}`).toEqual(
      []
    )
  })

  it('names, in a tools/call example, only tools and arguments that exist', () => {
    const wrong: string[] = []
    let calls = 0
    for (const doc of publicDocs()) {
      for (const block of fencedBlocks(readDoc(doc))) {
        for (const m of block.code.matchAll(/tools\/call (\w+) (\{[^\n]*\})/g)) {
          calls++
          const [, tool, json] = m
          if (!NAMES.has(tool)) {
            wrong.push(`${doc}: no tool ${tool}`)
            continue
          }
          for (const key of Object.keys(JSON.parse(json) as object))
            if (!ARGS.get(tool)?.has(key)) wrong.push(`${doc}: ${tool} has no argument "${key}"`)
        }
      }
    }
    expect(calls).toBeGreaterThan(1)
    expect(wrong).toEqual([])
  })

  it('names, in the MCP README tool tables, only arguments the tool takes', () => {
    // The tables say `force: true`, `strict: true`, `confirmName`. A row's
    // arguments are the backticked camelCase words in it, or a word followed
    // by `:`, checked against that tool's input schema.
    const wrong: string[] = []
    let rows = 0
    for (const line of readDoc('packages/mcp/README.md').split('\n')) {
      const row = /^\| `([a-z_]+)` +\|(.*)\|\s*$/.exec(line)
      if (!row || !NAMES.has(row[1])) continue
      rows++
      const args = ARGS.get(row[1]) ?? new Set()
      for (const m of row[2].matchAll(/`([a-z][A-Za-z]*)(?::[^`]*)?`/g)) {
        const word = m[1]
        const looksLikeArg = m[0].includes(':') || /[A-Z]/.test(word)
        if (looksLikeArg && !args.has(word)) wrong.push(`${row[1]} has no argument "${word}"`)
      }
    }
    expect(rows).toBe(NAMES.size)
    expect(wrong).toEqual([])
  })
})

describe('MCP server flags named in the public docs', () => {
  /** Flags written after the package or binary name, up to the end of the
   *  command (a closing bracket, quote or line end). */
  function documentedFlags(): { doc: string; flag: string }[] {
    const found: { doc: string; flag: string }[] = []
    for (const doc of publicDocs()) {
      const text = readDoc(doc)
      const code = [...fencedBlocks(text).map((b) => b.code), ...inlineCode(text)].join('\n')
      for (const m of code.matchAll(
        /(?:@veilio-inc\/mcp(?:@\w+)?|veilio-mcp|mcp\/dist\/index\.js)"?,?([^\n\]]*)/g
      )) {
        for (const f of m[1].matchAll(/(?<![\w-])"?(--?[a-z][\w-]*)/g))
          found.push({ doc, flag: f[1] })
      }
    }
    return found
  }

  it('finds the flags it is checking', () => {
    expect(documentedFlags().map((f) => f.flag)).toEqual(expect.arrayContaining(['--root']))
  })

  it('names only flags the server parses', () => {
    // A flag the server parses changes the context it builds from argv. One it
    // does not know is ignored silently, which is the failure a doc would
    // hide: `--root` misspelled serves the whole working directory.
    const base = JSON.stringify(contextFromArgv([], {}))
    const ignored = documentedFlags().filter(
      ({ flag }) => JSON.stringify(contextFromArgv([flag, '/tmp/docs-check'], {})) === base
    )
    expect(ignored.map((f) => `${f.doc}: ${f.flag}`)).toEqual([])
  })
})
