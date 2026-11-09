// Tool definitions and handlers.
//
// THE POINT OF THE PATH-BASED TOOLS
//
// A naive MCP anonymizer would take source code as a tool argument. That is
// self-defeating: to call it, the agent must already hold the real code, which
// means the real identifiers are already in the model's context. Nothing was
// protected.
//
// So the primary tools take a FILE PATH. The server reads the file itself, in
// this process, and returns only the masked text. The agent learns
// `__CLS__1.__FN__2()` and never sees `PaymentGateway.chargeCard()`. That is the
// only arrangement where an MCP anonymizer actually anonymizes anything.
//
// `anonymize_text` exists for the case where the agent legitimately already has
// the text (a user pasted it into chat). Its description says so plainly, so the
// model does not reach for it out of convenience and quietly defeat the purpose.

// First: every request this process makes is labelled as the MCP server's.
import './identity.js'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  detectCredentials,
  isPlaceholder,
  restore,
  restoreLayers,
  RULES_STOPPED_NOTE,
  appearsAsToken,
  disputedNote,
  locallyNumberedNote,
  localFamilyNote,
  summarizeSecrets,
  withAiPreamble,
  BIN_NAME,
  LANGUAGES,
  LANGUAGE_LABELS,
  PRODUCT_NAME,
  type RestoreReport,
  type SecretFinding,
  alteredNote,
  keepRule,
  languageOfPath,
  type LanguageOption,
  fileKindOf,
  isLocalPlaceholder,
  GuardJsonCache,
  isRawOnly,
  windowsAlias,
} from '@veilio-inc/engine'
import { findProjectRoot, loadMap, resolveMapPath, saveMap } from '@veilio-inc/cli/store'
import {
  confirmProject,
  getNamespace,
  namespaceLine,
  refreshNamespaceIfStale,
} from './namespace.js'
import { misattributedNote, teamLayerNote, unissuedNote } from '@veilio-inc/cli/team-namespace'
import {
  contestedNote,
  ownWithAliases,
  ignoredKeysNote,
  localNumbering,
  reservationRefusedSentence,
  redactedNote,
  redactionsIn,
} from '@veilio-inc/cli/reservations'
import { anonymizeOverTeam } from '@veilio-inc/cli/team-anonymize'

/** Said when a tool call has just started reloading the team's maps. */
function loadingNote(why: 'unlocked' | 'retrying' | 'changed'): string {
  if (why === 'changed')
    return "Note: the team's maps changed (a team map written, or another project chosen) - loading them now; call again in a moment to use them."
  return why === 'unlocked'
    ? "Note: the team key was unlocked - loading the team's maps now; call again in a moment to use them."
    : "Note: asking Cloud for the team's maps again; call again in a moment to use them."
}
import { getRules, type ResolvedRules } from './rules.js'
import { describeAge } from '@veilio-inc/cli/rules'
import { thirdPartyNames } from '@veilio-inc/cli/third-party'
import { readCredential } from '@veilio-inc/cli/credential'
import { projectOverride, refusal, rulesSkippedSentences } from '@veilio-inc/cli/client'
import {
  ArgumentError,
  CLOUD_TOOLS,
  CLOUD_TOOLS_BY_NAME,
  refusalResult,
  type CloudToolDefinition,
} from './cloud-tools.js'

export { CLOUD_TOOLS }

export interface ToolContext {
  /** Root the server is allowed to read from. */
  cwd: string
  /** Override for the symbol-map location; null uses the project store. */
  mapPath: string | null
  /** Home the sign-in and unlocked keys are read from. Undefined: the real
   *  one. Injectable so tests never read a developer's ~/.veilio. */
  home?: string
  /**
   * Removing maps and updates that drop entries allowed (spec 052 FR-010).
   * Set ONLY from VEILIO_MCP_DESTRUCTIVE=1 when the server starts - the
   * person's choice, never a tool argument's.
   */
  destructive?: boolean
  /**
   * restore_text offered (spec 078 FR-018). Set ONLY from VEILIO_MCP_RESTORE=1
   * when the server starts: its answers put the real names into the agent's
   * context, where an instruction hidden in a file the agent reads could ask
   * for them.
   */
  restoreText?: boolean
  /**
   * The server's environment, for VEILIO_PROJECT (spec 052 FR-012a): set in a
   * repository's `.mcp.json` `env`, it pins that repository's project for
   * every tool call. Undefined: this process's environment.
   */
  env?: Readonly<Record<string, string | undefined>>
  /** Spec 070: the guard-missing line, worked out once when the server starts. */
  guardHint?: string | null
}

