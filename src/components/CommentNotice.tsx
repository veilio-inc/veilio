import type { CommentExposure } from '@veilio-inc/engine'
import { SEVERITY_STYLE, severityBadgeStyle } from '../lib/severityStyle.js'

// 004-b3. The engine masks identifiers, not meaning — so the sentence naming a
// customer, an incident or a colleague leaves exactly as typed. That trade is
// right and it is not going to change: masking prose produces ciphertext that
// reads as obfuscation and trips downstream-AI refusals.
//
// What this panel changes is that the trade stops being invisible. It sits
// above the output, next to the copy action, because a warning read after the
// paste has already failed.
//
// Two things it deliberately does NOT do:
//
//   - Claim urgency. It never says a comment IS sensitive, because the engine
//     cannot know that, and a badge that overstates is one people stop reading.
//   - Interrupt. No `role="alert"`, at any grade. Nearly every real file has a
//     comment beside code, so an alert here would fire on almost every paste —
//     which is the audible version of the crying wolf 001-b1 removed.

/** Long enough that the amount is worth naming rather than just the count. Below
 *  this a character figure adds a number without adding information. */
const WORTH_QUANTIFYING = 200

function volume(characters: number): string {
  if (characters < WORTH_QUANTIFYING) return ''
  const approx =
    characters < 1000 ? `${Math.round(characters / 50) * 50}` : `${(characters / 1000).toFixed(1)}k`
  return ` — roughly ${approx} characters of prose`
}

export default function CommentNotice({ exposure }: { exposure: CommentExposure }) {
  // FR-003. Nothing left unmasked, nothing to say. A panel that appears on every
  // paste regardless of content is furniture, and furniture is not read.
  if (exposure.total === 0) return null

  const style = SEVERITY_STYLE[exposure.severity]
  const { total, inline } = exposure
  const noun = total === 1 ? 'comment' : 'comments'

  // The grade is positional, not semantic: a licence header sits above the code
  // and is almost never sensitive, a note written beside a function is where
  // incidents and names actually get written down.
  const where =
    inline === 0
      ? `${total} ${noun} above the code`
      : inline === total
        ? `${total} ${noun}`
        : `${total} ${noun}, ${inline} of them beside code`

  return (
    <section
      aria-label="Comment prose"
      style={{
        border: `1px solid ${style.border}`,
        background: style.background,
        borderRadius: 8,
        padding: '12px 16px',
        marginBottom: 16,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 6,
          flexWrap: 'wrap',
        }}
      >
        <span style={severityBadgeStyle(exposure.severity)}>{style.label}</span>
        <strong style={{ fontSize: 13 }}>{where} left as written</strong>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          — comment text is never masked{volume(exposure.characters)}.
        </span>
      </div>
      {/* Acceptance scenario 3: say what to do. A risk with no next step is an
          apology, and the user closes it the same way either time. */}
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6 }}>
        Names, customers and ticket numbers written in comments go out exactly as typed. Select any
        term in the anonymized panel and choose <strong>Mask selection</strong> to replace it
        everywhere it appears — or delete the comment before you copy.
      </p>
    </section>
  )
}
