// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import ThemeToggle from './ThemeToggle.js'
import { THEME_STORAGE_KEY } from '../lib/theme.js'

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})
// This project does not set vitest `globals`, so React Testing Library's
// automatic cleanup never registers — without this the previous test's toggle
// is still mounted and every query matches twice.
afterEach(cleanup)

describe('ThemeToggle', () => {
  it('opens on System and names the state without being clicked', () => {
    render(<ThemeToggle />)
    // "What is it set to?" has to be answerable by looking. A toggle whose only
    // state is an icon makes the user click it to find out, which changes it.
    expect(screen.getByRole('button', { name: /Theme: System/i })).toBeTruthy()
  })

  it('cycles system → light → dark → system, stamping each', () => {
    render(<ThemeToggle />)
    const button = () => screen.getByRole('button', { name: /Theme:/i })

    fireEvent.click(button())
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(button().getAttribute('aria-label')).toMatch(/Light/)

    fireEvent.click(button())
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    fireEvent.click(button())
    // Back to following the OS — the attribute is gone, not set to a resolved
    // value. This is the step a two-position switch cannot express, and the
    // reason this is a three-state cycle.
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
  })

  it('opens on the stored choice rather than resetting it', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    render(<ThemeToggle />)
    expect(screen.getByRole('button', { name: /Theme: Dark/i })).toBeTruthy()
  })
})
