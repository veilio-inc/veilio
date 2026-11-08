// `veilio scan --blobs <listing>` (spec 085 review round 1): the files a
// `git diff --raw --no-abbrev` listing names, their content read by object id
// from `git cat-file --batch` on stdin. The pre-commit hook and the GitHub
// Action run git; the CLI only reads what git printed, and never a `:<path>`
// revision, which git would parse (`0:foo` names foo's stage-0 blob).

/** A listed file: its mode and object id after the change, and its path. */
export interface ListedBlob {
  mode: string
  id: string
  path: string
}

export class BlobsError extends Error {}

// `:<old mode> <new mode> <old id> <new id> <status>[score]<TAB><path>`
const RAW = /^:[0-7]{6} ([0-7]{6}) [0-9a-f]{40,64} ([0-9a-f]{40,64}) [A-Z][0-9]*\t(.+)$/

/** The entries of a `--raw --no-abbrev --no-renames` listing (core.quotepath on). */
export function parseListing(text: string): ListedBlob[] {
  const out: ListedBlob[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    const m = RAW.exec(line)
    if (!m)
      throw new BlobsError(
        `a line of the listing is not git raw diff output: ${JSON.stringify(line.slice(0, 80))}`
      )
    out.push({ mode: m[1]!, id: m[2]!, path: unquote(m[3]!) })
  }
  return out
}

const ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
}

/** A path as git prints it: as is, or C-quoted with octal bytes when it holds
 *  a control character, a quote, a backslash or (quotepath) a non-ASCII byte. */
function unquote(path: string): string {
  if (!path.startsWith('"')) return path
  if (!path.endsWith('"') || path.length < 2)
    throw new BlobsError(`a quoted path does not end: ${path.slice(0, 80)}`)
  const bytes: number[] = []
  const body = path.slice(1, -1)
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'))
      continue
    }
    const next = body[++i]
    if (next !== undefined && /[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8))
      i += 2
    } else if (next !== undefined && next in ESCAPES) bytes.push(ESCAPES[next]!)
    else throw new BlobsError(`a quoted path holds an unknown escape: ${path.slice(0, 80)}`)
  }
  return Buffer.from(bytes).toString('utf8')
}

/** The largest text blob scanned: past it the file is "could not check". */
export const MAX_TEXT_BLOB = 16 * 1024 * 1024
/** Bytes looked at to tell a binary blob (a NUL among them), as git does. */
const SNIFF = 8000

/**
 * Read `git cat-file --batch` output as it arrives, and hand each listed text
 * blob to `scan` with its path, one blob at a time. A binary blob keeps no
 * more than its first SNIFF bytes are looked at; a text blob past
 * MAX_TEXT_BLOB keeps nothing and is an error, as is a listed blob the stream
 * lacks or a stream cut short.
 */
export async function scanListedBlobs(
  listing: ListedBlob[],
  stream: AsyncIterable<Buffer>,
  scan: (path: string, text: string) => void
): Promise<void> {
  const wanted = new Map<string, string[]>()
  for (const e of listing) {
    // A submodule names another repository's commit; a deletion has no blob.
    if (e.mode === '160000' || e.mode === '000000') continue
    wanted.set(e.id, [...(wanted.get(e.id) ?? []), e.path])
  }
  const seen = new Set<string>()
  let pending: Buffer = Buffer.alloc(0)
  // The blob being read: content bytes still to come, and what is kept of it.
  type Reading = {
    id: string
    left: number
    size: number
    kept: Buffer[]
    binary?: true
    tooBig?: true
  }
  let blob: Reading | null = null
  const finish = (b: Reading) => {
    const paths = wanted.get(b.id)
    if (!paths) return
    seen.add(b.id)
    if (b.binary) return
    if (b.tooBig)
      throw new BlobsError(
        `the staged ${JSON.stringify(paths[0])} is larger than 16 MiB, so it could not be checked`
      )
    const text = Buffer.concat(b.kept).toString('utf8')
    for (const p of paths) scan(p, text)
  }
  for await (const chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    for (;;) {
      if (blob) {
        if (blob.left > 0) {
          const take = Math.min(blob.left, pending.length)
          const part = pending.subarray(0, take)
          pending = pending.subarray(take)
          blob.left -= take
          if (!blob.binary && !blob.tooBig) {
            if (blob.size < SNIFF && part.subarray(0, SNIFF - blob.size).includes(0)) {
              blob.binary = true
              blob.kept = []
            } else if ((blob.size += part.length) > MAX_TEXT_BLOB) {
              blob.tooBig = true
              blob.kept = []
            } else blob.kept.push(Buffer.from(part))
          }
          if (blob.left > 0) break
        }
        // git writes a LF after each blob's content.
        if (pending.length === 0) break
        if (pending[0] !== 0x0a)
          throw new BlobsError('the blob stream is not `git cat-file --batch` output')
        pending = pending.subarray(1)
        const done: Reading = blob
        blob = null
        finish(done)
        continue
      }
      const eol = pending.indexOf(0x0a)
      if (eol === -1) break
      const header = pending.toString('latin1', 0, eol).split(' ')
      pending = pending.subarray(eol + 1)
      if (header[1] === 'missing') continue
      const size = Number(header[2])
      if (header.length !== 3 || !Number.isSafeInteger(size) || size < 0)
        throw new BlobsError('the blob stream is not `git cat-file --batch` output')
      blob = { id: header[0]!, left: size, size: 0, kept: [] }
    }
  }
  if (blob || pending.length > 0)
    throw new BlobsError('the blob stream is cut short or is not `git cat-file --batch` output')
  for (const [id, paths] of wanted)
    if (!seen.has(id))
      throw new BlobsError(`could not read the staged ${JSON.stringify(paths[0])} from git`)
}
