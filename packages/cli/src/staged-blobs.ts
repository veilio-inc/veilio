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

/** The blobs `git cat-file --batch` printed, by object id; a missing one is absent. */
export function parseBatch(buf: Buffer): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>()
  let at = 0
  while (at < buf.length) {
    const eol = buf.indexOf(0x0a, at)
    if (eol === -1) throw new BlobsError('the blob stream ends inside a header')
    const header = buf.toString('latin1', at, eol).split(' ')
    at = eol + 1
    if (header[1] === 'missing') continue
    const size = Number(header[2])
    if (
      header.length !== 3 ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      at + size + 1 > buf.length
    )
      throw new BlobsError('the blob stream is cut short or is not `git cat-file --batch` output')
    if (header[1] === 'blob') blobs.set(header[0]!, buf.subarray(at, at + size))
    at += size + 1
  }
  return blobs
}
