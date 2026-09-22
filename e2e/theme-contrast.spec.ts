import { test, expect, type Page } from '@playwright/test'

/**
 * Both themes are readable, measured rather than eyeballed.
 *
 * ROADMAP E9's warning is specific and it is the reason this exists: the
 * components that paint their own colours are the ones a user reads when
 * something has gone wrong — the vault modal, the key-change prompt, the secret
 * panel — and "a warning that is unreadable in one theme is worse than no
 * theme".
 *
 * A screenshot does not catch that. A human comparing two screenshots catches
 * the obvious half and misses 3.8:1 grey-on-cream every time, because it looks
 * fine until you are tired, or outdoors, or not twenty-five. So this computes
 * the actual WCAG 2.1 contrast ratio of every visible run of text against the
 * ground it is composited over, in both themes.
 *
 * It earned its place in the Cloud edition before it was ported here: that
 * palette's first pass shipped `--accent` at 3.78:1 and white-on-terracotta on
 * the primary button at 2.72:1. Both passed every unit test, both rendered, and
 * both were unreadable to somebody.
 *
 * ## What it refuses to guess
 *
 * Contrast against a GRADIENT or an image has no single answer, and a made-up
 * one is worse than none: the demo code block and the filled terracotta buttons
 * are both painted with `linear-gradient`, so `backgroundColor` reads
 * transparent and a naive walk finds the page behind them and reports white
 * text at 1.14:1. Those are counted as unmeasurable and reported, never failed
 * on. The count is asserted to stay SMALL, so an ocean of gradients can't
 * quietly become the place unreadable text hides.
 */

const THEMES = ['dark', 'light'] as const

// CE has no accounts, so every route is a public route — which makes this a
// near-complete sweep rather than a sample.
const ROUTES = ['/', '/pricing', '/legal/terms', '/legal/privacy']

interface Audit {
  failures: {
    where: string
    text: string
    color: string
    /** The worst candidate ground — without it, a failure cannot be located. */
    ground: string
    ratio: number
    needed: number
  }[]
  unmeasurable: number
  measured: number
}

/**
 * Stamp the theme and wait for the page to actually be painting in it.
 *
 * Separate from the audit, and not optional. Stamping and measuring inside one
 * `evaluate` silently returned the PREVIOUS theme's computed values while
 * developing this — the first run reported the light palette's numbers under
 * the heading "dark", which is the most convincing kind of wrong answer,
 * because every value in it is real. Asserting on `--accent` afterwards is what
 * makes the stamp observable rather than assumed.
 */
async function stampTheme(page: Page, theme: string): Promise<void> {
  await page.evaluate((t) => {
    document.documentElement.setAttribute('data-theme', t)
    void document.documentElement.offsetHeight
  }, theme)

  // Long enough for every colour transition to finish. Components animate
  // `all 0.15s`, and `getComputedStyle` during a transition returns the
  // INTERPOLATED colour — a blend of the two themes that belongs to neither.
  // Measured mid-flight, the navigation reported #964d2e: not a token, not a
  // bug, just a frame. Two animation frames were not enough; this is.
  await page.waitForTimeout(500)

  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  )
  expect(accent, 'the theme stamp did not take effect before measuring').not.toBe('')
}

