// Command implementations.
//
// Two rules hold everywhere here:
//   1. Transformed code goes to stdout and nothing else does, so the CLI can sit
//      in a pipe (`veilio scrub src/billing.ts | pbcopy`).
//   2. Summaries, warnings and errors go to stderr, so they stay visible without
//      corrupting that pipe.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import {
  alteredNote,
  BIN_NAME,
  detectCredentials,
  keepRule,
  type LanguageOption,
  languageOfPath,
  disputedNote,
  hasBlockingSecrets,
  LANGUAGE_LABELS,
  locallyNumberedNote,
  localFamilyNote,
  restore,
  restoreLayers,
  RULES_STOPPED_NOTE,
  appearsAsToken,
  type SecretFinding,
  STRIPPABLE_TYPES,
  summarizeSecrets,
  type TeamLayer,
  withAiPreamble,
  fileKindOf,
} from '@veilio-inc/engine'
import type { ParsedArgs } from './args.js'
import { allCommandsHelp, optionsHelp } from './flags.js'
import { clearMap, loadMap, resolveMapPath, saveMap } from './store.js'
import {
  contestedNote,
  misattributedNote,
  unissuedNote,
  ownWithAliases,
  ignoredKeysNote,
  reservationRefusedSentence,
  localNumbering,
  redactedNote,
  redactionsIn,
} from './reservations.js'
import { readCredential } from './credential.js'
import { describeAge, readRules } from './rules.js'
import { NO_RULES_SKIPPED, rulesSkippedSentences } from './client/rules-skipped.js'
import {
  anonymizeOverTeam,
  reservedAnonymizeFilesOverTeam,
  type Reserve,
} from './team-anonymize.js'
import { thirdPartyNames } from './third-party.js'

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
  /**
   * Where `VEILIO_PROJECT` is read from (spec 052 FR-012a). Undefined: this
   * process's environment. Injectable so tests never depend on the shell's.
   */
  env?: Readonly<Record<string, string | undefined>>
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

/** Each file on its own, or standard input as one text. One `anonymize` call
 *  over joined files guessed one language for all of them: over this
 *  repository's 226 files it chose Go (spec 050 US3). */
