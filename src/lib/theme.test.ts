// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  applyThemeChoice,
  readThemeChoice,
  initTheme,
  resolvedTheme,
  THEME_STORAGE_KEY,
} from './theme.js'

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})
afterEach(() => vi.restoreAllMocks())

describe('theme choice', () => {
  it('defaults to system when nothing was ever chosen', () => {
    expect(readThemeChoice()).toBe('system')
  })

  it('stamps an explicit choice on <html> and remembers it', () => {
    applyThemeChoice('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(readThemeChoice()).toBe('light')
  })

  it('REMOVES the attribute for system rather than stamping a resolved value', () => {
    // The whole precedence chain rests on this. Stamping the resolved value
    // would freeze the page in whatever the OS said at load: a user on "system"
    // who switches their machine to light at dusk would keep the dark app until
    // they reloaded, and nothing on screen would explain why.
    applyThemeChoice('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    applyThemeChoice('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
  })

  it('survives a reload', () => {
    applyThemeChoice('light')
    document.documentElement.removeAttribute('data-theme') // a fresh document
    expect(initTheme()).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('ignores a stored value that is not a theme', () => {
    // Anyone can write to localStorage. `data-theme="<script>"` is not a real
    // injection - it is an attribute value - but a junk theme that silently
    // matches no CSS block leaves the page painting half a palette.
    window.localStorage.setItem(THEME_STORAGE_KEY, 'chartreuse')
    expect(readThemeChoice()).toBe('system')
    expect(initTheme()).toBe('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('does not throw when localStorage is unavailable', () => {
    // Private windows throw on ACCESS in some browsers rather than returning
    // null. A colour preference must not be able to take the app down.
    vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(readThemeChoice()).toBe('system')
    expect(() => applyThemeChoice('dark')).not.toThrow()
    // The page is still correct even though the memory of it failed.
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})

describe('resolvedTheme', () => {
  it('reports an explicit choice without consulting the system', () => {
    const mm = vi.fn()
    vi.stubGlobal('matchMedia', mm)
    expect(resolvedTheme('light')).toBe('light')
    expect(resolvedTheme('dark')).toBe('dark')
    expect(mm).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('falls back to dark - the documented floor - when the system cannot be asked', () => {
    vi.stubGlobal('matchMedia', () => {
      throw new Error('unsupported')
    })
    expect(resolvedTheme('system')).toBe('dark')
    vi.unstubAllGlobals()
  })
})

/**
 * The light palette is written out twice - once under
 * `@media (prefers-color-scheme: light)` for a system preference, once under
 * `[data-theme='light']` for an explicit one - because plain CSS cannot share a
 * declaration block between a media query and a selector.
 *
 * Duplication that nothing checks is duplication that drifts, and the drift
 * here is close to undetectable by eye: one token updated in one block gives a
 * page that looks right to whoever tested it and wrong to everyone whose route
 * into light mode was the other one.
 */
describe('the two light-theme blocks stay identical', () => {
  const css = readFileSync('src/global.css', 'utf8')

  function declarations(blockStart: RegExp): Map<string, string> {
    const at = css.search(blockStart)
    expect(at, `could not find the block matching ${blockStart}`).toBeGreaterThan(-1)
    const open = css.indexOf('{', at)
    // Token blocks contain no nested rules, so the first closing brace ends it.
    const body = css.slice(open + 1, css.indexOf('}', open))
    const out = new Map<string, string>()
    for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      out.set(m[1], m[2].replace(/\s+/g, ' ').trim())
    }
    return out
  }

  const fromMedia = declarations(/@media \(prefers-color-scheme: light\)[\s\S]{0,80}?:root:not/)
  const fromAttr = declarations(/:root\[data-theme='light'\]/)

  it('declares the same tokens in both', () => {
    expect([...fromAttr.keys()].sort()).toEqual([...fromMedia.keys()].sort())
  })

  it('gives every token the same value in both', () => {
    const differing = [...fromAttr.entries()]
      .filter(([k, v]) => fromMedia.get(k) !== v)
      .map(([k, v]) => `${k}: ${v} vs ${fromMedia.get(k)}`)
    expect(differing).toEqual([])
  })

  it('overrides enough of the dark palette to be a theme rather than a tint', () => {
    // A light "theme" that only moved the background is the failure mode this
    // number guards: the text, the borders, the syntax scale and the shadows
    // all have to move with it.
    expect(fromAttr.size).toBeGreaterThan(40)
    for (const required of [
      '--bg-base',
      '--text-primary',
      '--border',
      '--shadow-lg',
      '--syntax-keyword',
      '--code-bg',
      '--edge-light',
    ]) {
      expect(fromAttr.has(required), `${required} is not redefined for light`).toBe(true)
    }
  })

  it('leaves the demo block dark in both themes, deliberately', () => {
    // Not an omission. That block is an image OF code; a sample staying dark on
    // a light page is the convention everywhere, and it sits on its own ground
    // rather than on the page's.
    // `--demo-bg` is in the list for a reason: the demo used to sit on
    // `--code-bg`, which DOES flip, so a dark syntax palette landed on paper at
    // 2.1:1. Its ground has to stay put or the scale above cannot.
    for (const token of [
      '--demo-bg',
      '--demo-text',
      '--demo-comment',
      '--demo-placeholder',
      '--demo-keyword',
      '--demo-function',
      '--demo-string',
      '--demo-scrim',
    ]) {
      expect(fromAttr.has(token), `${token} should not be themed`).toBe(false)
    }
  })
})
