import { describe, expect, it } from 'vitest'
import { RECORDED } from '../../plugins/veilio-guard/tests/fixtures/recorded.ts'
import { argumentPolicy, resultPolicy } from '../../plugins/veilio-guard/lib/policy.ts'

// Spec 033 data-model tables A and B, as data. What a tool's arguments get
// before it runs, and which fields of its result the model reads.
const recorded = RECORDED
const callOf = (tool: string, n = 0) =>
  recorded.filter((o) => o.kind === 'tool.call' && o.data.e.tool === tool)[n].data

describe('argumentPolicy (table A)', () => {
  it('edits are restored strictly, in every field that lands in the file', () => {
    expect(argumentPolicy('Edit', [])).toEqual({
      mode: 'strict',
      restore: ['file_path', 'old_string', 'new_string'],
      paths: ['file_path'],
    })
    expect(argumentPolicy('Write', []).restore).toEqual(['file_path', 'content'])
    expect(argumentPolicy('MultiEdit', []).restore).toEqual([
      'file_path',
      'edits[].old_string',
      'edits[].new_string',
    ])
    expect(argumentPolicy('NotebookEdit', []).mode).toBe('strict')
    expect(argumentPolicy('Read', []).mode).toBe('strict')
  })

  it('searches and commands are restored leniently, so a literal placeholder search still runs', () => {
    expect(argumentPolicy('Bash', [])).toEqual({
      mode: 'lenient',
      restore: ['command'],
      paths: [],
      command: 'command',
    })
    expect(argumentPolicy('Grep', []).restore).toEqual(['pattern', 'path', 'glob'])
    expect(argumentPolicy('Glob', []).mode).toBe('lenient')
  })

  it('never restores into a web request', () => {
    expect(argumentPolicy('WebFetch', []).restore).toEqual([])
    expect(argumentPolicy('WebSearch', []).restore).toEqual([])
  })

  it('restores an MCP tool only for a server the project names', () => {
    expect(argumentPolicy('mcp__github__create_issue', []).restore).toEqual([])
    expect(argumentPolicy('mcp__local_db__query', ['local_db'])).toEqual({
      mode: 'lenient',
      restore: ['*'],
      paths: [],
    })
    expect(argumentPolicy('mcp__local_db_extra__query', ['local_db']).restore).toEqual([])
  })

  it('restores nothing for a tool it does not know, and nothing for a subagent prompt', () => {
    expect(argumentPolicy('SomeNewTool', []).restore).toEqual([])
    expect(argumentPolicy('Agent', []).restore).toEqual([])
    expect(argumentPolicy('Task', []).restore).toEqual([])
  })
})

describe('resultPolicy (table B), on recorded results', () => {
  it('a source Read grows the map; its path is applied', () => {
    const { e, r } = callOf('Read')
    expect(resultPolicy('Read', r.result, String(e.file_path))).toEqual({
      kind: 'fields',
      fields: [
        { path: 'file.content', mode: 'source' },
        { path: 'file.filePath', mode: 'apply' },
      ],
      keep: ['type'],
    })
  })

  it('a Read of prose or config only applies the map', () => {
    const { r } = callOf('Read')
    const p = resultPolicy('Read', r.result, '/work/project/notes.md')
    expect(p.kind === 'fields' && p.fields[0]).toEqual({ path: 'file.content', mode: 'apply' })
  })

  it('a Read of an image or a PDF is withheld: it is not scrubbed yet', () => {
    expect(resultPolicy('Read', { type: 'image', file: {} }, '/a.png').kind).toBe('withhold')
    expect(resultPolicy('Read', { type: 'pdf', file: {} }, '/a.pdf').kind).toBe('withhold')
  })

  it('search and shell output only apply the map', () => {
    for (const tool of ['Grep', 'Glob', 'Bash']) {
      const p = resultPolicy(tool, callOf(tool).r.result, '')
      expect(p.kind).toBe('fields')
      if (p.kind === 'fields') expect(p.fields.every((f) => f.mode === 'apply')).toBe(true)
    }
    const bash = resultPolicy('Bash', callOf('Bash').r.result, '')
    expect(bash.kind === 'fields' && bash.fields.map((f) => f.path)).toEqual(['stdout', 'stderr'])
  })

  it('edit and write records apply the map to every field that holds file text', () => {
    const edit = resultPolicy('Edit', callOf('Edit').r.result, '')
    expect(edit.kind === 'fields' && edit.fields.map((f) => f.path)).toEqual([
      'filePath',
      'oldString',
      'newString',
      'originalFile',
      'structuredPatch[].lines[]',
    ])
    const write = resultPolicy('Write', callOf('Write').r.result, '')
    expect(write.kind === 'fields' && write.fields.map((f) => f.path)).toEqual([
      'filePath',
      'content',
      'originalFile',
      'structuredPatch[].lines[]',
    ])
  })

  it('an error result, which is a string, is applied as text', () => {
    expect(resultPolicy('Edit', callOf('Edit', 1).r.result, '')).toEqual({ kind: 'text' })
    expect(resultPolicy('Bash', callOf('Bash', 1).r.result, '')).toEqual({ kind: 'text' })
  })

  it('an MCP result rewrites its text blocks and withholds anything else', () => {
    const mcp = callOf('mcp__veilio__anonymize_text').r.result
    expect(resultPolicy('mcp__veilio__anonymize_text', mcp, '')).toEqual({
      kind: 'fields',
      fields: [{ path: '[].text', mode: 'apply' }],
      keep: ['type'],
    })
    expect(
      resultPolicy('mcp__x__y', [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }], '').kind
    ).toBe('withhold')
  })

  it('every other tool has every string rewritten, so nothing new is left open', () => {
    expect(resultPolicy('Agent', callOf('Agent').r.result, '')).toEqual({ kind: 'deep' })
    expect(resultPolicy('ToolSearch', callOf('ToolSearch').r.result, '')).toEqual({ kind: 'deep' })
    expect(resultPolicy('SomeNewTool', { anything: 'x' }, '')).toEqual({ kind: 'deep' })
  })
})
