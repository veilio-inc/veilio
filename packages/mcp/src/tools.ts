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

import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import {
  detectSecrets,
  isPlaceholder,
  restore,
  restoreLayers,
  disputedNote,
  locallyNumberedNote,
  summarizeSecrets,
  withAiPreamble,
  BIN_NAME,
  LANGUAGES,
  LANGUAGE_LABELS,
  PRODUCT_NAME,
  type RestoreReport,
  type SecretFinding,
  alteredNote,
} from '@veilio-inc/engine'
import { loadMap, resolveMapPath, saveMap } from '@veilio-inc/cli/store'
import { getNamespace, namespaceLine, refreshNamespaceIfStale } from './namespace.js'
import { teamLayerNote } from '@veilio-inc/cli/team-namespace'
import { anonymizeOverTeam } from '@veilio-inc/cli/team-anonymize'

/** Said when a tool call has just started reloading the team's maps. */
function loadingNote(why: 'unlocked' | 'retrying'): string {
  return why === 'unlocked'
    ? "Note: the team key was unlocked - loading the team's maps now; call again in a moment to use them."
    : "Note: asking Cloud for the team's maps again; call again in a moment to use them."
}
import { getRules, type ResolvedRules } from './rules.js'
import { describeAge } from '@veilio-inc/cli/rules'

export interface ToolContext {
  /** Root the server is allowed to read from. */
  cwd: string
  /** Override for the symbol-map location; null uses the project store. */
  mapPath: string | null
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
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/** Where a path really leads, links and junctions followed; undefined when it
 *  does not exist, which the read that follows reports. */
function realPath(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** Resolve a caller-supplied path and refuse anything outside `cwd`.
 *  The server reads files on the agent's behalf, so path traversal here would
 *  turn it into an arbitrary-file-read primitive.
 *
 *  Checked twice: as written, and where it really leads. A link committed to a
 *  repository, or a Windows junction, sits inside the root as text and points
 *  outside it, and the text check alone let the server read the target. */
function safeResolve(path: string, cwd: string): string {
  const abs = isAbsolute(path) ? path : resolve(cwd, path)
  const outside = new ToolError(`path "${path}" is outside the project root`)
  if (!isInside(cwd, abs)) throw outside
  const realTarget = realPath(abs)
  if (realTarget !== undefined && !isInside(realPath(cwd) ?? cwd, realTarget)) throw outside
  return realTarget ?? abs
}

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
    const abs = safeResolve(path, ctx.cwd)
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
  ctx: ToolContext
): ToolResult {
  const mapPath = resolveMapPath(ctx.mapPath, ctx.cwd)
  const localMap = loadMap(mapPath)
  const refreshing = refreshNamespaceIfStale()
  const resolved = getNamespace()
  const { namespace, highest, conflicts } = resolved
  const language = (str(args, 'language') ?? 'auto') as 'auto'
  const rules = getRules()
  // The same composition `veilio scrub` uses (spec 030): the team's maps over
  // this project's, new names above both, and only the team entries the output
  // uses kept in the store.
  const { result, toPersist } = anonymizeOverTeam(
    source,
    localMap,
    { namespace, highest, conflicts },
    {
      language,
      secrets: 'redact',
      rules: rules.rules,
    }
  )
  saveMap(mapPath, toPersist)

  const body =
    args.preamble === true ? withAiPreamble(result.anonymized, result.map) : result.anonymized
  // The model reading this is about to reason over the masked text, and these
  // two lines are the only place it can learn what the masking did NOT cover.
  // The engine puts both on every result precisely so this server does not have
  // to decide for itself; dropping them here would leave an agent believing the
  // output is clean when a name is sitting in a comment inside it.
  const caveats: string[] = []
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
      `locally so restore_text can reverse it later.`,
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
      const abs = safeResolve(path, ctx.cwd)
      let source: string
      try {
        source = readFileSync(abs, 'utf8')
      } catch {
        throw new ToolError(`cannot read "${path}"`)
      }
      return runAnonymize(source, path, args, ctx)
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
      `AI-generated noise (JSDoc, TODO comments, narration). Use this on a reply that came back ` +
      `containing placeholders. Note that irreversibly redacted credentials stay redacted — ` +
      `that is deliberate.`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text containing placeholders.' },
        strict: {
          type: 'boolean',
          description:
            'Refuse instead of returning text that still holds a placeholder (invented, ' +
            "altered, disputed, or the team's maps unreadable): an error naming them, and no text.",
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    handler: (args, ctx) => {
      const text = str(args, 'text', true)
      const strict = bool(args, 'strict')
      const own = loadMap(resolveMapPath(ctx.mapPath, ctx.cwd))
      // The one restore rule (spec 028), shared with the web app and the CLI:
      // the team's maps - aliases included, disputed placeholders left out -
      // then this project's map on top where it is in the team's numbering.
      const refreshing = refreshNamespaceIfStale()
      const resolved = getNamespace()
      const team =
        resolved.source === 'team' && resolved.conflictDetection
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
      const disputed = layers.disputedIn(text)
      const localOnly = layers.locallyNumberedIn(text)
      const result = restore(text, layers.map)
      // Measured against this project's map, not the whole team layer (review),
      // and a placeholder left for a named reason is not "invented".
      const report: RestoreReport = {
        ...result.report,
        missing: result.report.missing.filter((p) => p in own),
        unresolved: result.report.unresolved.filter(
          (p) => !disputed.includes(p) && !localOnly.includes(p)
        ),
      }
      const counted = new Set([...Object.keys(own), ...result.report.resolved]).size
      const altered = result.report.altered
      const left = [...report.unresolved, ...disputed, ...localOnly, ...altered]
      const warnings = [
        ...(refreshing ? [loadingNote(refreshing)] : []),
        ...(note ? [`WARNING: ${note}`] : []),
        ...(disputed.length ? [`WARNING: ${disputedNote(disputed)}`] : []),
        ...(localOnly.length ? [`WARNING: ${locallyNumberedNote(localOnly)}`] : []),
        ...(altered.length ? [`WARNING: ${alteredNote(altered)}`] : []),
      ]
      // Unrestored team placeholders because the team's maps could not be used
      // (locked, unreadable): not a success, whatever else restored (FR-005).
      const failed = found.status === 'locked' || found.status === 'unavailable'
      // strict: nothing that still holds a placeholder is handed back (the CLI's
      // --strict, the same rule). A credential redacted on purpose is not one.
      // A placeholder the team's maps were needed for is in `left` already.
      if (strict && left.length > 0) {
        return {
          isError: true,
          text:
            `Restored ${result.report.resolved.length} of ${counted} placeholders.` +
            `${restoreReportLines(report)}` +
            `${warnings.length ? `\n\n${warnings.join('\n')}` : ''}\n\n` +
            `strict: the restored text is withheld - ${left.join(', ')} would have been left in it.`,
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
      `context (findings carry truncated previews only). Run this on a file before reading it, ` +
      `or on a diff before committing.`,
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
      const findings = detectSecrets(text)
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
  const tool = TOOLS_BY_NAME.get(name)
  if (!tool) return { text: `Unknown tool "${name}".`, isError: true }
  try {
    return tool.handler(args, ctx)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { text: `${PRODUCT_NAME}: ${message}`, isError: true }
  }
}
