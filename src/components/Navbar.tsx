import { Link, useLocation } from 'react-router-dom'

export default function Navbar() {
  const location = useLocation()

  return (
    <div className="nav-shell">
      <nav className="nav-pill">
        <Link
          to="/"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            fontFamily: 'var(--font-display)',
            fontSize: 26,
            fontStyle: 'italic',
            color: 'var(--accent-bright)',
            letterSpacing: '-0.01em',
            textShadow: '0 0 24px rgba(204,120,92,0.35)',
          }}
        >
          {/* Veil mark: a redaction bar half-covering a glyph — the brand gesture. */}
          <span
            aria-hidden
            style={{
              width: 16,
              height: 16,
              borderRadius: 5,
              background: 'linear-gradient(135deg, var(--accent-bright), var(--accent-hover))',
              boxShadow: '0 0 14px rgba(204,120,92,0.5), inset 0 0 0 1px rgba(250,247,244,0.25)',
              display: 'inline-block',
            }}
          />
          Veilio
        </Link>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <NavLink to="/" active={location.pathname === '/'}>
            Tool
          </NavLink>
          <NavLink to="/pricing" active={location.pathname === '/pricing'}>
            Pricing
          </NavLink>
          <NavLink to="/dashboard" active={location.pathname === '/dashboard'}>
            Dashboard
          </NavLink>
          <span
            style={{
              marginLeft: 8,
              marginRight: 6,
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-dim)',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 999,
              padding: '2px 9px',
            }}
          >
            CE
          </span>
        </div>
      </nav>
    </div>
  )
}

function NavLink({
  to,
  active,
  children,
}: {
  to: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <Link to={to} className={`nav-link${active ? ' active' : ''}`}>
      {children}
    </Link>
  )
}
