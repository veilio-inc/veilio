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
          {/* The mark, not a stand-in for one: this is the same /icon.svg the
              browser puts in the tab, so the nav and the tab can never drift.
              22px rather than the old 16 — the window detail needs the room. */}
          <img
            src="/icon.svg"
            alt=""
            aria-hidden
            width={22}
            height={22}
            style={{
              display: 'block',
              filter: 'drop-shadow(0 0 10px rgba(204,120,92,0.35))',
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
