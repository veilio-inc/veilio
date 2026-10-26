import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import ts from 'typescript'
import { fencedBlocks, publicDocs, readDoc } from './fixtures/public-docs.js'

/**
 * Every TypeScript and JavaScript example in the public docs, compiled against
 * the engine as it is now.
 *
 * A reader copies these. `anonymize(code, { style: 'plain' })` compiled in the
 * README's head for eleven published versions after the option was gone, and
 * nothing checked it, because a README is text. The compiler can check it if
 * it is handed the block.
 *
 * Examples are fragments, so two things are added before compiling:
 *
 * - an import of every engine export the block uses without importing it. The
 *   README imports `anonymize` once, at the top, and the later blocks assume
 *   it;
 * - `declare const x: any` for a lowercase name the block uses and never
 *   defines (`aiReply`, `goSource`), which stands for the reader's own data.
 *
 * A name that is called (`name(`) or capitalised gets no declaration. If the
 * engine stops exporting a function an example calls, the example fails here.
 * Without this rule, the fragment handling would hide exactly the failure this
 * test exists for.
 */
const ENGINE_INDEX = join(import.meta.dirname, '..', 'src', 'index.ts')
const LANGS = ['ts', 'typescript', 'js', 'javascript'] as const
const VIRTUAL = join(import.meta.dirname, '__readme_example__.ts')

const OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.es2022.d.ts'],
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  // Examples bind results they then only describe in a comment.
  noUnusedLocals: false,
  paths: { '@veilio-inc/engine': [ENGINE_INDEX] },
}

// One host for every compile, so the engine source and the lib files are parsed
// once rather than once per example per round.
const sourceCache = new Map<string, ts.SourceFile | undefined>()
const baseHost = ts.createCompilerHost(OPTIONS)
let previous: ts.Program | undefined

function compile(code: string): { program: ts.Program; diagnostics: ts.Diagnostic[] } {
  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists: (f) => f === VIRTUAL || baseHost.fileExists(f),
    readFile: (f) => (f === VIRTUAL ? code : baseHost.readFile(f)),
    getSourceFile: (f, lang, onError, create) => {
      if (f === VIRTUAL) return ts.createSourceFile(f, code, lang, true, ts.ScriptKind.TS)
      if (!sourceCache.has(f)) sourceCache.set(f, baseHost.getSourceFile(f, lang, onError, create))
      return sourceCache.get(f)
    },
  }
  const program = ts.createProgram([VIRTUAL], OPTIONS, host, previous)
  previous = program
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName === VIRTUAL)
  return { program, diagnostics }
}

/**
 * `anonymize(code, { style: 'plain' })` type-checks. The second parameter is
 * `AnonymizeOptions | SymbolMap`, and a SymbolMap is any record of strings, so
 * an unknown key with a string value is accepted as a positional map, and the
 * engine stores it in the map. The compiler cannot see the failure that started
 * this test. So the option objects an example passes are checked by name: the
 * second argument of `anonymize` and the third of `restore` must use only real
 * option keys.
 */
