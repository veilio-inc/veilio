import { Link, useLocation } from 'react-router-dom'

export default function Navbar() {
  const location = useLocation()

  return (
    <nav
      style={{
        background: 'rgba(28,25,23,0.72)',
        backdropFilter: 'blur(14px) saturate(140%)',
        WebkitBackdropFilter: 'blur(14px) saturate(140%)',
        borderBottom: '1px solid var(--border)',
        boxShadow: '0 1px 0 rgba(204,120,92,0.10), 0 8px 24px -16px rgba(0,0,0,0.8)',
        padding: '0 24px',
        height: 56,
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
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          fontFamily: 'var(--font-display)',
          fontSize: 25,
          fontWeight: 700,
          fontStyle: 'italic',
          color: 'var(--accent)',
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
            borderRadius: 4,
            background: 'linear-gradient(135deg, var(--accent), var(--accent-hover))',
            boxShadow: '0 0 14px rgba(204,120,92,0.5), inset 0 0 0 1px rgba(250,249,247,0.25)',
            display: 'inline-block',
          }}
        />
        Veilio
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
        color: active ? 'var(--accent)' : 'var(--text-secondary)',
        fontSize: 14,
        fontWeight: active ? 600 : 400,
        padding: '5px 11px',
        borderRadius: 'var(--radius)',
        background: active ? 'var(--accent-dim)' : 'transparent',
        boxShadow: active ? 'inset 0 0 0 1px rgba(204,120,92,0.30)' : 'none',
        transition: 'all 0.15s',
      }}
    >
      {children}
    </Link>
  )
}
