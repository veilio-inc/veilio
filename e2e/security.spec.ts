import { test, expect } from '@playwright/test'
import { anonymize, editor, editors } from './helpers.js'

// The product's central claim is that nothing you paste leaves your machine.
// Two things back it, and both are asserted here rather than trusted:
//
//  1. The bundle contacts no third-party origin at all (ROADMAP A4). This is a
//     property of the build, so it holds wherever the app is served from.
//  2. The server enforces that with a Content-Security-Policy (ROADMAP E3).
//     This is a property of the *server*, so it only holds for the real
//     artefact — `vite preview` sends no such headers. Those checks therefore
//     run only against a deployed instance, via VEILIO_E2E_URL:
//
//       docker run -d -p 8099:80 <image>
//       VEILIO_E2E_URL=http://127.0.0.1:8099 npx playwright test e2e/security.spec.ts

const DEPLOYED = Boolean(process.env.VEILIO_E2E_URL)

test.describe('no third-party origins', () => {
  test('a full page load contacts nothing off-origin', async ({ page, baseURL }) => {
    // Google Fonts used to be fetched on every page load, disclosing the
    // visitor's IP and User-Agent to a third party from a privacy tool.
    const origin = new URL(baseURL ?? 'http://127.0.0.1:4173').origin
    const offOrigin: string[] = []
    page.on('requestfinished', (r) => {
      const url = r.url()
      if (!url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:')) {
        offOrigin.push(url)
      }
    })

    await page.goto('/', { waitUntil: 'networkidle' })
    await page.goto('/legal/privacy', { waitUntil: 'networkidle' })

    expect(offOrigin).toEqual([])
  })

  test('the vendored fonts actually load', async ({ page }) => {
    // Removing the Google Fonts link is only an improvement if the faces still
    // resolve; otherwise this silently becomes a fallback-font regression.
    await page.goto('/', { waitUntil: 'networkidle' })

    expect(await page.evaluate(() => document.fonts.check("16px 'Inter'"))).toBe(true)
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain('Inter')
  })

  test('only the subsets a page needs are fetched', async ({ page }) => {
    // The 18 vendored files are ~760 kB on disk, which would be a poor trade if
    // every visitor paid it. unicode-range means they do not.
    const fonts: string[] = []
    page.on('requestfinished', (r) => {
      if (r.url().endsWith('.woff2')) fonts.push(r.url())
    })

    await page.goto('/', { waitUntil: 'networkidle' })

    expect(fonts.length).toBeGreaterThan(0)
    expect(fonts.length).toBeLessThan(18)
    expect(fonts.every((u) => u.includes('/fonts/'))).toBe(true)
  })
})

test.describe('security headers', () => {
  test.skip(!DEPLOYED, 'needs the real server — set VEILIO_E2E_URL')

  test('the response carries a Content-Security-Policy that confines the app', async ({
    request,
  }) => {
    const res = await request.get('/')
    const csp = res.headers()['content-security-policy'] ?? ''

    // connect-src is the directive that turns the privacy claim into something
    // the browser enforces: it is what a beacon or fetch would have to escape.
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    // No third-party origin may appear: vendoring the fonts is what allows this.
    expect(csp).not.toContain('http://')
    expect(csp).not.toContain('https://')
    // script-src must never be loosened, whatever style-src needs.
    expect(csp).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/)
  })

  test('the usual hardening headers are present', async ({ request }) => {
    const h = (await request.get('/')).headers()

    expect(h['x-content-type-options']).toBe('nosniff')
    expect(h['x-frame-options']).toBe('DENY')
    expect(h['referrer-policy']).toBe('no-referrer')
    expect(h['permissions-policy']).toContain('geolocation=()')
  })

  test('headers are on assets too, not just the document', async ({ request }) => {
    // The cache-control rules are per-extension, and it would be easy to set
    // them on a path that skipped the security headers.
    const res = await request.get('/icon.svg')

    expect(res.headers()['content-security-policy']).toBeTruthy()
    expect(res.headers()['x-content-type-options']).toBe('nosniff')
  })

  test('no CSP violation is reported during a real masking session', async ({ page }) => {
    // A policy that breaks the app would be reverted rather than fixed, so the
    // interesting assertion is that a genuine workflow runs clean under it.
    const violations: string[] = []
    page.on('console', (m) => {
      if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text())
    })

    await page.goto('/')
    await anonymize(page)
    await expect(editor(page, editors.output)).toContainText('__FN__1')

    expect(violations).toEqual([])
  })
})
