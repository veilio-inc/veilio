/**
 * Which palette the app paints in.
 *
 * Three states, not two. "System" is a real choice and the DEFAULT one - it is
 * what an unconfigured visitor gets, and it is the only setting that keeps
 * following the operating system after the fact.
 *
 *   an explicit choice  >  the operating system  >  dark
 *
 * The mechanism is one attribute. `system` REMOVES `data-theme` from <html>
 * rather than stamping a resolved value, which is what lets `global.css`'s
 * `@media (prefers-color-scheme: light)` keep answering as the OS changes - a
 * resolved stamp would freeze the page in whatever the OS said at load and go
 * stale the moment somebody switched at dusk.
 *
 * Nothing here reads the preference back to decide what to paint: CSS does
 * that. This module only records the choice and stamps the attribute, so there
 * is exactly one source of truth for the colours and it is the stylesheet.
 */

export type ThemeChoice = 'system' | 'light' | 'dark'

export const THEME_STORAGE_KEY = 'veilio_ce_theme'

const CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark']

function isChoice(v: unknown): v is ThemeChoice {
  return typeof v === 'string' && (CHOICES as readonly string[]).includes(v)
}

/**
 * The stored choice, or `system` when there isn't a valid one.
 *
 * Never throws. localStorage is unavailable in a private window on some
 * browsers and throws on ACCESS rather than returning null, and a colour
 * preference is not worth taking the app down for.
 */
export function readThemeChoice(): ThemeChoice {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isChoice(raw) ? raw : 'system'
  } catch {
    return 'system'
  }
}

/**
 * Stamp the choice onto <html> and remember it.
 *
 * Returns the choice so a caller can set state from the same value it applied,
 * rather than reading the DOM back.
 */
export function applyThemeChoice(choice: ThemeChoice): ThemeChoice {
  const root = document.documentElement
  if (choice === 'system') {
    // Absence is the signal. See the note above: stamping a resolved value here
    // is the bug, not the shortcut.
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', choice)
  }
  try {
    if (choice === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY)
    else window.localStorage.setItem(THEME_STORAGE_KEY, choice)
  } catch {
    // The page is already correct; only the memory of it failed.
  }
  return choice
}

/**
 * Apply the stored choice before React mounts.
 *
 * Called from `main.tsx` rather than from a component effect, because an effect
 * runs after the first paint: a user who chose light would see one dark frame
 * on every load. That flash is the entire reason this is not a hook.
 */
export function initTheme(): ThemeChoice {
  return applyThemeChoice(readThemeChoice())
}

/** What the page is actually painting right now, choice resolved against the OS. */
export function resolvedTheme(choice: ThemeChoice = readThemeChoice()): 'light' | 'dark' {
  if (choice !== 'system') return choice
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  } catch {
    // No matchMedia (jsdom without a stub, very old browsers) - dark is the
    // documented floor of the precedence chain.
    return 'dark'
  }
}
