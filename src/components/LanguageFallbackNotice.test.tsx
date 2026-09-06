// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import LanguageFallbackNotice from './LanguageFallbackNotice.js'

afterEach(cleanup)

const noop = () => {}

describe('LanguageFallbackNotice', () => {
  it('says nothing when the language was recognised', () => {
    // FR-006: no new UI for the ten supported languages.
    const { container } = render(<LanguageFallbackNotice show={false} onSelectLanguage={noop} />)
    expect(container.textContent).toBe('')
  })

  it('states that masking is partial, not merely that detection failed', () => {
    // "Unknown language" is a fact about us. "Some identifiers are likely still
    // real" is the fact the reader needs before pasting into a model.
    render(<LanguageFallbackNotice show onSelectLanguage={noop} />)
    expect(screen.getByText(/masking is partial/i)).toBeDefined()
  })

  it('is announced to assistive technology without hijacking focus', () => {
    // `status` rather than `alert`: it is important, and it is not an emergency
    // interrupt — the secret panel owns that register.
    const { container } = render(<LanguageFallbackNotice show onSelectLanguage={noop} />)
    expect(container.querySelector('[role="status"]')).not.toBeNull()
  })

  // ROADMAP B4, User Story 2: the warning is a dead end without a way to act
  // on it.
  it('offers every supported language to pick from', () => {
    render(<LanguageFallbackNotice show onSelectLanguage={noop} />)
    const select = screen.getByLabelText(/actual language/i) as HTMLSelectElement
    // Ten supported languages, plus the disabled "Choose…" placeholder.
    expect(select.options.length).toBe(11)
  })

  it('calls onSelectLanguage with the chosen language', () => {
    const onSelectLanguage = vi.fn()
    render(<LanguageFallbackNotice show onSelectLanguage={onSelectLanguage} />)
    const select = screen.getByLabelText(/actual language/i)
    fireEvent.change(select, { target: { value: 'python' } })
    expect(onSelectLanguage).toHaveBeenCalledWith('python')
  })

  it('does not call onSelectLanguage for the disabled placeholder', () => {
    const onSelectLanguage = vi.fn()
    render(<LanguageFallbackNotice show onSelectLanguage={onSelectLanguage} />)
    const select = screen.getByLabelText(/actual language/i)
    fireEvent.change(select, { target: { value: '' } })
    expect(onSelectLanguage).not.toHaveBeenCalled()
  })
})
