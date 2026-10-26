import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import ts from 'typescript'
import {
  COMPILER_OPTIONS,
  ENGINE_INDEX,
  cachedHost,
  engineExports,
  fencedBlocks,
  optionKeys,
  publicDocs,
  readDoc,
} from './fixtures/public-docs.js'

/**
 * Every TypeScript and JavaScript example in the public docs, compiled against
 * the engine as it is now.
 *
 * A reader copies these. `anonymize(code, { style: 'plain' })` stayed in the
 * README for eleven published versions after the option was removed, and
 * nothing checked it, because a README is text. The compiler can check it once
 * it is handed the block.
 *
 * Examples are fragments, so two things are added before compiling:
 *
 * - an import of every engine export the block uses without importing it. The
 *   README imports `anonymize` once, at the top, and the later blocks assume
 *   it;
 * - `declare const x: any` for a lowercase name the block uses and never
 *   defines (`aiReply`, `goSource`). It stands for the reader's own data.
 *
 * A name that is called (`name(`) or capitalised gets no declaration. If the
 * engine stops exporting a function an example calls, the example fails here.
 * Without this rule, the fragment handling would hide the very failure this
 * test exists for.
 */
const LANGS = ['ts', 'typescript', 'js', 'javascript'] as const
const VIRTUAL = join(import.meta.dirname, '__readme_example__.ts')

const OPTIONS: ts.CompilerOptions = {
  ...COMPILER_OPTIONS,
  // Examples bind results they then only describe in a comment.
  noUnusedLocals: false,
}

let previous: ts.Program | undefined

function compile(code: string): { program: ts.Program; diagnostics: ts.Diagnostic[] } {
  const host = cachedHost(new Map([[VIRTUAL, code]]))
  const program = ts.createProgram([VIRTUAL], OPTIONS, host, previous)
  previous = program
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName === VIRTUAL)
  return { program, diagnostics }
}

/** An exported engine type, as the example's own checker sees it. */
function engineType(program: ts.Program, name: string): ts.Type {
  const checker = program.getTypeChecker()
  const index = program.getSourceFile(ENGINE_INDEX)
  const moduleSymbol = index && checker.getSymbolAtLocation(index)
  const symbol =
    moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((s) => s.name === name)
  if (!symbol) throw new Error(`@veilio-inc/engine does not export ${name}`)
  return checker.getDeclaredTypeOfSymbol(symbol)
}

/** Where each function takes its options, and the type they must be. */
const OPTION_ARGUMENTS: Record<string, { at: number; type: string }> = {
  anonymize: { at: 1, type: 'AnonymizeOptions' },
  restore: { at: 2, type: 'RestoreOptions' },
}

/**
 * The option arguments an example passes, checked by the type checker.
 *
 * The compiler alone cannot catch `anonymize(code, { style: 'plain' })`. The
 * second parameter is `AnonymizeOptions | SymbolMap`, and a SymbolMap is any
 * record of strings, so an unknown key with a string value is accepted as a
 * positional map, and the engine stores it in the map. So each options
 * argument is judged by its type, as the checker resolves it:
 *
 * - `any`, or a type with a string index signature (`SymbolMap`, a `Record`),
 *   is a map passed positionally. The docs write `{ existingMap }` instead.
 * - Any other type must have only real option keys among its properties.
 *   Because this reads the type and not the syntax, a quoted key
 *   (`{ 'style': … }`), a computed key, a spread (`{ ...{ style: … } }`) and
 *   a variable holding options are all judged the same way. A variable typed
 *   `AnonymizeOptions` passes, because its properties are the options.
 */
function badOptionArguments(program: ts.Program): string[] {
  const source = program.getSourceFile(VIRTUAL)
  if (!source) return []
  const checker = program.getTypeChecker()
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const fn = node.expression.text
      const rule = OPTION_ARGUMENTS[fn]
      const arg = rule && node.arguments[rule.at]
      if (rule && arg) {
        const argType = checker.getTypeAtLocation(arg)
        const isAny = (argType.flags & ts.TypeFlags.Any) !== 0
        if (isAny || argType.getStringIndexType()) {
          found.push(
            fn === 'anonymize'
              ? 'anonymize() is given a map positionally; write { existingMap: map }'
              : `${fn}() is given a map where its options go`
          )
        } else {
          const allowed = new Set(optionKeys(rule.type))
          for (const prop of argType.getProperties())
            if (!allowed.has(prop.name)) found.push(`${fn}() has no option "${prop.name}"`)
          // What is left is the compiler's question: whether the values have
          // the right types. It answers that in the diagnostics.
          if (
            found.length === 0 &&
            !checker.isTypeAssignableTo(argType, engineType(program, rule.type))
          )
            found.push(`${fn}() is given options that are not ${rule.type}`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
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
      return [...typeErrors, ...badOptionArguments(program)]
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
    },
    // The first case builds the program, which takes over a second locally
    // and longer on a CI runner, so it gets more than vitest's 5 s default.
    30_000
  )
})

describe('the example check itself', () => {
  // If the fragment handling or the option check ever swallowed these, every
  // example above would pass whatever it said.
  it('fails an option the engine does not have', () => {
    expect(check(`anonymize(source, { style: 'plain' })`)).toEqual([
      'anonymize() has no option "style"',
    ])
  })

  it('fails it with a quoted key, a computed key or a spread', () => {
    const style = ['anonymize() has no option "style"']
    expect(check(`anonymize(source, { 'style': 'plain' })`)).toEqual(style)
    expect(check(`anonymize(source, { ['style']: 'plain' })`)).toEqual(style)
    expect(check(`anonymize(source, { ...{ style: 'plain' } })`)).toEqual(style)
    expect(check(`anonymize(source, { language: 'go', ...{ style: 'plain' } })`)).toEqual(style)
  })

  it('fails a computed key it cannot name', () => {
    // `{ [k]: … }` with `k: string` has an index signature: a map, as far as
    // the engine can tell.
    expect(check(`declare const k: string\nanonymize(source, { [k]: 'plain' })`)).toEqual([
      'anonymize() is given a map positionally; write { existingMap: map }',
    ])
  })

  it('fails an unknown option of restore', () => {
    expect(check(`restore(text, map, { strip: 'all', keep: true })`)).toContain(
      'restore() has no option "keep"'
    )
  })

  it('passes options held in a variable typed as the options', () => {
    expect(
      check(`const opts: AnonymizeOptions = { language: 'go' }\nanonymize(source, opts)`)
    ).toEqual([])
    expect(check(`const opts = { language: 'go' } as const\nanonymize(source, opts)`)).toEqual([])
  })

  it('fails options held in a variable that carry an unknown key', () => {
    expect(
      check(`const opts = { language: 'go', style: 'plain' } as const\nanonymize(source, opts)`)
    ).toEqual(['anonymize() has no option "style"'])
  })

  it('fails a map passed where the options go', () => {
    const positional = ['anonymize() is given a map positionally; write { existingMap: map }']
    expect(check(`anonymize(source, previousMap)`)).toEqual(positional)
    expect(check(`const m: SymbolMap = {}\nanonymize(source, m)`)).toEqual(positional)
    expect(check(`anonymize(source, { existingMap: previousMap })`)).toEqual([])
  })

  it('fails a call to a function the engine does not export', () => {
    expect(check(`const r = anonymizeLegacy(source)`).join('\n')).toMatch(/anonymizeLegacy/)
  })
})
