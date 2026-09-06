// Shown when the engine masked a file it does not have a grammar for.
//
// An unsupported file is tokenised with TypeScript's rules, so identifiers that
// grammar does not recognise are simply not masked. The output looks exactly as
// anonymised as a real one — which for a privacy tool is the worst available
// failure mode, and the reason this sits beside the output rather than at the
// top of the page. A warning placed away from the copy action is read after the
// paste it was meant to prevent.
//
// ROADMAP B4, User Story 2: the warning is a dead end without a way to act on
// it — `resolveLanguage` already honours an explicit `language`, this just
// surfaces it here. Deliberately not a refusal: spec 002-b4 records that as a
// non-goal — masking still ran, and a partial mask the reader knows is partial
// is still useful.

import { LANGUAGES, LANGUAGE_LABELS, type Language } from '@veilio-inc/engine'

export default function LanguageFallbackNotice({
  show,
  onSelectLanguage,
}: {
  show: boolean
  onSelectLanguage: (language: Language) => void
}) {
  if (!show) return null
  return (
    <div
      role="status"
      style={{
        border: '1px solid rgba(217, 137, 104, 0.5)',
        background: 'rgba(217, 137, 104, 0.09)',
        borderRadius: 8,
        padding: '10px 14px',
        marginBottom: 10,
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      <strong>This language is not one we recognise.</strong> It was processed with the default
      rules, so <strong>masking is partial</strong> — some identifiers are likely still real. Check
      the output before sharing it, or tell us the real language:{' '}
      <select
        aria-label="Actual language"
        defaultValue=""
        onChange={(e) => {
          const value = e.target.value
          if (value) onSelectLanguage(value as Language)
        }}
        style={{
          font: 'inherit',
          fontSize: 12,
          padding: '2px 4px',
          borderRadius: 4,
          border: '1px solid var(--border)',
          background: 'var(--bg-elevated)',
          color: 'var(--text-primary)',
        }}
      >
        <option value="" disabled>
          Choose…
        </option>
        {LANGUAGES.map((lang) => (
          <option key={lang} value={lang}>
            {LANGUAGE_LABELS[lang]}
          </option>
        ))}
      </select>
    </div>
  )
}
