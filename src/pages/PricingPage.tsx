import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar.js'

const CLOUD_URL = import.meta.env.VITE_VEILIO_CLOUD_URL ?? 'https://veilio.dev'
const ENTERPRISE_CONTACT = 'mailto:hello@veilio.dev'

type PlanId = 'free' | 'pro' | 'team' | 'enterprise'
type CtaType = 'tool' | 'cloud' | 'mailto'

interface PlanCard {
  name: string
  price: string
  period: string
  tagline: string
  features: string[]
  cta: string
  highlight: boolean
  badge?: string
  planId: PlanId
  ctaType: CtaType
}

// Mirrors Veilio Cloud's four tiers. In the Community Edition, Free is what
// you're self-hosting; the paid tiers live on Veilio Cloud, so their CTAs link
// out rather than running checkout (there's no billing in the CE).
const PLANS: PlanCard[] = [
  {
    name: 'Free',
    price: '$0',
    period: 'forever',
    tagline: 'Everything you need to protect your code. Self-hosted, MIT licensed.',
    features: [
      'Full anonymize / restore tool',
      'Stripped metadata panel',
      'Session maps (browser memory)',
      'Local localStorage maps',
      'Export / import .veilio files',
      'Self-host: run your own instance',
    ],
    cta: 'Open the tool',
    highlight: false,
    badge: 'You are here',
    planId: 'free',
    ctaType: 'tool',
  },
  {
    name: 'Pro',
    price: '$9',
    period: 'per user, per month',
    tagline: 'Cloud sync, custom rules, and the browser extension — for one developer.',
    features: [
      'Everything in Free',
      'Unlimited cloud maps',
      'Cross-device history sync',
      'Custom rules',
      'Browser extension',
      'Email support',
    ],
    cta: 'Get Pro on Cloud →',
    highlight: false,
    planId: 'pro',
    ctaType: 'cloud',
  },
  {
    name: 'Team',
    price: '$19',
    period: 'per seat, per month',
    tagline: 'Shared dictionaries, SSO, and audit — for a team.',
    features: [
      'Everything in Pro',
      'Team shared maps',
      'Team member invites',
      'SSO (Google / Microsoft)',
      'Audit log',
      'Shared dictionaries',
      'Policy console',
      'Priority support',
    ],
    cta: 'Get Team on Cloud →',
    highlight: true,
    badge: 'Most popular',
    planId: 'team',
    ctaType: 'cloud',
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: 'talk to us',
    tagline: 'Compliance, SAML, on-prem. SLA-backed.',
    features: [
      'Everything in Team',
      'SAML SSO',
      'SIEM export',
      'On-prem deployment',
      'Dedicated success manager',
      '99.9% SLA',
    ],
    cta: 'Contact us',
    highlight: false,
    planId: 'enterprise',
    ctaType: 'mailto',
  },
]

const FAQS = [
  {
    q: 'What is the Community Edition?',
    a: 'CE is the MIT-licensed, self-hostable version of Veilio. It includes the full anonymize/restore engine, .veilio file export/import, and localStorage map persistence. No backend, no accounts, no data leaves your machine.',
  },
  {
    q: 'How do I save maps permanently in CE?',
    a: 'Maps are stored in your browser\'s localStorage by default. For durable backups — or to move a map to another device — use "Export .veilio" to save a passphrase-encrypted file to disk, then "Import .veilio" to load it back.',
  },
  {
    q: 'What does the Cloud edition add?',
    a: 'Cloud has four tiers. Free is the same engine as CE, hosted, with limited cloud-map storage. Pro adds unlimited cloud sync, custom rules, and the browser extension for $9/user/mo. Team ($19/seat/mo) adds shared maps, SSO, and audit. Enterprise (custom) adds SAML, SIEM export, and on-prem. The anonymizer engine is identical across all editions — only persistence and team features differ.',
  },
  {
    q: 'Is my source code ever sent anywhere in CE?',
    a: 'No. The engine runs entirely in your browser. Source code, identifier names, and symbol maps never leave your machine. Even .veilio files are encrypted client-side before being written to disk.',
  },
  {
    q: 'How is the .veilio file encrypted?',
    a: 'AES-256-GCM with a key derived from your passphrase via PBKDF2 (100,000 iterations, SHA-256). The passphrase is never stored or transmitted. Losing the passphrase means losing the map.',
  },
]

