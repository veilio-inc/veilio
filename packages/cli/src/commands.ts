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
  alteredNote,
  BIN_NAME,
  detectSecrets,
  disputedNote,
  hasBlockingSecrets,
  LANGUAGE_LABELS,
  locallyNumberedNote,
  restore,
  restoreLayers,
  type SecretFinding,
  STORE_DIR,
  STRIPPABLE_TYPES,
  summarizeSecrets,
  type TeamLayer,
  withAiPreamble,
} from '@veilio-inc/engine'
import type { ParsedArgs } from './args.js'
import { clearMap, loadMap, resolveMapPath, saveMap } from './store.js'
import { readCredential } from './credential.js'
import { describeAge, readRules } from './rules.js'
import { anonymizeOverTeam } from './team-anonymize.js'

export interface Io {
  cwd: string
  stdin: () => Promise<string>
  stdout: (text: string) => void
  stderr: (text: string) => void
  /**
   * Home directory the credential lives under. Optional, and every field below
   * is optional for the same reason: the local commands in this file must
   * remain constructible without any of it. A required field here would mean a
   * caller who only wants `scrub` has to supply a way to read a password.
   *
   * Undefined means "the real one" — `credential.ts` defaults to `homedir()`.
   */
  home?: string
  /** Read a line from the terminal. Only the cloud commands use it. */
  prompt?: (label: string) => Promise<string>
  /** Read a line without echoing it. Only the cloud commands use it. */
  password?: (label: string) => Promise<string>
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

export async function runScrub(
  args: ParsedArgs,
  io: Io,
  teamSource?: TeamNamespaceSource
): Promise<number> {
  const source = await readInput(args, io)
  const mapPath = resolveMapPath(args.mapPath, io.cwd)
  const existingMap = loadMap(mapPath)
  // The account's custom rules, as last pulled. Read from disk, never fetched.
  // Signed out means no rules, whatever the cache holds.
  const credential = readCredential(io.home)
  const cached = credential ? readRules(credential, io.home) : null

  // Signed in to a team: the team's namespace, as the web app and the MCP server
  // number (spec 030, F11). Signed out: no request - scrub stays offline.
  const found = teamSource ? await teamSource() : { team: null, note: null }
  const { result, toPersist } = anonymizeOverTeam(
    source,
    existingMap,
    found.team ?? { namespace: {}, highest: {} },
    { language: args.language, secrets: args.secrets, rules: cached?.rules }
  )

  saveMap(mapPath, toPersist, { force: args.force })
  io.stdout(args.preamble ? withAiPreamble(result.anonymized, result.map) : result.anonymized)

  // Survives --quiet. Everything else here describes work that went right; this
  // says the masking itself may be wrong. No marker matched, so the file was
  // tokenised with TypeScript rules — in a Ruby file that means `#` comments
  // were read as code and their prose masked, and in the other direction a
  // language whose comment syntax we did not apply had its prose left in the
  // clear. Output that looks anonymised and is not is the one thing a pipeline
  // must not swallow.
  // A finding, not the summary: the placeholders may clash with the team's.
  if (found.note) io.stderr(`${BIN_NAME}: ${found.note}\n`)

  if (result.languageFallback) {
    io.stderr(
      `${BIN_NAME}: no language marker matched — masked as ${LANGUAGE_LABELS[result.language]}, which may be wrong. ` +
        `Pass --language to be sure.\n`
    )
  }

  if (!args.quiet) {
    if (found.team) io.stderr(`${BIN_NAME}: Namespace: team (the team's maps, from Cloud)\n`)
    const added = Object.keys(toPersist).length - Object.keys(existingMap).length
    io.stderr(
      `${BIN_NAME}: ${LANGUAGE_LABELS[result.language]} — ${added} new placeholder${added === 1 ? '' : 's'}, ${Object.keys(toPersist).length} in map\n`
    )
    // Said every time, with the age: a whitelist rule the team has since
    // removed would still leave that name readable until the next pull.
    if (cached && cached.rules.length > 0) {
      const n = cached.rules.length
      io.stderr(
        `${BIN_NAME}: applied ${n} custom rule${n === 1 ? '' : 's'} pulled ${describeAge(cached.pulledAt)} ` +
          `(\`${BIN_NAME} rules pull\` to refresh)\n`
      )
    }
    // Under --quiet, unlike the language warning above. Nearly every real file
    // has a comment beside code, so this fires on almost every run; surviving
    // --quiet would defeat the flag and teach people to stop passing it. The
    // engine reports it on every result either way, so nothing is hidden from a
    // caller that wants it.
    if (result.comments.total > 0) {
      const { total, inline, characters } = result.comments
      const where = inline === 0 ? 'above the code' : `${inline} inside the body`
      io.stderr(
        `${BIN_NAME}: ${total} comment${total === 1 ? '' : 's'} (${where}) left as written — ` +
          `${characters} characters of prose are NOT masked. Names and ticket numbers in them go out as typed.\n`
      )
    }
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

/**
 * Where `restore` gets the team's maps from. Injected, never imported: this file
 * is the local command path and must not even be linked to the network code
 * (tests/offline.test.ts). The entry point passes the Cloud one; nothing passed
 * means no team layer - a local-only restore, as before spec 028.
 * `missing`: the placeholders this project's map could not explain.
 */
/** Where `scrub` gets the team's namespace from (index.ts: Cloud, 5 s at most). */
export type TeamNamespaceSource = () => Promise<{
  team: { namespace: Record<string, string>; highest: Record<string, number> } | null
  note: string | null
}>

export type TeamLayerSource = (
  missing: readonly string[]
) => Promise<{ team: TeamLayer | null; note: string | null }>

export async function runRestore(
  args: ParsedArgs,
  io: Io,
  teamLayer?: TeamLayerSource
): Promise<number> {
  const source = await readInput(args, io)
  const mapPath = resolveMapPath(args.mapPath, io.cwd)
  const own = loadMap(mapPath)

  // The one restore rule (spec 028): the team's maps, this project's map on
  // top where it is in the team's numbering. Asked whenever the text holds a
  // placeholder - even one this project's map explains, because an entry
  // numbered locally (signed out, during a lapse) can explain it WRONGLY, and
  // only the team's maps can tell (review). Signed out, the source makes no
  // request: that restore stays offline, as it always was.
  const hasPlaceholders = restore(source, {}).report.unresolved.length > 0
  const unexplained = restore(source, own).report.unresolved
  let team: TeamLayer | null = null
  let teamNote: string | null = null
  if (hasPlaceholders && teamLayer) {
    const found = await teamLayer(unexplained)
    team = found.team
    teamNote = found.note
  }

  if (Object.keys(own).length === 0 && !team && !teamNote) {
    // Restoring against an empty map returns the input verbatim, which looks
    // like success. Say so instead.
    io.stderr(`${BIN_NAME}: no symbol map at ${mapPath} — run "${BIN_NAME} scrub" first.\n`)
    return EXIT_ERROR
  }
  const layers = restoreLayers({ own, team })
  const map = layers.map
  const disputed = layers.disputedIn(source)
  const localOnly = layers.locallyNumberedIn(source)

  // Without --keep-docs the default strips JSDoc along with the narration and
  // TODOs. That is right for noise, wrong when the model was asked to document
  // its output — so the escape hatch is a flag, not a code change.
  const strip = args.keepDocs ? STRIPPABLE_TYPES.filter((t) => t !== 'jsdoc') : 'all'
  const result = restore(source, map, { strip })

  const { resolved } = result.report
  // Measured against this project's map, not the whole team layer: a team of
  // 400 placeholders is not 397 "renamed by the AI" (review).
  const missing = result.report.missing.filter((p) => p in own)
  const counted = new Set([...Object.keys(own), ...resolved]).size
  // Left for a named reason - disputed, or numbered locally - is not "invented".
  const unresolved = result.report.unresolved.filter(
    (p) => !disputed.includes(p) && !localOnly.includes(p)
  )
  const altered = result.report.altered

  // --strict: a restore that leaves any placeholder in the text writes nothing,
  // so `... | veilio restore --strict > file` cannot produce a file that still
  // holds one. A credential redacted on purpose is not a placeholder. The
  // team's maps failing needs no case of its own: a placeholder they were needed
  // for is unresolved.
  const left = [...unresolved, ...disputed, ...localOnly, ...altered]
  const refused = args.strict && left.length > 0
  if (!refused) io.stdout(result.restored)

  // Findings, never under --quiet: the output still holds these placeholders.
  if (teamNote) io.stderr(`${BIN_NAME}: ${teamNote}\n`)
  if (disputed.length > 0) io.stderr(`${BIN_NAME}: ${disputedNote(disputed)}\n`)
  if (localOnly.length > 0) io.stderr(`${BIN_NAME}: ${locallyNumberedNote(localOnly)}\n`)

  // A token the map cannot explain is a finding, not a summary line: the text on
  // stdout now contains something that means nothing, and the user is about to
  // paste it into an editor. --quiet suppresses the all-clear, never findings —
  // the same contract `scan` follows.
  if (unresolved.length > 0 && !teamNote) {
    io.stderr(
      `${BIN_NAME}: ${unresolved.length} placeholder-shaped token${unresolved.length === 1 ? '' : 's'} not in the map — ` +
        `${unresolved.join(', ')}\n`
    )
    io.stderr(
      `${BIN_NAME}: the AI invented or altered these; ${refused ? 'nothing was written (--strict)' : 'they are still in the output above'}.\n`
    )
  }
  if (altered.length > 0) io.stderr(`${BIN_NAME}: ${alteredNote(altered)}\n`)

  if (refused) {
    io.stderr(
      `${BIN_NAME}: --strict: nothing written - ${left.join(', ')} would have been left in the text.\n`
    )
    return EXIT_FINDINGS
  }

  if (!args.quiet) {
    io.stderr(
      `${BIN_NAME}: restored ${resolved.length} of ${counted} placeholders, stripped ${result.strippedCount} AI artifact${result.strippedCount === 1 ? '' : 's'}\n`
    )
    // Usually innocent — an answer about one function omits the rest of the
    // file — so this sits under --quiet with the summary rather than above it.
    if (missing.length > 0) {
      io.stderr(
        `${BIN_NAME}: ${missing.length} placeholder${missing.length === 1 ? '' : 's'} did not appear in the input; ` +
          `if the AI covered the whole file, it renamed them and those names are not recoverable from this text.\n`
      )
    }
  }

  // Deliberately still EXIT_OK without --strict. `restore` writes usable text to
  // stdout even when a token is unexplained, and exiting non-zero would break
  // every `... | veilio restore > file` pipeline under `set -e` for a warning the
  // user can act on. --strict (above) is the opt-in refusal.
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
    io.stdout(
      `${JSON.stringify(
        all.map((r) => ({ file: r.file, ...r.finding })),
        null,
        2
      )}\n`
    )
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

  Everything above works offline, with no account. The commands below connect a
  Veilio Cloud subscription and are the only ones that touch the network.

  login                Sign in to Veilio Cloud (--instance for self-hosted).
  logout               Revoke the session and forget the credential.
  whoami               Show the signed-in account. Answers from disk; makes no
                       request, so it works with the instance down.
  maps list            List the maps this account holds in Cloud.
  maps pull <id>       Fetch one into the local store. A personal map is
                       decrypted here — the passphrase never leaves the machine.
                       A team map opens with the key from \`team unlock\`.
  maps push [name]     Encrypt the local map and upload it as a new map.
  team unlock          Open this account's team keys with the vault passphrase
                       and keep them on this machine (7 days), so team maps -
                       and the MCP server's shared namespace - work unattended.
  team lock            Remove the unlocked team keys from this machine.
  rules pull           Fetch this account's custom rules (personal and team).
                       \`scrub\` then applies them offline, as the web app does.

OPTIONS
  -l, --language <lang>   auto (default), typescript, python, go, java, csharp,
                          rust, ruby, php, c, sql
  -s, --secrets <policy>  redact (default) | warn | off
  -p, --preamble          Prepend the downstream-AI note and placeholder legend
  -m, --map <path>        Use a specific map file
      --json              Machine-readable output (scan, map)
      --strict            scan: also fail on advisory findings. restore: write
                          nothing and exit 1 if a placeholder would be left
      --keep-docs         restore: keep JSDoc blocks the model wrote
  -f, --force             Allow a map write that would drop existing entries
  -q, --quiet             Suppress the all-clear summary (findings always show)
      --instance <url>    login: the Veilio instance to sign in to. Defaults to
                          the public Cloud; https required (localhost excepted)
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
