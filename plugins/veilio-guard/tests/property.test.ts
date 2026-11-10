// The masking property through every entry point of the guard (reviews of
// da4ff84 and 0ef312b): whatever mix of credentials, regulated numbers, map
// placeholders and ordinary names a text holds, every value the engine
// destroys or masks is gone where it was found, one the guard carries forward
// is gone everywhere (fixtures/oracle.ts, from the engine's own verdicts),
// and ordinary names and the map's placeholders reach the model unchanged.
// Seeded random texts (fixtures/generate.ts), 175 per entry point.
import { expect, test } from 'claude-code/testing'
import { generate } from './fixtures/generate.ts'
import { leaks } from './fixtures/oracle.ts'
import { eventOf, mapFile, project, recorded, recordedPrompt, ROOT } from './helpers.ts'
import type { ToolEvent } from '../lib/guard.ts'
import type { Fields } from './fixtures/recorded.ts'
import type { TestHost, TestOn } from './kit.ts'

function check(seed: number, raw: string, sent: string, names: string[], kept: string[]): string[] {
  const out: string[] = leaks(raw, sent).map((l) => `seed ${seed}: ${l}`)
  for (const n of [...names, ...kept]) if (!sent.includes(n)) out.push(`seed ${seed}: ${n} lost`)
  return out
}

// Many cases each: a slow runner (CI, a loaded machine) gets the time it needs.
const SLOW = { timeoutMs: 60_000 }

const ENTRY = [
  'prompt',
  'attachment',
  'context',
  'bash',
  'grep',
  'read',
  'restore',
  'listing',
] as const

// Guard decision 1: a built-in skill's entry goes as written, beside a
// project skill whose description is the random text.
const PUBLIC = '- init: Initialize a new CLAUDE.md file with codebase documentation'

