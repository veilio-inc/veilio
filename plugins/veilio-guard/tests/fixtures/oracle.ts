// What the masking property expects, from the engine's own verdict on each
// finding (review of 0ef312b): a value it destroys or masks must not reach
// the model where it was found, and one the guard carries forward must not
// reach it anywhere; a value it only reports (too plain to tell from a
// dummy) may. Shared by the lib and the hook property tests.
import { carriedForward } from '../../lib/scrub.ts'
import { scanSecrets } from '../../vendor/engine/index.js'

function count(text: string, v: string): number {
  let n = 0
  for (let i = text.indexOf(v); i !== -1; i = text.indexOf(v, i + 1)) n++
  return n
}

/** The problems with `sent` as the masking of `raw`, if any. */
export function leaks(raw: string, sent: string): string[] {
  const starts = [0]
  for (let i = 0; i < raw.length; i++) if (raw[i] === '\n') starts.push(i + 1)
  const out: string[] = []
  const acted = new Map<string, { type: string; n: number }>()
  for (const f of scanSecrets(raw, 'redact').findings) {
    if (f.disposition === 'report') continue
    const start = (starts[f.line - 1] ?? 0) + f.column - 1
    const v = raw.slice(start, start + f.length)
    const prev = acted.get(v)
    acted.set(v, { type: prev?.type ?? f.type, n: (prev?.n ?? 0) + 1 })
  }
  for (const [v, { type, n }] of acted) {
    const left = count(sent, v)
    if (carriedForward(type, v) ? left > 0 : left > count(raw, v) - n)
      out.push(`${JSON.stringify(v)} survived (${type})`)
  }
  return out
}
