// Shown when the engine masked a file it does not have a grammar for.
//
// An unsupported file is tokenised with TypeScript's rules, so identifiers that
// grammar does not recognise are simply not masked. The output looks exactly as
// anonymised as a real one — which for a privacy tool is the worst available
// failure mode, and the reason this sits beside the output rather than at the
// top of the page. A warning placed away from the copy action is read after the
// paste it was meant to prevent.

export default function LanguageFallbackNotice({ show }: { show: boolean }) {
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
      the output before sharing it.
    </div>
  )
}