export default function PricingPage() {
  const [openFaq, setOpenFaq] = useState<number | null>(null)
  const navigate = useNavigate()

  function handleCta(plan: PlanCard) {
    if (plan.ctaType === 'tool') {
      navigate('/')
      return
    }
    if (plan.ctaType === 'mailto') {
      window.location.href = ENTERPRISE_CONTACT
      return
    }
    window.open(`${CLOUD_URL}/pricing`, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="page">
      <Navbar />

      <div style={{ padding: '48px 24px', maxWidth: 960, margin: '0 auto', width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 40,
              fontWeight: 800,
              letterSpacing: '-0.03em',
              marginBottom: 12,
            }}
          >
            Simple, honest pricing.
          </h1>
          <p
            style={{
              color: 'var(--text-secondary)',
              fontSize: 16,
              maxWidth: 520,
              margin: '0 auto',
            }}
          >
            Free forever and self-hostable. Pro, Team, and Enterprise add cloud sync,
            collaboration, and compliance on Veilio Cloud.
          </p>
        </div>

        {/* Community Edition context banner */}
        <div
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '12px 16px',
            marginBottom: 28,
            textAlign: 'center',
            fontSize: 13,
            color: 'var(--text-secondary)',
          }}
        >
          You're running the <strong style={{ color: 'var(--text-primary)' }}>Community Edition</strong> —
          the Free tier, self-hosted. The paid tiers run on{' '}
          <a href={`${CLOUD_URL}/pricing`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
            Veilio Cloud
          </a>.
        </div>

        <div
          className="pricing-grid"
          style={{
            display: 'grid',
            gap: 20,
            marginBottom: 64,
          }}
        >
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              style={{
                background: 'var(--bg-surface)',
                border: `1px solid ${plan.highlight ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 10,
                padding: 28,
                display: 'flex',
                flexDirection: 'column',
                position: 'relative',
                boxShadow: plan.highlight ? '0 0 32px rgba(249,115,22,0.12)' : 'none',
              }}
            >
              {plan.badge && (
                <div
                  style={{
                    position: 'absolute',
                    top: -12,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: plan.highlight ? 'var(--accent)' : 'var(--bg-elevated)',
                    color: plan.highlight ? '#000' : 'var(--text-secondary)',
                    border: plan.highlight ? 'none' : '1px solid var(--border)',
                    fontSize: 11,
                    fontWeight: 700,
                    fontFamily: 'var(--font-mono)',
                    padding: '3px 12px',
                    borderRadius: 20,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {plan.badge}
                </div>
              )}

              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700 }}>
                    {plan.name}
                  </span>
                  {plan.planId === 'free' && <span className="badge badge-accent">CE</span>}
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontFamily: 'var(--font-display)', fontSize: 36, fontWeight: 800 }}>
                    {plan.price}
                  </span>
                  <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{plan.period}</span>
                </div>
                <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 8 }}>
                  {plan.tagline}
                </p>
              </div>

              <ul
                style={{
                  listStyle: 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  flex: 1,
                  marginBottom: 24,
                }}
              >
                {plan.features.map((f) => (
                  <li
                    key={f}
                    style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 14 }}
                  >
                    <span style={{ color: 'var(--success)', marginTop: 1, flexShrink: 0 }}>✓</span>
                    <span style={{ color: 'var(--text-primary)' }}>{f}</span>
                  </li>
                ))}
              </ul>

              <button
                className={plan.highlight ? 'btn-primary' : 'btn-ghost'}
                onClick={() => handleCta(plan)}
                style={{ width: '100%', padding: '10px' }}
              >
                {plan.cta}
              </button>
            </div>
          ))}
        </div>

        {/* FAQ */}
        <div style={{ maxWidth: 640, margin: '0 auto' }}>
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 24,
              fontWeight: 700,
              marginBottom: 24,
              textAlign: 'center',
            }}
          >
            FAQ
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {FAQS.map((faq, i) => (
              <div
                key={i}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  overflow: 'hidden',
                  marginBottom: 4,
                }}
              >
                <button
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '14px 16px',
                    background: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                    fontSize: 14,
                    fontWeight: 500,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    border: 'none',
                    borderRadius: 0,
                  }}
                >
                  {faq.q}
                  <span
                    style={{
                      color: 'var(--text-dim)',
                      transition: 'transform 0.15s',
                      transform: openFaq === i ? 'rotate(180deg)' : 'none',
                    }}
                  >
                    ▾
                  </span>
                </button>
                {openFaq === i && (
                  <div
                    style={{
                      padding: '12px 16px 16px',
                      color: 'var(--text-secondary)',
                      fontSize: 14,
                      lineHeight: 1.6,
                      background: 'var(--bg-elevated)',
                    }}
                  >
                    {faq.a}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