function property(entry: (typeof ENTRY)[number]) {
  return async ($: TestHost, on: TestOn) => {
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
    project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(map) }, { ownEnv: true })
    let next: (e: ToolEvent) => Fields = () => ({})
    on('tool.call', (_, e) => next(e))
    const sent: Fields[] = []
    on('prompt.submit', (_, e) => {
      sent.push(e)
      return { text: e.text }
    })
    on('prompt.attachment', (_, e) => ({ text: e.text }))
    on('command.list', () => ({
      value: [
        {
          name: 'init',
          description: 'Initialize a new CLAUDE.md file with codebase documentation',
          source: 'builtin',
        },
        { name: 'own', description: 'random', source: 'user' },
      ],
    }))
    // HOME as the helper's: its map is recorded there (spec 085 R2-3).
    on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
    let block = ''
    on('prompt.context', () => ({ blocks: [{ name: 'claudeMd', text: block }] }))
    for (const [k, c] of cases.entries()) {
      const seed = k + 1 + 1000 * ENTRY.indexOf(entry)
      let out: string
      if (entry === 'prompt') {
        const r = await $.prompt.submit({ ...recordedPrompt('prompt.submit').e, text: c.text })
        out = r?.drop ? '' : String(sent[sent.length - 1]?.text ?? '')
        if (r?.drop) failures.push(`seed ${seed}: prompt dropped`)
      } else if (entry === 'attachment') {
        out =
          (
            await $.prompt.attachment({
              type: 'edited_text_file',
              text: c.text,
              origin: { kind: 'engine' },
            })
          ).text ?? ''
      } else if (entry === 'listing') {
        const text = `The following skills are available:\n\n${PUBLIC}\n- own: ${c.text}`
        out =
          (await $.prompt.attachment({ type: 'skill_listing', text, origin: { kind: 'engine' } }))
            .text ?? ''
        if (!out.includes(`${PUBLIC}\n`)) failures.push(`seed ${seed}: public entry masked`)
      } else if (entry === 'context') {
        block = c.text
        const r = await $.prompt.context(recordedPrompt('prompt.context').e)
        out = r.blocks[0]?.text ?? ''
      } else if (entry === 'bash') {
        next = () => ({ ...bash.r, result: { ...bash.r.result, stdout: c.text } })
        const r = await $.tool.call(eventOf(bash))
        out = JSON.stringify(r)
      } else if (entry === 'grep') {
        const content = c.text
          .split('\n')
          .map((line, i) => `${ROOT}/notes.md:${i + 1}:${line}`)
          .join('\n')
        next = () => ({ ...grep.r, result: { ...grep.r.result, content } })
        const r = await $.tool.call(eventOf(grep))
        out = JSON.stringify(r)
      } else if (entry === 'read') {
        next = () => ({
          ...read.r,
          result: {
            ...read.r.result,
            file: { ...read.r.result.file, filePath: `${ROOT}/notes.md`, content: c.text },
          },
        })
        const r = await $.tool.call({ ...eventOf(read), file_path: `${ROOT}/notes.md` })
        out = JSON.stringify(r)
      } else {
        // What the model writes back with the placeholders it was shown:
        // each comes back as its name, and nothing else changes.
        const seen: Fields[] = []
        next = (e) => (seen.push(e), edit.r)
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

test('the masking property holds through prompt, over random texts', SLOW, property('prompt'))

test(
  'the masking property holds through attachment, over random texts',
  SLOW,
  property('attachment')
)

test('the masking property holds through context, over random texts', SLOW, property('context'))

test('the masking property holds through bash, over random texts', SLOW, property('bash'))

test('the masking property holds through grep, over random texts', SLOW, property('grep'))

test('the masking property holds through read, over random texts', SLOW, property('read'))

test('the masking property holds through restore, over random texts', SLOW, property('restore'))

test('the masking property holds through listing, over random texts', SLOW, property('listing'))

// Spec 078 R3: random fake keys, removed by a Read, re-emitted through Bash
// spaced, sliced, reversed, base64 or dash-grouped: no 16 characters of one
// reach the model in any of those forms.
test(
  'removed credentials re-emitted reshaped through Bash never reach the model',
  SLOW,
  async ($, on) => {
    const read = recorded('Read')
    const bash = recorded('Bash')
    project(on, {}, { ownEnv: true })
    let seed = 78
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    const alnum = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
    let next: Fields = {}
    on('tool.call', () => next)
    const failures: string[] = []
    for (let k = 0; k < 40; k++) {
      const body = Array.from({ length: 32 }, () => alnum[Math.floor(rand() * alnum.length)]).join(
        ''
      )
      const key = 'sk_live_' + body
      next = {
        ...read.r,
        result: {
          ...read.r.result,
          file: {
            ...read.r.result.file,
            filePath: `${ROOT}/src/k${k}.ts`,
            content: `const k = '${key}'\n`,
          },
        },
      }
      await $.tool.call({ ...eventOf(read), file_path: `${ROOT}/src/k${k}.ts` })
      const at = Math.floor(rand() * 16)
      const slice = body.slice(at, at + 16 + Math.floor(rand() * (16 - at)))
      const forms = [
        [...key].join(' '),
        slice,
        [...key].reverse().join(''),
        btoa(key),
        body.match(/.{1,4}/g)!.join('-'),
      ]
      const form = forms[k % forms.length]!
      next = { ...bash.r, result: { ...bash.r.result, stdout: `out: ${form}\n`, stderr: '' } }
      const out = JSON.stringify(await $.tool.call(eventOf(bash)))
      const compact = out.replace(/[^A-Za-z0-9]/g, '').toLowerCase()
      const c = body.toLowerCase()
      for (let i = 0; i + 16 <= c.length; i++)
        if (compact.includes(c.slice(i, i + 16)) || out.includes(btoa(key).slice(0, 20)))
          failures.push(`case ${k} (${k % forms.length}): reached the model`)
    }
    expect([...new Set(failures)]).toEqual([])
  }
)

// Spec 085 L16: random map names used as an MCP result's keys never come back.
test(
  'map names as the keys of an MCP result never reach the model, over random cases',
  SLOW,
  async ($, on) => {
    const cases = Array.from({ length: 60 }, (_, i) => generate(i + 8501))
    const map: Record<string, string> = {}
    for (const c of cases) Object.assign(map, c.map)
    project(on, { [`${ROOT}/.veilio/map.json`]: mapFile(map) }, { ownEnv: true })
    let next: Fields = {}
    on('tool.call', () => next)
    const failures: string[] = []
    for (const [k, c] of cases.entries()) {
      const names = Object.values(c.map)
      next = {
        result: {
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: { rows: Object.fromEntries(names.map((n, i) => [n, i])) },
        },
      }
      const got = await $.tool.call({ tool: 'mcp__notes__rows', q: 'x' })
      if (got.deny !== undefined) failures.push(`case ${k}: withheld (${got.deny})`)
      const out = JSON.stringify(got)
      for (const n of names) if (out.includes(`"${n}"`)) failures.push(`case ${k}: ${n} came back`)
    }
    expect(failures).toEqual([])
  }
)
