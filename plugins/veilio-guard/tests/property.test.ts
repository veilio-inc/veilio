// The masking property through every entry point of the guard (review of
// da4ff84): whatever mix of credentials, regulated numbers, map placeholders
// and ordinary names a text holds, no value the scanner flags on the raw text
// reaches the model, and ordinary names and the map's placeholders reach it
// unchanged. Seeded random texts (fixtures/generate.ts), 1,200 cases.
import { expect, test } from 'claude-code/testing'
import { scanSecrets, SECRET_DISPOSITIONS } from '../vendor/engine/index.js'
import { generate } from './fixtures/generate.ts'
import { highSignal } from '../lib/scrub.ts'
import { eventOf, mapFile, project, recorded, recordedPrompt, ROOT } from './helpers.ts'

const HEURISTIC = new Set([
  'password-assignment',
  'high-entropy-string',
  'connection-string',
  'basic-auth',
  'bearer-token',
  'possible-credential',
])

// As tests/guard/property.test.ts: a provider-format or high-signal value must
// be gone everywhere; a low-entropy one where its rule found it (research R4).
function flagged(text: string): string[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return scanSecrets(text, 'warn')
    .findings.filter((f: any) => SECRET_DISPOSITIONS[f.type] !== 'report')
    .map((f: any) => {
      const start = (starts[f.line - 1] ?? 0) + f.column - 1
      const v = text.slice(start, start + f.length)
      return !HEURISTIC.has(f.type) || highSignal(v)
        ? v
        : text.slice(Math.max(0, start - 10), start + f.length)
    })
}

function check(seed: number, raw: string, sent: string, names: string[], kept: string[]): string[] {
  const out: string[] = []
  for (const v of flagged(raw)) if (sent.includes(v)) out.push(`seed ${seed}: ${v} survived`)
  for (const n of [...names, ...kept]) if (!sent.includes(n)) out.push(`seed ${seed}: ${n} lost`)
  return out
}

const ENTRY = ['prompt', 'attachment', 'context', 'bash', 'grep', 'read', 'restore'] as const

function property(entry: (typeof ENTRY)[number]) {
  return async ($: any, on: any) => {
    const bash = recorded('Bash')
    const grep = recorded('Grep')
    const read = recorded('Read')
    const edit = recorded('Edit')
    const failures: string[] = []
    // One project for all cases: the union of their maps.
    const cases = Array.from({ length: 175 }, (_, i) =>
      generate(i + 1 + 1000 * ENTRY.indexOf(entry))
    )
    const map: Record<string, string> = {}
    for (const c of cases) Object.assign(map, c.map)
    project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(map) })
    let next: (e: any) => any = () => ({})
    on('tool.call', (_: any, e: any) => next(e))
    const sent: any[] = []
    on('prompt.submit', (_: any, e: any) => {
      sent.push(e)
      return { text: e.text }
    })
    on('prompt.attachment', (_: any, e: any) => ({ text: e.text }))
    let block = ''
    on('prompt.context', () => ({ blocks: [{ name: 'claudeMd', text: block }] }))
    for (const [k, c] of cases.entries()) {
      const seed = k + 1 + 1000 * ENTRY.indexOf(entry)
      let out = ''
      if (entry === 'prompt') {
        const r: any = await $.prompt.submit({ ...recordedPrompt('prompt.submit').e, text: c.text })
        out = r?.drop ? '' : (sent[sent.length - 1]?.text ?? '')
        if (r?.drop) failures.push(`seed ${seed}: prompt dropped`)
      } else if (entry === 'attachment') {
        out = ((await $.prompt.attachment({ type: 'edited_text_file', text: c.text })) as any).text
      } else if (entry === 'context') {
        block = c.text
        const r: any = await $.prompt.context(recordedPrompt('prompt.context').e)
        out = r.blocks[0]?.text ?? ''
      } else if (entry === 'bash') {
        next = () => ({ ...bash.r, result: { ...bash.r.result, stdout: c.text } })
        const r: any = await $.tool.call(eventOf(bash))
        out = JSON.stringify(r)
      } else if (entry === 'grep') {
        const content = c.text
          .split('\n')
          .map((line, i) => `${ROOT}/notes.md:${i + 1}:${line}`)
          .join('\n')
        next = () => ({ ...grep.r, result: { ...grep.r.result, content } })
        const r: any = await $.tool.call(eventOf(grep))
        out = JSON.stringify(r)
      } else if (entry === 'read') {
        next = () => ({
          ...read.r,
          result: {
            ...read.r.result,
            file: { ...read.r.result.file, filePath: `${ROOT}/notes.md`, content: c.text },
          },
        })
        const r: any = await $.tool.call({ ...eventOf(read), file_path: `${ROOT}/notes.md` })
        out = JSON.stringify(r)
      } else {
        // What the model writes back with the placeholders it was shown:
        // each comes back as its name, and nothing else changes.
        const seen: any[] = []
        next = (e: any) => (seen.push(e), edit.r)
        const shown = c.placeholders.map((p) => `${p} ok`).join('\n') || 'x'
        await $.tool.call({ ...eventOf(edit), old_string: 'x', new_string: shown })
        const got = String(seen[0]?.new_string ?? '')
        for (const p of c.placeholders)
          if (!got.includes(map[p]!)) failures.push(`seed ${seed}: ${p} not restored`)
        continue
      }
      // Names and placeholders reach the model unchanged (a placeholder stays,
      // as it is no name of its own), and nothing the scanner flags does.
      failures.push(...check(seed, c.text, out, c.names, c.placeholders))
      if (failures.length > 5) break
    }
    expect(failures).toEqual([])
  }
}

test('the masking property holds through prompt, over random texts', property('prompt'))

test('the masking property holds through attachment, over random texts', property('attachment'))

test('the masking property holds through context, over random texts', property('context'))

test('the masking property holds through bash, over random texts', property('bash'))

test('the masking property holds through grep, over random texts', property('grep'))

test('the masking property holds through read, over random texts', property('read'))

test('the masking property holds through restore, over random texts', property('restore'))