function unknownOptionKeys(program: ts.Program): string[] {
  const source = program.getSourceFile(VIRTUAL)
  if (!source) return []
  const keys: Record<string, { at: number; allowed: readonly string[] }> = {
    anonymize: { at: 1, allowed: optionKeys('AnonymizeOptions') },
    restore: { at: 2, allowed: optionKeys('RestoreOptions') },
  }
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const rule = keys[node.expression.text]
      const arg = rule && node.arguments[rule.at]
      // A map passed where the options go is the positional form. It still
      // works, and it is the reason a bad option key passes silently, so the
      // docs show `{ existingMap }` instead.
      if (arg && node.expression.text === 'anonymize' && !ts.isObjectLiteralExpression(arg))
        found.push('anonymize() is given a map positionally; write { existingMap: map }')
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const prop of arg.properties) {
          const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : undefined
          if (name && !rule.allowed.includes(name))
            found.push(`${node.expression.text}() has no option "${name}"`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

const optionKeysCache = new Map<string, string[]>()
function optionKeys(typeName: string): string[] {
  const cached = optionKeysCache.get(typeName)
  if (cached) return cached
  const program = ts.createProgram([ENGINE_INDEX], OPTIONS, baseHost)
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(ENGINE_INDEX)
  const symbol = source && checker.getSymbolAtLocation(source)
  const exported = symbol && checker.getExportsOfModule(symbol).find((s) => s.name === typeName)
  if (!exported) throw new Error(`@veilio-inc/engine does not export ${typeName}`)
  const keys = checker
    .getDeclaredTypeOfSymbol(exported)
    .getProperties()
    .map((p) => p.name)
  optionKeysCache.set(typeName, keys)
  return keys
}

let exportsCache: Set<string> | undefined
function engineExports(): Set<string> {
  if (exportsCache) return exportsCache
  const program = ts.createProgram([ENGINE_INDEX], OPTIONS, baseHost)
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(ENGINE_INDEX)
  const symbol = source && checker.getSymbolAtLocation(source)
  if (!symbol) throw new Error('could not read the exports of src/index.ts')
  exportsCache = new Set(checker.getExportsOfModule(symbol).map((s) => s.name))
  return exportsCache
}

const CANNOT_FIND_NAME = new Set([2304, 2552])

/** Compile a block as a reader would run it, and return what is still wrong. */
function check(block: string): string[] {
  const exported = engineExports()
  const imports = new Set<string>()
  const declared = new Set<string>()
  // Each round adds what the last one could not find. Two rounds settle a
  // block; the limit only stops a loop if one never settles.
  for (let round = 0; round < 4; round++) {
    const prelude = [
      imports.size > 0 ? `import { ${[...imports].join(', ')} } from '@veilio-inc/engine'` : '',
      ...[...declared].map((n) => `declare const ${n}: any`),
    ].join('\n')
    const code = `${prelude}\n${block}\nexport {}\n`
    const { program, diagnostics } = compile(code)
    let added = false
    for (const d of diagnostics) {
      if (!CANNOT_FIND_NAME.has(d.code) || d.start === undefined || !d.length) continue
      const name = code.slice(d.start, d.start + d.length)
      const called = code
        .slice(d.start + d.length)
        .trimStart()
        .startsWith('(')
      if (exported.has(name) && !imports.has(name)) {
        imports.add(name)
        added = true
      } else if (!exported.has(name) && !called && /^[a-z]/.test(name) && !declared.has(name)) {
        declared.add(name)
        added = true
      }
    }
    if (!added) {
      const typeErrors = diagnostics.map((d) => {
        const line =
          d.file && d.start !== undefined
            ? d.file.getLineAndCharacterOfPosition(d.start).line - prelude.split('\n').length + 1
            : 0
        return `line ${line}: TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`
      })
      return [...typeErrors, ...unknownOptionKeys(program)]
    }
  }
  throw new Error('the example did not settle after four rounds')
}

const EXAMPLES = publicDocs().flatMap((doc) =>
  fencedBlocks(readDoc(doc), LANGS).map((b) => ({ doc, ...b }))
)

describe('the TypeScript examples in the public docs', () => {
  it('finds the examples it is checking', () => {
    // If a fence changed language or the docs moved, this would otherwise
    // pass with nothing compiled.
    expect(EXAMPLES.filter((e) => e.doc === 'packages/engine/README.md').length).toBeGreaterThan(4)
  })

  it.each(EXAMPLES.map((e) => [`${e.doc}:${e.line}`, e] as const))(
    '%s compiles against the current engine',
    (_label, example) => {
      expect(check(example.code), `${example.doc} line ${example.line}`).toEqual([])
    }
  )

  it('fails an example that uses an option the engine does not have', () => {
    // The check itself, on the failure that started this: if the fragment
    // handling ever swallowed this error, every example above would pass
    // whatever it said.
    const errors = check(`anonymize(source, { style: 'plain' })`)
    expect(errors).toEqual(['anonymize() has no option "style"'])
  })

  it('fails an example that passes a map where the options go', () => {
    expect(check(`anonymize(source, previousMap)`)).toEqual([
      'anonymize() is given a map positionally; write { existingMap: map }',
    ])
    expect(check(`anonymize(source, { existingMap: previousMap })`)).toEqual([])
  })

  it('fails an example that calls a function the engine does not export', () => {
    expect(check(`const r = anonymizeLegacy(source)`).join('\n')).toMatch(/anonymizeLegacy/)
  })
})
