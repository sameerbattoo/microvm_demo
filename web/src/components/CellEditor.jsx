/**
 * CellEditor — CodeMirror 6 editor wrapper for notebook cells.
 *
 * Replaces the textarea + Prism overlay approach with a proper code editor
 * that provides syntax highlighting, autocomplete, bracket matching, and
 * keybindings out of the box.
 *
 * Props:
 *   code         - current cell code (controlled from parent)
 *   language     - 'python' | 'sql'
 *   placeholder  - placeholder text when empty
 *   onCodeChange - callback(newCode) on every edit
 *   onExecute    - callback() for Shift+Enter
 *   onFocus      - callback() when editor gains focus
 *   readOnly     - boolean
 *   variables    - array of namespace variable names for autocomplete
 *   dataSources  - { items: [], schemas: {} } for table/file completion
 *   sessionId    - session ID for API calls
 */

import { useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { EditorState, Compartment, Annotation } from '@codemirror/state'
import { EditorView, keymap, placeholder as cmPlaceholder, lineNumbers, drawSelection, highlightActiveLine, highlightSpecialChars } from '@codemirror/view'
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands'
import { python } from '@codemirror/lang-python'
import { sql as sqlLang } from '@codemirror/lang-sql'
import { syntaxHighlighting, indentOnInput, bracketMatching, HighlightStyle } from '@codemirror/language'
import { autocompletion, closeBrackets, closeBracketsKeymap, startCompletion } from '@codemirror/autocomplete'
import { tags } from '@lezer/highlight'
import { PROXY_URL } from '../config'

// ─── Theme: matches our CSS custom properties ───────────────────────────
const editorTheme = EditorView.theme({
  '&': {
    fontSize: '13px',
    fontFamily: 'var(--font-mono)',
    backgroundColor: 'transparent',
  },
  '.cm-content': {
    padding: '12px',
    caretColor: 'var(--text-primary)',
    lineHeight: '1.6',
    minHeight: '40px',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-line': {
    padding: '0',
  },
  '.cm-gutters': {
    display: 'none', // We use our own gutter (cell numbers)
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--accent-primary-subtle)',
  },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--accent-primary-muted) !important',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--text-primary)',
    borderLeftWidth: '2px',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'var(--accent-success-subtle)',
    outline: '1px solid var(--accent-success-muted)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface-3)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-md)',
    boxShadow: 'var(--shadow-lg)',
  },
  '.cm-tooltip-autocomplete': {
    '& > ul': {
      fontFamily: 'var(--font-mono)',
      fontSize: '12px',
      maxHeight: '200px',
    },
    '& > ul > li': {
      padding: '4px 8px',
      color: 'var(--text-primary)',
    },
    '& > ul > li[aria-selected]': {
      backgroundColor: 'var(--accent-primary-subtle)',
      color: 'var(--text-primary)',
    },
  },
  '.cm-completionIcon': {
    opacity: '0.6',
    marginRight: '4px',
  },
  '.cm-completionLabel': {
    color: 'var(--text-primary)',
  },
  '.cm-completionDetail': {
    color: 'var(--text-muted)',
    fontStyle: 'italic',
    marginLeft: '8px',
  },
  '.cm-placeholder': {
    color: 'var(--text-muted)',
    fontStyle: 'normal',
  },
  // Scrollbar
  '.cm-scroller': {
    overflow: 'hidden !important',
  },
}, { dark: true }) // Will be overridden per-theme via class

// ─── Syntax highlighting colors using theme variables ───────────────────
const syntaxColors = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--accent-purple)' },
  { tag: tags.string, color: 'var(--accent-success)' },
  { tag: tags.number, color: 'var(--accent-warning)' },
  { tag: tags.bool, color: 'var(--accent-warning)' },
  { tag: tags.null, color: 'var(--accent-warning)' },
  { tag: tags.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: tags.variableName, color: 'var(--text-primary)' },
  { tag: tags.definition(tags.variableName), color: 'var(--accent-primary)' },
  { tag: tags.propertyName, color: 'var(--text-secondary)' },
  { tag: tags.className, color: 'var(--accent-warning)' },
  { tag: tags.operator, color: 'var(--text-tertiary)' },
  { tag: tags.punctuation, color: 'var(--text-tertiary)' },
  { tag: tags.bracket, color: 'var(--text-secondary)' },
  { tag: tags.meta, color: 'var(--text-muted)' },
  { tag: tags.typeName, color: 'var(--accent-success)' },
  { tag: tags.attributeName, color: 'var(--accent-warning)' },
])

