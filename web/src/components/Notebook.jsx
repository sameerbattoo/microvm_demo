import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import Cell from './Cell'
import ConnectionPanel from './ConnectionPanel'
import { IconPlus, IconPlayAll, IconPlay, IconTrash, IconSave, IconFolderOpen, IconStop, IconFile, IconSearch, IconChevronUp, IconChevronDown, IconX, IconZap, IconSun, IconMoon, IconFlame, IconCode, IconNotebook, IconEraser, IconDatabase } from './Icons'
import { PROXY_URL } from '../config'
import { buildNativeNotebook, buildNotebookHTML, buildNotebookMarkdown, buildIPYNB, downloadTextFile } from '../services/notebookExport'
import NotebookToolbar from './NotebookToolbar'
import { useNotebookSearch } from '../hooks/useNotebookSearch'
import { useNotebookCells } from '../hooks/useNotebookCells'
import './Notebook.css'

export default function Notebook({ tab, instances = {}, onUpdateTab, onMarkVmRunning, onNewNotebook, onCloseTab, onRefreshMetrics, attachedIds = [], theme, onToggleTheme, aiAvailable = false }) {
  const [showConnection, setShowConnection] = useState(tab.status !== 'connected' && !tab.microvmId)
  const [isAnnotating, setIsAnnotating] = useState(false)
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [saveMenuPos, setSaveMenuPos] = useState(null)
  const [exportMenuPos, setExportMenuPos] = useState(null)

  // Cell state + CRUD + drag-reorder + tab persistence + execution — one cohesive hook.
  const {
    cells, setCells, activeCellId, setActiveCellId, dragOverId,
    variables, isExecuting, runProgress,
    executeCell, executeAllCells, runActiveCell, interruptExecution,
    clearAllOutputs, deleteActiveCell,
    updateCellCode, updateCellOutputVar, addCellBelow, addCellAtEnd, changeCellType,
    handleDragStart, handleDragOver, handleDrop, handleDragEnd, deleteCell,
  } = useNotebookCells({ tab, onUpdateTab, onMarkVmRunning, onRefreshMetrics })

  // Sync connection panel visibility when tab status changes
  useEffect(() => {
    if (tab.status === 'connected') {
      // Auto-dismiss connection panel shortly after connecting
      const timer = setTimeout(() => {
        setShowConnection(false)
        // Clear any accidental text selection caused by overlay removal
        window.getSelection()?.removeAllRanges()
        // Auto-focus first code cell
        const firstCodeCell = cells.find(c => c.type !== 'markdown')
        if (firstCodeCell) {
          setActiveCellId(firstCodeCell.id)
          setTimeout(() => {
            const el = document.querySelector(`[data-cell-id="${firstCodeCell.id}"] .cm-editor .cm-content`)
            if (el) el.focus()
          }, 100)
        }
      }, 800)
      return () => clearTimeout(timer)
    }
  }, [tab.status])

  // Auto-show connection panel when VM is terminated (disappeared from instances)
  useEffect(() => {
    if (tab.microvmId && Object.keys(instances).length > 0 && !instances[tab.microvmId]) {
      setShowConnection(true)
    }
  }, [tab.microvmId, instances])
  // Find-in-notebook (Cmd+F) — search state, match computation, and navigation.
  const {
    showSearch, setShowSearch,
    searchQuery, setSearchQuery,
    searchMatches, setSearchMatches,
    searchActiveIdx,
    searchInputRef,
    searchNext, searchPrev,
    searchMatchCellIds, searchActiveOccurrenceMap,
  } = useNotebookSearch(cells, setActiveCellId)

  const handleConnect = useCallback((endpoint) => {
    onUpdateTab({
      microvmEndpoint: endpoint,
      status: 'connected',
    })
    setShowConnection(false)
  }, [onUpdateTab])

  // Auto-document: explain all code cells that don't have an AI explanation yet
  const autoDocumentNotebook = useCallback(async () => {
    // Only annotate cells that don't already have an AI explanation AND don't have a markdown summary above
    const codeCells = cells.filter((c, idx) => {
      if (c.type === 'markdown' || !c.code?.trim()) return false
      if (c.aiExplanation) return false
      // Check if the cell above is already a markdown annotation
      if (idx > 0 && cells[idx - 1].type === 'markdown') return false
      return true
    })
    if (codeCells.length === 0) return

    setIsAnnotating(true)
    // Process cells sequentially to avoid rate limiting
    for (const cell of codeCells) {
      try {
        const resp = await fetch(`${PROXY_URL}/ai/explain`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: cell.code || '',
            output: (cell.output || '') + (cell.html ? ' [table output]' : ''),
            microvm_id: tab.microvmId || '',
            session_id: tab.sessionId || '',
          }),
        })
        if (resp.ok) {
          const data = await resp.json()
          if (data.explanation) {
            setCells(prev => prev.map(c => c.id === cell.id ? { ...c, aiExplanation: data.explanation } : c))
          }
          // Insert markdown summary above
          if (data.summary) {
            setCells(prev => {
              const idx = prev.findIndex(c => c.id === cell.id)
              if (idx < 0) return prev
              const mdText = data.summary.startsWith('#') || data.summary.startsWith('**') ? data.summary : `**${data.summary}**`
              const descLine = data.description ? `\n\n${data.description}` : ''
              const newCells = [...prev]
              newCells.splice(idx, 0, { id: Date.now() + Math.random(), type: 'markdown', code: mdText + descLine, output: null, error: null, html: null, image: null })
              return newCells
            })
          }
        }
      } catch {}
    }
    setIsAnnotating(false)
  }, [cells, tab.microvmId, tab.sessionId])

  const saveNotebook = useCallback(() => {
    downloadTextFile(buildNativeNotebook(tab, cells))
  }, [tab.name, tab.description, tab.tag, tab.microvmId, cells])

  // Listen for Cmd+S save shortcut
  useEffect(() => {
    const handler = () => saveNotebook()
    window.addEventListener('notebook-save', handler)
    return () => window.removeEventListener('notebook-save', handler)
  }, [saveNotebook])

  const exportNotebookHTML = useCallback(() => {
    downloadTextFile(buildNotebookHTML(tab, cells))
  }, [tab.name, tab.description, cells])

  const exportNotebookMD = useCallback(() => {
    downloadTextFile(buildNotebookMarkdown(tab, cells))
  }, [tab.name, tab.description, cells])

  const saveAsIPYNB = useCallback(() => {
    downloadTextFile(buildIPYNB(tab, cells))
    setSaveMenuPos(null)
  }, [tab.name, cells])

  const loadNotebook = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.notebook.json,.ipynb'
    input.onchange = (e) => {
      const file = e.target.files?.[0]
      if (!file) return

      const reader = new FileReader()
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result)

          // Detect Jupyter .ipynb format
          if (data.nbformat && data.cells && Array.isArray(data.cells)) {
            // Parse Jupyter notebook
            const cells = data.cells
              .filter(c => c.cell_type === 'code' || c.cell_type === 'markdown')
              .map(c => {
                const code = Array.isArray(c.source) ? c.source.join('') : (c.source || '')
                // Detect %%sql magic → SQL cell type
                let cellType = c.cell_type === 'markdown' ? 'markdown' : 'code'
                let cellCode = code
                if (cellType === 'code' && code.trimStart().startsWith('%%sql')) {
                  cellType = 'sql'
                  cellCode = code.trimStart().replace(/^%%sql\s*\n?/, '')
                }
                // Extract text output if available
                let output = null
                if (c.outputs && c.outputs.length > 0) {
                  const textOut = c.outputs.find(o => o.output_type === 'stream' || o.output_type === 'execute_result')
                  if (textOut) {
                    const text = textOut.text || textOut.data?.['text/plain']
                    output = Array.isArray(text) ? text.join('') : text || null
                  }
                }
                return {
                  type: cellType,
                  code: cellCode,
                  output,
                  error: null,
                  html: null,
                  image: null,
                }
              })

            const name = file.name.replace('.ipynb', '')
            window.dispatchEvent(new CustomEvent('open-notebook', {
              detail: { name, description: `Imported from Jupyter: ${file.name}`, tag: null, cells }
            }))
            return
          }

          // Our native .notebook.json format
          if (data.cells && Array.isArray(data.cells)) {
            window.dispatchEvent(new CustomEvent('open-notebook', {
              detail: {
                name: data.name || file.name.replace('.notebook.json', '').replace('.json', ''),
                description: data.description || '',
                tag: data.tag || null,
                cells: data.cells,
              }
            }))
          }
        } catch {
          alert('Invalid notebook file. Supported formats: .notebook.json, .ipynb')
        }
      }
      reader.readAsText(file)
    }
    input.click()
  }, [onUpdateTab])

  // Derive whether the linked VM is alive (exists in instances) — used for toolbar/cell disabled state
  const vmAlive = tab.microvmId && !!instances[tab.microvmId]

  return (
    <>
    <div className="notebook">
      {showConnection && tab.status !== 'connecting' && (
        <ConnectionPanel
          tab={tab}
          onConnect={handleConnect}
          onUpdateTab={onUpdateTab}
          onDismiss={() => setShowConnection(false)}
          attachedIds={attachedIds}
        />
      )}
      {!showConnection && (
        <>
        <NotebookToolbar
          tab={tab}
          instances={instances}
          cells={cells}
          vmAlive={vmAlive}
          activeCellId={activeCellId}
          isExecuting={isExecuting}
          runProgress={runProgress}
          runActiveCell={runActiveCell}
          interruptExecution={interruptExecution}
          executeAllCells={executeAllCells}
          addCellAtEnd={addCellAtEnd}
          deleteActiveCell={deleteActiveCell}
          onNewNotebook={onNewNotebook}
          loadNotebook={loadNotebook}
          saveMenuPos={saveMenuPos}
          setSaveMenuPos={setSaveMenuPos}
          exportMenuPos={exportMenuPos}
          setExportMenuPos={setExportMenuPos}
          setShowSearch={setShowSearch}
          searchInputRef={searchInputRef}
          aiAvailable={aiAvailable}
          autoDocumentNotebook={autoDocumentNotebook}
          isAnnotating={isAnnotating}
          clearAllOutputs={clearAllOutputs}
          onCloseTab={onCloseTab}
          setShowConnection={setShowConnection}
          theme={theme}
          onToggleTheme={onToggleTheme}
        />
        {tab.description && (
          <div className="notebook-identity">
            <span className="notebook-description">{tab.description}</span>
          </div>
        )}
        </>
      )}

      {showSearch && (
        <div className="notebook-search-bar">
          <div className="notebook-search-field">
            <IconSearch width={13} height={13} className="notebook-search-icon" />
            <input
              ref={searchInputRef}
              className="notebook-search-input"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.shiftKey ? searchPrev() : searchNext() }
                if (e.key === 'Escape') { setShowSearch(false); setSearchQuery(''); setSearchMatches([]) }
              }}
              placeholder="Find in notebook..."
              autoFocus
            />
            {searchQuery && (
              <span className="notebook-search-count">
                {searchMatches.length > 0
                  ? `${searchActiveIdx + 1} of ${searchMatches.length} in ${new Set(searchMatches.map(m => m.cellId)).size} cells`
                  : 'No results'}
              </span>
            )}
          </div>
          <div className="notebook-search-actions">
            <button className="notebook-search-nav" onClick={searchPrev} disabled={searchMatches.length === 0} title="Previous (Shift+Enter)">
              <IconChevronUp width={14} height={14} />
            </button>
            <button className="notebook-search-nav" onClick={searchNext} disabled={searchMatches.length === 0} title="Next (Enter)">
              <IconChevronDown width={14} height={14} />
            </button>
            <button className="notebook-search-close" onClick={() => { setShowSearch(false); setSearchQuery(''); setSearchMatches([]) }} title="Close (Esc)">
              <IconX width={14} height={14} />
            </button>
          </div>
        </div>
      )}

      <div className="notebook-body">
      <div className="cells-container">
        {cells.map((cell, index) => (
          <Cell
            key={cell.id}
            cell={cell}
            index={index}
            isConnected={vmAlive}
            isActive={cell.id === activeCellId}
            isDragOver={cell.id === dragOverId}
            hasSearchMatch={searchMatchCellIds.has(cell.id)}
            onFocus={() => setActiveCellId(cell.id)}
            onExecute={() => executeCell(cell.id)}
            onInterrupt={interruptExecution}
            onCodeChange={(code) => updateCellCode(cell.id, code)}
            onOutputVarChange={(v) => updateCellOutputVar(cell.id, v)}
            onAddBelow={(type) => addCellBelow(cell.id, type)}
            onInsertAbove={(summary) => {
              const cellAbove = index > 0 ? cells[index - 1] : null
              if (!cellAbove || cellAbove.type !== 'markdown') {
                setCells(prev => {
                  const newCells = [...prev]
                  // Format as markdown bold heading
                  const mdText = summary.startsWith('#') ? summary : `**${summary}**`
                  newCells.splice(index, 0, { id: Date.now(), type: 'markdown', code: mdText, output: null, error: null, html: null, image: null })
                  return newCells
                })
              }
            }}
            onSetAiExplanation={(explanation) => {
              setCells(prev => prev.map(c => c.id === cell.id ? { ...c, aiExplanation: explanation } : c))
            }}
            onTypeChange={(newType) => changeCellType(cell.id, newType)}
            onDelete={() => deleteCell(cell.id)}
            onClearOutput={() => setCells(prev => prev.map(c => c.id === cell.id ? { ...c, output: null, error: null, html: null, image: null, executionNumber: null, executionTime: null, status: 'idle' } : c))}
            onDragStart={() => handleDragStart(cell.id)}
            onDragOver={() => handleDragOver(cell.id)}
            onDrop={() => handleDrop(cell.id)}
            onDragEnd={handleDragEnd}
            searchQuery={showSearch ? searchQuery : ''}
            searchActiveOccurrence={searchActiveOccurrenceMap[cell.id] ?? -1}
            notebookContext={cells}
            notebookName={tab.name}
            microvmId={tab.microvmId}
            sessionId={tab.sessionId}
            aiAvailable={aiAvailable}
            variables={variables}
            dataSources={tab._dataSources}
          />
        ))}
        <div className="add-cell-row">
          <button className="add-cell-btn" onClick={() => addCellAtEnd('code')}>
            + Code
          </button>
          <button className="add-cell-btn" onClick={() => addCellAtEnd('sql')}>
            + SQL
          </button>
          <button className="add-cell-btn" onClick={() => addCellAtEnd('markdown')}>
            + Text
          </button>
        </div>
      </div>

      </div>
    </div>
    {saveMenuPos && createPortal(
      <div className="toolbar-portal-menu" style={{ position: 'fixed', top: saveMenuPos.top, left: saveMenuPos.left, zIndex: 9999 }}>
        <div className="toolbar-portal-backdrop" onClick={() => setSaveMenuPos(null)} />
        <div className="toolbar-portal-options">
          <button onClick={() => { saveNotebook(); setSaveMenuPos(null) }}>Native (.notebook.json)</button>
          <button onClick={saveAsIPYNB}>Jupyter (.ipynb)</button>
        </div>
      </div>,
      document.body
    )}
    {exportMenuPos && createPortal(
      <div className="toolbar-portal-menu" style={{ position: 'fixed', top: exportMenuPos.top, left: exportMenuPos.left, zIndex: 9999 }}>
        <div className="toolbar-portal-backdrop" onClick={() => setExportMenuPos(null)} />
        <div className="toolbar-portal-options">
          <button onClick={() => { exportNotebookHTML(); setExportMenuPos(null) }}>HTML</button>
          <button onClick={() => { exportNotebookMD(); setExportMenuPos(null) }}>Markdown</button>
        </div>
      </div>,
      document.body
    )}
    </>
  )
}
