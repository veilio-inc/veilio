// Read and replace the listed string fields of a tool's result record.
//
// Claude Code validates what a hook returns against the tool's output schema,
// so the guard must not touch an enum such as Read's `type: "text"`: only the
// fields that carry file text or output are rewritten (spec 033, data-model
// table B). A path is dot-separated; a segment ending in `[]` is an array whose
// every element continues the path, and a leading `[]` is a root array:
//
//   'file.content'               result.file.content
//   'filenames[]'                every string of result.filenames
//   'structuredPatch[].lines[]'  every line of every hunk
//   '[].text'                    the text of every block of an MCP result
//
// An absent or null field is left alone. A field that is present with another
// type than the path says makes the whole record refused: the guard withholds
// a result it cannot read rather than pass it on unscrubbed.

export type Rewrite = (text: string) => string
export type Rewritten = { ok: true; value: unknown } | { ok: false; reason: string }

class ShapeError extends Error {}

function walk(value: unknown, segments: readonly string[], fn: Rewrite, where: string): unknown {
  if (segments.length === 0) {
    if (typeof value !== 'string') throw new ShapeError(`${where} is not text`)
    return fn(value)
  }
  if (value === undefined || value === null) return value
  const [head = '', ...rest] = segments
  if (head === '[]') {
    if (!Array.isArray(value)) throw new ShapeError(`${where} is not a list`)
    return value.map((item, i) => walk(item, rest, fn, `${where}[${i}]`))
  }
  const isList = head.endsWith('[]')
  const key = isList ? head.slice(0, -2) : head
  if (typeof value !== 'object' || Array.isArray(value))
    throw new ShapeError(`${where} is not a record`)
  const record = value as Record<string, unknown>
  const field = record[key]
  if (field === undefined || field === null) return value
  const next = isList ? ['[]', ...rest] : rest
  return { ...record, [key]: walk(field, next, fn, where ? `${where}.${key}` : key) }
}

function split(path: string): string[] {
  if (path.startsWith('[]'))
    return ['[]', ...split(path.slice(2).replace(/^\./, ''))].filter(Boolean)
  return path.split('.').filter(Boolean)
}

export function rewriteFields(record: unknown, paths: readonly string[], fn: Rewrite): Rewritten {
  try {
    let value = record
    for (const path of paths) value = walk(value, split(path), fn, '')
    return { ok: true, value }
  } catch (e) {
    if (e instanceof ShapeError) return { ok: false, reason: e.message }
    throw e
  }
}

/** Every string in a value, at any depth, except under the keys in `keep`
 *  (a tool's enum fields, such as Read's `type`). Used for results of tools the
 *  guard has no field list for, and for the fields of a known tool's record
 *  that its list does not name: nothing escapes it, at the risk of Claude Code
 *  refusing a record whose enum it changed - an error, never a leak. */
export function deepRewrite(
  value: unknown,
  fn: Rewrite,
  keep: ReadonlySet<string> = NONE
): unknown {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map((v) => deepRewrite(v, fn, keep))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = keep.has(k) ? v : deepRewrite(v, fn, keep)
    return out
  }
  return value
}

const NONE: ReadonlySet<string> = new Set()
