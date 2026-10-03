import { describe, expect, it } from 'vitest'
import { RECORDED } from '../../plugins/veilio-guard/tests/fixtures/recorded.ts'
import { deepRewrite, rewriteFields } from '../../plugins/veilio-guard/lib/fields.ts'

// A rewritten tool result must keep the tool's schema: Claude Code validates a
// hook's answer and refuses one whose enum fields changed ("Tool output
// validation error", seen live). So only listed fields are touched.
const recorded = RECORDED
const resultOf = (tool: string, n = 0) =>
  recorded.filter((o) => o.kind === 'tool.call' && o.data.e.tool === tool)[n].data.r.result

const UP = (s: string) => s.toUpperCase()

describe('rewriteFields', () => {
  it('changes only the listed field of a real Read result', () => {
    const read = resultOf('Read') as { type: string; file: Record<string, unknown> }
    const out = rewriteFields(read, ['file.content'], UP)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const v = out.value as typeof read
    expect(v.file.content).toBe((read.file.content as string).toUpperCase())
    expect(v.type).toBe('text')
    expect(v.file.filePath).toBe(read.file.filePath)
    expect(v.file.numLines).toBe(read.file.numLines)
  })

  it('does not change the input, which Claude Code hands over frozen', () => {
    const read = structuredClone(resultOf('Read')) as { file: { content: string } }
    const before = JSON.stringify(read)
    rewriteFields(read, ['file.content'], UP)
    expect(JSON.stringify(read)).toBe(before)
  })

  it('rewrites every string of an array field', () => {
    const glob = resultOf('Glob') as { filenames: string[] }
    const out = rewriteFields(glob, ['filenames[]'], UP)
    expect(out.ok && (out.value as typeof glob).filenames).toEqual(glob.filenames.map(UP))
  })

  it('rewrites a field of each object in an array, as in an Edit patch', () => {
    const edit = resultOf('Edit') as { structuredPatch: { lines: string[]; oldStart: number }[] }
    const out = rewriteFields(edit, ['structuredPatch[].lines[]'], UP)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const v = out.value as typeof edit
    expect(v.structuredPatch[0].lines).toEqual(edit.structuredPatch[0].lines.map(UP))
    expect(v.structuredPatch[0].oldStart).toBe(edit.structuredPatch[0].oldStart)
  })

  it('leaves an absent or null field alone', () => {
    const write = resultOf('Write') as { originalFile: unknown }
    expect(write.originalFile).toBeNull()
    const out = rewriteFields(write, ['originalFile', 'missing.deep'], UP)
    expect(out.ok && (out.value as typeof write).originalFile).toBeNull()
  })

  it('refuses a record whose listed field has another type, instead of passing it', () => {
    expect(rewriteFields({ file: { content: 42 } }, ['file.content'], UP).ok).toBe(false)
    expect(rewriteFields({ filenames: 'a.ts' }, ['filenames[]'], UP).ok).toBe(false)
    expect(rewriteFields({ filenames: [1] }, ['filenames[]'], UP).ok).toBe(false)
    expect(rewriteFields({ file: 'x' }, ['file.content'], UP).ok).toBe(false)
  })

  it('rewrites a root array path, as an MCP result is', () => {
    const out = rewriteFields([{ type: 'text', text: 'abc' }], ['[].text'], UP)
    expect(out.ok && out.value).toEqual([{ type: 'text', text: 'ABC' }])
  })
})

describe('deepRewrite', () => {
  it('rewrites every string, keys excluded, numbers and booleans kept', () => {
    expect(deepRewrite({ a: 'x', b: [1, 'y', { c: 'z', d: true }], e: null }, UP)).toEqual({
      a: 'X',
      b: [1, 'Y', { c: 'Z', d: true }],
      e: null,
    })
  })
})

describe('deepRewrite keep: top-level enums only', () => {
  it('keeps a top-level key and rewrites the same key deeper down', () => {
    const out = deepRewrite({ type: 'text', nested: { type: 'secret' } }, UP, new Set(['type']))
    expect(out).toEqual({ type: 'text', nested: { type: 'SECRET' } })
  })

  it('keeps the key in the blocks of a root list, as an MCP result has them', () => {
    const out = deepRewrite(
      [{ type: 'text', text: 'a', meta: { type: 'b' } }],
      UP,
      new Set(['type'])
    )
    expect(out).toEqual([{ type: 'text', text: 'A', meta: { type: 'B' } }])
  })
})
