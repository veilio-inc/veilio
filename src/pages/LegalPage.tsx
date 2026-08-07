import { useEffect, useState, type ReactNode } from 'react'
import { useParams, Navigate, Link } from 'react-router-dom'
import Navbar from '../components/Navbar.js'

// Allow-listed legal documents. The slug maps 1:1 to a static file in
// public/legal/<slug>.md, so a user can never coerce LegalPage into fetching
// an arbitrary path.
const DOCS: Record<string, string> = {
  terms: 'Terms of Service',
  privacy: 'Privacy Policy',
  aup: 'Acceptable Use Policy',
  cookies: 'Cookie Policy',
}

export default function LegalPage() {
  const { slug = '' } = useParams()
  const [md, setMd] = useState<string | null>(null)
  const [error, setError] = useState(false)

  const valid = Object.prototype.hasOwnProperty.call(DOCS, slug)

  useEffect(() => {
    if (!valid) return
    setMd(null)
    setError(false)
    fetch(`/legal/${slug}.md`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(setMd)
      .catch(() => setError(true))
  }, [slug, valid])

  if (!valid) return <Navigate to="/" replace />

  return (
    <div className="page">
      <Navbar />
      <div style={{ maxWidth: 800, margin: '0 auto', width: '100%', padding: '36px 24px 80px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
            marginBottom: 20,
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--text-dim)',
            }}
          >
            Legal / <span style={{ color: 'var(--accent)' }}>{DOCS[slug]}</span>
          </span>
          <nav style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {Object.entries(DOCS).map(([s, label]) => (
              <Link key={s} to={`/legal/${s}`} className={`doc-pill${s === slug ? ' active' : ''}`}>
                {label.replace(' Policy', '').replace(' of Service', '')}
              </Link>
            ))}
          </nav>
        </div>

        <div className="surface ticks" style={{ padding: 'clamp(24px, 5vw, 44px)' }}>
          {error && (
            <p style={{ color: 'var(--danger)' }}>
              Could not load this document. Please try again.
            </p>
          )}
          {!error && md === null && (
            <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="skeleton" style={{ height: 30, width: '55%' }} />
              <div className="skeleton" style={{ height: 13, width: '100%' }} />
              <div className="skeleton" style={{ height: 13, width: '92%' }} />
              <div className="skeleton" style={{ height: 13, width: '97%' }} />
              <div className="skeleton" style={{ height: 13, width: '40%' }} />
              <div className="skeleton" style={{ height: 20, width: '35%', marginTop: 16 }} />
              <div className="skeleton" style={{ height: 13, width: '95%' }} />
              <div className="skeleton" style={{ height: 13, width: '88%' }} />
            </div>
          )}
          {md !== null && <article style={{ lineHeight: 1.7 }}>{renderMarkdown(md)}</article>}
        </div>
      </div>
    </div>
  )
}

// ── A small, dependency-free markdown renderer ───────────────────────────────
// Supports the constructs our legal drafts use: # / ## / ### headings, > quotes,
// - / * lists, | tables |, paragraphs, and inline **bold**, _italic_, `code`,
// and [links](url) (relative ./X.md links are rewritten to in-app /legal/x).

function renderMarkdown(md: string): ReactNode[] {
  const lines = md.split('\n')
  const out: ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      i++
      continue
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      const sizes = { 1: 30, 2: 21, 3: 16 } as const
      out.push(
        <div
          key={key++}
          role="heading"
          aria-level={level}
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: sizes[level as 1 | 2 | 3],
            fontWeight: 400,
            lineHeight: 1.25,
            margin: level === 1 ? '0 0 20px' : '28px 0 8px',
            color: 'var(--text-primary)',
          }}
        >
          {renderInline(heading[2])}
        </div>
      )
      i++
      continue
    }

    // Blockquote — group consecutive `>` lines.
    if (/^>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      out.push(
        <blockquote
          key={key++}
          style={{
            borderLeft: '3px solid var(--accent)',
            background: 'var(--accent-dim)',
            padding: '10px 16px',
            margin: '14px 0',
            borderRadius: '0 var(--radius) var(--radius) 0',
            color: 'var(--text-secondary)',
            fontSize: 13.5,
          }}
        >
          {renderInline(buf.join(' '))}
        </blockquote>
      )
      continue
    }

    // List — group consecutive `- ` / `* ` items.
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ''))
        i++
      }
      out.push(
        <ul key={key++} style={{ margin: '8px 0 8px 22px', color: 'var(--text-secondary)' }}>
          {items.map((it, n) => (
            <li key={n} style={{ marginBottom: 4 }}>
              {renderInline(it)}
            </li>
          ))}
        </ul>
      )
      continue
    }

    // Table — group consecutive `|` lines (header, `|---|` separator, body).
    if (/^\s*\|/.test(line)) {
      const rows: string[] = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(lines[i])
        i++
      }
      out.push(renderTable(rows, key++))
      continue
    }

    // Paragraph — group consecutive plain lines.
    const buf: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,3}\s|>\s?|[-*]\s+|\s*\|)/.test(lines[i])
    ) {
      buf.push(lines[i])
      i++
    }
    out.push(
      <p key={key++} style={{ margin: '0 0 14px', color: 'var(--text-secondary)' }}>
        {renderInline(buf.join(' '))}
      </p>
    )
  }

  return out
}

function renderTable(rows: string[], key: number): ReactNode {
  const cells = (row: string) =>
    row
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((c) => c.trim())
  const header = cells(rows[0])
  // rows[1] is the |---|---| separator.
  const body = rows.slice(2).map(cells)
  return (
    <table
      key={key}
      style={{ width: '100%', borderCollapse: 'collapse', margin: '14px 0', fontSize: 13.5 }}
    >
      <thead>
        <tr>
          {header.map((h, n) => (
            <th
              key={n}
              style={{
                textAlign: 'left',
                padding: '8px 10px',
                borderBottom: '1px solid var(--border)',
                color: 'var(--text-primary)',
                fontWeight: 600,
              }}
            >
              {renderInline(h)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((r, rn) => (
          <tr key={rn}>
            {r.map((c, cn) => (
              <td
                key={cn}
                style={{
                  padding: '8px 10px',
                  borderBottom: '1px solid var(--border)',
                  color: 'var(--text-secondary)',
                  verticalAlign: 'top',
                }}
              >
                {renderInline(c)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const INLINE = /(\[([^\]]+)\]\(([^)]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(_([^_]+)_)/g

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  INLINE.lastIndex = 0
  while ((m = INLINE.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    if (m[1]) {
      // Link — rewrite a relative ./Doc.md reference to its in-app route.
      let href = m[3]
      const rel = /^\.\/(\w+)\.md$/i.exec(href)
      if (rel) href = `/legal/${rel[1].toLowerCase()}`
      const external = /^https?:/i.test(href)
      nodes.push(
        <a
          key={key++}
          href={href}
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          style={{ color: 'var(--accent)' }}
        >
          {m[2]}
        </a>
      )
    } else if (m[4]) {
      nodes.push(
        <code
          key={key++}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.9em',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '1px 5px',
          }}
        >
          {m[5]}
        </code>
      )
    } else if (m[6]) {
      nodes.push(
        <strong key={key++} style={{ color: 'var(--text-primary)' }}>
          {m[7]}
        </strong>
      )
    } else if (m[8]) {
      nodes.push(<em key={key++}>{m[9]}</em>)
    }
    last = INLINE.lastIndex
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}
