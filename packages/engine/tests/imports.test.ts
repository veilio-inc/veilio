import { describe, it, expect } from 'vitest'
import {
  externalNames,
  isExternalSpecifier,
  parseDeclarations,
  parseImports,
} from '../src/index.js'

// Spec 050 R4: what a file takes from outside the project is public, and the
// guard leaves it as written. What the project declares is its own, and wins.

describe('parseImports - TypeScript and JavaScript', () => {
  it('reads named, aliased, type-only and multi-line imports', () => {
    const src = [
      "import { describe, it as test, type Mock } from 'vitest'",
      'import {',
      '  readFileSync,',
      '  writeFileSync as write,',
      "} from 'node:fs'",
    ].join('\n')
    expect(parseImports(src, 'typescript')).toEqual([
      { specifier: 'vitest', names: ['describe', 'it', 'Mock'] },
      { specifier: 'node:fs', names: ['readFileSync', 'writeFileSync'] },
    ])
  })

  it('keeps a default or namespace binding only when it is named after the package', () => {
    const src = [
      "import express from 'express'",
      "import * as path from 'node:path'",
      "import ledgerClient from 'acme-ledger'",
    ].join('\n')
    expect(parseImports(src, 'typescript')).toEqual([
      { specifier: 'express', names: ['express'] },
      { specifier: 'node:path', names: ['path'] },
      // The project chose this name; it is not the package's.
      { specifier: 'acme-ledger', names: [] },
    ])
  })

  it('reads side-effect imports, re-exports, require and dynamic import', () => {
    const src = [
      "import 'reflect-metadata'",
      "export { z } from 'zod'",
      "export * from './local.js'",
      "const { join, resolve: r } = require('path')",
      "const chalk = require('chalk')",
      "const mod = await import('lodash')",
    ].join('\n')
    expect(parseImports(src, 'typescript')).toEqual([
      { specifier: 'reflect-metadata', names: [] },
      { specifier: 'zod', names: ['z'] },
      { specifier: './local.js', names: [] },
      { specifier: 'path', names: ['join', 'resolve'] },
      { specifier: 'chalk', names: ['chalk'] },
      { specifier: 'lodash', names: [] },
    ])
  })
})

describe('parseImports - Python', () => {
  it('reads import and from-import, aliased and parenthesised', () => {
    const src = [
      'import os.path',
      'import numpy as np',
      'from collections import OrderedDict, defaultdict as dd',
      'from typing import (',
      '    Any,',
      '    Optional,',
      ')',
      'from . import sibling',
      'from .models import Invoice',
    ].join('\n')
    expect(parseImports(src, 'python')).toEqual([
      { specifier: 'os.path', names: [] },
      { specifier: 'numpy', names: [] },
      { specifier: 'collections', names: ['OrderedDict', 'defaultdict'] },
      { specifier: 'typing', names: ['Any', 'Optional'] },
      { specifier: '.', names: ['sibling'] },
      { specifier: '.models', names: ['Invoice'] },
    ])
  })
})

describe('parseImports - Go', () => {
  it('reads single and grouped imports, and the selectors used on each package', () => {
    const src = [
      'package main',
      'import "fmt"',
      'import (',
      '  "net/http"',
      '  ledger "github.com/acme/app/ledger"',
      ')',
      'func main() { fmt.Println(http.StatusOK, ledger.Settle()) }',
    ].join('\n')
    expect(parseImports(src, 'go')).toEqual([
      { specifier: 'fmt', names: ['fmt', 'Println'] },
      { specifier: 'net/http', names: ['http', 'StatusOK'] },
      // An alias the project chose is not the package's name.
      { specifier: 'github.com/acme/app/ledger', names: ['Settle'] },
    ])
  })
})

describe('parseImports - other languages', () => {
  it('returns nothing, so nothing is exempted', () => {
    expect(parseImports('import java.util.List;', 'java')).toEqual([])
  })
})

