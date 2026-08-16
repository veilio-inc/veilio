/** Schemes a link in a rendered document may use.
 *
 *  Everything else — `javascript:`, `data:`, `vbscript:`, `blob:` — is refused
 *  and the link is rendered as plain text instead.
 *
 *  Why this exists (ROADMAP E6): the legal documents are markdown fetched at
 *  runtime and rendered through a hand-written renderer, and an href taken
 *  straight from a document is executable, and React's own handling of that has
 *  never been something to rely on — 18 warned about `javascript:` URLs and
 *  rendered them anyway. The documents are ours today, so nothing here
 *  is exploitable — but this is a source-available repository that accepts pull
 *  requests, and a legal notice is an unremarkable file to skim.
 */
const ALLOWED_SCHEME = /^(?:https?|mailto):/i

/** A site-relative path: one leading slash, and not two.
 *
 *  `//evil.example` is protocol-relative, not relative — it navigates off-site
 *  while looking local. That exact confusion is what the advisory against this
 *  app's router was about, so it is refused here too. */
const SITE_RELATIVE = /^\/(?!\/)/

/** Leading and trailing C0 controls and spaces, which the URL parser discards. */
/* eslint-disable-next-line no-control-regex -- matching these characters is the point: a browser strips them before resolving a scheme, so not matching them IS the bypass. */
const OUTER_JUNK = /^[\u0000-\u0020]+|[\u0000-\u0020]+$/g

/** Tab, newline and carriage return, which the URL parser removes from
 *  *anywhere* in the string — not just the ends.
 *
 *  This is the part that makes a naive check useless: `java&#9;script:alert(1)`
 *  executes, because the parser strips the tab before it looks for the `:`.
 *  Testing the raw string would pass it straight through. */
/* eslint-disable-next-line no-control-regex -- matching these characters is the point: a browser strips them before resolving a scheme, so not matching them IS the bypass. */
const INNER_JUNK = /[\u0009\u000A\u000D]/g

/** Normalise an href the way a browser would, then allow-list it.
 *
 *  Returns the href to use, or `null` when it must not become a link.
 *
 *  The returned value is the *normalised* form rather than the original: if the
 *  two differ, the original contained characters the browser would have ignored,
 *  and rendering the original would mean testing one string and shipping
 *  another. */
export function safeHref(raw: string): string | null {
  const href = raw.replace(OUTER_JUNK, '').replace(INNER_JUNK, '')
  if (!href) return null
  if (SITE_RELATIVE.test(href) || href.startsWith('#')) return href
  if (ALLOWED_SCHEME.test(href)) return href
  return null
}

/** Whether a safe href points off-site, and so needs `noopener noreferrer`. */
export function isExternal(href: string): boolean {
  return /^https?:/i.test(href)
}