export interface ToolResult {
  text: string
  isError?: boolean
}

export interface ToolDefinition {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>, ctx: ToolContext) => ToolResult
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

class ToolError extends Error {}

function str(args: Record<string, unknown>, key: string, required: true): string
function str(args: Record<string, unknown>, key: string, required?: false): string | undefined
function str(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) {
    if (required) throw new ToolError(`missing required argument "${key}"`)
    return undefined
  }
  if (typeof value !== 'string') throw new ToolError(`argument "${key}" must be a string`)
  return value
}

/** An optional boolean. Anything else is an error, not `false`: a `strict: "true"`
 *  read as not strict would hand back the text strict exists to withhold. */
function bool(args: Record<string, unknown>, key: string): boolean {
  const value = args[key]
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') throw new ToolError(`argument "${key}" must be true or false`)
  return value
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  // `..notes.ts` is a name inside the root; only `..` itself, or `..` followed
  // by a separator, climbs out of it.
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Where a path really leads, links and junctions followed. A path that does
 *  not exist resolves through its deepest existing parent, so a missing file
 *  behind a link that leads out is refused like an existing one: otherwise
 *  "cannot read" against "outside" says which files exist outside the root.
 *  Undefined when it cannot be resolved (a dangling or looping link, no
 *  permission), which the caller refuses: fail closed. */
function realPath(path: string): string | undefined {
  try {
    // The canonical long name: on Windows an 8.3 short name resolves too.
    return realpathSync.native(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
    // ENOENT for a link that exists means its target does not: dangling.
    if (isLink(path)) return undefined
    const parent = dirname(path)
    if (parent === path) return path
    const real = realPath(parent)
    return real === undefined ? undefined : join(real, basename(path))
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** Resolve a caller-supplied path and refuse anything outside `cwd`.
 *  The server reads files on the agent's behalf, so path traversal here would
 *  turn it into an arbitrary-file-read primitive.
 *
 *  Checked twice: as written, and where it really leads. A link committed to a
 *  repository, or a Windows junction, sits inside the root as text and points
 *  outside it, and the text check alone let the server read the target.
 *  A link swapped between this check and the read is not caught; whatever can
 *  do that already has a shell in the project. */
function safeResolve(path: string, cwd: string): string {
  const abs = isAbsolute(path) ? path : resolve(cwd, path)
  const outside = new ToolError(`path "${path}" is outside the project root`)
  if (!isInside(cwd, abs)) throw outside
  const realTarget = realPath(abs)
  const realRoot = realPath(cwd) ?? cwd
  if (realTarget === undefined || !isInside(realRoot, realTarget)) throw outside
  return realTarget
}

/** Spec 078 FR-016: the guard's raw-only list (one list, the engine's), a
 *  Windows stream or short name, and this server's own map files wherever the
 *  configuration puts them - on the path as given, before it is resolved, and
 *  where it really leads, before anything is read. */
function refuseRawOnly(path: string, ctx: ToolContext): string {
  const refuse = () =>
    new ToolError(
      `"${path}" is on Veilio's raw-only list (.env, private keys, credential stores, .veilio/); Veilio never reads it. Ask the user for what you need from it.`
    )
  const map = resolveMapPath(ctx.mapPath, ctx.cwd)
  const stores = [map, join(dirname(map), 'aliases.json'), join(dirname(map), 'reserved.json')]
  const own = new Set(stores.flatMap((p) => [resolve(p), realPath(p) ?? resolve(p)]))
  // The project's own patterns are its root's, as the guard reads them
  // (security review of the git and MCP changes): matched from there.
  const project = findProjectRoot(ctx.cwd)
  const extra = projectRawOnly(project)
  const fromProject = relative(project, resolve(ctx.cwd, path))
  if (
    isRawOnly(path, []) ||
    isRawOnly(fromProject, extra) ||
    windowsAlias(path) ||
    own.has(resolve(ctx.cwd, path))
  )
    throw refuse()
  const real = safeResolve(path, ctx.cwd)
  const root = realPath(ctx.cwd) ?? ctx.cwd
  if (
    isRawOnly(relative(root, real), []) ||
    isRawOnly(relative(realPath(project) ?? project, real), extra) ||
    own.has(real)
  )
    throw refuse()
  return real
}

/** The project's own raw-only patterns, from `.veilio/guard.json` at the
 *  project root, through the engine's loader the guard reads them with
 *  (review round 1 item 10, round 2), cached by the file's mtime. A file that
 *  is not JSON refuses the call, as it stops the guard. */
export function projectRawOnly(project: string): string[] {
  const path = join(project, '.veilio', 'guard.json')
  let mtimeMs: number | undefined
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    mtimeMs = undefined
  }
  try {
    return guardJson.get(project, mtimeMs, () => readFileSync(path, 'utf8'))
  } catch (err) {
    // Unreadable (EACCES, swapped away) refuses too, as it stops the guard
    // (review round 3): never read as "no patterns".
    throw new ToolError(
      err instanceof SyntaxError
        ? '.veilio/guard.json is not valid JSON, so Veilio cannot tell which files are raw-only. Fix it, or ask the user for what you need.'
        : 'Veilio could not read .veilio/guard.json, so it cannot tell which files are raw-only. Fix it, or ask the user for what you need.'
    )
  }
}
const guardJson = new GuardJsonCache()

function readTarget(
  args: Record<string, unknown>,
  ctx: ToolContext
): { text: string; label: string } {
  const path = str(args, 'path')
  const text = str(args, 'text')
  if (path !== undefined && text !== undefined) {
    throw new ToolError('pass either "path" or "text", not both')
  }
  if (path !== undefined) {
    const abs = refuseRawOnly(path, ctx)
    try {
      return { text: readFileSync(abs, 'utf8'), label: path }
    } catch {
      throw new ToolError(`cannot read "${path}"`)
    }
  }
  if (text !== undefined) return { text, label: 'inline text' }
  throw new ToolError('pass either "path" or "text"')
}

function findingLines(findings: readonly SecretFinding[]): string {
  return findings
    .map(
      (f) =>
        `  ${f.severity.padEnd(8)} line ${f.line}:${f.column}  ${f.label} — ${f.preview}` +
        (f.redacted ? ' (redacted, not recoverable)' : ' (left in place)')
    )
    .join('\n')
}

function secretSummary(findings: readonly SecretFinding[]): string {
  if (findings.length === 0) return 'No credentials detected.'
  const s = summarizeSecrets(findings)
  const parts: string[] = []
  if (s.critical) parts.push(`${s.critical} critical`)
  if (s.high) parts.push(`${s.high} high`)
  if (s.medium) parts.push(`${s.medium} advisory`)
  return `Credentials detected — ${parts.join(', ')}:\n${findingLines(findings)}`
}

/** Tell the caller what did not survive the round trip.
 *
 *  Worth more here than anywhere else in the product: over MCP the caller is the
 *  model, and the model is usually the thing that broke the placeholder. Told
 *  which token it mangled, it can go back and fix its own reply — a correction
 *  loop no human-facing panel can close.
 *
 *  `unresolved` leads because it is always wrong: the restored text now carries
 *  a token that means nothing. `missing` is reported as information, since a
 *  reply about one function legitimately omits the rest of the file. Silence
 *  when both are empty keeps a clean restore from growing a paragraph nobody
 *  needs to read. */
function restoreReportLines(report: RestoreReport): string {
  const parts: string[] = []
  if (report.unresolved.length > 0) {
    parts.push(
      `WARNING: ${report.unresolved.length} placeholder-shaped token(s) match no map entry — ` +
        `they were invented or altered somewhere in the reply and are still in the output: ` +
        `${report.unresolved.join(', ')}. Replace them with the correct placeholders and restore again.`
    )
  }
  if (report.missing.length > 0) {
    parts.push(
      `${report.missing.length} placeholder(s) never appeared in the text: ` +
        `${report.missing.join(', ')}. Expected if the text only covered part of the source; ` +
        `if it covered all of it, those names came back renamed and are not recoverable from it.`
    )
  }
  return parts.length > 0 ? `\n\n${parts.join('\n\n')}` : ''
}

function rulesLine(r: ResolvedRules): string {
  if (r.source === 'none') return 'Custom rules: none'
  const n = `${r.rules.length} custom rule${r.rules.length === 1 ? '' : 's'}`
  if (r.source === 'cloud') return `Custom rules: ${n} from Cloud`
  return `Custom rules: ${n} cached, pulled ${describeAge(r.pulledAt ?? '')} - Cloud did not answer`
}

const LANGUAGE_ENUM = ['auto', ...LANGUAGES]

const LANGUAGE_PROP = {
  type: 'string',
  enum: LANGUAGE_ENUM,
  description: `Source language. "auto" (default) detects it. Supported: ${LANGUAGES.map((l) => LANGUAGE_LABELS[l]).join(', ')}.`,
}

function runAnonymize(
  source: string,
  label: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  /** The file's path, relative to the project root, when the input is a file. */
  file?: string
): ToolResult {
  const mapPath = resolveMapPath(ctx.mapPath, ctx.cwd)
  const localMap = loadMap(mapPath)
  const refreshing = refreshNamespaceIfStale()
  const resolved = getNamespace()
  // VEILIO_PROJECT names no project the team works in (FR-012a): refused,
  // before anything is masked or stored. Masking from the local map instead
  // is the quiet fallback the variable exists to rule out.
  if (resolved.found.status === 'refused') return refusalResult(resolved.found.refusal)
  const { namespace, highest, conflicts } = resolved
  // A file is masked in its extension's language unless one is asked for, and
  // keeps the names it takes from a public package as written - the rule
  // `veilio scrub <file>` follows, from the same module, so the two give the
  // same placeholders for the same file (spec 030 FR-005, spec 050 T033-T036).
  // Inline text has no file and no project: nothing is proven third-party.
  const asked = (str(args, 'language') ?? 'auto') as LanguageOption
  const language: LanguageOption =
    asked !== 'auto' || !file ? asked : (languageOfPath(file) ?? 'auto')
  const keep = file
    ? (() => {
        const input = { name: file, text: source }
        return thirdPartyNames([input], [localMap, namespace], ctx.cwd).get(input) ?? new Set()
      })()
    : new Set<string>()
  const rules = getRules()
  // Spec 066 R3: in a team, inside this checkout's block, else its local
  // family - read from reserved.json, never written, never reserved here.
  const owner = resolved.owner
  const numbering = owner
    ? localNumbering(mapPath, owner, owner.teamId, { write: false })
    : undefined
  // The same composition `veilio scrub` uses (spec 030): the team's maps over
  // this project's, new names inside the block or local, and only the team
  // entries the output uses kept in the store.
  const { result, toPersist } = anonymizeOverTeam(
    source,
    localMap,
    { namespace, highest, conflicts },
    {
      language,
      secrets: 'redact',
      // The file's kind, never its path (engine spec 013 R19): the
      // environment-style credential rules apply, the test-file relaxation does not.
      ...(file && fileKindOf(file) ? { fileKind: fileKindOf(file) } : {}),
      rules: [
        ...(rules.rules ?? []),
        ...keepRule(keep, 'veilio-scrub-third-party', 'veilio scrub: third-party names'),
      ],
    },
    numbering
  )
  saveMap(mapPath, toPersist)
  const localMints = Object.keys(result.map).filter(
    (p) => isLocalPlaceholder(p) && !(p in localMap)
  ).length

  const body =
    args.preamble === true ? withAiPreamble(result.anonymized, result.map) : result.anonymized
  // The model reading this is about to reason over the masked text, and these
  // two lines are the only place it can learn what the masking did NOT cover.
  // The engine puts both on every result precisely so this server does not have
  // to decide for itself; dropping them here would leave an agent believing the
  // output is clean when a name is sitting in a comment inside it.
  const caveats: string[] = []
  if (result.rulesStopped) caveats.push(`WARNING: ${RULES_STOPPED_NOTE}`)
  if (result.languageFallback) {
    caveats.push(
      `WARNING: no language marker matched. Masked as ${LANGUAGE_LABELS[result.language]}, ` +
        `which may be wrong for this file — pass "language" explicitly to be sure.`
    )
  }
  if (result.comments.total > 0) {
    const { total, inline, characters } = result.comments
    caveats.push(
      `Comment prose is NOT masked: ${total} comment${total === 1 ? '' : 's'} ` +
        `(${inline === 0 ? 'above the code' : `${inline} inside the body`}), ` +
        `${characters} characters, left exactly as written. Names, customers and ticket ` +
        `numbers in them are still real. Treat them as unmasked when quoting or forwarding.`
    )
  }

  const notes = [
    `Source: ${label}`,
    `Language: ${LANGUAGE_LABELS[result.language]}`,
    `Placeholders in map: ${Object.keys(toPersist).length}`,
    // Never absent (FR-016, Constitution V): a result that cannot say where its
    // names came from is the silent fallback this line exists to rule out.
    namespaceLine(resolved),
    ...(refreshing ? [loadingNote(refreshing)] : []),
    // Stated every time, like the namespace: an agent whose masking ignored the
    // team's rules must be able to tell.
    rulesLine(rules),
    // Beside the source, on every result while it holds: rules the account set
    // were not applied, so the masking is less than its owner expects.
    ...rulesSkippedSentences(rules.skipped),
    ...(rules.notices ?? []).map((n) => `WARNING: ${n.replace(/^veilio: /, '')}`),
    // Spec 066 R8: on every result while this checkout's last reservation is
    // refused, and whenever this call numbered names on this machine only.
    ...(numbering?.refused
      ? [`WARNING: ${reservationRefusedSentence(numbering.refused, numbering.tag)}`]
      : []),
    ...(localMints > 0
      ? [
          `${localMints} name${localMints === 1 ? '' : 's'} numbered locally (__LOCAL_${numbering?.tag}_…): ` +
            "teammates' restores leave them as written until this checkout's next publish.",
        ]
      : []),
    secretSummary(result.secrets),
    ...caveats,
  ].join('\n')

  return {
    text: `${notes}\n\n--- masked code ---\n${body}`,
  }
}

// ─── Tools ───────────────────────────────────────────────────────────────────

export const TOOLS: ToolDefinition[] = [
  {
    name: 'anonymize_file',
    title: 'Anonymize a file',
    description:
      `Read a file from disk and return it with every proprietary identifier replaced by a ` +
      `placeholder (__CLS__1, __FN__2, …) and every credential irreversibly redacted. ` +
      `PREFER THIS over anonymize_text: ${PRODUCT_NAME} reads the file itself, so the real ` +
      `identifiers never enter your context — you only ever see the masked form. Use it before ` +
      `reasoning about, quoting, or forwarding proprietary source. The symbol map is stored ` +
      `locally so the developer can restore an answer later. Files on the raw-only list ` +
      `(.env, private keys, credential stores, .veilio/) are refused, never read.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the project root.' },
        language: LANGUAGE_PROP,
        preamble: {
          type: 'boolean',
          description:
            'Prepend a note explaining the placeholders, for forwarding to another model.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: (args, ctx) => {
      const path = str(args, 'path', true)
      const abs = refuseRawOnly(path, ctx)
      let source: string
      try {
        source = readFileSync(abs, 'utf8')
      } catch {
        throw new ToolError(`cannot read "${path}"`)
      }
      return runAnonymize(source, path, args, ctx, path)
    },
  },
  {
    name: 'anonymize_text',
    title: 'Anonymize text you already have',
    description:
      `Mask identifiers and redact credentials in text passed as an argument. Only use this for ` +
      `text you ALREADY hold — something the user pasted into the conversation. If the content ` +
      `is in a file, use anonymize_file instead: passing file contents through this tool means ` +
      `the real identifiers are already in your context, which defeats the purpose.`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The code to mask.' },
        language: LANGUAGE_PROP,
        preamble: { type: 'boolean', description: 'Prepend the explanatory note.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    handler: (args, ctx) => runAnonymize(str(args, 'text', true), 'inline text', args, ctx),
  },
  {
    name: 'restore_text',
    title: 'Restore real identifiers',
    description:
      `Swap placeholders back to the real identifiers using the stored symbol map, and strip ` +
      `AI-generated noise (JSDoc, TODO comments, narration). Its result puts the real names ` +
      `into your context, which undoes the masking for whatever it restores: call it only ` +
      `when the developer asks for restored text for their own use, never to read the ` +
      `project. Irreversibly redacted credentials stay redacted - that is deliberate.`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text containing placeholders.' },
        strict: {
          type: 'boolean',
          description:
            'Refuse instead of returning text that still holds a placeholder (invented, ' +
            "altered, disputed, or the team's maps unreadable) or a redaction, which cannot be " +
            'restored: an error naming them, and no text.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    handler: (args, ctx) => {
      const text = str(args, 'text', true)
      const strict = bool(args, 'strict')
      // Spec 063: this member's renumbered old placeholders still read back here.
      const mapPath = resolveMapPath(ctx.mapPath, ctx.cwd)
      const { own, contested: contestedAll, ignored } = ownWithAliases(mapPath, loadMap(mapPath))
      // The one restore rule (spec 028), shared with the web app and the CLI:
      // the team's maps - aliases included, disputed placeholders left out -
      // then this project's map on top where it is in the team's numbering.
      const refreshing = refreshNamespaceIfStale()
      const resolved = getNamespace()
      if (resolved.found.status === 'refused') return refusalResult(resolved.found.refusal)
      const team =
        resolved.source === 'team'
          ? {
              namespace: resolved.namespace,
              aliases: resolved.aliases,
              conflicts: resolved.conflicts,
            }
          : null
      const unexplained = restore(text, own).report.unresolved
      const found = resolved.found
      const note = team ? null : teamLayerNote(found, unexplained)
      if (Object.keys(own).length === 0 && !team && !note) {
        throw new ToolError(`no symbol map yet — run anonymize_file (or "${BIN_NAME} scrub") first`)
      }
      const layers = restoreLayers({ own, team })
      // Spec 063: a number another member reserved is left with its own reason.
      const misattributed = team && found.status === 'team' ? (found.misattributed ?? []) : []
      // Round 4 (D): above every number the server issued for its kind.
      const unissued = team && found.status === 'team' ? (found.unissued ?? []) : []
      const disputedAll = layers.disputedIn(text)
      const otherMembers = disputedAll.filter((p) => misattributed.includes(p))
      const notIssued = disputedAll.filter(
        (p) => unissued.includes(p) && !misattributed.includes(p)
      )
      const disputed = disputedAll.filter(
        (p) => !misattributed.includes(p) && !unissued.includes(p)
      )
      const localOnly = layers.locallyNumberedIn(text)
      // Spec 066 R5: another checkout numbered these while it held no team numbers.
      const otherLocal = layers.otherLocalIn(text)
      const contested = contestedAll.filter((p) => appearsAsToken(text, p))
      // A contested placeholder is in no layer: not this member's, not the team's.
      const restoreMap = { ...layers.map }
      for (const p of contestedAll) delete restoreMap[p]
      const result = restore(text, restoreMap)
      // Measured against this project's map, not the whole team layer (review),
      // and a placeholder left for a named reason is not "invented".
      const report: RestoreReport = {
        ...result.report,
        missing: result.report.missing.filter((p) => p in own),
        unresolved: result.report.unresolved.filter(
          (p) =>
            !disputed.includes(p) &&
            !localOnly.includes(p) &&
            !otherMembers.includes(p) &&
            !notIssued.includes(p) &&
            !contested.includes(p) &&
            !otherLocal.includes(p)
        ),
      }
      const counted = new Set([...Object.keys(own), ...result.report.resolved]).size
      const altered = result.report.altered
      const left = [
        ...report.unresolved,
        ...disputed,
        ...otherMembers,
        ...notIssued,
        ...contested,
        ...localOnly,
        ...otherLocal,
        ...altered,
      ]
      // Spec 067: a redaction cannot be restored, so text holding one is not
      // the file - written over it, the file loses those values for good.
      const redacted = redactionsIn(result.restored)
      const warnings = [
        ...(refreshing ? [loadingNote(refreshing)] : []),
        ...(note ? [`WARNING: ${note}`] : []),
        ...(disputed.length ? [`WARNING: ${disputedNote(disputed)}`] : []),
        ...(otherMembers.length ? [`WARNING: ${misattributedNote(otherMembers)}`] : []),
        ...(notIssued.length ? [`WARNING: ${unissuedNote(notIssued)}`] : []),
        ...(contested.length ? [`WARNING: ${contestedNote(contested)}`] : []),
        ...(localOnly.length ? [`WARNING: ${locallyNumberedNote(localOnly)}`] : []),
        ...(otherLocal.length ? [`WARNING: ${localFamilyNote(otherLocal)}`] : []),
        ...(altered.length ? [`WARNING: ${alteredNote(altered)}`] : []),
        ...(redacted.length && !(strict && (left.length > 0 || redacted.length > 0))
          ? [`WARNING: ${redactedNote(redacted)}`]
          : []),
        ...(ignored ? [`WARNING: ${ignoredKeysNote(ignored)}`] : []),
      ]
      // Unrestored team placeholders because the team's maps could not be used
      // (locked, unreadable): not a success, whatever else restored (FR-005).
      const failed = found.status === 'locked' || found.status === 'unavailable'
      // strict: nothing that still holds a placeholder is handed back (the CLI's
      // --strict, the same rule), nor a redaction. A placeholder the team's
      // maps were needed for is in `left` already.
      if (strict && (left.length > 0 || redacted.length > 0)) {
        return {
          isError: true,
          text:
            `Restored ${result.report.resolved.length} of ${counted} placeholders.` +
            `${restoreReportLines(report)}` +
            `${warnings.length ? `\n\n${warnings.join('\n')}` : ''}\n\n` +
            `strict: the restored text is withheld - ${[...left, ...redacted].join(', ')} would have been left in it.`,
        }
      }
      return {
        isError: note !== null && failed,
        text:
          `Restored ${result.report.resolved.length} of ${counted} placeholders; ` +
          `stripped ${result.strippedCount} AI artifact(s).` +
          `${restoreReportLines(report)}` +
          `${warnings.length ? `\n\n${warnings.join('\n')}` : ''}\n\n--- restored ---\n${result.restored}`,
      }
    },
  },
  {
    name: 'scan_secrets',
    title: 'Scan for credentials',
    description:
      `Detect credentials — API keys, tokens, private keys, connection-string passwords, ` +
      `emails, private IPs — without modifying anything and WITHOUT putting the values in your ` +
      `context (a finding shows only a value's last four characters and its length). Run this ` +
      `on a file before reading it, or on a diff before committing. Files on the raw-only list ` +
      `(.env, private keys, credential stores, .veilio/) are refused, never read.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to scan, relative to the project root.' },
        text: { type: 'string', description: 'Text to scan, if not reading a file.' },
      },
      additionalProperties: false,
    },
    handler: (args, ctx) => {
      const { text, label } = readTarget(args, ctx)
      const path = str(args, 'path')
      const fileKind = path ? fileKindOf(path) : undefined
      const language = path ? languageOfPath(path) : null
      const findings = detectCredentials(text, {
        ...(fileKind ? { fileKind } : {}),
        ...(language ? { language } : {}),
      })
      return { text: `Scanned ${label}.\n${secretSummary(findings)}` }
    },
  },
  {
    name: 'symbol_map_summary',
    title: 'Summarize the symbol map',
    description:
      `Report how many placeholders exist and which kinds. Deliberately returns placeholder ` +
      `KEYS only, never the real names — so you can reason about coverage without ` +
      `de-anonymizing anything.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (_args, ctx) => {
      const mapPath = resolveMapPath(ctx.mapPath, ctx.cwd)
      const map = loadMap(mapPath)
      const keys = Object.keys(map)
      if (keys.length === 0) return { text: 'No symbol map yet.' }
      const byBase = new Map<string, number>()
      for (const key of keys) {
        // Whether a key is a placeholder is the engine's question, so it is
        // asked rather than re-encoded here — a local copy of the pattern goes
        // stale the first time the engine mints a role it does not describe,
        // and mis-grouping is silent. Stripping the trailing counter to get the
        // role is presentation, and stays here.
        const base = isPlaceholder(key) ? key.replace(/\d+$/, '') : key
        byBase.set(base, (byBase.get(base) ?? 0) + 1)
      }
      const breakdown = [...byBase].map(([base, n]) => `  ${base}* × ${n}`).join('\n')
      return { text: `${keys.length} placeholders at ${mapPath}:\n${breakdown}` }
    },
  },
]

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

/** Run a tool, converting expected failures into an error result rather than a
 *  protocol-level fault — MCP clients surface tool errors to the model so it can
 *  correct itself, whereas a JSON-RPC error usually aborts the call. */
export function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): ToolResult {
  const tool = offered(name, ctx) ? TOOLS_BY_NAME.get(name) : undefined
  if (!tool) return { text: `Unknown tool "${name}".`, isError: true }
  try {
    return tool.handler(args, ctx)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { text: `${PRODUCT_NAME}: ${message}`, isError: true }
  }
}

/**
 * The tools this server offers right now (spec 052 FR-023).
 *
 * Signed out - always, in the Community Edition - exactly the five offline
 * tools, as before: an agent shown map tools it can never use would keep
 * reaching for them. Signed in, the map, team and project tools too. Asked on
 * every `tools/list`, from the credential file, so signing in or out while the
 * server runs is picked up without a restart.
 */
export function listTools(ctx: ToolContext): (ToolDefinition | CloudToolDefinition)[] {
  const tools = TOOLS.filter((t) => offered(t.name, ctx))
  return readCredential(ctx.home) ? [...tools, ...CLOUD_TOOLS] : tools
}

/** restore_text only when the person started the server with it (FR-018). */
function offered(name: string, ctx: ToolContext): boolean {
  return name !== 'restore_text' || ctx.restoreText === true
}

/**
 * Run any tool, the Cloud ones included, which need the network and so answer
 * asynchronously. The offline five run exactly as `callTool` runs them.
 *
 * A Cloud tool called with nobody signed in - listed by an older client, or
 * named from memory - answers with the sign-in sentence and sends nothing.
 */
export async function callToolAsync(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const cloud = CLOUD_TOOLS_BY_NAME.get(name)
  if (!cloud) {
    // A tool that numbers placeholders from the team namespace asks first
    // which project VEILIO_PROJECT names now (see confirmProject).
    if (needsProjectCheck(name, ctx)) await confirmProject()
    return callTool(name, args, ctx)
  }
  if (!readCredential(ctx.home)) return refusalResult(refusal('not_signed_in'))
  try {
    return await cloud.handler(args, ctx)
  } catch (err) {
    if (err instanceof ArgumentError)
      return { text: `${PRODUCT_NAME}: ${err.message}`, isError: true }
    const message = err instanceof Error ? err.message : String(err)
    return { text: `${PRODUCT_NAME}: ${message}`, isError: true }
  }
}

/**
 * Whether a call must be checked against the project VEILIO_PROJECT names now
 * before it runs: it numbers or restores from the team namespace (anonymize,
 * restore), and the server's environment pins a project, whose name can move to another
 * project meanwhile. Without the variable nothing is asked.
 */
function needsProjectCheck(name: string, ctx: ToolContext): boolean {
  return (
    (name.startsWith('anonymize_') || name === 'restore_text') && projectOverride(ctx.env) !== null
  )
}

/** Whether a call answers asynchronously: a Cloud tool, or a masking tool
 *  that first confirms the project the variable names. */
export function isCloudTool(name: string, ctx?: ToolContext): boolean {
  return CLOUD_TOOLS_BY_NAME.has(name) || (ctx !== undefined && needsProjectCheck(name, ctx))
}
