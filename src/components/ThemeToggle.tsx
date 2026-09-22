import { useState } from 'react'
import { applyThemeChoice, readThemeChoice, type ThemeChoice } from '../lib/theme.js'

const ORDER: ThemeChoice[] = ['system', 'light', 'dark']

const LABEL: Record<ThemeChoice, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

// Drawn rather than pulled from an icon font: the dependency budget is the
// supply-chain argument everywhere else in this codebase, and three glyphs do
// not earn an exception. `currentColor` so each one follows the button's text.
const GLYPH: Record<ThemeChoice, React.ReactNode> = {
  system: (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none">
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" stroke="currentColor" />
      <path d="M5.5 14h5" stroke="currentColor" strokeLinecap="round" />
    </svg>
  ),
  light: (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none">
      <circle cx="8" cy="8" r="3" stroke="currentColor" />
      <path
        d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.1 3.1l1 1M11.9 11.9l1 1M12.9 3.1l-1 1M4.1 11.9l-1 1"
        stroke="currentColor"
        strokeLinecap="round"
      />
    </svg>
  ),
  dark: (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none">
      <path
        d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z"
        stroke="currentColor"
        strokeLinejoin="round"
      />
    </svg>
  ),
}

/**
 * Cycle: system → light → dark → system.
 *
 * A cycle rather than a switch because there are three states and one of them
 * matters: "system" is the default and the only setting that keeps following
 * the OS afterwards. A two-position switch has nowhere to put it, so choosing
 * once would silently opt the user out of ever tracking their OS again -
 * a decision they never made.
 *
 * The button announces the CURRENT state and the label names it in full, so
 * "what is it set to" is answerable without clicking. `aria-live` is
 * deliberately absent: the change is visible on every pixel of the page, and
 * announcing it as well is noise.
 */
export default function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(() => readThemeChoice())

  function cycle() {
    const next = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length]
    setChoice(applyThemeChoice(next))
  }

  return (
    <button
      className="btn-ghost"
      onClick={cycle}
      title={`Theme: ${LABEL[choice]} - click to change`}
      aria-label={`Theme: ${LABEL[choice]}. Change theme`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 10px',
        fontSize: 13,
      }}
    >
      {GLYPH[choice]}
      <span>{LABEL[choice]}</span>
    </button>
  )
}
