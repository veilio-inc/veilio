// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import ScrubPage from './ScrubPage.js'

// jsdom cannot make a CodeMirror selection, so the editor is replaced by a
// textarea and a second field that reports a selection the way the editor does
// (`onSelectionChange`). Kept to this file: the page's other tests use the real
// editor.
vi.mock('../components/CodePanel.js', () => ({
  default: (p: {
    label: string
    value: string
    onChange?: (v: string) => void
    onSelectionChange?: (text: string) => void
    actions?: ReactNode
  }) => (
    <div>
      <textarea
        aria-label={p.label}
        value={p.value}
        onChange={(e) => p.onChange?.(e.target.value)}
        readOnly={!p.onChange}
      />
      {p.onSelectionChange && (
        <textarea
          aria-label={`Selection in ${p.label}`}
          onChange={(e) => p.onSelectionChange?.(e.target.value)}
        />
      )}
      {p.actions}
    </div>
  ),
}))

afterEach(() => {
  cleanup()
  globalThis.localStorage?.clear()
})

const ONE_LINE =
  'A mark cannot span lines or hold a tab. Nothing was masked. Mark the text on each line separately.'

describe('ScrubPage, a selection across lines', () => {
  it('is refused with an error, and the output, the map and the selection stay', () => {
    render(
      <MemoryRouter>
        <ScrubPage />
      </MemoryRouter>
    )
    fireEvent.change(screen.getByLabelText('① Your code'), {
      target: {
        value: '// escalated by Kowalska,\n// acct 88412037\nfunction settle(rate) { return rate }',
      },
    })
    fireEvent.click(screen.getByRole('button', { name: /Anonymize/ }))
    const output = screen.getByLabelText('② Anonymized (paste to AI)') as HTMLTextAreaElement
    const before = output.value
    expect(before).toContain('Kowalska,\n// acct')

    fireEvent.change(screen.getByLabelText('Selection in ② Anonymized (paste to AI)'), {
      target: { value: 'Kowalska,\n// acct' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Mask selection' }))

    const toast = screen.getByText(ONE_LINE)
    expect(toast.className).toContain('error')
    expect(output.value).toBe(before)
    expect(output.value).not.toContain('__MANUAL__')
    expect(screen.queryByText('Marked by hand')).toBeNull()
    expect(screen.getByRole('button', { name: 'Mask selection' })).toBeTruthy()
  })
})
