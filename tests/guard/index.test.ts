import { describe, expect, it } from 'vitest'
import { ProjectIndex, type IndexIO } from '../../plugins/veilio-guard/lib/index.ts'

// Spec 050 R1: the project's tracked source files, indexed so that a result is
// masked by what it contains even before Claude has read anything. The guard
// gives it a deadline per hook; a file it cannot read, or cannot reach before
// the deadline, is reported back so the result naming it can be withheld.

const FILES: Record<string, string> = {
  'package.json': '{ "name": "acme-app", "workspaces": ["packages/*"] }',
  'packages/ledger/package.json': '{ "name": "@acme/ledger" }',
  'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }',
  'src/secrets.ts': [
    "import { describe } from 'vitest'",
    "import { Ledger } from '@acme/ledger'",
    "import { money } from '@/money'",
    'export function luhnValid(v: string) { return v }',
  ].join('\n'),
  'src/batch.ts': "import { expect } from 'vitest'\nexport class BatchReconciler {}",
  'src/shadow.ts': '// declares a name another file imports\nexport function expect() {}',
  'app/models.py': 'import numpy\nfrom app.util import helper\nclass Invoice:\n    pass',
  'README.md': '# not source',
}

function io(
  files = FILES,
  opts: { list?: string[] | null; failRead?: string; clock?: () => number } = {}
) {
  const reads: string[] = []
  const value: IndexIO = {
    list: async () => (opts.list === undefined ? Object.keys(files) : opts.list),
    read: async (rel) => {
      reads.push(rel)
      if (rel === opts.failRead) throw new Error('EIO')
      if (!(rel in files)) throw new Error(`ENOENT: ${rel}`)
      return files[rel]
    },
    now: opts.clock ?? (() => 0),
  }
  return { value, reads }
}

const indexed: { rel: string; external: string[] }[] = []
const record = async (rel: string, _text: string, _language: string, external: Set<string>) => {
  indexed.push({ rel, external: [...external].sort() })
}

describe('ProjectIndex', () => {
  it('lists the tracked source files and indexes them all before the deadline', async () => {
    const index = new ProjectIndex(io().value, record)
    await index.start()
    expect([...index.pending].sort()).toEqual(
      ['app/models.py', 'src/batch.ts', 'src/secrets.ts', 'src/shadow.ts'].sort()
    )
    await index.run(Infinity)
    expect(index.state).toBe('complete')
    expect([...index.languages].sort()).toEqual(['python', 'typescript'])
    expect([...index.declared]).toEqual(
      expect.arrayContaining(['luhnValid', 'BatchReconciler', 'Invoice', 'expect'])
    )
  })

  it('reads the project shape: workspaces, path aliases and top-level directories are internal', async () => {
    const index = new ProjectIndex(io().value, record)
    await index.start()
    await index.run(Infinity)
    const ts = index.externalFor('typescript')
    const py = index.externalFor('python')
    expect(ts.has('vitest')).toBe(true)
    expect(ts.has('describe')).toBe(true)
    // Its own workspace package, its alias, and its own Python package.
    expect(ts.has('Ledger')).toBe(false)
    expect(ts.has('money')).toBe(false)
    expect(py.has('helper')).toBe(false)
    expect(py.has('numpy')).toBe(true)
    // Per language: a Python import says nothing about a TypeScript word.
    expect(ts.has('numpy')).toBe(false)
  })

  it('a name one file imports and another declares is not external', async () => {
    const index = new ProjectIndex(io().value, record)
    await index.start()
    await index.run(Infinity)
    expect(index.externalFor('typescript').has('expect')).toBe(false)
  })

  it('stops at the deadline and reports what is left', async () => {
    let t = 0
    const index = new ProjectIndex(io(FILES, { clock: () => t++ }).value, record)
    await index.start()
    const missed = await index.index(['src/secrets.ts', 'src/batch.ts', 'src/shadow.ts'], 2)
    expect(missed.length).toBeGreaterThan(0)
    expect(index.state).toBe('indexing')
  })

  it('a file it cannot read is reported, with the reason, and not marked indexed', async () => {
    const index = new ProjectIndex(io(FILES, { failRead: 'src/batch.ts' }).value, record)
    await index.start()
    const missed = await index.index(['src/batch.ts'], Infinity)
    expect(missed).toEqual(['src/batch.ts'])
    expect(index.failed.get('src/batch.ts')).toContain('EIO')
    expect(index.indexed.has('src/batch.ts')).toBe(false)
  })

  it('a project it cannot list is unavailable, and still indexes the files it is asked for', async () => {
    const index = new ProjectIndex(io(FILES, { list: null }).value, record)
    await index.start()
    expect(index.state).toBe('unavailable')
    expect(await index.index(['src/secrets.ts'], Infinity)).toEqual([])
    expect(index.declared.has('luhnValid')).toBe(true)
  })

  it('indexes each file once', async () => {
    const { value, reads } = io()
    const index = new ProjectIndex(value, record)
    await index.start()
    await index.index(['src/secrets.ts'], Infinity)
    await index.index(['src/secrets.ts'], Infinity)
    await index.run(Infinity)
    expect(reads.filter((r) => r === 'src/secrets.ts')).toHaveLength(1)
  })
})

describe('ProjectIndex and its deadline (review of ef1a533)', () => {
  it('a read that does not answer by the deadline counts as missed', async () => {
    const files = { 'src/a.ts': 'export const a = 1' }
    const index = new ProjectIndex(
      {
        list: async () => Object.keys(files),
        read: () => new Promise(() => undefined), // hangs
        now: () => 0,
        wait: async () => undefined, // the deadline comes at once
      },
      record
    )
    await index.start()
    expect(await index.index(['src/a.ts'], 100)).toEqual(['src/a.ts'])
    expect(index.indexed.has('src/a.ts')).toBe(false)
  })
})

describe('when nothing may be exempt (security reviews of 9355866 and 506324c)', () => {
  it('before every file is indexed', async () => {
    const index = new ProjectIndex(io().value, record)
    await index.start()
    await index.index(['src/secrets.ts'], Infinity)
    expect(index.externalFor('typescript').size).toBe(0)
  })

  it('when a file could not be read, even once the rest is done', async () => {
    const index = new ProjectIndex(io(FILES, { failRead: 'src/shadow.ts' }).value, record)
    await index.start()
    await index.run(Infinity)
    expect(index.externalFor('typescript').size).toBe(0)
  })

  it('when the project has a language whose declarations are not read', async () => {
    const files = { ...FILES, 'src/Ledger.java': 'class Ledger { int expect; }' }
    const index = new ProjectIndex(io(files).value, record)
    await index.start()
    await index.run(Infinity)
    expect(index.externalFor('typescript').size).toBe(0)
  })

  it('text of unknown language gets only what every language imports', async () => {
    const index = new ProjectIndex(io().value, record)
    await index.start()
    await index.run(Infinity)
    expect(index.externalFor('unknown').has('vitest')).toBe(false)
  })
})

describe('a shell script does not turn the exemption off', () => {
  it('a project with .sh files still exempts third-party names', async () => {
    const files = { ...FILES, 'scripts/deploy.sh': 'deploy() { echo "$1"; }\n' }
    const index = new ProjectIndex(io(files).value, record)
    await index.start()
    await index.run(Infinity)
    expect(index.externalFor('typescript').has('vitest')).toBe(true)
  })
})
