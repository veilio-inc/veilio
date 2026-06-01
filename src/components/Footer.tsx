import { Link } from 'react-router-dom'

const LEGAL: [string, string][] = [
  ['/legal/terms', 'Terms'],
  ['/legal/privacy', 'Privacy'],
  ['/legal/cookies', 'Cookies'],
  ['/legal/aup', 'Acceptable Use'],
]

export default function Footer() {
  return (
    <footer
      style={{
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-surface)',
        padding: '20px 24px',
      }}
    >
      <div
        style={{
          maxWidth: 1280,
          margin: '0 auto',
          width: '100%',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'var(--text-dim)', fontSize: 13 }}>
          <span
            aria-hidden
            style={{
              width: 12,
              height: 12,
              borderRadius: 3,
              background: 'linear-gradient(135deg, var(--accent), var(--accent-hover))',
              boxShadow: '0 0 10px rgba(204,120,92,0.4)',
            }}
          />
          <span style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', color: 'var(--accent)', fontSize: 15 }}>
            Veilio
          </span>
          <span>© {new Date().getFullYear()}</span>
        </div>

        <nav style={{ display: 'flex', flexWrap: 'wrap', gap: 18, fontSize: 13 }}>
          {LEGAL.map(([to, label]) => (
            <Link key={to} to={to} className="footer-link">
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  )
}