// ─── Compartments for dynamic reconfiguration ───────────────────────────
// (created per-instance so they don't conflict)

// ─── Search highlight — using CM6's native search extension ─────────────
import { search, setSearchQuery as cmSetSearchQuery, SearchQuery, findNext, findPrevious } from '@codemirror/search'

// ─── Annotation to mark external (programmatic) changes ─────────────────
// When we dispatch changes from the value prop, we annotate the transaction
// so the updateListener knows not to call onCodeChange back (prevents loop).
// This is the same pattern used by @uiw/react-codemirror.
const ExternalChange = Annotation.define()

export default function CellEditor({
  code = '',
  language = 'python',
  placeholder = '',
  onCodeChange,
  onExecute,
  onFocus,
  readOnly = false,
  variables = [],
  dataSources = { items: [], schemas: {} },
  sessionId = null,
  searchQuery = '',
  searchActiveOccurrence = -1,
}) {
  const containerRef = useRef(null)
  const viewRef = useRef(null)
  const compartmentsRef = useRef(null)

  // Lazily create compartments — only once, tied to the editor lifetime
  if (!compartmentsRef.current) {
    compartmentsRef.current = {
      lang: new Compartment(),
      readOnly: new Compartment(),
      completion: new Compartment(),
    }
  }
  const { lang: langCompartment, readOnly: readOnlyCompartment, completion: completionCompartment } = compartmentsRef.current

  // Stable refs for callbacks (avoid recreating editor on every render)
  const onCodeChangeRef = useRef(onCodeChange)
  const onExecuteRef = useRef(onExecute)
  const onFocusRef = useRef(onFocus)
  const variablesRef = useRef(variables)
  const dataSourcesRef = useRef(dataSources)
  const sessionIdRef = useRef(sessionId)
  const searchQueryRef = useRef(searchQuery)

  useEffect(() => { onCodeChangeRef.current = onCodeChange }, [onCodeChange])
  useEffect(() => { onExecuteRef.current = onExecute }, [onExecute])
  useEffect(() => { onFocusRef.current = onFocus }, [onFocus])
  useEffect(() => { variablesRef.current = variables }, [variables])
  useEffect(() => { dataSourcesRef.current = dataSources }, [dataSources])
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])

  // Language extension
  const getLangExtension = useCallback((lang) => {
    if (lang === 'sql') return sqlLang()
    return python()
  }, [])

  // ─── Autocomplete source ─────────────────────────────────────────────
  const completionSource = useCallback(async (context) => {
    const line = context.state.doc.lineAt(context.pos)
    const textBefore = line.text.slice(0, context.pos - line.from)

    // --- Dot completion ---
    const dotMatch = textBefore.match(/(\w+)\.\w*$/)
    if (dotMatch) {
      const prefix = dotMatch[1]
      const partial = textBefore.match(/\.(\w*)$/)?.[1] || ''

      // SQL: schema.table completion (e.g. database_name. or dynamodb.)
      if (language === 'sql') {
        const schemas = dataSourcesRef.current?.schemas || {}
        const tables = schemas[prefix]
        if (tables) {
          const options = tables
            .filter(t => t.toLowerCase().startsWith(partial.toLowerCase()) || partial === '')
            .map(t => {
              // Quote table name if it contains non-identifier characters (hyphens, spaces, etc.)
              const needsQuotes = /[^a-zA-Z0-9_]/.test(t)
              return {
                label: needsQuotes ? `"${t}"` : t,
                type: 'text',
                detail: `table in ${prefix}`,
              }
            })
          if (options.length > 0) {
            return { from: context.pos - partial.length, validFor: /^[\w"]*$/, options }
          }
        }
      }

      // Python: introspect variable (df.head, etc.)
      if (language === 'python' && sessionIdRef.current) {
        try {
          const headers = { 'Content-Type': 'application/json', 'X-Session-Id': sessionIdRef.current }
          const resp = await fetch(`${PROXY_URL}/proxy/introspect`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ variable: prefix, partial }),
          })
          if (resp.ok) {
            const data = await resp.json()
            if (data.completions && data.completions.length > 0) {
              return {
                from: context.pos - partial.length,
                validFor: /^\w*$/,
                options: data.completions.map(c => ({
                  label: c.name,
                  type: c.type || 'property',
                  detail: c.detail || '',
                  boost: c.name.startsWith('_') ? -1 : 0,
                })),
              }
            }
          }
        } catch (err) {
          if (err.name !== 'AbortError') {
            console.warn('[autocomplete] Introspect failed for', prefix, ':', err.message)
          }
        }
      }

      return null
    }

    // --- Word-based completion (variables, keywords, datasources) ---
    const wordMatch = textBefore.match(/(\w+)$/)
    if (!wordMatch) return null
    const partial = wordMatch[1]

    // Need at least 2 chars (unless explicit trigger via Ctrl+Space)
    if (partial.length < 2 && !context.explicit) return null

    const options = []

    // Namespace variables (always relevant)
    const vars = variablesRef.current || []
    vars
      .filter(v => v.toLowerCase().startsWith(partial.toLowerCase()) && v !== partial)
      .forEach(v => options.push({ label: v, type: 'variable', boost: 2 }))

    // Data source items (tables, schemas, URIs)
    const dsItems = dataSourcesRef.current?.items || []
    dsItems
      .filter(d => d.label.toLowerCase().startsWith(partial.toLowerCase()) && d.label !== partial)
      .forEach(d => options.push({ label: d.label, type: 'text', detail: d.detail || d.type, boost: 1 }))

    // Language-specific keywords (require 2+ chars)
    if (partial.length >= 2) {
      if (language === 'python') {
        const pyKeywords = [
          'print', 'len', 'range', 'enumerate', 'zip', 'map', 'filter',
          'sorted', 'reversed', 'list', 'dict', 'set', 'tuple', 'str', 'int', 'float',
          'bool', 'type', 'isinstance', 'hasattr', 'getattr', 'setattr',
          'import', 'from', 'def', 'class', 'return', 'yield', 'lambda',
          'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally',
          'with', 'as', 'raise', 'pass', 'break', 'continue', 'and', 'or', 'not', 'in', 'is',
          'True', 'False', 'None',
          'pandas', 'numpy', 'plt', 'pd', 'np', 'px',
          'DataFrame', 'Series', 'read_csv', 'read_parquet', 'read_json', 'read_excel',
          'groupby', 'merge', 'concat', 'pivot_table', 'describe', 'value_counts',
          'matplotlib', 'plotly', 'seaborn', 'boto3',
        ]
        pyKeywords
          .filter(b => b.toLowerCase().startsWith(partial.toLowerCase()) && b !== partial)
          .forEach(b => options.push({ label: b, type: 'keyword' }))
      } else if (language === 'sql') {
        const sqlKeywords = [
          'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'BETWEEN', 'LIKE', 'IS', 'NULL',
          'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
          'CREATE', 'TABLE', 'DROP', 'ALTER', 'ADD', 'COLUMN',
          'JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'FULL', 'CROSS', 'ON',
          'GROUP', 'BY', 'ORDER', 'ASC', 'DESC', 'HAVING', 'LIMIT', 'OFFSET',
          'AS', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
          'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
          'UNION', 'ALL', 'EXCEPT', 'INTERSECT',
          'EXISTS', 'ANY', 'SOME',
          'CAST', 'COALESCE', 'NULLIF', 'IFNULL',
          'WITH', 'RECURSIVE',
          'OVER', 'PARTITION', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD',
          'VARCHAR', 'INTEGER', 'FLOAT', 'DOUBLE', 'BOOLEAN', 'DATE', 'TIMESTAMP',
          'read_csv', 'read_parquet', 'read_json', 'read_csv_auto',
          'INSTALL', 'LOAD', 'DESCRIBE', 'SHOW', 'TABLES', 'COLUMNS',
          'STRFTIME', 'DATE_TRUNC', 'DATE_PART', 'EXTRACT',
        ]
        sqlKeywords
          .filter(k => k.toLowerCase().startsWith(partial.toLowerCase()) && k.toLowerCase() !== partial.toLowerCase())
          .forEach(k => options.push({ label: k, type: 'keyword' }))
      }
    }

    if (options.length === 0) return null
    return {
      from: context.pos - partial.length,
      validFor: /^\w*$/,
      options,
    }
  }, [language])

  // ─── Create editor instance ───────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    if (viewRef.current) return // Already created

    const state = EditorState.create({
      doc: code,
      extensions: [
        // Core
        lineNumbers(),
        highlightActiveLine(),
        highlightSpecialChars(),
        drawSelection(),
        EditorView.lineWrapping,
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        history(),
        editorTheme,
        syntaxHighlighting(syntaxColors),

        // Placeholder
        cmPlaceholder(placeholder),

        // Language (in compartment for dynamic switching)
        langCompartment.of(getLangExtension(language)),

        // Read-only (in compartment)
        readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),

        // Autocomplete
        completionCompartment.of(
          autocompletion({
            override: [completionSource],
            activateOnTyping: true,
            maxRenderedOptions: 30,
          })
        ),

        // Search highlighting (CM6 native — panel hidden, highlights only)
        search({ top: false, createPanel: () => ({ dom: document.createElement('span') }) }),

        // Keybindings
        keymap.of([
          {
            key: 'Shift-Enter',
            run: () => {
              if (onExecuteRef.current) onExecuteRef.current()
              return true
            },
          },
          ...closeBracketsKeymap,
          ...historyKeymap,
          indentWithTab,
          ...defaultKeymap,
        ]),

        // Update listener — sync code changes back to parent
        EditorView.updateListener.of((update) => {
          if (update.docChanged && onCodeChangeRef.current &&
              !update.transactions.some(tr => tr.annotation(ExternalChange))) {
            onCodeChangeRef.current(update.state.doc.toString())
          }
          if (update.focusChanged && update.view.hasFocus && onFocusRef.current) {
            onFocusRef.current()
          }
          // Trigger completion on '.' (dot-completion for Python objects and SQL schemas)
          if (update.docChanged) {
            update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
              if (inserted.toString() === '.') {
                setTimeout(() => startCompletion(update.view), 10)
              }
            })
          }
        }),
      ],
    })

    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view

    return () => {

      view.destroy()
      viewRef.current = null
    }
  }, []) // Only run once on mount

  // ─── Sync external code changes INTO the editor ───────────────────────
  // Uses the ExternalChange annotation so the updateListener knows to skip
  // calling onCodeChange (prevents echo loop). Same pattern as @uiw/react-codemirror.

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view) return
    const currentDoc = view.state.doc.toString()
    if (currentDoc !== code) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: code },
        annotations: [ExternalChange.of(true)],
      })
    }
  })

  // ─── Switch language dynamically ─────────────────────────────────────
  useEffect(() => {

    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: langCompartment.reconfigure(getLangExtension(language)),
    })
  }, [language, getLangExtension])

  // ─── Update read-only state ───────────────────────────────────────────
  useEffect(() => {

    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
    })
  }, [readOnly])

  // ─── Update autocomplete when variables change ────────────────────────
  useEffect(() => {

    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: completionCompartment.reconfigure(
        autocompletion({
          override: [completionSource],
          activateOnTyping: true,
          maxRenderedOptions: 30,
        })
      ),
    })
  }, [variables, completionSource])

  // ─── Update search highlighting ──────────────────────────────────────
  useEffect(() => {
    searchQueryRef.current = searchQuery

    const view = viewRef.current
    if (!view) return
    // Set the search query (highlights all matches)
    const q = new SearchQuery({
      search: searchQuery || '',
      caseSensitive: false,
      literal: true,
    })
    view.dispatch({ effects: cmSetSearchQuery.of(q) })

    // Advance to the active occurrence within this cell
    if (searchQuery && searchActiveOccurrence >= 0) {
      // Move cursor to start of document, then findNext N times
      view.dispatch({ selection: { anchor: 0 } })
      for (let i = 0; i <= searchActiveOccurrence; i++) {
        findNext(view)
      }
    }
  }, [searchQuery, searchActiveOccurrence])

  return (
    <div ref={containerRef} className="cell-cm-editor" />
  )
}
