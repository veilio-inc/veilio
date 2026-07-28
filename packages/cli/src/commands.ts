// Command implementations.
//
// Two rules hold everywhere here:
//   1. Transformed code goes to stdout and nothing else does, so the CLI can sit
//      in a pipe (`veilio scrub src/billing.ts | pbcopy`).
//   2. Summaries, warnings and errors go to stderr, so they stay visible without
//      corrupting that pipe.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  anonymize,
  detectSecrets,
  hasBlockingSecrets,
  restore,
  summarizeSecrets,
  withAiPreamble,
  LANGUAGE_LABELS,
  STRIPPABLE_TYPES,
  BIN_NAME,
  STORE_DIR,
  type SecretFinding,
} from '@veilio/shared'
import type { ParsedArgs } from './args.js'
import { clearMap, loadMap, resolveMapPath, saveMap } from './store.js'

export interface Io {
  cwd: string
  stdin: () => Promise<string>
  stdout: (text: string) => void
  stderr: (text: string) => void
}

/** Exit codes are the contract for CI and pre-commit hooks:
 *  0 clean, 1 findings that should stop the pipeline, 2 usage/IO failure. */
export const EXIT_OK = 0
export const EXIT_FINDINGS = 1
export const EXIT_ERROR = 2

async function readInput(args: ParsedArgs, io: Io): Promise<string> {
  if (args.files.length === 0) return io.stdin()
  return args.files.map((f) => readFileSync(resolve(io.cwd, f), 'utf8')).join('\n')
}

function formatFinding(f: SecretFinding, file?: string): string {
  const where = file ? `${file}:${f.line}:${f.column}` : `line ${f.line}:${f.column}`
  const state = f.redacted ? 'redacted' : 'left in place'
  return `  ${f.severity.padEnd(8)} ${where}  ${f.label} — ${f.preview} (${state})`
}

function summaryLine(findings: readonly SecretFinding[]): string {
  const s = summarizeSecrets(findings)
  const parts: string[] = []
  if (s.critical) parts.push(`${s.critical} critical`)
  if (s.high) parts.push(`${s.high} high`)
  if (s.medium) parts.push(`${s.medium} advisory`)
  return parts.join(', ')
}

export async function runScrub(args: ParsedArgs, io: Io): Promise<number> {
  const source = await readInput(args, io)
  const mapPath = resolveMapPath(args.mapPath, io.cwd)
  const existingMap = loadMap(mapPath)

  const result = anonymize(source, {
    existingMap,
    language: args.language,
    secrets: args.secrets,
  })

  saveMap(mapPath, result.map)
  io.stdout(args.preamble ? withAiPreamble(result.anonymized, result.map) : result.anonymized)

  if (!args.quiet) {
    const added = Object.keys(result.map).length - Object.keys(existingMap).length
    io.stderr(
      `${BIN_NAME}: ${LANGUAGE_LABELS[result.language]} — ${added} new placeholder${added === 1 ? '' : 's'}, ${Object.keys(result.map).length} in map\n`
    )
    if (result.secrets.length > 0) {
      io.stderr(`${BIN_NAME}: credentials detected — ${summaryLine(result.secrets)}\n`)
      for (const f of result.secrets) io.stderr(`${formatFinding(f)}\n`)
      if (result.secrets.some((f) => f.redacted)) {
        io.stderr(
          `${BIN_NAME}: redacted values are NOT recoverable on restore. Rotate anything real.\n`
        )
      }
    }
  }
  return EXIT_OK
}

export async function runRestore(args: ParsedArgs, io: Io): Promise<number> {
  const source = await readInput(args, io)
  const mapPath = resolveMapPath(args.mapPath, io.cwd)
  const map = loadMap(mapPath)

  if (Object.keys(map).length === 0) {
    // Restoring against an empty map returns the input verbatim, which looks
    // like success. Say so instead.
    io.stderr(`${BIN_NAME}: no symbol map at ${mapPath} — run "${BIN_NAME} scrub" first.\n`)
    return EXIT_ERROR
  }

  // Without --keep-docs the default strips JSDoc along with the narration and
  // TODOs. That is right for noise, wrong when the model was asked to document
  // its output — so the escape hatch is a flag, not a code change.
  const strip = args.keepDocs ? STRIPPABLE_TYPES.filter((t) => t !== 'jsdoc') : 'all'
  const result = restore(source, map, { strip })
  io.stdout(result.restored)
  if (!args.quiet) {
    io.stderr(
      `${BIN_NAME}: restored from ${Object.keys(map).length} placeholders, stripped ${result.strippedCount} AI artifact${result.strippedCount === 1 ? '' : 's'}\n`
    )
  }
  return EXIT_OK
}