describe('parseDeclarations', () => {
  it('finds what a TypeScript file declares, and not what it imports', () => {
    const src = [
      "import { describe } from 'vitest'",
      "const { join } = require('path')",
      'export async function luhnValid(v: string) {}',
      'export default class Reconciler {',
      '  settle(batch: Batch): void {',
      '    if (batch) {}',
      '  }',
      '}',
      'const { first, second } = pair',
      'let total = 0',
      'export interface Batch {}',
      'type Mode = "a"',
      'enum Kind { A }',
      'function describe() {}',
    ].join('\n')
    const declared = parseDeclarations(src, 'typescript')
    expect(declared).toEqual(
      expect.arrayContaining([
        'Batch',
        'Kind',
        'Mode',
        'Reconciler',
        'describe',
        'first',
        'luhnValid',
        'second',
        'settle',
        'total',
        'batch',
        'v',
      ])
    )
    // Taken from a package, not declared here: these must stay exemptible.
    expect(declared).not.toContain('join')
    // Keywords are never "declared".
    expect(declared).not.toContain('if')
  })

  it('finds Python functions, classes and module-level assignments', () => {
    const src = [
      'RATE = 1',
      'def settle(batch):',
      '    inner = 2',
      'class Ledger:',
      '    pass',
    ].join('\n')
    expect(parseDeclarations(src, 'python').sort()).toEqual([
      'Ledger',
      'RATE',
      'batch',
      'inner',
      'settle',
    ])
  })

  it('finds Go functions, methods, types, vars and consts', () => {
    const src = [
      'func Settle() {}',
      'func (l *Ledger) Close() error { return nil }',
      'type Ledger struct{}',
      'var (',
      '  limit = 3',
      ')',
      'const Max = 9',
    ].join('\n')
    expect(parseDeclarations(src, 'go').sort()).toEqual([
      'Close',
      'Ledger',
      'Max',
      'Settle',
      'l',
      'limit',
    ])
  })
})

describe('isExternalSpecifier', () => {
  const project = {
    workspaces: ['@veilio-inc/engine'],
    pathAliases: ['@/'],
    pythonModules: ['app'],
    goModule: 'github.com/acme/app',
  }
  it.each([
    ['vitest', 'typescript', true],
    ['node:fs', 'typescript', true],
    ['./local.js', 'typescript', false],
    ['/abs/file', 'typescript', false],
    ['@veilio-inc/engine', 'typescript', false],
    ['@veilio-inc/engine/dist/x.js', 'typescript', false],
    ['@/components/Button', 'typescript', false],
    ['numpy', 'python', true],
    ['app.models', 'python', false],
    ['.models', 'python', false],
    ['fmt', 'go', true],
    ['github.com/acme/app/ledger', 'go', false],
    ['github.com/other/lib', 'go', false],
    ['java.util', 'java', false],
  ] as const)('%s in %s is external: %s', (specifier, language, expected) => {
    expect(isExternalSpecifier(specifier, language, project)).toBe(expected)
  })
})

describe('externalNames', () => {
  it('collects external specifiers, their segments and imported names, minus what the file declares', () => {
    const src = [
      "import { describe, expect } from 'vitest'",
      "import { helper } from './helper.js'",
      "import * as fs from 'node:fs'",
      'function describe() {}',
    ].join('\n')
    expect([...externalNames(src, 'typescript', {})].sort()).toEqual(
      ['expect', 'fs', 'node', 'node:fs', 'vitest'].sort()
    )
  })
})