async function readInputs(
  args: ParsedArgs,
  io: Io
): Promise<{ name: string | null; text: string }[]> {
  if (args.files.length === 0) return [{ name: null, text: await io.stdin() }]
  return args.files.map((f) => ({ name: f, text: readFileSync(resolve(io.cwd, f), 'utf8') }))
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
  const inputs = await readInputs(args, io)
  const mapPath = resolveMapPath(args.mapPath, io.cwd)
  const existingMap = loadMap(mapPath)
  // The account's custom rules, as last pulled. Read from disk, never fetched.
  // Signed out means no rules, whatever the cache holds.
  const credential = readCredential(io.home)
  const cached = credential ? readRules(credential, io.home) : null

  // Signed in to a team: the team's namespace, as the web app and the MCP server
  // number (spec 030, F11). Signed out: no request - scrub stays offline.
  const found: Awaited<ReturnType<TeamNamespaceSource>> = teamSource
    ? await teamSource()
    : { team: null, note: null, reserve: null }
  if (found.refused) {
    io.stderr(found.refused)
    return EXIT_ERROR
  }
  // Spec 066 R3, FR-001: in a team - its maps read or not - new names go
  // inside this checkout's block, else into its local family: the guard's
  // rule, from the same reserved.json. Never the home store's directory.
  const numbering =
    credential && found.numberingTeam !== undefined
      ? localNumbering(
          mapPath,
          { instance: credential.instance, account: credential.account },
          found.numberingTeam,
          { write: dirname(mapPath) !== join(io.home ?? homedir(), '.veilio') }
        )
      : undefined

  // `--team`: take new numbers out of the team's SHARED allocation rather than
  // from a floor computed here, because this map is going to be published.
  //
  // OPT-IN, not the default, and the reason is a second spec. Two members
  // computing the same floor both minted __FN__6 on staging and one member's
  // restore named the other's function (spec 017), so reserving is plainly
  // better for a map that will be shared — but spec 030 FR-005 requires that
  // `veilio scrub` and the MCP server's `anonymize_text` give the SAME
  // placeholders for the same code and the same team, and the MCP server must
  // never reserve (spec 011 FR-009: it does not publish, and an agent
  // consuming the team's allocation on every tool call is a different thing
  // again). Reserving unconditionally here would split the two surfaces apart
  // for every user, to benefit the ones about to publish.
  //
  // So the person who is about to publish says so, and `maps push --team`
  // refuses a map that conflicts anyway - naming this flag as the remedy.
  //
  // One reservation for the whole call, every file together (e40: one per file
  // met Cloud's rate limit on a 164-file project).
  const reserveTeam = args.team && found.team && found.reserve ? found.reserve : null

  // Each file in its own language: the flag's, else its extension's, else a
  // guess from that file alone (spec 050 FR-004).
  const languageFor = (name: string | null): LanguageOption =>
    args.language !== 'auto' ? args.language : ((name ? languageOfPath(name) : null) ?? 'auto')
  // What the team's maps hold counts as known code too (security review of 8adc729).
  const keep = thirdPartyNames(inputs, [existingMap, found.team?.namespace ?? {}], io.cwd)

  const optionsFor = (input: (typeof inputs)[number]): Parameters<typeof anonymizeOverTeam>[3] => {
    const own = keep.get(input) ?? new Set<string>()
    const rules = [
      ...(cached?.rules ?? []),
      ...keepRule(own, 'veilio-scrub-third-party', 'veilio scrub: third-party names'),
    ]
    // The file's kind, never its path (engine spec 013 R19): the
    // environment-style credential rules apply, the test-file relaxation does not.
    const fileKind = input.name ? fileKindOf(input.name) : undefined
    return {
      language: languageFor(input.name),
      secrets: args.secrets,
      rules: rules.length ? rules : undefined,
      ...(fileKind ? { fileKind } : {}),
    }
  }

  let toPersist: Record<string, string> = existingMap
  const outputs: string[] = []
  const added = new Map<string, number>()
  const results: { name: string | null; result: ReturnType<typeof anonymizeOverTeam>['result'] }[] =
    []
  const record = (
    input: (typeof inputs)[number],
    result: ReturnType<typeof anonymizeOverTeam>['result'],
    persist: Record<string, string>
  ): void => {
    const before = Object.keys(toPersist).length
    toPersist = persist
    const label = LANGUAGE_LABELS[result.language]
    added.set(label, (added.get(label) ?? 0) + Object.keys(toPersist).length - before)
    outputs.push(result.anonymized)
    results.push({ name: input.name, result })
  }
  if (reserveTeam && found.team) {
    let batch: Awaited<ReturnType<typeof reservedAnonymizeFilesOverTeam>>
    try {
      batch = await reservedAnonymizeFilesOverTeam(
        inputs.map((input) => ({ source: input.text, options: optionsFor(input) })),
        existingMap,
        found.team,
        reserveTeam
      )
    } catch (err) {
      // Nothing is written and nothing is printed. Numbering locally instead
      // would hand back placeholders that look correct and collide — the
      // failure this path exists to prevent. Retrying without reservation is
      // deliberately NOT offered.
      const why = err instanceof Error ? err.message : String(err)
      io.stderr(
        `${BIN_NAME}: could not reserve placeholder numbers from the team (${why}), ` +
          `so nothing was masked and nothing was written. ` +
          `Numbering locally here would produce placeholders that clash with a ` +
          `teammate's without either side noticing.\n`
      )
      return EXIT_ERROR
    }
    inputs.forEach((input, i) => record(input, batch.results[i]!, batch.persists[i]!))
  } else {
    for (const input of inputs) {
      const masked = anonymizeOverTeam(
        input.text,
        toPersist,
        found.team ?? { namespace: {}, highest: {} },
        optionsFor(input),
        numbering
      )
      record(input, masked.result, masked.toPersist)
    }
  }

  saveMap(mapPath, toPersist, { force: args.force })
  const anonymized = outputs.join('\n')
  io.stdout(args.preamble ? withAiPreamble(anonymized, toPersist) : anonymized)

  // Survives --quiet. Everything else here describes work that went right; this
  // says the masking itself may be wrong. No marker matched, so the file was
  // tokenised with TypeScript rules — in a Ruby file that means `#` comments
  // were read as code and their prose masked, and in the other direction a
  // language whose comment syntax we did not apply had its prose left in the
  // clear. Output that looks anonymised and is not is the one thing a pipeline
  // must not swallow.
  // A finding, not the summary: the placeholders may clash with the team's.
  if (found.note) io.stderr(`${BIN_NAME}: ${found.note}\n`)
  // Spec 066 R8: survives --quiet. New names were numbered locally because the
  // last reservation failed; stderr is scrub's normal channel for findings.
  if (numbering?.refused)
    io.stderr(`${BIN_NAME}: ${reservationRefusedSentence(numbering.refused, numbering.tag)}\n`)
  // `--team` asked for the team's numbers, and with nobody signed in there is
  // no team to ask - the Community Edition's case. Numbering locally is right
  // (there is nobody to clash with), but only if it is said: a flag that
  // quietly does less than it promised reads as having worked (spec 011 T034,
  // spec 052 FR-024). Signed in with no team, the team lookup's own note says it.
  else if (args.team && credential === null) {
    io.stderr(
      `${BIN_NAME}: --team numbers from your team's shared placeholders, and nobody is ` +
        `signed in, so this was numbered from this project's map only. Run \`${BIN_NAME} login\` ` +
        `to use your team's numbers.\n`
    )
  }

  // Survives --quiet, like the language warning below: rules the account set
  // were not applied, so the output masks less than its owner expects.
  const skippedCounts = cached?.skipped ?? NO_RULES_SKIPPED
  const skipped = rulesSkippedSentences(skippedCounts)
  // Said below, in the same line as the rules that did apply, when that is printed.
  const appliedLine = !args.quiet && cached !== null && cached.rules.length > 0
  if (skipped.length && !appliedLine) io.stderr(`${BIN_NAME}: ${skipped.join(' ')}\n`)

  for (const { name, result } of results) {
    // Survives --quiet: the rules the account set stopped applying part-way.
    if (result.rulesStopped)
      io.stderr(`${BIN_NAME}: ${name ? `${name}: ` : ''}${RULES_STOPPED_NOTE}\n`)
    if (!result.languageFallback) continue
    io.stderr(
      `${BIN_NAME}: ${name ? `${name}: ` : ''}no language marker matched — masked as ${LANGUAGE_LABELS[result.language]}, which may be wrong. ` +
        `Pass --language to be sure.\n`
    )
  }

  if (!args.quiet) {
    if (found.team) io.stderr(`${BIN_NAME}: Namespace: team (the team's maps, from Cloud)\n`)
    const parts = [...added].map(
      ([label, n]) => `${label} — ${n} new placeholder${n === 1 ? '' : 's'}`
    )
    io.stderr(`${BIN_NAME}: ${parts.join('; ')}, ${Object.keys(toPersist).length} in map\n`)
    // Said every time, with the age: a whitelist rule the team has since
    // removed would still leave that name readable until the next pull.
    if (appliedLine) {
      const n = cached.rules.length
      const notApplied = rulesSkippedSentences(skippedCounts, { noun: false }).join(' ')
      io.stderr(
        `${BIN_NAME}: applied ${n} custom rule${n === 1 ? '' : 's'} pulled ${describeAge(cached.pulledAt)}` +
          (notApplied ? `; ${notApplied}\n` : ` (\`${BIN_NAME} rules pull\` to refresh)\n`)
      )
    }
    // Under --quiet, unlike the language warning above. Nearly every real file
    // has a comment beside code, so this fires on almost every run; surviving
    // --quiet would defeat the flag and teach people to stop passing it. The
    // engine reports it on every result either way, so nothing is hidden from a
    // caller that wants it.
    const comments = results.reduce(
      (sum, { result }) => ({
        total: sum.total + result.comments.total,
        inline: sum.inline + result.comments.inline,
        characters: sum.characters + result.comments.characters,
      }),
      { total: 0, inline: 0, characters: 0 }
    )
    if (comments.total > 0) {
      const { total, inline, characters } = comments
      const where = inline === 0 ? 'above the code' : `${inline} inside the body`
      io.stderr(
        `${BIN_NAME}: ${total} comment${total === 1 ? '' : 's'} (${where}) left as written — ` +
          `${characters} characters of prose are NOT masked. Names and ticket numbers in them go out as typed.\n`
      )
    }
    const secrets = results.flatMap(({ name, result }) => result.secrets.map((f) => ({ f, name })))
    if (secrets.length > 0) {
      io.stderr(`${BIN_NAME}: credentials detected — ${summaryLine(secrets.map(({ f }) => f))}\n`)
      for (const { f, name } of secrets) io.stderr(`${formatFinding(f, name ?? undefined)}\n`)
      if (secrets.some(({ f }) => f.redacted)) {
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
  team: {
    namespace: Record<string, string>
    highest: Record<string, number>
    conflicts?: Record<string, number>
  } | null
  note: string | null
  /**
   * Take new placeholder numbers out of the team's shared allocation.
   *
   * `null` when there is nothing to reserve against: signed out, not in a
   * team, the key locked, the team's maps unreadable, or an older self-hosted
   * instance that predates the endpoint. In each of those cases scrub numbers
   * from a local floor and SAYS SO via `note` — which is the honest answer,
   * because the alternative is pretending the number is safe.
   */
  reserve?: Reserve | null
  /**
   * Spec 066: new names are numbered from this checkout's reserved.json -
   * the team's id, or null in a team (or maybe one) whose id is unknown.
   * Undefined: no team numbering (signed out, in no team, an older instance).
   */
  numberingTeam?: string | null
  /**
   * The command is refused, in these words (a whole `veilio: ...` line):
   * VEILIO_PROJECT names no project the team works in (spec 052 FR-012a).
   * Nothing is masked - numbering from the local map instead is the quiet
   * fallback the variable rules out.
   */
  refused?: string
}>

export type TeamLayerSource = (missing: readonly string[]) => Promise<{
  team: TeamLayer | null
  note: string | null
  refused?: string
  /** Spec 063: placeholders whose number another member reserved. */
  misattributed?: string[]
  /** Round 4 (D): placeholders above every number the server issued for their kind. */
  unissued?: string[]
}>

export async function runRestore(
  args: ParsedArgs,
  io: Io,
  teamLayer?: TeamLayerSource
): Promise<number> {
  const source = await readInput(args, io)
  const mapPath = resolveMapPath(args.mapPath, io.cwd)
  // Spec 063: this member's old placeholders a publish renumbered still read
  // back here; the map wins where both name a placeholder.
  const { own, contested: contestedAll, ignored } = ownWithAliases(mapPath, loadMap(mapPath))
  if (ignored) io.stderr(`${BIN_NAME}: ${ignoredKeysNote(ignored)}\n`)

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
  let misattributed: string[] = []
  let unissued: string[] = []
  if (hasPlaceholders && teamLayer) {
    const found = await teamLayer(unexplained)
    if (found.refused) {
      io.stderr(found.refused)
      return EXIT_ERROR
    }
    team = found.team
    teamNote = found.note
    misattributed = found.misattributed ?? []
    unissued = found.unissued ?? []
  }

  if (Object.keys(own).length === 0 && !team && !teamNote) {
    // Restoring against an empty map returns the input verbatim, which looks
    // like success. Say so instead.
    io.stderr(`${BIN_NAME}: no symbol map at ${mapPath} — run "${BIN_NAME} scrub" first.\n`)
    return EXIT_ERROR
  }
  const layers = restoreLayers({ own, team })
  // A contested placeholder is in no layer: not this member's, not the team's.
  const map = { ...layers.map }
  for (const p of contestedAll) delete map[p]
  // Spec 063: a number reserved by another member than its map's publisher is
  // left with its own reason, apart from the maps disputing one.
  const disputedAll = layers.disputedIn(source)
  const otherMembers = disputedAll.filter((p) => misattributed.includes(p))
  const notIssued = disputedAll.filter((p) => unissued.includes(p) && !misattributed.includes(p))
  const disputed = disputedAll.filter((p) => !misattributed.includes(p) && !unissued.includes(p))
  const localOnly = layers.locallyNumberedIn(source)
  // Spec 066 R5: another checkout numbered these while it held no team numbers.
  const otherLocal = layers.otherLocalIn(source)
  const contested = contestedAll.filter((p) => appearsAsToken(source, p))

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
    (p) =>
      !disputed.includes(p) &&
      !localOnly.includes(p) &&
      !otherMembers.includes(p) &&
      !notIssued.includes(p) &&
      !contested.includes(p) &&
      !otherLocal.includes(p)
  )
  const altered = result.report.altered

  // --strict: a restore that leaves any placeholder in the text writes nothing,
  // so `... | veilio restore --strict > file` cannot produce a file that still
  // holds one, nor a redaction (below). The
  // team's maps failing needs no case of its own: a placeholder they were needed
  // for is unresolved.
  const left = [
    ...unresolved,
    ...disputed,
    ...otherMembers,
    ...notIssued,
    ...contested,
    ...localOnly,
    ...otherLocal,
    ...altered,
  ]
  // Spec 067: a redaction cannot be restored, so text holding one is not the
  // file - written over it, the file loses those values for good.
  const redacted = redactionsIn(result.restored)
  const refused = args.strict && (left.length > 0 || redacted.length > 0)
  if (!refused) io.stdout(result.restored)

  // Findings, never under --quiet: the output still holds these placeholders.
  if (teamNote) io.stderr(`${BIN_NAME}: ${teamNote}\n`)
  if (disputed.length > 0) io.stderr(`${BIN_NAME}: ${disputedNote(disputed)}\n`)
  if (otherMembers.length > 0) io.stderr(`${BIN_NAME}: ${misattributedNote(otherMembers)}\n`)
  if (notIssued.length > 0) io.stderr(`${BIN_NAME}: ${unissuedNote(notIssued)}\n`)
  if (contested.length > 0) io.stderr(`${BIN_NAME}: ${contestedNote(contested)}\n`)
  if (localOnly.length > 0) io.stderr(`${BIN_NAME}: ${locallyNumberedNote(localOnly)}\n`)
  if (otherLocal.length > 0) io.stderr(`${BIN_NAME}: ${localFamilyNote(otherLocal)}\n`)

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
  if (redacted.length > 0 && !refused) io.stderr(`${BIN_NAME}: ${redactedNote(redacted)}\n`)

  if (refused) {
    io.stderr(
      `${BIN_NAME}: --strict: nothing written - ${[...left, ...redacted].join(', ')} would have been left in the text.\n`
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
    const fileKind = target.name === '<stdin>' ? undefined : fileKindOf(target.name)
    const language = target.name === '<stdin>' ? null : languageOfPath(target.name)
    for (const finding of detectCredentials(target.text, {
      ...(fileKind ? { fileKind } : {}),
      ...(language ? { language } : {}),
    })) {
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
${allCommandsHelp()}

OPTIONS
${optionsHelp()}

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
