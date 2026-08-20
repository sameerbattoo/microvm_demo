import { useState, useCallback } from 'react'
import { PROXY_URL } from '../config'

/**
 * useSamplesImport — welcome-screen sample gallery + "Import from Git URL" + loading
 * a bundled sample notebook. Each path creates a new tab (via createTab) and opens it.
 *
 * Tab creation is threaded in via createTab/setTabs/setActiveTabId/setShowAiChat.
 */
export function useSamplesImport({ createTab, setTabs, setActiveTabId, setShowAiChat }) {
  const [showGitImport, setShowGitImport] = useState(false)
  const [gitImportUrl, setGitImportUrl] = useState('')
  const [gitImportLoading, setGitImportLoading] = useState(false)

  // Sample gallery (welcome screen) — lazily loads the sample manifest on first open
  const [showSampleGallery, setShowSampleGallery] = useState(false)
  const [samples, setSamples] = useState([])
  const [samplesLoaded, setSamplesLoaded] = useState(false)

  const loadSample = useCallback(async (sampleUrl, sampleName) => {
    try {
      const resp = await fetch(sampleUrl)
      const notebook = await resp.json()

      const tab = createTab(sampleName || notebook.name, notebook.description || '', 'Samples')
      tab._loadedCells = notebook.cells
      tab._cells = notebook.cells.map((c, i) => ({
        id: Date.now() + Math.random() + i,
        type: c.type || 'code',
        code: c.code || '',
        output: c.output || null,
        error: c.error || null,
        html: c.html || null,
        image: c.image || null,
        aiExplanation: c.aiExplanation || null,
        outputVariable: c.outputVariable || null,
      }))
      setTabs(prev => [...prev, { ...tab }])
      setActiveTabId(tab.id)
      setShowAiChat(true)
    } catch (err) {
      alert(`Failed to load sample: ${err.message}`)
    }
  }, [])

  const toggleSampleGallery = useCallback(async () => {
    setShowGitImport(false)
    setShowSampleGallery(v => !v)
    if (!samplesLoaded) {
      try {
        const resp = await fetch('/samples/index.json')
        const data = await resp.json()
        setSamples(Array.isArray(data) ? data : [])
      } catch { setSamples([]) }
      setSamplesLoaded(true)
    }
  }, [samplesLoaded])

  const importFromGitUrl = useCallback(async () => {
    if (!gitImportUrl.trim()) return
    setGitImportLoading(true)
    try {
      const resp = await fetch(`${PROXY_URL}/import-from-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: gitImportUrl.trim() }),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        alert(err.error || `Import failed: ${resp.status}`)
        setGitImportLoading(false)
        return
      }
      const notebook = await resp.json()
      const tab = createTab(notebook.name || 'Imported', notebook.description || '', 'Imported')
      tab._loadedCells = notebook.cells
      tab._cells = notebook.cells.map((c, i) => ({
        id: Date.now() + Math.random() + i,
        type: c.type || 'code',
        code: c.code || '',
        output: null,
        error: null,
        html: null,
        image: null,
        outputVariable: c.outputVariable || null,
      }))
      tab.sourceUrl = notebook.source_url
      setTabs(prev => [...prev, { ...tab }])
      setActiveTabId(tab.id)
      setShowGitImport(false)
      setGitImportUrl('')
      setShowAiChat(true)
    } catch (err) {
      alert(`Import error: ${err.message}`)
    }
    setGitImportLoading(false)
  }, [gitImportUrl])

  return {
    loadSample,
    showGitImport,
    setShowGitImport,
    gitImportUrl,
    setGitImportUrl,
    gitImportLoading,
    importFromGitUrl,
    showSampleGallery,
    setShowSampleGallery,
    toggleSampleGallery,
    samples,
  }
}
