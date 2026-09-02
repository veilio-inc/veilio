import { describe, it, expect } from 'vitest'
import { anonymize } from '../src/engine.js'
import { describeLanguage, guessLanguage } from '../src/languages.js'

/**
 * An unsupported file is tokenised with TypeScript's grammar, so identifiers it
 * does not recognise are never masked — and the output looks exactly as
 * confident as a real one. Silence is the wrong failure mode for a privacy tool.
 */

// Genuinely matches no marker in any supported language.
const UNSUPPORTED = `
(defun charge-card (customer-id amount)
  (let ((total (* amount 100)))
    (list :customer customer-id :total total)))
`

// Matches Ruby's markers strongly (def / do / end) and is therefore NOT reported
// as a fallback. See 'what this signal cannot tell you' below.
const ELIXIR = `
defmodule Payments.Charger do
  @moduledoc "Charges cards"
  def charge(customer_id, amount) do
    {:ok, %{customer: customer_id, total: amount}}
  end
end
`

const TYPESCRIPT = `
export interface Payment { id: string }
export function chargeCard(customerId: string): Payment {
  const result = { id: customerId }
  return result
}
`

describe('describeLanguage', () => {
  it('reports a fallback for a language with no markers', () => {
    const { fallback } = describeLanguage(UNSUPPORTED, undefined)
    expect(fallback).toBe(true)
  })

  it('reports no fallback for a language it recognises', () => {
    const { language, fallback } = describeLanguage(TYPESCRIPT, undefined)
    expect(fallback).toBe(false)
    expect(language).toBe('typescript')
  })

  it('never reports a fallback when the caller named the language', () => {
    // FR-004: an explicit language bypasses detection entirely. Warning here
    // would be telling the user we ignored what they told us.
    expect(describeLanguage(UNSUPPORTED, 'python').fallback).toBe(false)
    expect(describeLanguage(UNSUPPORTED, 'python').language).toBe('python')
  })

  it('still consults detection for the explicit "auto"', () => {
    expect(describeLanguage(UNSUPPORTED, 'auto').fallback).toBe(true)
  })

  it('says nothing about an empty or near-empty buffer', () => {
    // FR-005. These score zero for every language, so the raw guess calls them a
    // fallback. Accusing an empty editor of being unsupported is how a warning
    // gets dismissed before it ever matters.
    for (const trivial of ['', '   ', '\n\n', 'x', 'const a = 1']) {
      expect(describeLanguage(trivial, undefined).fallback, JSON.stringify(trivial)).toBe(false)
    }
    // The raw guess still reports it — the narrowing is in describeLanguage, not
    // hidden by weakening guessLanguage.
    expect(guessLanguage('').fallback).toBe(true)
  })
})

describe('the signal reaches the public result', () => {
  it('is on the anonymize result for an unsupported language', () => {
    // FR-001/FR-002: reachable from a pure engine call, so the CLI and MCP get
    // the same fact as the web app rather than each inventing its own.
    expect(anonymize(UNSUPPORTED).languageFallback).toBe(true)
  })

  it('is false for a supported language', () => {
    expect(anonymize(TYPESCRIPT).languageFallback).toBe(false)
  })

  it('is false when the caller named the language', () => {
    expect(anonymize(UNSUPPORTED, { language: 'ruby' }).languageFallback).toBe(false)
  })

  it('does not change what gets masked', () => {
    // FR-006: this reports a pre-existing gap, it does not alter behaviour.
    const before = anonymize(TYPESCRIPT)
    expect(before.identifierCount).toBeGreaterThan(0)
    expect(before.language).toBe('typescript')
  })
})

describe('what this signal cannot tell you', () => {
  // Recorded as a test rather than a comment, so the day detection improves this
  // fails and someone deletes it deliberately.
  //
  // `fallback` means "no marker matched at all". It does NOT mean "we are
  // unsure". A language that superficially resembles a supported one is
  // confidently mis-detected and reports no fallback — measured at the time of
  // writing: Elixir scores 8 as Ruby, Swift 3 as Go, Haskell 2 as SQL.
  //
  // A score threshold cannot separate these: a real Java file scored 3 (and was
  // itself mis-detected as Go), which is the same score as Swift. Any floor that
  // catches Swift also fires on Java. Closing this needs markers for those
  // languages — the roadmap's next story — not a tuned constant.

  it('does not fire for a language that resembles a supported one', () => {
    expect(describeLanguage(ELIXIR, undefined).fallback).toBe(false)
    expect(describeLanguage(ELIXIR, undefined).language).toBe('ruby')
  })

  it('fires only when nothing matched at all', () => {
    expect(guessLanguage(ELIXIR).score).toBeGreaterThan(0)
    expect(guessLanguage(UNSUPPORTED).score).toBe(0)
  })
})