async function audit(page: Page): Promise<Audit> {
  return page.evaluate(() => {
    type C = { r: number; g: number; b: number; a: number }
    const parse = (c: string): C | null => {
      const m = /rgba?\(([^)]+)\)/.exec(c)
      if (!m) return null
      const p = m[1].split(',').map((s) => parseFloat(s))
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
    }
    /**
     * Porter-Duff source-over, alpha included.
     *
     * The alpha matters and getting it wrong is silent: an earlier version
     * returned `a: 1` unconditionally, which is correct only when the BACKDROP
     * is opaque. Compositing two translucent tints — a 12% accent pill sitting
     * on a 7% accent wash — then produced a FULLY OPAQUE accent as the ground,
     * and reported the pill's own label unreadable at 1.34:1 against a colour
     * that appears nowhere on screen. Every number in that report was real
     * except the one that mattered.
     */
    const over = (fg: C, bg: C): C => {
      const a = fg.a + bg.a * (1 - fg.a)
      if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
      return {
        r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
        g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
        b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
        a,
      }
    }
    const lum = (c: C) => {
      const f = (v: number) => {
        const x = v / 255
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
    }
    const ratio = (a: C, b: C) => {
      const [l1, l2] = [lum(a), lum(b)]
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    }

    /**
     * Every ground this text might actually sit on.
     *
     * A gradient has no single background colour, and the first version of this
     * gave up on one — which declared more than half of the pricing page
     * unmeasurable, because that page is built from gradient-filled cards. An
     * audit blind to the busiest surface is an audit that passes for the wrong
     * reason.
     *
     * A gradient does have a FINITE set of colours, though: its stops, and
     * everything between them. Contrast is monotonic between two colours, so
     * text that clears the bar against every stop clears it everywhere along
     * the ramp. Each stop is composited over whatever is behind it and returned
     * as a candidate; the caller takes the worst.
     *
     * `null` is still returned for a background we genuinely cannot reason
     * about — a `url()` image — because guessing there is worse than admitting
     * it.
     */
    /**
     * An opaque, positioned sibling painted UNDER this text, if there is one.
     *
     * The ancestor walk misses these by construction, and they are not exotic:
     * a segmented control slides a pill behind the active label, so the label's
     * real ground is a sibling `<span>`, not any ancestor. Measured against the
     * ancestor chain, white-on-terracotta reported 1.15:1 against the track it
     * never touches.
     *
     * This REPLACES the ancestor ground rather than joining it as a candidate:
     * an opaque layer under the glyphs is the ground, not one possibility among
     * several. Only earlier siblings count — later ones paint on top, and text
     * hidden beneath something is a different bug than this one looks for.
     */
    const overlappingSibling = (el: Element): C | null => {
      const parent = el.parentElement
      if (!parent) return null
      const box = el.getBoundingClientRect()
      for (const sib of Array.from(parent.children)) {
        if (sib === el) break // later siblings paint above; stop here
        const cs = getComputedStyle(sib)
        if (cs.position !== 'absolute' && cs.position !== 'fixed') continue
        const r = sib.getBoundingClientRect()
        const covers =
          r.left <= box.left + 1 &&
          r.right >= box.right - 1 &&
          r.top <= box.top + 1 &&
          r.bottom >= box.bottom - 1
        if (!covers) continue
        const solid = parse(cs.backgroundColor)
        if (solid && solid.a >= 1) return solid
        const stops = [...cs.backgroundImage.matchAll(/rgba?\([^)]+\)/g)]
          .map((m) => parse(m[0]))
          .filter((c): c is C => c !== null && c.a >= 1)
        if (stops.length > 0) return stops[0]
      }
      return null
    }

    const grounds = (el: Element): C[] | null => {
      const beneath = overlappingSibling(el)
      if (beneath) return [beneath]

      let cur: Element | null = el
      let acc: C | null = null
      const compose = (c: C): C => (acc ? over(acc, c) : c)

      while (cur) {
        const cs = getComputedStyle(cur)
        const image = cs.backgroundImage
        if (image && image !== 'none') {
          if (/\burl\(/.test(image)) return null

          // A layer sized to a few pixels is a RULE or a TICK, not a ground.
          //
          // Colour cannot reveal this: the corner ticks on the legal pages are
          // `linear-gradient(to right, <dim>, <dim>)` — a perfectly ordinary
          // solid-colour gradient — and only `background-size: 9px 1px` says it
          // is a 9×1 mark in a corner. Without this, every paragraph on the page
          // was reported unreadable against a hairline no glyph sits on, which
          // is the most confident kind of wrong answer: the number is real and
          // the ground is imaginary.
          //
          // Conservative: the image is skipped only when EVERY layer is a
          // hairline. One real fill among them and the stops are read as before.
          const layers = cs.backgroundSize.split(',').map((s) => s.trim())
          const hairline = (size: string) =>
            size.split(/\s+/).some((axis) => /^([0-4](\.\d+)?)px$/.test(axis))
          if (layers.length > 0 && layers.every(hairline)) {
            cur = cur.parentElement
            continue
          }

          const stops = [...image.matchAll(/rgba?\([^)]+\)/g)]
            .map((m) => parse(m[0]))
            .filter((c): c is C => c !== null)
          // A gradient we cannot read the stops of (a named colour, a
          // colour-mix) is not one to guess at.
          if (stops.length === 0) return null

          const opaque = stops.filter((s) => s.a >= 1)
          const translucent = stops.filter((s) => s.a < 1)

          // A FILL: every stop is opaque, so the element really is painted in
          // those colours and the text sits on one of them.
          if (translucent.length === 0) return opaque.map(compose)

          // A PATTERN or an overlay: the gradient punches transparency, so what
          // is behind shows through and is the actual ground.
          //
          // The distinction is structural, not a fudge — a fill ramps between
          // opaque colours; a pattern has holes. It matters because a decorative
          // hairline drawn as a repeating gradient would otherwise BE the
          // ground: a tick-mark rule in the legal pages painted 1px lines in
          // --text-dim, and every paragraph under it was reported unreadable
          // against a line no glyph meaningfully sits on.
          //
          // Opaque stops in a mixed gradient are therefore treated as
          // decoration and dropped; translucent ones are composited over what
          // is behind, which is where the page atmosphere belongs.
          const behind = cur.parentElement ? grounds(cur.parentElement) : null
          if (!behind) return null
          return behind.flatMap((b) => [b, ...translucent.map((s) => over(compose(s), b))])
        }

        const bg = parse(cs.backgroundColor)
        if (bg && bg.a > 0) {
          acc = compose(bg)
          if (bg.a >= 1) return [acc]
        }
        cur = cur.parentElement
      }
      return acc ? [acc] : null
    }

    const failures: Audit['failures'] = []
    let unmeasurable = 0
    let measured = 0

    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => (n.textContent ?? '').trim())
        .join('')
      if (!own) continue

      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none') continue
      if (parseFloat(cs.opacity) < 0.3) continue
      const box = el.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue

      const fg = parse(cs.color)
      if (!fg) continue
      // Fully transparent text is painted by something else — a gradient
      // clipped to the glyphs (`background-clip: text`), which is how the hero
      // wordmarks are drawn. Its colour is not in `color`, and this technique
      // cannot reach it, so it is admitted as unmeasurable rather than reported
      // as a 1:1 failure against itself.
      if (fg.a === 0) {
        unmeasurable++
        continue
      }
      const candidates = grounds(el)
      if (!candidates || candidates.length === 0) {
        unmeasurable++
        continue
      }

      measured++
      const size = parseFloat(cs.fontSize)
      const bold = parseInt(cs.fontWeight, 10) >= 700
      // WCAG "large text": 24px, or 18.66px when bold.
      const needed = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5
      // The worst ground wins: text over a gradient has to be readable at every
      // point along it, not on average.
      // The worst ground wins, and it is REPORTED: "2.7:1" without naming the
      // colour underneath sends you hunting through ancestors by hand.
      let worst = candidates[0]
      let r = Infinity
      for (const bg of candidates) {
        const x = ratio(over(fg, bg), bg)
        if (x < r) {
          r = x
          worst = bg
        }
      }
      if (r < needed) {
        failures.push({
          where: `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`,
          text: own.slice(0, 48),
          color: cs.color,
          ground: `rgb(${Math.round(worst.r)}, ${Math.round(worst.g)}, ${Math.round(worst.b)})`,
          ratio: Math.round(r * 100) / 100,
          needed,
        })
      }
    }

    return { failures, unmeasurable, measured }
  })
}

for (const theme of THEMES) {
  for (const route of ROUTES) {
    test(`every run of text on ${route} meets WCAG AA in the ${theme} theme`, async ({ page }) => {
      await page.goto(route)
      // The legal pages fetch their markdown, so the text under test may not
      // exist yet when the route resolves.
      await page.waitForLoadState('networkidle')

      await stampTheme(page, theme)
      const result = await audit(page)

      expect(
        result.measured,
        'no text was measured at all, so this proved nothing'
      ).toBeGreaterThan(5)

      expect(result.failures, `unreadable text in the ${theme} theme on ${route}`).toEqual([])

      // Not a failure, a ceiling — and a low one, now that gradients are read
      // by their stops rather than skipped. What is left is genuinely
      // unreasonable-about: a `url()` background, or a gradient whose stops do
      // not resolve to rgb. If this climbs, the audit is going blind and the
      // green above stops meaning anything.
      expect(
        result.unmeasurable,
        'too much text sits on a ground that cannot be reasoned about'
      ).toBeLessThan(10)
    })
  }
}
