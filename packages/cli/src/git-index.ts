// What git tracks, read from the index file itself (spec 085 R1).
//
// The CLI and the MCP server spawn no process (offline.test.ts, MCP
// purity.test.ts), and running git in a cloned repository would run that
// repository's own config (core.fsmonitor and the like). So the store asks
// the index directly. Anything this reader does not fully understand - no
// .git, no index, an unknown version, a split index, a short or odd file - is
// `null`: unknown, which the store treats as "not tracked", as it did before.

import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** The work tree root and every path its index lists, lower-cased. */
export interface Tracked {
  root: string
  paths: Set<string>
}

/** The git checkout holding `from`, and what its index lists; null when unknown. */
export function trackedPaths(from: string): Tracked | null {
  try {
    const found = findGitDir(resolve(from))
    if (!found) return null
    const paths = readIndex(readFileSync(join(found.gitDir, 'index')), hashSize(found))
    return paths && { root: found.root, paths }
  } catch {
    return null
  }
}

function findGitDir(start: string): { root: string; gitDir: string; commonDir: string } | null {
  for (let dir = start; ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git')
    const st = statOrNull(dotGit)
    if (st?.isDirectory()) return { root: dir, gitDir: dotGit, commonDir: dotGit }
    if (st?.isFile()) {
      // A worktree or submodule: `gitdir: <path>`, and the shared config in its commondir.
      const m = /^gitdir: *(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'))
      if (!m) return null
      const gitDir = isAbsolute(m[1]!) ? m[1]! : resolve(dir, m[1]!)
      let commonDir = gitDir
      try {
        const c = readFileSync(join(gitDir, 'commondir'), 'utf8').trim()
        commonDir = isAbsolute(c) ? c : resolve(gitDir, c)
      } catch {
        // no commondir: a submodule, whose config is its own
      }
      return { root: dir, gitDir, commonDir }
    }
    if (dirname(dir) === dir) return null
  }
}

function statOrNull(path: string) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

/** 20 for SHA-1, 32 for a repository made with `--object-format=sha256`. */
function hashSize(found: { commonDir: string }): number {
  try {
    const config = readFileSync(join(found.commonDir, 'config'), 'utf8')
    return /^\s*objectformat\s*=\s*sha256\s*$/im.test(config) ? 32 : 20
  } catch {
    return 20
  }
}

/** Index versions 2, 3 and 4 (git's index-format.txt). Null on anything else. */
function readIndex(buf: Buffer, hash: number): Set<string> | null {
  if (buf.length < 12 + hash || buf.toString('latin1', 0, 4) !== 'DIRC') return null
  const version = buf.readUInt32BE(4)
  if (version < 2 || version > 4) return null
  const count = buf.readUInt32BE(8)
  const end = buf.length - hash
  const paths = new Set<string>()
  let at = 12
  let previous: Buffer = Buffer.alloc(0)
  for (let i = 0; i < count; i++) {
    // ctime, mtime, dev, ino, mode, uid, gid, size (40 bytes), the object id, flags.
    const flagsAt = at + 40 + hash
    if (flagsAt + 2 > end) return null
    const flags = buf.readUInt16BE(flagsAt)
    let nameAt = flagsAt + 2
    if (flags & 0x4000) {
      if (version < 3) return null
      nameAt += 2
    }
    let name: Buffer
    if (version === 4) {
      // A varint of bytes to drop from the previous path, then the rest, NUL-ended.
      let drop = 0
      let byte: number
      let k = nameAt
      do {
        if (k >= end) return null
        byte = buf[k++]!
        drop = (drop << 7) | (byte & 0x7f)
        if (byte & 0x80) drop++
      } while (byte & 0x80)
      if (drop > previous.length) return null
      const nul = buf.indexOf(0, k)
      if (nul === -1 || nul >= end) return null
      name = Buffer.concat([previous.subarray(0, previous.length - drop), buf.subarray(k, nul)])
      at = nul + 1
    } else {
      const nul = buf.indexOf(0, nameAt)
      if (nul === -1 || nul >= end) return null
      name = buf.subarray(nameAt, nul)
      // Each entry is padded with 1-8 NULs to a multiple of 8 bytes.
      at = at + ((nameAt - at + name.length + 8) & ~7)
    }
    previous = name
    paths.add(name.toString('utf8').toLowerCase())
  }
  // Extensions: a split index ("link") keeps entries in another file, so this
  // list would be partial. Anything malformed here is unknown too.
  while (at < end) {
    if (at + 8 > end) return null
    const sig = buf.toString('latin1', at, at + 4)
    const size = buf.readUInt32BE(at + 4)
    if (sig === 'link' || sig === 'sdir') return null
    at += 8 + size
  }
  return at === end ? paths : null
}
