// @vitest-environment jsdom
//
// safeHref has its own suite covering each bypass. This one covers the wiring:
// that the renderer actually consults it, and that a refused link degrades into
// readable text rather than disappearing. A validator nothing calls is the
// failure mode worth guarding against, and it is invisible to a unit test of
// the validator alone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import LegalPage from './LegalPage.js'

function renderDoc(markdown: string, slug = 'terms') {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve(markdown) }))
  )
  return render(
    <MemoryRouter initialEntries={[`/legal/${slug}`]}>
      <Routes>
        <Route path="/legal/:slug" element={<LegalPage />} />
      </Routes>
    </MemoryRouter>
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('LegalPage link rendering (ROADMAP E6)', () => {
  it('renders an ordinary external link as a link', async () => {
    renderDoc('See [the licence](https://example.com/licence) for details.')

    const link = await screen.findByRole('link', { name: 'the licence' })
    expect(link.getAttribute('href')).toBe('https://example.com/licence')
  })

  it('opens external links without leaking the referrer or the opener', async () => {
    renderDoc('See [the licence](https://example.com/licence).')

    const link = await screen.findByRole('link', { name: 'the licence' })
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(link.getAttribute('rel')).toContain('noreferrer')
  })

  it('keeps a site-relative link in the same tab', async () => {
    renderDoc('See [our privacy notice](/legal/privacy).')

    const link = await screen.findByRole('link', { name: 'our privacy notice' })
    expect(link.getAttribute('href')).toBe('/legal/privacy')
    expect(link.hasAttribute('target')).toBe(false)
  })

  it('rewrites a sibling document reference to its route', async () => {
    renderDoc('See [the notice](./Privacy.md).')

    const link = await screen.findByRole('link', { name: 'the notice' })
    expect(link.getAttribute('href')).toBe('/legal/privacy')
  })

  it('renders a javascript: link as plain text, keeping the sentence readable', async () => {
    renderDoc('Please [click here](javascript:alert(1)) now.')

    await screen.findByText(/Please/)
    expect(screen.queryByRole('link', { name: 'click here' })).toBeNull()
    // The words survive — refusing the link must not delete the prose.
    expect(document.body.textContent).toContain('click here')
    expect(document.body.innerHTML).not.toContain('javascript:')
  })

  it('refuses a scheme obfuscated with an embedded tab, which browsers strip', async () => {
    // `java&#9;script:` resolves as javascript: in a browser, so a naive
    // startsWith check waves it through. This is the case most likely to be
    // reintroduced by someone "simplifying" the check.
    renderDoc('Please [click here](java\tscript:alert(1)) now.')

    await screen.findByText(/Please/)
    expect(screen.queryByRole('link', { name: 'click here' })).toBeNull()
  })

  it('refuses a protocol-relative link, which reads as a local path', async () => {
    renderDoc('See [the docs](//evil.example/docs).')

    await screen.findByText(/See/)
    expect(screen.queryByRole('link', { name: 'the docs' })).toBeNull()
  })

  it('refuses a data: URL', async () => {
    renderDoc('See [the docs](data:text/html,<script>alert(1)</script>).')

    await screen.findByText(/See/)
    expect(screen.queryByRole('link', { name: 'the docs' })).toBeNull()
  })

  it('allows mailto:, which a legal notice legitimately needs', async () => {
    renderDoc('Contact [our DPO](mailto:privacy@example.com).')

    const link = await screen.findByRole('link', { name: 'our DPO' })
    expect(link.getAttribute('href')).toBe('mailto:privacy@example.com')
  })
})

describe('LegalPage document routing', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('# Terms of Use') }))
    )
  })

  it('fetches only the allow-listed slug, never a caller-supplied path', async () => {
    render(
      <MemoryRouter initialEntries={['/legal/privacy']}>
        <Routes>
          <Route path="/legal/:slug" element={<LegalPage />} />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(fetch).toHaveBeenCalledWith('/legal/privacy.md')
  })

  it('redirects an unknown slug instead of fetching it', async () => {
    // The allow-list is what stops `/legal/..%2F..%2Fetc%2Fpasswd` becoming a
    // fetch. Asserting no request happened is the part that matters.
    render(
      <MemoryRouter initialEntries={['/legal/../../secrets']}>
        <Routes>
          <Route path="/legal/*" element={<LegalPage />} />
          <Route path="/" element={<div>home</div>} />
        </Routes>
      </MemoryRouter>
    )

    expect(await screen.findByText('home')).toBeTruthy()
    expect(fetch).not.toHaveBeenCalled()
  })
})