/** Detect-only pass for pre-commit hooks and CI. Never rewrites anything. */
export async function runScan(args: ParsedArgs, io: Io): Promise<number> {
  const targets =
    args.files.length > 0
      ? args.files.map((f) => ({ name: f, text: readFileSync(resolve(io.cwd, f), 'utf8') }))
      : [{ name: '<stdin>', text: await io.stdin() }]

  const all: { file: string; finding: SecretFinding }[] = []
  for (const target of targets) {
    for (const finding of detectSecrets(target.text)) {
      all.push({ file: target.name, finding })
    }
  }

  if (args.json) {
    io.stdout(`${JSON.stringify(all.map((r) => ({ file: r.file, ...r.finding })), null, 2)}\n`)
  } else if (all.length === 0) {
    if (!args.quiet) io.stderr(`${BIN_NAME}: no credentials detected\n`)
  } else {
    io.stderr(`${BIN_NAME}: ${summaryLine(all.map((r) => r.finding))}\n`)
    for (const { file, finding } of all) io.stderr(`${formatFinding(finding, file)}\n`)
  }

  const findings = all.map((r) => r.finding)
  // Default gate is critical/high. --strict also fails on advisory findings,
  // for teams whose policy covers customer emails and internal hostnames.
  const fail = args.strict ? findings.length > 0 : hasBlockingSecrets(findings)
  return fail ? EXIT_FINDINGS : EXIT_OK
}

export async function runMap(args: ParsedArgs, io: Io): Promise<number> {
  const mapPath = resolveMapPath(args.mapPath, io.cwd)

  if (args.clear) {
    const removed = clearMap(mapPath)
    io.stderr(removed ? `${BIN_NAME}: cleared ${mapPath}\n` : `${BIN_NAME}: no map at ${mapPath}\n`)
    return EXIT_OK
  }

  const map = loadMap(mapPath)
  const entries = Object.entries(map)
  if (args.json) {
    io.stdout(`${JSON.stringify(map, null, 2)}\n`)
    return EXIT_OK
  }
  if (entries.length === 0) {
    io.stderr(`${BIN_NAME}: no map at ${mapPath}\n`)
    return EXIT_OK
  }
  io.stderr(`${BIN_NAME}: ${entries.length} placeholders at ${mapPath}\n`)
  for (const [placeholder, real] of entries) io.stdout(`${placeholder}\t${real}\n`)
  return EXIT_OK
}

export const HELP = `${BIN_NAME} — anonymize code before it reaches an LLM, restore it after.

USAGE
  ${BIN_NAME} <command> [files...] [options]

COMMANDS
  scrub [files...]     Mask identifiers and redact credentials. Reads stdin when
                       no file is given. Writes the symbol map to ${STORE_DIR}/map.json.
  restore [files...]   Swap placeholders back and strip AI-generated noise.
  scan [files...]      Detect credentials only; never rewrites. Exits 1 when it
                       finds something — use it in a pre-commit hook or CI.
  map                  Show the current symbol map (--clear to wipe it).

OPTIONS
  -l, --language <lang>   auto (default), typescript, python, go, java, csharp,
                          rust, ruby, php, c, sql
  -s, --secrets <policy>  redact (default) | warn | off
  -p, --preamble          Prepend the downstream-AI note and placeholder legend
  -m, --map <path>        Use a specific map file
      --json              Machine-readable output (scan, map)
      --strict            scan: also fail on advisory findings
      --keep-docs         restore: keep JSDoc blocks the model wrote
  -q, --quiet             Suppress the all-clear summary (findings always show)
  -h, --help              Show this help
  -v, --version           Show the version

EXIT CODES
  0  clean    1  findings that should stop the pipeline    2  usage or IO error

EXAMPLES
  ${BIN_NAME} scrub src/billing.ts | pbcopy
  pbpaste | ${BIN_NAME} restore
  git diff --cached | ${BIN_NAME} scan       # pre-commit gate
  ${BIN_NAME} scan 'src/**/*.ts' --json > findings.json

Transformed code goes to stdout; everything else goes to stderr, so the CLI
composes in a pipe.
`
