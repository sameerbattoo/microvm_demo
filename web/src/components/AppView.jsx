import { useMemo } from 'react'
import { marked } from 'marked'
import { sanitizeMarkdown } from '../services/sanitize'
import ParamWidgets, { parseParams } from './ParamWidgets'
import CellOutput from './CellOutput'
import { appShows, deriveDisplayVar } from '../services/appViewModel'
import { IconPlayAll } from './Icons'
import './AppView.css'

/**
 * AppView — Phase 1 of app publishing: an author-only, live "consumer" view of a
 * workbook. Reuses the author's current MicroVM/session (zero new infra) — it is
 * purely a presentation layer over the existing cells + the @param re-run loop.
 *
 * Layout: title/description, an "Inputs" control panel (all @param widgets), then
 * the presentation content (markdown + charts/tables/metric outputs). Code editors
 * are hidden. Changing an input re-runs from that cell downward via the existing
 * 'notebook-run-from-cell' pipeline. If nothing has been run yet, we show a
 * "Run all to preview" prompt instead of empty charts.
 */

export default function AppView({ cells = [], isConnected = false, isExecuting = false, onRunAll, updateCellCode }) {
  // All cells that expose @param controls, with their index (for run-from-cell).
  const paramCells = useMemo(
    () => cells
      .map((cell, index) => ({ cell, index, params: parseParams(cell.code || '') }))
      .filter(entry => entry.params.length > 0),
    [cells]
  )

  const presentationCells = useMemo(() => cells.filter(appShows), [cells])

  const hasAnyOutput = cells.some(c => c.type !== 'markdown' && (c.output || c.html || c.image))

  // Stale = a runnable cell's code changed since it was last executed.
  const isStale = cells.some(
    c => c.type !== 'markdown' && c.code?.trim() && c.lastExecutedCode != null && c.lastExecutedCode !== c.code
  )

  // Re-run from a given cell downward using the existing notebook execution pipeline.
  const runFrom = (cellId) => {
    const idx = cells.findIndex(c => c.id === cellId)
    if (idx >= 0) {
      window.dispatchEvent(new CustomEvent('notebook-run-from-cell', { detail: { cellIdx: idx } }))
    }
  }

  return (
    <div className="app-view">
      <div className="app-view-inner">
        {paramCells.length > 0 && (
          <section className="app-controls">
            <div className="app-controls-title">Inputs</div>
            {paramCells.map(({ cell, index }) => (
              <ParamWidgets
                key={cell.id}
                code={cell.code}
                onCodeChange={(newCode) => updateCellCode(cell.id, newCode)}
                onExecute={() => runFrom(cell.id)}
              />
            ))}
            {!isConnected && (
              <div className="app-controls-hint">Connect a MicroVM to make inputs live.</div>
            )}
          </section>
        )}

        {isStale && hasAnyOutput && (
          <div className="app-stale-banner">
            <span>Outputs may be out of date.</span>
            <button
              className="app-run-btn app-run-btn-sm"
              onClick={onRunAll}
              disabled={!isConnected || isExecuting}
            >
              {isExecuting ? 'Running…' : 'Run all'}
            </button>
          </div>
        )}

        {!hasAnyOutput ? (
          <div className="app-empty">
            <IconPlayAll width={26} height={26} />
            <p className="app-empty-title">This app hasn’t been run yet</p>
            <p className="app-empty-sub">Run all cells to render the app preview.</p>
            <button
              className="app-run-btn"
              onClick={onRunAll}
              disabled={!isConnected || isExecuting}
            >
              {isExecuting ? 'Running…' : 'Run all to preview'}
            </button>
            {!isConnected && <p className="app-empty-hint">Connect a MicroVM first.</p>}
          </div>
        ) : (
          <div className="app-content">
            {presentationCells.map(cell => {
              if (cell.type === 'markdown') {
                return (
                  <div key={cell.id} className="app-block app-block-markdown">
                    <div
                      className="md-rendered app-markdown"
                      dangerouslySetInnerHTML={{ __html: sanitizeMarkdown(marked.parse(cell.code || '')) }}
                    />
                  </div>
                )
              }
              const varName = deriveDisplayVar(cell)
              return (
                <div key={cell.id} className={`app-block app-block-${cell.type}`}>
                  {varName && (
                    <div className="app-block-var">
                      <span className="app-var-name">{varName}</span>
                    </div>
                  )}
                  <CellOutput cell={cell} isConnected={false} />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
