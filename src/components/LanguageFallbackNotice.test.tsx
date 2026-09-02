// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import LanguageFallbackNotice from './LanguageFallbackNotice.js'

afterEach(cleanup)

describe('LanguageFallbackNotice', () => {
  it('says nothing when the language was recognised', () => {
    // FR-006: no new UI for the ten supported languages.
    const { container } = render(<LanguageFallbackNotice show={false} />)
    expect(container.textContent).toBe('')
  })

  it('states that masking is partial, not merely that detection failed', () => {
    // "Unknown language" is a fact about us. "Some identifiers are likely still
    // real" is the fact the reader needs before pasting into a model.
    render(<LanguageFallbackNotice show />)
    expect(screen.getByText(/masking is partial/i)).toBeDefined()
  })

  it('is announced to assistive technology without hijacking focus', () => {
    // `status` rather than `alert`: it is important, and it is not an emergency
    // interrupt — the secret panel owns that register.
    const { container } = render(<LanguageFallbackNotice show />)
    expect(container.querySelector('[role="status"]')).not.toBeNull()
  })
})
