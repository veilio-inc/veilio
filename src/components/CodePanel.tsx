import { useState, useMemo, useRef, useEffect } from 'react'
import CodeMirror, { EditorView } from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { java } from '@codemirror/lang-java'
import { cpp } from '@codemirror/lang-cpp'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { createTheme } from '@uiw/codemirror-themes'
import { tags as t } from '@lezer/highlight'

const LANGS = {
  auto: null,
  js: javascript({ jsx: true, typescript: false }),
  ts: javascript({ jsx: true, typescript: true }),
  python: python(),
  java: java(),
  cpp: cpp(),
  rust: rust(),
  go: go(),
} as const

type LangKey = keyof typeof LANGS

// Every colour here is a custom-property reference from the syntax and editor
// scales rather than a literal. CodeMirror emits these as ordinary CSS
// declarations, so they resolve at paint time like anything else — which is
// what lets a second palette reach the editor without this file knowing a theme
// exists. Tags are grouped by ROLE, and the role is the token name.
const scrubTheme = createTheme({
  theme: 'dark',
  settings: {
    background: 'var(--code-bg)',
    foreground: 'var(--syntax-variable)',
    caret: 'var(--syntax-keyword)',
    selection: 'var(--editor-selection)',
    selectionMatch: 'var(--editor-selection-match)',
    gutterBackground: 'var(--code-bg)',
    gutterForeground: 'var(--syntax-comment)',
    lineHighlight: 'var(--editor-line-highlight)',
  },
  styles: [
    { tag: t.comment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
    { tag: t.lineComment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
    { tag: t.blockComment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
    { tag: t.keyword, color: 'var(--syntax-keyword)' }, // terracotta — keywords
    { tag: t.controlKeyword, color: 'var(--syntax-keyword)' },
    { tag: t.definitionKeyword, color: 'var(--syntax-keyword)' },
    { tag: t.moduleKeyword, color: 'var(--syntax-keyword)' },
    { tag: t.operatorKeyword, color: 'var(--syntax-keyword)' },
    { tag: t.string, color: 'var(--syntax-string)' }, // muted green — strings
    { tag: t.special(t.string), color: 'var(--syntax-string)' },
    { tag: t.regexp, color: 'var(--syntax-string)' },
    { tag: t.number, color: 'var(--syntax-number)' }, // muted blue — numbers
    { tag: t.bool, color: 'var(--syntax-number)' },
    { tag: t.null, color: 'var(--syntax-number)' },
    { tag: t.function(t.variableName), color: 'var(--syntax-function)' }, // warm yellow — function names
    { tag: t.function(t.propertyName), color: 'var(--syntax-function)' },
    { tag: t.className, color: 'var(--syntax-class)' }, // soft purple — classes/types
    { tag: t.typeName, color: 'var(--syntax-class)' },
    { tag: t.typeOperator, color: 'var(--syntax-class)' },
    { tag: t.propertyName, color: 'var(--syntax-property)' }, // warm tan — properties
    { tag: t.variableName, color: 'var(--syntax-variable)' },
    { tag: t.definition(t.variableName), color: 'var(--syntax-variable)' },
    { tag: t.operator, color: 'var(--syntax-punctuation)' },
    { tag: t.punctuation, color: 'var(--syntax-punctuation)' },
    { tag: t.angleBracket, color: 'var(--syntax-punctuation)' },
    { tag: t.bracket, color: 'var(--syntax-punctuation)' },
    { tag: t.squareBracket, color: 'var(--syntax-punctuation)' },
    { tag: t.brace, color: 'var(--syntax-punctuation)' },
    { tag: t.meta, color: 'var(--syntax-comment)' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strong, fontWeight: 'bold' },
    { tag: t.tagName, color: 'var(--syntax-keyword)' },
    { tag: t.attributeName, color: 'var(--syntax-property)' },
    { tag: t.attributeValue, color: 'var(--syntax-string)' },
  ],
})

const baseExtensions = [
  EditorView.lineWrapping,
  EditorView.theme({
    '&': { fontSize: '13px', height: '100%' },
    '.cm-scroller': { fontFamily: 'var(--font-mono, monospace)', lineHeight: '1.6' },
    '.cm-content': { padding: '16px' },
    '.cm-gutters': { borderRight: '1px solid var(--editor-gutter-border)', paddingRight: 4 },
    '.cm-activeLine': { backgroundColor: 'var(--editor-active-line)' },
    '.cm-cursor': { borderLeftColor: 'var(--syntax-keyword)', borderLeftWidth: '2px' },
    '.cm-placeholder': { color: 'var(--syntax-comment)', fontStyle: 'italic' },
  }),
]

interface Props {
  label: string
  value: string
  onChange?: (v: string) => void
  readOnly?: boolean
  placeholder?: string
  actions?: React.ReactNode
  badge?: string
  minHeight?: number
  /** Called with the selected text, or '' when the selection is emptied.
   *  Lets the page offer an action on a span the engine did not mask. */
  onSelectionChange?: (text: string) => void
}

export default function CodePanel({
  label,
  value,
  onChange,
  readOnly,
  placeholder,
  actions,
  badge,
  minHeight = 320,
  onSelectionChange,
}: Props) {
  const [lang, setLang] = useState<LangKey>('auto')
  const [copied, setCopied] = useState(false)

  // Held in a ref so the listener extension stays referentially stable. Putting
  // the callback in the extensions dep array rebuilds them on every parent
  // render, which tears down and recreates the editor mid-selection.
  const selectionCb = useRef(onSelectionChange)
  useEffect(() => {
    selectionCb.current = onSelectionChange
  }, [onSelectionChange])

  // Memoized so the array identity is stable. Previously this was a function
  // invoked in JSX, which handed CodeMirror a fresh array on every parent
  // render and made it reconfigure the editor each time. That churn was not
  // causing a visible defect, but it is pure waste on every keystroke.
  const extensions = useMemo(() => {
    const langExt = LANGS[lang]
    // Give CodeMirror's contenteditable an accessible name. Without this, axe
    // flags `aria-input-field-name` (serious WCAG 4.1.2 violation).
    const labelAttr = EditorView.contentAttributes.of({ 'aria-label': label })
    const selectionWatcher = EditorView.updateListener.of((u) => {
      if (!u.selectionSet && !u.docChanged) return
      const { from, to } = u.state.selection.main
      selectionCb.current?.(from === to ? '' : u.state.sliceDoc(from, to))
    })
    const exts = [...baseExtensions, labelAttr, selectionWatcher]
    return langExt ? [...exts, langExt] : exts
  }, [lang, label])

  async function copyToClipboard() {
    if (!value) return
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="code-panel">
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-surface)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-secondary)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
            }}
          >
            {label}
          </span>
          {badge && <span className="badge badge-accent">{badge}</span>}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {actions}
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value as LangKey)}
            aria-label="Source code language"
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              color: 'var(--text-secondary)',
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              padding: '2px 6px',
              cursor: 'pointer',
              outline: 'none',
            }}
          >
            <option value="auto">auto</option>
            <option value="ts">TypeScript</option>
            <option value="js">JavaScript</option>
            <option value="python">Python</option>
            <option value="java">Java</option>
            <option value="cpp">C / C++</option>
            <option value="rust">Rust</option>
            <option value="go">Go</option>
          </select>
          {value && (
            <button
              className="btn-ghost"
              style={{
                padding: '3px 10px',
                fontSize: 12,
                minWidth: 64,
                ...(copied
                  ? { color: 'var(--success)', borderColor: 'rgba(var(--success-rgb), 0.45)' }
                  : {}),
              }}
              onClick={copyToClipboard}
            >
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
          )}
        </div>
      </div>

      {/* Editor */}
      <div style={{ minHeight, flex: 1, overflow: 'auto' }}>
        <CodeMirror
          value={value}
          onChange={readOnly ? undefined : onChange}
          readOnly={readOnly}
          placeholder={placeholder}
          theme={scrubTheme}
          extensions={extensions}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLineGutter: true,
            highlightSpecialChars: true,
            foldGutter: false,
            dropCursor: true,
            allowMultipleSelections: false,
            indentOnInput: true,
            bracketMatching: true,
            closeBrackets: !readOnly,
            autocompletion: false,
            crosshairCursor: false,
            highlightActiveLine: true,
            highlightSelectionMatches: true,
            closeBracketsKeymap: !readOnly,
            searchKeymap: false,
            foldKeymap: false,
            completionKeymap: false,
            lintKeymap: false,
          }}
          style={{ minHeight }}
        />
      </div>
    </div>
  )
}
