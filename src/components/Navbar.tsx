import { Link, useLocation } from 'react-router-dom'

export default function Navbar() {
  const location = useLocation()

  return (
    <nav
      style={{
        background: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border)',
        padding: '0 24px',
        height: 52,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        position: 'sticky',
        top: 0,
        zIndex: 100,
      }}
    >
      <Link
        to="/"
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 24,
          fontWeight: 700,
          fontStyle: 'italic',
          color: 'var(--accent)',
          letterSpacing: '-0.01em',
        }}
      >
        SCRUBR
      </Link>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-dim)',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '2px 7px',
          }}
        >
          CE
        </span>
      </div>
    </nav>
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
    <Link
      to={to}
      style={{
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontSize: 14,
        padding: '4px 10px',
        borderRadius: 'var(--radius)',
        background: active ? 'var(--bg-elevated)' : 'transparent',
        transition: 'all 0.15s',
      }}
    >
      {children}
    </Link>
  )
}
