import type { RestoreReport } from '@veilio-inc/engine'

interface Props {
  report: RestoreReport
}

function TokenList({ tokens }: { tokens: string[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, paddingLeft: 16 }}>
      {tokens.slice(0, 12).map((t) => (
        <span
          key={t}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-dim)',
            background: 'var(--bg-elevated)',
            padding: '3px 7px',
            borderRadius: 4,
          }}
        >
          {t}
        </span>
      ))}
      {tokens.length > 12 && (
        <span style={{ fontSize: 11, color: 'var(--text-dim)', alignSelf: 'center' }}>
          +{tokens.length - 12} more
        </span>
      )}
    </div>
  )
}

function Section({
  color,
  title,
  explanation,
  tokens,
}: {
  color: string
  title: string
  explanation: string
  tokens: string[]
}) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: color,
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{title}</span>
      </div>
      <TokenList tokens={tokens} />
      <p
        style={{
          fontSize: 11,
          color: 'var(--text-dim)',
          margin: '6px 0 0',
          paddingLeft: 16,
          lineHeight: 1.6,
        }}
      >
        {explanation}
      </p>
    </div>
  )
}

/** What the round trip actually recovered.
 *
 *  A model is asked to echo placeholders verbatim and is under no obligation to
 *  comply. When it renames one, `restore()` has nothing to substitute and hands
 *  back confident-looking code with the model's invention where a real name
 *  belonged — indistinguishable, in the output alone, from a clean run. This
 *  panel is the only place that difference is visible.
 *
 *  Severity is deliberately split. `unresolved` is always wrong: the text now
 *  carries a token that means nothing. `missing` is usually innocent — a model
 *  answering about one function omits the rest of the file — so it is presented
 *  as information rather than as a failure. Ranking both as warnings would make
 *  the panel noise, and a panel people dismiss is worse than no panel. */
export default function RestoreReportPanel({ report }: Props) {
  const { resolved, missing, unresolved } = report
  const total = resolved.length + missing.length

  if (total === 0 && unresolved.length === 0) return null

  const clean = missing.length === 0 && unresolved.length === 0

  return (
    <div className="surface" style={{ overflow: 'hidden' }}>
      <div
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          Round trip
        </span>
        <span
          className="badge"
          style={{
            background: clean ? 'rgba(91, 169, 139, 0.15)' : 'var(--danger-dim)',
            color: clean ? 'var(--success)' : 'var(--danger)',
          }}
        >
          {resolved.length} / {total} restored
        </span>
      </div>

      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {clean && (
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>
            Every placeholder came back exactly as it was sent.
          </p>
        )}

        {unresolved.length > 0 && (
          <Section
            color="var(--danger)"
            title={`${unresolved.length} token${unresolved.length === 1 ? '' : 's'} the map cannot explain`}
            explanation="The model invented or altered these. They correspond to nothing and are still in your output — replace them by hand."
            tokens={unresolved}
          />
        )}

        {missing.length > 0 && (
          <Section
            color="var(--text-dim)"
            title={`${missing.length} placeholder${missing.length === 1 ? '' : 's'} did not come back`}
            explanation="Expected if the reply only covered part of your code. If it covered all of it, the model renamed them — check those spots, because the real names are not recoverable from this response."
            tokens={missing}
          />
        )}
      </div>
    </div>
  )
}
