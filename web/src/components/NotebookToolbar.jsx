/**
 * NotebookToolbar — presentational toolbar for the notebook view.
 * Extracted from Notebook.jsx. All behavior lives in the callbacks/state passed
 * in as props; this component only renders the buttons and the VM status pill.
 */
import { IconPlayAll, IconPlay, IconTrash, IconSave, IconFolderOpen, IconStop, IconSearch, IconX, IconZap, IconSun, IconMoon, IconFlame, IconCode, IconNotebook, IconEraser, IconDatabase } from './Icons'

export default function NotebookToolbar({
  tab,
  instances = {},
  cells,
  vmAlive,
  activeCellId,
  isExecuting,
  runProgress,
  runActiveCell,
  interruptExecution,
  executeAllCells,
  addCellAtEnd,
  deleteActiveCell,
  onNewNotebook,
  loadNotebook,
  saveMenuPos,
  setSaveMenuPos,
  exportMenuPos,
  setExportMenuPos,
  setShowSearch,
  searchInputRef,
  aiAvailable,
  autoDocumentNotebook,
  isAnnotating,
  clearAllOutputs,
  onCloseTab,
  setShowConnection,
  theme,
  onToggleTheme,
}) {
  return (
    <div className="notebook-toolbar">
      <div className="toolbar-scrollable">
        <div className="toolbar-brand">
          <IconZap width={14} height={14} />
          <span className="toolbar-notebook-name" title={tab.name}>{tab.name || 'Untitled'}</span>
        </div>

        <span className="toolbar-divider" />

        <div className="toolbar-group toolbar-group-cells" title="Cell actions">
          <button
            className="toolbar-btn toolbar-btn-run"
            onClick={runActiveCell}
            disabled={!activeCellId || isExecuting || !vmAlive}
            title="Run active cell (Shift+Enter)"
          >
            <IconPlay width={14} height={14} />
          </button>
          <button
            className="toolbar-btn toolbar-btn-stop"
            onClick={interruptExecution}
            disabled={!cells.some(c => c.status === 'running')}
            title="Stop execution"
          >
            <IconStop width={14} height={14} />
          </button>
          <button
            className="toolbar-btn toolbar-btn-run-all"
            onClick={executeAllCells}
            disabled={isExecuting || !vmAlive}
            title="Execute all cells sequentially"
          >
            <IconPlayAll width={14} height={14} />
            {runProgress && <span className="toolbar-progress">{runProgress.current}/{runProgress.total}</span>}
          </button>
          <button className="toolbar-btn" onClick={() => addCellAtEnd('code')} title="Add code cell">
            <IconCode width={14} height={14} />
          </button>
          <button className="toolbar-btn" onClick={() => addCellAtEnd('sql')} title="Add SQL cell">
            <IconDatabase width={14} height={14} />
          </button>
          <button className="toolbar-btn" onClick={() => addCellAtEnd('markdown')} title="Add text/markdown cell">
            <span style={{fontWeight: 700, fontSize: '13px'}}>M</span>
          </button>
          <button
            className="toolbar-btn toolbar-btn-delete"
            onClick={deleteActiveCell}
            disabled={!activeCellId}
            title="Delete active cell"
          >
            <IconTrash width={14} height={14} />
          </button>
        </div>

        <span className="toolbar-divider" />

        <div className="toolbar-group toolbar-group-notebook" title="Notebook actions">
          {onNewNotebook && (
            <button className="toolbar-btn" onClick={onNewNotebook} title="New notebook">
              <IconNotebook width={14} height={14} />
            </button>
          )}
          <button className="toolbar-btn toolbar-btn-open" onClick={loadNotebook} title="Open notebook">
            <IconFolderOpen width={14} height={14} />
          </button>
          <button className="toolbar-btn toolbar-btn-save" onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setSaveMenuPos(saveMenuPos ? null : { top: rect.bottom + 4, left: rect.left })
          }} title="Save notebook">
            <IconSave width={14} height={14} />
          </button>
          <button className="toolbar-btn" onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setExportMenuPos(exportMenuPos ? null : { top: rect.bottom + 4, left: rect.left })
          }} title="Export notebook">
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button className="toolbar-btn toolbar-btn-find" onClick={() => { setShowSearch(true); setTimeout(() => searchInputRef.current?.focus(), 50) }} title="Find in notebook (Cmd+F)">
            <IconSearch width={14} height={14} />
          </button>
          {aiAvailable && (
            <button
              className={`toolbar-btn toolbar-btn-autodoc ${isAnnotating ? 'toolbar-btn-loading' : ''}`}
              onClick={autoDocumentNotebook}
              disabled={!tab.microvmEndpoint || tab.status !== 'connected' || isAnnotating}
              title="Auto-annotate all cells with AI explanations"
            >
              {isAnnotating ? <span className="toolbar-spinner" /> : <IconZap width={14} height={14} />}
            </button>
          )}
          <button
            className="toolbar-btn"
            onClick={clearAllOutputs}
            disabled={!cells.some(c => c.output || c.error || c.html || c.image)}
            title="Clear all cell outputs"
          >
            <IconEraser width={14} height={14} />
          </button>
          {onCloseTab && (
            <button className="toolbar-btn toolbar-btn-close" onClick={() => onCloseTab(tab.id)} title="Close notebook">
              <IconX width={14} height={14} />
            </button>
          )}
        </div>

      </div>

      <div className="toolbar-pinned">
        {(() => {
          // VM state derived directly from instances (single source of truth)
          const vmState = tab.microvmId && instances[tab.microvmId] ? instances[tab.microvmId].state : null
          const isSuspended = vmState === 'SUSPENDED'
          const isTerminated = tab.microvmId && !instances[tab.microvmId]
          const isUnhealthy = tab.microvmId && instances[tab.microvmId]?.unhealthy
          return (
            <div className="toolbar-status" onClick={() => setShowConnection(true)} title="Click to manage connection">
              <span className={`status-dot ${isUnhealthy ? 'status-terminated' : isSuspended ? 'status-suspended' : isTerminated ? 'status-terminated' : `status-${tab.status}`}`} />
              <span className="status-text">
                {isUnhealthy ? 'Unhealthy' :
                 isSuspended ? 'Suspended' :
                 isTerminated ? 'Terminated' :
                 tab.status === 'connected' ? 'Running' :
                 tab.status === 'connecting' ? 'Connecting...' :
                 tab.status === 'launching' ? 'Launching...' :
                 'Disconnected'}
              </span>
              {tab.microvmId && tab.status === 'connected' && (
                <span className="status-id" title={tab.microvmId}>{tab.microvmId.slice(-12)}</span>
              )}
            </div>
          )
        })()}

        <button className="toolbar-theme-btn" onClick={onToggleTheme} title={`Switch theme (${theme})`}>
          {theme === 'dark' ? <IconSun width={14} height={14} /> : theme === 'light' ? <IconFlame width={14} height={14} /> : <IconMoon width={14} height={14} />}
        </button>
      </div>
    </div>
  )
}
