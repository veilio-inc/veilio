import { useState, useCallback } from 'react'
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

const scrubTheme = createTheme({
  theme: 'dark',
  settings: {
    background: 'var(--code-bg, #141210)',
    foreground: '#FAF9F7',
    caret: '#CC785C',
    selection: 'rgba(204,120,92,0.25)',
    selectionMatch: 'rgba(204,120,92,0.15)',
    gutterBackground: 'var(--code-bg, #141210)',
    gutterForeground: '#6B6360',
    lineHighlight: 'rgba(255,255,255,0.04)',
  },
  styles: [
    { tag: t.comment,             color: '#6B6360', fontStyle: 'italic' },
    { tag: t.lineComment,         color: '#6B6360', fontStyle: 'italic' },
    { tag: t.blockComment,        color: '#6B6360', fontStyle: 'italic' },
    { tag: t.keyword,             color: '#CC785C' },       // terracotta — keywords
    { tag: t.controlKeyword,      color: '#CC785C' },
    { tag: t.definitionKeyword,   color: '#CC785C' },
    { tag: t.moduleKeyword,       color: '#CC785C' },
    { tag: t.operatorKeyword,     color: '#CC785C' },
    { tag: t.string,              color: '#8DB38B' },       // muted green — strings
    { tag: t.special(t.string),   color: '#8DB38B' },
    { tag: t.regexp,              color: '#8DB38B' },
    { tag: t.number,              color: '#A8C0D6' },       // muted blue — numbers
    { tag: t.bool,                color: '#A8C0D6' },
    { tag: t.null,                color: '#A8C0D6' },
    { tag: t.function(t.variableName), color: '#E0C97F' },  // warm yellow — function names
    { tag: t.function(t.propertyName), color: '#E0C97F' },
    { tag: t.className,           color: '#C49AC0' },       // soft purple — classes/types
    { tag: t.typeName,            color: '#C49AC0' },
    { tag: t.typeOperator,        color: '#C49AC0' },
    { tag: t.propertyName,        color: '#C4A882' },       // warm tan — properties
    { tag: t.variableName,        color: '#FAF9F7' },
    { tag: t.definition(t.variableName), color: '#FAF9F7' },
    { tag: t.operator,            color: '#A89F99' },
    { tag: t.punctuation,         color: '#A89F99' },
    { tag: t.angleBracket,        color: '#A89F99' },
    { tag: t.bracket,             color: '#A89F99' },
    { tag: t.squareBracket,       color: '#A89F99' },
    { tag: t.brace,               color: '#A89F99' },
    { tag: t.meta,                color: '#6B6360' },
    { tag: t.emphasis,            fontStyle: 'italic' },
    { tag: t.strong,              fontWeight: 'bold' },
    { tag: t.tagName,             color: '#CC785C' },
    { tag: t.attributeName,       color: '#C4A882' },
    { tag: t.attributeValue,      color: '#8DB38B' },
  ],
})

const baseExtensions = [
  EditorView.lineWrapping,
  EditorView.theme({
    '&': { fontSize: '13px', height: '100%' },
    '.cm-scroller': { fontFamily: 'var(--font-mono, monospace)', lineHeight: '1.6' },
    '.cm-content': { padding: '16px' },
    '.cm-gutters': { borderRight: '1px solid rgba(255,255,255,0.06)', paddingRight: 4 },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
    '.cm-cursor': { borderLeftColor: '#CC785C', borderLeftWidth: '2px' },
    '.cm-placeholder': { color: '#6B6360', fontStyle: 'italic' },
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
}: Props) {
  const [lang, setLang] = useState<LangKey>('auto')

  const extensions = useCallback(() => {
    const langExt = LANGS[lang]
    // Give CodeMirror's contenteditable an accessible name. Without this, axe
    // flags `aria-input-field-name` (serious WCAG 4.1.2 violation).
    const labelAttr = EditorView.contentAttributes.of({ 'aria-label': label })
    const exts = langExt ? [...baseExtensions, langExt, labelAttr] : [...baseExtensions, labelAttr]
    return exts
  }, [lang, label])

  async function copyToClipboard() {
    if (value) await navigator.clipboard.writeText(value)
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
              style={{ padding: '3px 10px', fontSize: 12 }}
              onClick={copyToClipboard}
            >
              Copy
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
          extensions={extensions()}
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
