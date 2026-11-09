// Spec 086 T005/T006: the fixture project of contracts/cd-verdicts.md, in
// memory and at fixed paths (root /p, HOME /home/dev) so the base verdicts
// are the same on every machine, and the replay that both the base script
// (scripts/cd-differential.mts) and the differential test run.
import { Guard, type GuardIO } from '../../../plugins/veilio-guard/lib/guard.ts'
import { restoreRefusal, shellWords, splitChain } from '../../../plugins/veilio-guard/lib/shell.ts'
import type { CorpusEntry } from './cd-corpus.ts'

export const ROOT = '/p'
export const HOME = '/home/dev'

const FILES: Record<string, string> = {
  [`${ROOT}/.git/HEAD`]: 'ref: refs/heads/main\n',
  [`${ROOT}/.veilio/guard.json`]: JSON.stringify({ rawOnly: ['secrets/**'] }),
  [`${ROOT}/.env`]: 'DB_HOST=db.example.invalid\n',
  [`${ROOT}/notes`]: 'plain notes\n',
  [`${ROOT}/sub/notes`]: '',
  [`${ROOT}/sub/readme.md`]: '# sub\n',
  [`${ROOT}/src/index.ts`]: 'export const x = 1\n',
  [`${ROOT}/packages/cli/package.json`]: '{}\n',
  [`${ROOT}/packages/cli/.npmrc`]: '//registry.example.invalid/:_authToken=x\n',
  [`${ROOT}/secrets/db.txt`]: 'x\n',
  [`${ROOT}/my folder/a.txt`]: 'a\n',
  [`${HOME}/.kube/config`]: 'x\n',
  [`${HOME}/.aws/credentials`]: 'x\n',
  [`${HOME}/.config/gcloud/credentials.db`]: 'x\n',
  [`${HOME}/code/a.txt`]: 'a\n',
}
const LINKS: Record<string, string> = { [`${ROOT}/sub/notes`]: `${ROOT}/.env` }

function io(): GuardIO {
  const files = { ...FILES }
  const exists = (p: string) => p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`))
  return {
    read: async (p) => {
      const t = files[LINKS[p] ?? p]
      if (t === undefined) throw new Error(`ENOENT: ${p}`)
      return t
    },
    write: async (p, t) => void (files[p] = t),
    exists: async (p) => exists(p),
    realPath: async (p) => LINKS[p] ?? (exists(p) ? p : undefined),
    isFile: async (p) => (LINKS[p] ?? p) in files,
    fileSize: async (p) => files[LINKS[p] ?? p]?.length,
  }
}

/** A guard loaded in the fixture project. */
export async function fixtureGuard(): Promise<Guard> {
  const g = new Guard(io(), { rawOnly: [], mcpRestore: [] })
  await g.load(ROOT, HOME)
  if (g.state !== 'on') throw new Error(`the fixture guard is ${g.state}: ${g.stoppedReason}`)
  return g
}

// The benchmark sessions recorded no host directories (FR-011's truth at a
// call's start), so the replay carries each call where it most likely ended,
// as the host would have reported it. Without it, a session's fail branches
// pile up past the bound (spec 086 review #3: bench:399:5 refused).
async function guard(): Promise<Guard> {
  const g = await fixtureGuard()
  g.assumeSuccess = true
  return g
}

export type Verdict = {
  id: string
  deny: string | null
  restore: string | null
  chain: string[] | null
  words: (string[] | null)[] | null
  dirs: string[]
}

// A benchmark command holds the placeholders the guard showed the model; in
// the fixture none is known, so beforeTool would refuse them all as never
// shown and hide the cd verdict. beforeTool reads them as plain words; the
// text-only readers get the command as written.
const plain = (c: string) =>
  c.replace(/__([A-Z]+)__(\d+)/g, (_, k: string, n) => `${k.toLowerCase()}${n}`)

/** Every entry's verdicts. Its earlier calls go through afterTool first, as
 *  calls that ran (each in turn, so a session's entries share one guard). */
export async function replay(
  corpus: readonly CorpusEntry[],
  dirsOf: (g: Guard, command: string) => string[]
): Promise<Verdict[]> {
  const out: Verdict[] = []
  let g: Guard | null = null
  let prev: CorpusEntry | null = null
  for (const e of corpus) {
    const calls = e.calls ?? []
    const continues =
      g !== null &&
      prev !== null &&
      e.session !== undefined &&
      prev.session === e.session &&
      calls.length === (prev.calls?.length ?? 0) + 1
    if (continues) {
      await g!.afterTool(prev!.tool, { tool: prev!.tool, command: plain(prev!.command) }, ran)
    } else {
      g = await guard()
      for (const c of calls) await g.afterTool(e.tool, { tool: e.tool, command: plain(c) }, ran)
    }
    const dirs = dirsOf(g!, plain(e.command))
    const v = await g!.beforeTool({ tool: e.tool, command: plain(e.command), description: 'x' })
    const chain = splitChain(e.command)
    out.push({
      id: e.id,
      deny: 'deny' in v ? v.deny : null,
      restore: restoreRefusal(e.command, e.tool),
      chain,
      words: chain ? chain.map(shellWords) : [shellWords(e.command)],
      dirs,
    })
    prev = e
  }
  return out
}
const ran = { result: { stdout: '', stderr: '', interrupted: false } }
