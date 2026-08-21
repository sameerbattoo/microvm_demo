/**
 * NotebookToolbar — presentational toolbar for the notebook view.
 * Extracted from Notebook.jsx. All behavior lives in the callbacks/state passed
 * in as props; this component only renders the buttons and the VM status pill.
 */
import { IconPlayAll, IconSave, IconFolderOpen, IconStop, IconSearch, IconX, IconZap, IconSun, IconMoon, IconFlame, IconNotebook, IconEraser } from './Icons'

export default function NotebookToolbar({
  tab,
  instances = {},
  cells,
  vmAlive,
  viewMode = 'notebook',
  setViewMode,
  isExecuting,
  runProgress,
  interruptExecution,
  executeAllCells,
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
  clearAnnotations,
  hasAnnotations,
  clearAllOutputs,
  onCloseTab,
  setShowConnection,
  theme,
  onToggleTheme,
}) {
  return (
    <div className="notebook-toolbar">
      {setViewMode && (
        <div className="toolbar-lead">
          <div className="toolbar-viewmode" role="tablist" aria-label="View mode">
            <button
              className={`viewmode-seg ${viewMode === 'notebook' ? 'viewmode-seg-active' : ''}`}
              onClick={() => setViewMode('notebook')}
              role="tab"
              aria-selected={viewMode === 'notebook'}
              title="Edit the notebook"
            >
              Notebook
            </button>
            <button
              className={`viewmode-seg ${viewMode === 'app' ? 'viewmode-seg-active' : ''}`}
              onClick={() => setViewMode('app')}
              role="tab"
              aria-selected={viewMode === 'app'}
              title="Preview as an app (code hidden, inputs on top)"
            >
              App
            </button>
          </div>
        </div>
      )}
      <div className="toolbar-scrollable">
        <div className="toolbar-brand">
          <IconZap width={14} height={14} />
          <span className="toolbar-notebook-name" title={tab.name}>{tab.name || 'Untitled'}</span>
        </div>

        <span className="toolbar-divider" />

        <div className="toolbar-group toolbar-group-run" title="Run">
          <button
            className="toolbar-btn toolbar-btn-run-all"
            onClick={executeAllCells}
            disabled={isExecuting || !vmAlive}
            title="Run all cells"
          >
            <IconPlayAll width={14} height={14} />
            {runProgress && <span className="toolbar-progress">{runProgress.current}/{runProgress.total}</span>}
          </button>
          {cells.some(c => c.status === 'running') && (
            <button
              className="toolbar-btn toolbar-btn-stop"
              onClick={interruptExecution}
              title="Stop execution"
            >
              <IconStop width={14} height={14} />
            </button>
          )}
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
          {viewMode !== 'app' && (
            <button className="toolbar-btn toolbar-btn-find" onClick={() => { setShowSearch(true); setTimeout(() => searchInputRef.current?.focus(), 50) }} title="Find in notebook (Cmd+F)">
              <IconSearch width={14} height={14} />
            </button>
          )}
          {aiAvailable && (
            <button
              className={`toolbar-btn toolbar-btn-autodoc ${isAnnotating ? 'toolbar-btn-loading' : ''}`}
              onClick={autoDocumentNotebook}
              disabled={isAnnotating}
              title="Auto-document notebook with AI (title, section headers, per-cell comments)"
            >
              {isAnnotating ? <span className="toolbar-spinner" /> : <IconZap width={14} height={14} />}
            </button>
          )}
          {aiAvailable && hasAnnotations && !isAnnotating && clearAnnotations && (
            <button
              className="toolbar-btn"
              onClick={clearAnnotations}
              title="Clear AI documentation (generated title/sections + per-cell comments)"
            >
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3l18 18"/><path d="M10.5 5.5A5 5 0 0 1 19 9c0 2-1 3.5-2.5 5"/><path d="M7.5 7.5A5 5 0 0 0 5 11c0 3 3 5 7 5"/></svg>
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
