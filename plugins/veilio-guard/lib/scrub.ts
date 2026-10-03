// The engine, as the guard uses it (spec 033, research R3).
//
// scrubSource: a source file the model reads. The engine's tokenizer masks
//   every identifier, reusing the map's placeholders, and reports the new
//   entries for the map file.
// applyMap: everything else - shell output, search results, prompts,
//   reminders. Only names the map already has are replaced, and credentials
//   are removed. No entries are added: fed to the tokenizer, a log would fill
//   the map with English words. Everyday words from string literals are left.
// restoreArgs: the model's arguments, with the real names put back and nothing
//   else changed. The caller decides what an unknown placeholder means.
import {
  anonymize,
  detectSecrets,
  restore,
  scanSecrets,
  SECRET_DISPOSITIONS,
} from '../vendor/engine/index.js'
import type { LanguageOption } from '../vendor/engine/index.js'

export type SymbolMap = Record<string, string>

export function scrubSource(
  text: string,
  map: SymbolMap,
  language: LanguageOption = 'auto'
): { text: string; additions: SymbolMap } {
  const result = anonymize(text, { existingMap: map, language })
  const additions: SymbolMap = {}
  for (const [placeholder, name] of Object.entries(result.map)) {
    if (map[placeholder] !== name) additions[placeholder] = name
  }
  return { text: result.anonymized, additions }
}

const WORD = /[A-Za-z0-9_$]/

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// One alternation per map, longest name first, so a name inside a longer one
// is never half-replaced. Cached by the map object: the guard keeps one map
// object until it changes.
const compiled = new WeakMap<SymbolMap, { re: RegExp | null; byName: Map<string, string> }>()

function matcher(map: SymbolMap) {
  let c = compiled.get(map)
  if (!c) {
    const byName = new Map<string, string>()
    for (const [placeholder, name] of Object.entries(map))
      if (name !== '' && !everydayWord(placeholder, name)) byName.set(name, placeholder)
    const names = [...byName.keys()].sort((a, b) => b.length - a.length)
    c = { re: names.length ? new RegExp(names.map(escape).join('|'), 'g') : null, byName }
    compiled.set(map, c)
  }
  return c
}

// A word from a string literal that is an everyday word (`the`, `keep`,
// `Placeholder`) is masked where the engine finds it, inside a literal in a
// source file. In output and prompts it is English, and masking it there turns
// a git log into placeholders. One shaped like a name (`customer_refunds`,
// `apiV2`) is still masked everywhere. Identifiers are masked everywhere, so a
// prompt naming `reconcile` matches the code the model reads.
function everydayWord(placeholder: string, name: string): boolean {
  return placeholder.startsWith('__STR__') && /^[A-Za-z][a-z]*$/.test(name)
}

function replaceNames(text: string, map: SymbolMap): string {
  const { re, byName } = matcher(map)
  if (!re) return text
  return text.replace(re, (name, offset: number) => {
    // A whole token only: `settledTotal` in `settledTotals` is another name.
    const before = text[offset - 1]
    const after = text[offset + name.length]
    if (WORD.test(name.charAt(0)) && before !== undefined && WORD.test(before)) return name
    if (WORD.test(name.charAt(name.length - 1)) && after !== undefined && WORD.test(after))
      return name
    return byName.get(name) ?? name
  })
}

export function applyMap(text: string, map: SymbolMap): string {
  const named = replaceNames(text, map)
  const scan = scanSecrets(named, 'redact')
  let out = scan.code
  // A regulated number (an IBAN, a card, a PESEL) the map does not have yet:
  // output adds no entries, so it is removed, irreversibly.
  for (const span of scan.regulated) {
    const token = `__REDACTED_${span.type.toUpperCase().replace(/[^A-Z0-9]/g, '_')}__`
    out = out.split(span.value).join(token)
  }
  return out
}

/** Credentials still in text the guard is about to hand the model. */
export function survivingSecrets(text: string): string[] {
  return detectSecrets(text)
    .filter((f) => SECRET_DISPOSITIONS[f.type] !== 'report')
    .map((f) => f.type)
}

export function restoreArgs(
  text: string,
  map: SymbolMap
): { text: string; unresolved: string[]; altered: string[] } {
  const r = restore(text, map, { strip: 'none' })
  return { text: r.restored, unresolved: r.report.unresolved, altered: r.report.altered }
}
