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

import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import {
  anonymize,
  detectSecrets,
  isPlaceholder,
  restore,
  summarizeSecrets,
  withAiPreamble,
  BIN_NAME,
  LANGUAGES,
  LANGUAGE_LABELS,
  PRODUCT_NAME,
  type RestoreReport,
  type SecretFinding,
} from '@veilio-inc/engine'
import { loadMap, resolveMapPath, saveMap } from '@veilio/cli/store'

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

/** Resolve a caller-supplied path and refuse anything outside `cwd`.
 *  The server reads files on the agent's behalf, so path traversal here would
 *  turn it into an arbitrary-file-read primitive. */
function safeResolve(path: string, cwd: string): string {
  const abs = isAbsolute(path) ? path : resolve(cwd, path)
  const rel = relative(cwd, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ToolError(`path "${path}" is outside the project root`)
  }
  return abs
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
  const existingMap = loadMap(mapPath)
  const language = (str(args, 'language') ?? 'auto') as 'auto'
  const result = anonymize(source, { existingMap, language, secrets: 'redact' })
  saveMap(mapPath, result.map)

  const body =
    args.preamble === true ? withAiPreamble(result.anonymized, result.map) : result.anonymized
  const notes = [
    `Source: ${label}`,
    `Language: ${LANGUAGE_LABELS[result.language]}`,
    `Placeholders in map: ${Object.keys(result.map).length}`,
    secretSummary(result.secrets),
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
      },
      required: ['text'],
      additionalProperties: false,
    },
    handler: (args, ctx) => {
      const text = str(args, 'text', true)
      const map = loadMap(resolveMapPath(ctx.mapPath, ctx.cwd))
      if (Object.keys(map).length === 0) {
        throw new ToolError(`no symbol map yet — run anonymize_file (or "${BIN_NAME} scrub") first`)
      }
      const result = restore(text, map)
      return {
        text:
          `Restored ${result.report.resolved.length} of ${Object.keys(map).length} placeholders; ` +
          `stripped ${result.strippedCount} AI artifact(s).` +
          `${restoreReportLines(result.report)}\n\n--- restored ---\n${result.restored}`,
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
