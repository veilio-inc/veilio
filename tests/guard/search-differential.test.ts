import { afterAll, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Guard, type GuardIO } from '../../plugins/veilio-guard/lib/guard.ts'
import { bigResult, CORPUS, type CorpusCase } from './fixtures/search-corpus.ts'

// Spec 074 FR-009, research R7: pass 1 is main's masking, so pass 2 off is
// main. Over the whole corpus, pass 2 on may only add: every redaction of the
// off run is still made, a result with nothing on disk to resolve is byte for
// byte the same, nothing is withheld that was sent, and what it hides beyond
// the off run is listed in the snapshot for review (values under a key that
// names a credential). The one-off check that pass 2 off equals real CE main
// is in evidence.md (T018).
const io: GuardIO = {
  read: async (p) => readFileSync(p, 'utf8'),
  write: async (p, t) => {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, t)
  },
  exists: async (p) => existsSync(p),
  realPath: async (p) => {
    try {
      return realpathSync(p)
    } catch {
      return undefined
    }
  },
  isFile: async (p) => {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  },
}

const base = realpathSync(mkdtempSync(join(tmpdir(), 'veilio-074-')))
afterAll(() => rmSync(base, { recursive: true, force: true }))
let made = 0

/** A plain-named project root holding the case's files: the same root for
 *  the off and the on run, so its path is masked the same way in both. */
function setUp(c: CorpusCase): string {
  const root = join(base, `project${++made}`)
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const [path, text] of Object.entries(c.files ?? {})) {
    const full = join(root, path.split('${ROOT}').join(root))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
  return root
}

type Seen = {
  text: string | null
  deny?: string
  later?: string | null
  ms: number
  map: Record<string, string>
}
async function run(c: CorpusCase, root: string, pass2: boolean): Promise<Seen> {
  rmSync(join(root, '.veilio'), { recursive: true, force: true })
  const g = new Guard(io, { rawOnly: [], mcpRestore: [] })
  await g.load(root)
  g.searchPass2 = pass2
  const sub = (v: string) => v.split('${ROOT}').join(root)
  const content = sub(c.content)
  const args = JSON.parse(sub(JSON.stringify({ tool: c.tool, ...c.args })))
  const result =
    c.tool === 'Grep'
      ? {
          mode: 'content',
          numFiles: 1,
          filenames: [],
          content,
          numLines: content.split('\n').length,
        }
      : { stdout: content, stderr: '', interrupted: false, isImage: false }
  const t = performance.now()
  const out = (await g.afterTool(c.tool, args, { result }, Date.now() + 60_000)) as {
    deny?: string
    result?: { content?: string; stdout?: string }
  }
  const ms = performance.now() - t
  // The fail-closed path (a run that cannot be written back line by line) never fires.
  expect(g.searchUnsplit).toBe(0)
  const text = out.result
    ? ((c.tool === 'Grep' ? out.result.content : out.result.stdout) ?? null)
    : null
  let later: string | null | undefined
  if (c.later !== undefined) {
    const two = (await g.afterTool(
      'Bash',
      { tool: 'Bash', command: 'echo' },
      { result: { stdout: c.later, stderr: '', interrupted: false, isImage: false } }
    )) as { result?: { stdout?: string } }
    later = two.result?.stdout ?? null
  }
  return { text, deny: out.deny, later, ms, map: { ...g.map } }
}

const TOKEN = /(__REDACTED_[A-Z0-9_]+?__)/
const PLACEHOLDER = /__[A-Z]+__\d+/g
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** What `on` hides that `off` showed, line by line, read back through the
 *  off run's map; null when `on` shows anything `off` did not (a redaction
 *  lost, a line changed otherwise). A placeholder matches any of its kind:
 *  numbering moves when pass 2 takes a value main minted a name for. */
function extras(off: string, on: string, map: Record<string, string>): string[] | null {
  const a = off.split('\n')
  const b = on.split('\n')
  if (a.length !== b.length) return null
  const found: string[] = []
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    const parts = b[i]!.split(TOKEN)
    const literal = (p: string) =>
      escape(p).replace(/__([A-Z]+)__\d+/g, (_, kind: string) => `__${kind}__\\d+`)
    const re = new RegExp(`^${parts.map((p, j) => (j % 2 ? '(.*?)' : literal(p))).join('')}$`, 's')
    const m = re.exec(a[i]!)
    if (!m) return null
    // A group that held a token of the off run is a redaction both made.
    for (const g of m.slice(1))
      if (g !== '' && !TOKEN.test(g)) found.push(g.replace(PLACEHOLDER, (p) => map[p] ?? p))
  }
  return found
}

const report: { cases: number; identical: number; extra: Record<string, string[]> } = {
  cases: 0,
  identical: 0,
  extra: {},
}

describe('search output: pass 2 only adds to main (spec 074 FR-009)', () => {
  it.each(CORPUS.map((c) => [c.name, c] as const))('%s', async (name, c) => {
    const root = setUp(c)
    const off = await run(c, root, false)
    const on = await run(c, root, true)
    report.cases++
    // Never withheld where main sends it.
    if (off.deny === undefined) expect(on.deny).toBeUndefined()
    else expect(on.deny).toBe(off.deny)
    if (off.text === null) return
    expect(on.text).not.toBeNull()
    // Nothing to resolve on disk: byte for byte main's.
    if (Object.keys(c.files ?? {}).length === 0) {
      expect(on.text).toBe(off.text)
      expect(on.later).toBe(off.later)
    }
    const more = extras(off.text, on.text!, off.map)
    if (more === null || process.env.SHOW_074)
      console.warn(JSON.stringify({ name, off: off.text, on: on.text }))
    expect(more, `${name}: the on run shows what the off run hid`).not.toBeNull()
    const later =
      off.later != null && on.later != null
        ? extras(off.later, on.later, off.map)
        : ([] as string[])
    if (later === null)
      console.warn(JSON.stringify({ name, offLater: off.later, onLater: on.later }))
    expect(later, `${name}: the later result shows what the off run hid`).not.toBeNull()
    if (on.text === off.text && on.later === off.later) report.identical++
    const all = [...more!, ...later!.map((v) => `later: ${v}`)]
    if (all.length) report.extra[name] = all
  })

  it('what pass 2 hides beyond main is the reviewed list', () => {
    expect(report.cases).toBe(CORPUS.length)
    console.warn(
      `corpus ${report.cases}, byte-identical ${report.identical}, with extra redactions ${Object.keys(report.extra).length}`
    )
    expect(report.extra).toMatchSnapshot()
  })

  for (const tool of ['Grep', 'Bash'] as const)
    it(`a 1 MB result (${tool}) is masked within twice main's time`, async () => {
      const c = bigResult(tool)
      const root = setUp(c)
      await run(c, root, false) // warm
      const off = await run(c, root, false)
      const on = await run(c, root, true)
      console.warn(`1 MB ${tool}: off ${off.ms.toFixed(0)} ms, on ${on.ms.toFixed(0)} ms`)
      expect(on.deny).toBe(off.deny)
      expect(on.ms).toBeLessThan(off.ms * 2 + 100)
    }, 120_000)
})
