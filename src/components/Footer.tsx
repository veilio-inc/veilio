import { Link } from 'react-router-dom'

const LEGAL: [string, string][] = [
  ['/legal/terms', 'Terms'],
  ['/legal/privacy', 'Privacy'],
  ['/legal/cookies', 'Cookies'],
  ['/legal/aup', 'Acceptable Use'],
]

export default function Footer() {
  return (
    <footer style={{ marginTop: 48 }}>
      <div className="footer-hairline" />
      <div style={{ background: 'rgba(33,27,24,0.5)', padding: '28px 24px 22px' }}>
        <div
          style={{
            maxWidth: 1280,
            margin: '0 auto',
            width: '100%',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 20,
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              {/* The real mark, same /icon.svg the nav and the browser tab use,
                  rather than the abstract gradient square this used to hold.
                  18px, not the 12 the old square sat at: the mark is an editor
                  window with a redacted line on it, and below ~16 that detail
                  collapses into a dash — which is the very shape it replaced. */}
              <img
                src="/icon.svg"
                alt=""
                aria-hidden
                width={18}
                height={18}
                style={{ display: 'block', filter: 'drop-shadow(0 0 8px rgba(204,120,92,0.35))' }}
              />
              <span
                style={{
                  fontFamily: 'var(--font-display)',
                  fontStyle: 'italic',
                  color: 'var(--accent-bright)',
                  fontSize: 17,
                }}
              >
                Veilio
              </span>
              <span className="badge badge-dim">Community Edition</span>
            </div>
            <p
              style={{
                color: 'var(--text-dim)',
                fontSize: 12.5,
                marginTop: 8,
                maxWidth: 320,
              }}
            >
              Your identifiers never leave this browser. Self-hostable and source-available — free
              to use, even commercially. Not for resale.
            </p>
          </div>

          <div
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10 }}
          >
            <nav style={{ display: 'flex', flexWrap: 'wrap', gap: 18, fontSize: 13 }}>
              {LEGAL.map(([to, label]) => (
                <Link key={to} to={to} className="footer-link">
                  {label}
                </Link>
              ))}
              <a
                href="https://github.com/veilio-inc/veilio"
                target="_blank"
                rel="noopener noreferrer"
                className="footer-link"
              >
                GitHub ↗
              </a>
            </nav>
            <span
              style={{ color: 'var(--text-dim)', fontSize: 12, fontFamily: 'var(--font-mono)' }}
            >
              © {new Date().getFullYear()} Veilio
            </span>
          </div>
        </div>
      </div>
    </footer>
  )
}
