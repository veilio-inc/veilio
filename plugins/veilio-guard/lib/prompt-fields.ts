// Spec 083 (research R1, R2): which fields of a prompt the guard knows, and
// which slash commands take only a path or a setting. Read from Claude Code
// 2.1.319's mod API (specs/083-review-leftovers/contracts/prompt-fields.md).

/** `prompt.submit`'s fields: `text` and `context` are masked, `command` is
 *  masked at `command.run`, `attachments` cannot be read, the rest is
 *  metadata the model does not read. */
export const KNOWN_PROMPT_FIELDS: ReadonlySet<string> = new Set([
  'text',
  'context',
  'command',
  'attachments',
  'isMeta',
  'turnId',
  'wait',
  'origin',
])

/** Built-in commands whose arguments are a path, a name or a setting, run as
 *  typed. Any other command's arguments are masked: a wrong entry here only
 *  mis-masks a path, a missing one never leaks. */
export const LOCAL_COMMANDS: ReadonlySet<string> = new Set([
  'add-dir',
  'export',
  'rename',
  'resume',
  'model',
  'effort',
  'config',
  'permissions',
  'plugin',
  'mcp',
])

const MAX_DEPTH = 8

/** Whether a value holds a string anywhere inside it; past MAX_DEPTH it is
 *  taken to, so a deep value fails closed. */
export function holdsText(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return true
  if (value === null || typeof value !== 'object') return false
  if (depth >= MAX_DEPTH) return true
  return Object.values(value).some((v) => holdsText(v, depth + 1))
}

/** The first field of a prompt the guard does not know that holds text. */
export function unknownTextField(e: Readonly<Record<string, unknown>>): string | undefined {
  return Object.keys(e).find((k) => !KNOWN_PROMPT_FIELDS.has(k) && holdsText(e[k]))
}

const PLACEHOLDER = /__[A-Z][A-Z0-9_]*?__\d*/g

/** How many placeholders the masked texts hold that the given ones did not:
 *  the names masking put in. */
export function maskedNames(given: readonly string[], masked: readonly string[]): number {
  const before = new Set(given.flatMap((t) => t.match(PLACEHOLDER) ?? []))
  const after = new Set(masked.flatMap((t) => t.match(PLACEHOLDER) ?? []))
  return [...after].filter((p) => !before.has(p)).length
}

/** strings.md #4. */
export function unknownFieldRefusal(field: string): string {
  return `Veilio did not send this prompt: it carries \`${field}\`, which this version of the guard cannot check. Update the guard (\`claude plugin marketplace update veilio\`, then \`claude plugin update veilio-guard@veilio\`), then send it again.`
}

/** strings.md #4a (founder, 2026-11-09). */
export function unseenPromptRefusal(n: number): string {
  return `Veilio did not send this message: Claude Code does not let the guard mask a message it sends on its own at the start of a turn, and this one names ${n} masked names.`
}

/** strings.md #5. */
export function attachedNotice(n: number): string {
  return `Veilio cannot mask images, audio or documents: the ${n} attached to this prompt went to the model as they are. Text you type is still masked.`
}
