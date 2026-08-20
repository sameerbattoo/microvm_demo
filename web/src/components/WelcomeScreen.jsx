/**
 * WelcomeScreen — the empty-state shown when no notebooks are open.
 * Presentational: New/Open/Sample/Git actions, the sample gallery, the git-import
 * input, and the getting-started hints. All state + handlers are passed in as props.
 */
import { IconSun, IconMoon, IconFlame } from './Icons'

export default function WelcomeScreen({
  theme,
  onToggleTheme,
  onNewNotebook,
  showSampleGallery,
  onToggleSampleGallery,
  samples = [],
  onLoadSample,
  showGitImport,
  setShowGitImport,
  setShowSampleGallery,
  gitImportUrl,
  setGitImportUrl,
  gitImportLoading,
  onImportFromGitUrl,
}) {
  // Open a local notebook file (.notebook.json or Jupyter .ipynb) via a hidden input.
  const handleOpenExisting = () => {
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
          if (data.nbformat && data.cells) {
            // Jupyter .ipynb
            const cells = data.cells
              .filter(c => c.cell_type === 'code' || c.cell_type === 'markdown')
              .map(c => {
                const code = Array.isArray(c.source) ? c.source.join('') : (c.source || '')
                let cellType = c.cell_type === 'markdown' ? 'markdown' : 'code'
                let cellCode = code
                if (cellType === 'code' && code.trimStart().startsWith('%%sql')) {
                  cellType = 'sql'
                  cellCode = code.trimStart().replace(/^%%sql\s*\n?/, '')
                }
                return { type: cellType, code: cellCode, output: null, error: null, html: null, image: null }
              })
            window.dispatchEvent(new CustomEvent('open-notebook', { detail: { name: file.name.replace('.ipynb', ''), description: '', tag: null, cells } }))
          } else if (data.cells && Array.isArray(data.cells)) {
            // Native .notebook.json
            window.dispatchEvent(new CustomEvent('open-notebook', { detail: { name: data.name || file.name.replace('.notebook.json', '').replace('.json', ''), description: data.description || '', tag: data.tag || null, cells: data.cells } }))
          }
        } catch { alert('Invalid notebook file.') }
      }
      reader.readAsText(file)
    }
    input.click()
  }

  return (
    <div className="app-empty">
      <button className="app-empty-theme-btn" onClick={onToggleTheme} title={`Switch theme (${theme})`}>
        {theme === 'dark' ? <IconSun width={16} height={16} /> : theme === 'light' ? <IconFlame width={16} height={16} /> : <IconMoon width={16} height={16} />}
      </button>
      <div className="app-empty-icon">
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill="rgba(137,180,250,0.2)" stroke="#89b4fa"/>
        </svg>
      </div>
      <h2 className="app-empty-title">Lambda MicroVM Notebook</h2>
      <p className="app-empty-subtitle">AI-Powered Python & SQL Notebooks on Serverless Firecracker Sandboxes</p>
      <div className="app-empty-actions">
        <button className="app-empty-btn app-empty-btn-primary" onClick={onNewNotebook}>
          + New Notebook
        </button>
        <button className="app-empty-btn" onClick={handleOpenExisting}>
          Open Existing
        </button>
        <button className={`app-empty-btn${showSampleGallery ? ' app-empty-btn-active' : ''}`} onClick={onToggleSampleGallery} aria-expanded={showSampleGallery}>
          Open Sample
          <svg className="app-empty-btn-chevron" width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <button className="app-empty-btn" onClick={() => { setShowSampleGallery(false); setShowGitImport(v => !v) }}>
          Import from Git URL
        </button>
      </div>
      <div className={`app-empty-samples-wrap${showSampleGallery ? ' open' : ''}`}>
        <div className="app-empty-samples-inner">
          <div className="app-empty-samples">
            {samples.length === 0 && (
              <div className="app-empty-samples-loading">Loading samples…</div>
            )}
            {samples.map(s => (
              <button
                key={s.id}
                className="sample-card"
                onClick={() => onLoadSample(`/samples/${s.file}`, s.name)}
                title={s.description || s.name}
                tabIndex={showSampleGallery ? 0 : -1}
              >
                <span className="sample-card-icon">{s.icon}</span>
                <span className="sample-card-text">
                  <span className="sample-card-name">{s.name}</span>
                  {s.description && <span className="sample-card-desc">{s.description}</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
      {showGitImport && (
        <div className="app-empty-git-import">
          <input
            className="app-empty-git-input"
            type="text"
            placeholder="Paste GitHub URL (e.g. https://github.com/user/repo/blob/main/notebook.ipynb)"
            value={gitImportUrl}
            onChange={e => setGitImportUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') onImportFromGitUrl(); if (e.key === 'Escape') setShowGitImport(false) }}
            autoFocus
            disabled={gitImportLoading}
          />
          <button className="app-empty-git-btn" onClick={onImportFromGitUrl} disabled={gitImportLoading || !gitImportUrl.trim()}>
            {gitImportLoading ? 'Importing...' : 'Import'}
          </button>
        </div>
      )}
      <div className="app-empty-hints">
        <div className="app-empty-hint">
          <span className="app-empty-hint-icon">1</span>
          <span>Create a notebook and connect to a MicroVM sandbox</span>
        </div>
        <div className="app-empty-hint">
          <span className="app-empty-hint-icon">2</span>
          <span>Write Python or SQL in cells — <kbd>Shift+Enter</kbd> to execute</span>
        </div>
        <div className="app-empty-hint">
          <span className="app-empty-hint-icon">3</span>
          <span>Use the <strong>AI assistant</strong> — toggle any cell to AI mode, describe what you want, and get code generated</span>
        </div>
        <div className="app-empty-hint">
          <span className="app-empty-hint-icon">4</span>
          <span>Click data sources in the sidebar to insert ready-to-run query code</span>
        </div>
      </div>
    </div>
  )
}
