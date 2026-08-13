import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar.js'

const CLOUD_URL = import.meta.env.VITE_VEILIO_CLOUD_URL ?? 'https://veilio.dev'
const ENTERPRISE_CONTACT = 'mailto:hello@veilio.dev'

type PlanId = 'free' | 'individual' | 'pro' | 'team' | 'enterprise'
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
    tagline:
      'Everything you need to protect your code. Self-hosted, free for any use — even commercial.',
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
    name: 'Individual',
    price: '$3',
    period: 'per month',
    tagline: 'Cloud sync for one developer.',
    features: [
      'Cloud map storage (up to 500 maps)',
      'Cross-device history sync',
      'Export / import .veilio files',
      'Email support',
    ],
    cta: 'Get Individual on Cloud →',
    highlight: false,
    planId: 'individual',
    ctaType: 'cloud',
  },
  {
    name: 'Pro',
    price: '$9',
    period: 'per user, per month',
    tagline: 'More maps, custom rules, and the browser extension — for one developer.',
    features: [
      'Everything in Individual',
      'Up to 2,000 cloud maps',
      'Custom rules',
      'Browser extension',
      'Priority email support',
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
    a: 'CE is the source-available, self-hostable version of Veilio, free to use for any purpose — including inside your own business — under the Veilio Community License 1.0. It includes the full anonymize/restore engine, .veilio file export/import, and localStorage map persistence. No backend, no accounts, no data leaves your machine. The license only prohibits selling Veilio itself, hosting it as a commercial service for others, or basing a competing product on it.',
  },
  {
    q: 'Can I use the Community Edition at work or commercially?',
    a: 'Yes. CE is free to use for any purpose, including inside a business and on commercial projects, under the Veilio Community License 1.0 — deploying it on your own infrastructure and running your business on it needs no commercial license. The one thing you may not do is sell, resell, rebrand, or host Veilio (or its engine) as a commercial service or a product that competes with Veilio Cloud. For that kind of redistribution, contact hello@veilio.dev.',
  },
  {
    q: 'How do I save maps permanently in CE?',
    a: 'Maps are stored in your browser\'s localStorage by default. For durable backups — or to move a map to another device — use "Export .veilio" to save a passphrase-encrypted file to disk, then "Import .veilio" to load it back.',
  },
  {
    q: 'What does the Cloud edition add?',
    a: 'Cloud is the paid, hosted edition — there is no free Cloud tier (the free option is self-hosting this Community Edition). Individual ($3/mo) adds hosted cloud sync with up to 500 maps. Pro ($9/user/mo) raises that to 2,000 maps and adds custom rules and the browser extension. Team ($19/seat/mo) adds shared maps, SSO, and audit. Enterprise (custom) adds SAML, SIEM export, and on-prem. The anonymizer engine is identical across all editions — only persistence and team features differ.',
  },
  {
    q: 'Is my source code ever sent anywhere in CE?',
    a: 'No. The engine runs entirely in your browser. Source code, identifier names, and symbol maps never leave your machine. Even .veilio files are encrypted client-side before being written to disk.',
  },
  {
    q: 'How is the .veilio file encrypted?',
    a: 'AES-256-GCM with a key derived from your passphrase via PBKDF2-SHA256 at 600,000 iterations. Each file records the parameters it was written under, so files exported before that raise (100,000 iterations) still open. The passphrase is never stored or transmitted. Losing the passphrase means losing the map.',
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
              fontSize: 44,
              fontWeight: 400,
              letterSpacing: '-0.02em',
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
            Free to use — even commercially — and self-hostable. The paid plans add cloud sync,
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
          You're running the{' '}
          <strong style={{ color: 'var(--text-primary)' }}>Community Edition</strong> — the Free
          tier, self-hosted. The paid tiers run on{' '}
          <a
            href={`${CLOUD_URL}/pricing`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--accent)' }}
          >
            Veilio Cloud
          </a>
          .
        </div>

        <div
          className="pricing-grid"
          style={{
            display: 'grid',
            gap: 20,
            marginBottom: 64,
          }}
        >
          {PLANS.map((plan, i) => (
            <div
              key={plan.name}
              className={`price-card ticks rise ${plan.highlight ? 'surface-accent surface' : 'surface'}`}
              style={{
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ...({ '--i': i } as any),
                padding: 28,
                display: 'flex',
                flexDirection: 'column',
                position: 'relative',
              }}
            >
              {plan.badge && (
                <div
                  style={{
                    position: 'absolute',
                    top: -12,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: plan.highlight
                      ? 'linear-gradient(180deg, #D98968, var(--accent-hover))'
                      : 'var(--bg-elevated)',
                    color: plan.highlight ? '#fff' : 'var(--text-secondary)',
                    border: plan.highlight ? 'none' : '1px solid var(--border)',
                    fontSize: 11,
                    fontWeight: 700,
                    fontFamily: 'var(--font-mono)',
                    padding: '4px 13px',
                    borderRadius: 20,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    whiteSpace: 'nowrap',
                    boxShadow: plan.highlight ? '0 6px 18px -6px var(--accent-glow)' : 'none',
                  }}
                >
                  {plan.badge}
                </div>
              )}

              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span
                    style={{ fontFamily: 'var(--font-display)', fontSize: 21, fontWeight: 400 }}
                  >
                    {plan.name}
                  </span>
                  {plan.planId === 'free' && <span className="badge badge-accent">CE</span>}
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span
                    style={{ fontFamily: 'var(--font-display)', fontSize: 40, fontWeight: 400 }}
                  >
                    {plan.price}
                  </span>
                  <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                    {plan.period}
                  </span>
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
              fontSize: 30,
              fontWeight: 400,
              marginBottom: 24,
              textAlign: 'center',
            }}
          >
            Questions, answered.
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {FAQS.map((faq, i) => (
              <div key={i} className={`faq-item${openFaq === i ? ' open' : ''}`}>
                <button
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  aria-expanded={openFaq === i}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '15px 18px',
                    background: 'transparent',
                    color: 'var(--text-primary)',
                    fontSize: 14,
                    fontWeight: 500,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 12,
                    border: 'none',
                    borderRadius: 0,
                  }}
                >
                  {faq.q}
                  <span aria-hidden className="faq-plus">
                    +
                  </span>
                </button>
                {openFaq === i && (
                  <div
                    className="faq-answer"
                    style={{
                      padding: '0 18px 16px',
                      color: 'var(--text-secondary)',
                      fontSize: 14,
                      lineHeight: 1.6,
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
