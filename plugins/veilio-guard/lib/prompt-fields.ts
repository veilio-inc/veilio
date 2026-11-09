// Spec 083 (research R1): which fields of a prompt and of a slash command the
// guard knows. Read from Claude Code
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

/** `command.run`'s fields: `args` is masked, the rest is metadata. */
export const KNOWN_COMMAND_FIELDS: ReadonlySet<string> = new Set([
  'command',
  'args',
  'origin',
  'presentation',
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

/** The first field of a prompt (or of a command) the guard does not know
 *  that holds text. */
export function unknownTextField(
  e: Readonly<Record<string, unknown>>,
  known: ReadonlySet<string> = KNOWN_PROMPT_FIELDS
): string | undefined {
  return Object.keys(e).find((k) => !known.has(k) && holdsText(e[k]))
}

const PLACEHOLDER = /__[A-Z][A-Z0-9_]*?__\d*/g

const counted = (texts: readonly string[]) => {
  const n = new Map<string, number>()
  for (const p of texts.flatMap((t) => t.match(PLACEHOLDER) ?? [])) n.set(p, (n.get(p) ?? 0) + 1)
  return n
}

/** How many placeholders masking put in: those the masked texts hold more
 *  often than the given ones. Asked only when masking changed a text, so at
 *  least 1 (a secret removed, or a name masked to a placeholder already there). */
export function maskedNames(given: readonly string[], masked: readonly string[]): number {
  const before = counted(given)
  const added = [...counted(masked)].filter(([p, n]) => n > (before.get(p) ?? 0)).length
  return Math.max(1, added)
}

/** strings.md #4. */
export function unknownFieldRefusal(field: string): string {
  return `Veilio did not send this prompt: it carries \`${field}\`, which this version of the guard cannot check. Update the guard (\`claude plugin marketplace update veilio\`, then \`claude plugin update veilio-guard@veilio\`), then send it again.`
}

/** strings.md #4a (founder, 2026-11-09). */
export function unseenPromptRefusal(n: number): string {
  return `Veilio did not send this message: Claude Code does not let the guard mask a message it sends on its own at the start of a turn, and this one names ${n} masked names.`
}

/** Pending approval (second review of spec 083): a slash command's line the
 *  host would send unmasked. */
export const COMMAND_LINE_REFUSED =
  'Veilio did not send this prompt: Claude Code does not let the guard mask the line of a slash command, and this one holds names the guard masks.'

/** strings.md #5. */
export function attachedNotice(n: number): string {
  return `Veilio cannot mask images, audio or documents: the ${n} attached to this prompt went to the model as they are. Text you type is still masked.`
}
