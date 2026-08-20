import { useEffect, useRef, useCallback } from 'react'
import { PROXY_URL } from '../config'
import { logError } from '../services/logger'
import { INTEL_GENERATING_POLL_MS, INTEL_IDLE_POLL_MS, INTEL_MAX_POLL_ATTEMPTS } from '../constants'

/**
 * useNotebookFiles — sandbox (VM /tmp) files + S3 user-data file operations for
 * the active tab: list/refresh, upload, delete (local + S3), each wired to a
 * debounced Notebook Intel (re)generation and a watch-then-refresh of the Data
 * Sources panel. Files are stored per-tab on `_localFiles`.
 */
export function useNotebookFiles({ tabs, setTabs, activeTabId }) {
  const intelTriggerTimer = useRef(null)
  const intelDeleteTimer = useRef(null)
  const intelS3DeleteTimer = useRef(null)

  // Fetch files from the active MicroVM (stored per-tab to avoid cross-VM contamination)
  const fetchFiles = useCallback(async () => {
    const activeTab = tabs.find(t => t.id === activeTabId)
    if (!activeTab || activeTab.status !== 'connected') {
      return
    }

    const headers = {}
    if (activeTab.sessionId) {
      headers['X-Session-Id'] = activeTab.sessionId
    }

    try {
      const resp = await fetch(`${activeTab.microvmEndpoint}/files`, { headers })
      if (resp.ok) {
        const data = await resp.json()
        const files = (data.files || []).map(f => ({
          name: f.name,
          size: f.size,
          variable: f.name.split('/').pop().replace(/\.[^.]+$/, '').replace(/[-\s.]/g, '_'),
          status: 'ready',
        }))
        // Store files on the tab object so each VM has its own file list
        setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, _localFiles: files } : t))
      }
    } catch {
      // Ignore — might not be connected yet
    }
  }, [tabs, activeTabId])

  // Refresh files when active tab changes or connects
  useEffect(() => {
    fetchFiles()
  }, [activeTabId, tabs.find(t => t.id === activeTabId)?.status])

  // After a file upload triggers an intel (re)generation — full OR delta — watch for
  // that run to finish, then refresh the Data Sources panel so the newly-uploaded
  // local file's entity-doc (sparkle) icon appears without a manual refresh.
  // This is needed in addition to the one-time auto-open poll, which is gated by
  // intelShownForSession and therefore does NOT re-fire for deltas on the same session.
  const watchIntelThenRefreshDataSources = useCallback((sessionId) => {
    if (!sessionId) return
    let attempts = 0
    let sawGenerating = false
    const poll = async () => {
      attempts++
      let data = null
      try {
        const resp = await fetch(`${PROXY_URL}/workbook-intel`, { headers: { 'X-Session-Id': sessionId } })
        if (resp.ok) data = await resp.json()
      } catch { /* transient — retry below */ }

      const status = data?.status
      if (status === 'generating') {
        sawGenerating = true
      }
      // Done once the run we triggered has produced a ready report. Requiring that we
      // first observed "generating" avoids refreshing on the pre-existing report before
      // the delta has actually started.
      if (status === 'ready' && (sawGenerating || attempts > 2)) {
        window.dispatchEvent(new CustomEvent('refresh-datasources'))
        return
      }
      if (status === 'error') return
      if (attempts >= INTEL_MAX_POLL_ATTEMPTS) return
      const delay = status === 'generating' ? INTEL_GENERATING_POLL_MS : INTEL_IDLE_POLL_MS
      setTimeout(poll, delay)
    }
    poll()
  }, [])

  const uploadFile = useCallback(async (file) => {
    // Find the active tab's connection to upload to
    const activeTab = tabs.find(t => t.id === activeTabId)
    if (!activeTab || activeTab.status !== 'connected') {
      alert('Connect to a MicroVM first before uploading files.')
      return
    }

    const size = file.size < 1024 * 1024
      ? `${(file.size / 1024).toFixed(1)} KB`
      : `${(file.size / (1024 * 1024)).toFixed(1)} MB`

    // Add to list immediately (uploading state)
    setTabs(prev => prev.map(t => t.id === activeTabId
      ? { ...t, _localFiles: [...(t._localFiles || []), { name: file.name, size, variable: null, status: 'uploading' }] }
      : t
    ))

    // Read as base64
    const reader = new FileReader()
    reader.onload = async (ev) => {
      const base64 = ev.target.result.split(',')[1]

      const headers = { 'Content-Type': 'application/json' }
      if (activeTab.sessionId) {
        headers['X-Session-Id'] = activeTab.sessionId
      }

      try {
        const response = await fetch(`${activeTab.microvmEndpoint}/upload`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ filename: file.name, data: base64 }),
        })
        const result = await response.json()

        setTabs(prev => prev.map(t => t.id === activeTabId
          ? { ...t, _localFiles: (t._localFiles || []).map(f =>
              f.name === file.name
                ? { ...f, variable: result.variable_name || null, status: result.success ? 'ready' : 'error' }
                : f
            ) }
          : t
        ))

        // Debounced intel trigger: fires 2s after the last successful upload
        if (result.success && activeTab.sessionId) {
          clearTimeout(intelTriggerTimer.current)
          const triggerSessionId = activeTab.sessionId
          intelTriggerTimer.current = setTimeout(() => {
            fetch(`${PROXY_URL}/workbook-intel/generate`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Session-Id': triggerSessionId },
              body: JSON.stringify({ trigger: 'file_upload' }),
            })
              .then(() => watchIntelThenRefreshDataSources(triggerSessionId))
              .catch(() => {})
          }, 2000)
        }
      } catch {
        setTabs(prev => prev.map(t => t.id === activeTabId
          ? { ...t, _localFiles: (t._localFiles || []).map(f =>
              f.name === file.name ? { ...f, status: 'error', variable: 'failed' } : f
            ) }
          : t
        ))
      }
    }
    reader.readAsDataURL(file)
  }, [tabs, activeTabId, watchIntelThenRefreshDataSources])

  const deleteFile = useCallback(async (filename) => {
    // Remove from frontend state immediately (optimistic)
    setTabs(prev => prev.map(t => t.id === activeTabId
      ? { ...t, _localFiles: (t._localFiles || []).filter(f => f.name !== filename) }
      : t
    ))
    // Also delete from the VM's /tmp so it doesn't reappear on next refresh
    const activeTab = tabs.find(t => t.id === activeTabId)
    if (activeTab?.sessionId) {
      try {
        await fetch(`${PROXY_URL}/proxy/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Session-Id': activeTab.sessionId },
          body: JSON.stringify({ code: `import os\ntry:\n    os.remove('/tmp/${filename}')\nexcept FileNotFoundError:\n    pass` }),
        })
      } catch (e) { logError('deleteFile', e) }

      // Deletion intel: prune insights tied to the removed file. Mirrors the upload
      // flow — debounced 2s (batches rapid deletes), then trigger + watch-and-refresh.
      // The backend no-ops if there's no existing report to prune.
      clearTimeout(intelDeleteTimer.current)
      const triggerSessionId = activeTab.sessionId
      intelDeleteTimer.current = setTimeout(() => {
        fetch(`${PROXY_URL}/workbook-intel/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Session-Id': triggerSessionId },
          body: JSON.stringify({ trigger: 'file_delete', deleted_source: `/tmp/${filename}` }),
        })
          .then(() => watchIntelThenRefreshDataSources(triggerSessionId))
          .catch(() => {})
      }, 2000)
    }
  }, [activeTabId, tabs, watchIntelThenRefreshDataSources])

  // Delete an S3 file (restricted server-side to configured deletable prefixes,
  // e.g. user-data/). Mirrors the local-file delete: remove the object, refresh the
  // Data Sources panel, then trigger a debounced Notebook Intel deletion update so
  // insights tied to the removed file are pruned. `src` is the discovered source
  // object; src.source_id is the canonical S3 URI ('s3://bucket/key').
  const deleteS3File = useCallback(async (src) => {
    const sourceId = src?.source_id
    if (!sourceId) return
    try {
      const resp = await fetch(`${PROXY_URL}/datasources/s3-file?source_id=${encodeURIComponent(sourceId)}`, {
        method: 'DELETE',
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        alert(err.error || `Delete failed: ${resp.status}`)
        return
      }
    } catch (e) {
      logError('deleteS3File', e)
      return
    }

    // Remove the row immediately (backend discover() will also no longer list it).
    window.dispatchEvent(new CustomEvent('refresh-datasources'))

    // Deletion intel: prune insights tied to the removed S3 file. Session-scoped like
    // local deletes; debounced 2s. Backend no-ops if there's no existing report.
    const activeTab = tabs.find(t => t.id === activeTabId)
    if (activeTab?.sessionId) {
      clearTimeout(intelS3DeleteTimer.current)
      const triggerSessionId = activeTab.sessionId
      intelS3DeleteTimer.current = setTimeout(() => {
        fetch(`${PROXY_URL}/workbook-intel/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Session-Id': triggerSessionId },
          body: JSON.stringify({ trigger: 'file_delete', deleted_source: sourceId }),
        })
          .then(() => watchIntelThenRefreshDataSources(triggerSessionId))
          .catch(() => {})
      }, 2000)
    }
  }, [activeTabId, tabs, watchIntelThenRefreshDataSources])

  return { fetchFiles, uploadFile, deleteFile, deleteS3File }
}
