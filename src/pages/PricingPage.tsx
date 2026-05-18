import { useState } from 'react'
import Navbar from '../components/Navbar.js'

const CLOUD_URL = import.meta.env.VITE_SCRUBR_CLOUD_URL ?? 'https://scrubr.app'

interface PlanCard {
  name: string
  price: string
  period: string
  tagline: string
  features: string[]
  cta: string
  highlight: boolean
  edition: 'ce' | 'cloud'
}

const PLANS: PlanCard[] = [
  {
    name: 'Community Edition',
    price: '$0',
    period: 'forever',
    tagline: 'Everything you need to protect your code. Self-hosted.',
    features: [
      'Full anonymize / restore tool',
      'Stripped metadata panel',
      'Session maps (browser memory)',
      'Local localStorage maps',
      'Export / import .scrubr files',
      'MIT licensed — run anywhere',
    ],
    cta: 'Current edition',
    highlight: false,
    edition: 'ce',
  },
  {
    name: 'Team (Cloud)',
    price: '$19',
    period: 'per month, flat',
    tagline: 'One price. Whole team. No headcount math.',
    features: [
      'Everything in CE',
      'Cloud saved maps — unlimited',
      'Access maps from any device',
      'Team shared maps',
      'Team member invites',
      'Priority support',
    ],
    cta: 'Go to Cloud →',
    highlight: true,
    edition: 'cloud',
  },
]

const FAQS = [
  {
    q: 'What is the Community Edition?',
    a: 'CE is the MIT-licensed, self-hostable version of SCRUBR. It includes the full anonymize/restore engine, .scrubr file export/import, and localStorage map persistence. No backend, no accounts, no data leaves your machine.',
  },
  {
    q: 'How do I save maps permanently in CE?',
    a: 'Maps are stored in your browser\'s localStorage by default. For durable backups — or to move a map to another device — use "Export .scrubr" to save a passphrase-encrypted file to disk, then "Import .scrubr" to load it back.',
  },
  {
    q: 'What does the Cloud edition add?',
    a: 'Cloud adds encrypted server-side map storage (accessible from any device), team shared maps, team member invites, and billing. The anonymizer engine is identical — only the persistence layer and team features differ.',
  },
  {
    q: 'Is my source code ever sent anywhere in CE?',
    a: 'No. The engine runs entirely in your browser. Source code, identifier names, and symbol maps never leave your machine. Even .scrubr files are encrypted client-side before being written to disk.',
  },
  {
    q: 'How is the .scrubr file encrypted?',
    a: 'AES-256-GCM with a key derived from your passphrase via PBKDF2 (100,000 iterations, SHA-256). The passphrase is never stored or transmitted. Losing the passphrase means losing the map.',
  },
]

export default function PricingPage() {
  const [openFaq, setOpenFaq] = useState<number | null>(null)

  function handleCta(plan: PlanCard) {
    if (plan.edition === 'cloud') {
      window.open(`${CLOUD_URL}/pricing`, '_blank', 'noopener,noreferrer')
    }
  }

  return (
    <div className="page">
      <Navbar />

      <div style={{ padding: '48px 24px', maxWidth: 960, margin: '0 auto', width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: 48 }}>
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
              maxWidth: 480,
              margin: '0 auto',
            }}
          >
            CE is free forever. Pay only for cloud sync and team sharing.
          </p>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
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
              {plan.highlight && (
                <div
                  style={{
                    position: 'absolute',
                    top: -12,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: 'var(--accent)',
                    color: '#000',
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
                  Flat price
                </div>
              )}

              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span
                    style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700 }}
                  >
                    {plan.name}
                  </span>
                  {plan.edition === 'ce' && (
                    <span className="badge badge-accent">You are here</span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span
                    style={{ fontFamily: 'var(--font-display)', fontSize: 36, fontWeight: 800 }}
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
                disabled={plan.edition === 'ce'}
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

        {/* Cloud callout */}
        <div
          style={{
            marginTop: 48,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: 28,
            textAlign: 'center',
          }}
        >
          <h3
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 20,
              fontWeight: 700,
              marginBottom: 8,
            }}
          >
            Want accounts, cloud sync, and teams?
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 16 }}>
            The hosted Cloud edition adds all of that — same engine, no self-hosting required.
          </p>
          <a
            href={`${CLOUD_URL}/pricing`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary"
            style={{ display: 'inline-block', padding: '8px 20px' }}
          >
            See Cloud pricing →
          </a>
        </div>
      </div>
    </div>
  )
}