// Review of 6bb19b3: each of these classified a project's own name as
// external, and the guard would have sent it to the model as written.
describe('a project name is never external', () => {
  const project = { baseDirs: ['src'], workspaces: ['acme-app'] }

  it('a bare specifier into a top-level project directory (tsconfig baseUrl) is internal', () => {
    expect(isExternalSpecifier('src/billing/ledger', 'typescript', project)).toBe(false)
  })

  it('a package.json `imports` specifier (#internal) is internal', () => {
    expect(isExternalSpecifier('#internal/payroll', 'typescript', project)).toBe(false)
  })

  it('a statement with no semicolon does not lend its names to the next one', () => {
    const src = ['export const cfg = { apiKey, dbPass }', "export { z } from 'zod'"].join('\n')
    expect(parseImports(src, 'typescript')).toEqual([{ specifier: 'zod', names: ['z'] }])
    expect(externalNames(src, 'typescript', {}).has('apiKey')).toBe(false)
  })

  it('a Go dot-import harvests no selectors', () => {
    const src = ['import . "github.com/x/y"', 'func f() { return order.Total }'].join('\n')
    expect(parseImports(src, 'go')).toEqual([{ specifier: 'github.com/x/y', names: [] }])
  })

  it('a Go parameter that shadows a package name lends it no selectors', () => {
    const src = [
      'import "example.com/db"',
      'func load(db *Conn) string { return db.SecretField }',
      'func other() { db.Open() }',
    ].join('\n')
    const names = parseImports(src, 'go')[0]?.names ?? []
    expect(names).not.toContain('SecretField')
  })

  it('a Go struct field named like a package lends it no selectors', () => {
    const src = [
      'import "example.com/db"',
      'func show(c Config) string { return c.db.SecretField + db.Open() }',
    ].join('\n')
    const names = parseImports(src, 'go')[0]?.names ?? []
    expect(names).not.toContain('SecretField')
    expect(names).toContain('Open')
  })
})

describe('parseDeclarations sees parameters, fields and keys', () => {
  it('TypeScript', () => {
    const src = [
      'export class Vault {',
      '  private secretKey: string',
      '  rotateAfter = 30',
      '  open(passphrase: string, { tenantId, region }: Opts) {}',
      '}',
      'const settings = { retentionDays: 7 }',
      'const pick = (accountRef: string) => accountRef',
    ].join('\n')
    const declared = parseDeclarations(src, 'typescript')
    for (const name of [
      'secretKey',
      'rotateAfter',
      'passphrase',
      'tenantId',
      'region',
      'retentionDays',
      'accountRef',
    ])
      expect(declared, name).toContain(name)
  })

  it('Python', () => {
    const src = [
      'class Ledger:',
      '    owner_id: int = 0',
      '    def close(self, batch_ref):',
      '        total = 1',
    ].join('\n')
    const declared = parseDeclarations(src, 'python')
    for (const name of ['owner_id', 'close', 'batch_ref', 'total'])
      expect(declared, name).toContain(name)
  })

  it('Go', () => {
    const src = [
      'type Ledger struct {',
      '  OwnerID int',
      '  balance float64',
      '}',
      'func Close(batchRef string) {}',
    ].join('\n')
    const declared = parseDeclarations(src, 'go')
    for (const name of ['OwnerID', 'balance', 'batchRef']) expect(declared, name).toContain(name)
  })
})

// Review of 9355866: what a company publishes privately is not public.
describe('only public packages are external', () => {
  it('a scoped package is never external: the scope can be a company', () => {
    expect(isExternalSpecifier('@acme/ledger', 'typescript', {})).toBe(false)
    expect(isExternalSpecifier('@types/node', 'typescript', {})).toBe(false)
  })
  it('in Go, only the standard library is external', () => {
    expect(isExternalSpecifier('net/http', 'go', {})).toBe(true)
    expect(isExternalSpecifier('git.corp/acme/billing/internal/ledger', 'go', {})).toBe(false)
    expect(isExternalSpecifier('github.com/stretchr/testify/assert', 'go', {})).toBe(false)
  })
  it('a Python module found anywhere in the project is internal', () => {
    expect(isExternalSpecifier('app.models', 'python', { pythonModules: ['backend', 'app'] })).toBe(
      false
    )
  })
  it('a baseUrl directory is internal', () => {
    expect(isExternalSpecifier('models/invoice', 'typescript', { baseDirs: ['models'] })).toBe(
      false
    )
  })
})
