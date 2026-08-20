import { useEffect, useRef } from 'react'
import { fetchNotebooks, saveNotebook as apiSaveNotebook, migrateFromLocalStorage, loadChatMessages } from '../services/notebooks'

/**
 * useTabsPersistence — persists notebook tabs to localStorage (debounced) and to
 * the API (debounced), loads/migrates notebooks from the API on first mount, and
 * persists the active tab id. Side-effect only hook (returns nothing).
 */
export function useTabsPersistence({ tabs, setTabs, activeTabId, setActiveTabId }) {
  const saveTimerRef = useRef(null)
  const apiSaveTimerRef = useRef(null)

  // Persist tabs to localStorage (debounced 1.5s to avoid thrashing during typing)
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
    const toSave = tabs.map(({ _loadedCells, ...tab }) => {
      // Persist cells with code and text outputs, but strip base64 images
      const cells = (tab._cells || []).map(c => ({
        id: c.id,
        type: c.type || 'code',
        code: c.code || '',
        output: c.output || null,
        error: c.error || null,
        html: c.html || null,
        image: null, // Strip base64 images (too large for localStorage)
        status: c.output || c.error || c.html ? 'success' : 'idle',
        executionNumber: c.executionNumber || null,
        executionTime: c.executionTime || null,
        lastExecutedCode: c.lastExecutedCode || null,
        aiExplanation: c.aiExplanation || null,
      }))
      return { ...tab, _cells: cells.length > 0 ? cells : undefined }
    })
    try {
      localStorage.setItem('microvm-notebooks', JSON.stringify(toSave))
    } catch (e) {
      // If localStorage is full (quota exceeded), save without outputs
      const minimal = tabs.map(({ _cells, _loadedCells, ...rest }) => ({
        ...rest,
        _cells: (_cells || []).map(c => ({ id: c.id, type: c.type || 'code', code: c.code || '', output: null, error: null, html: null, image: null, status: 'idle', executionNumber: null, executionTime: null, lastExecutedCode: null })),
      }))
      try {
        localStorage.setItem('microvm-notebooks', JSON.stringify(minimal))
      } catch {}
    }
    }, 1500)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [tabs])

  // Also persist to API (debounced, non-blocking)
  useEffect(() => {
    if (apiSaveTimerRef.current) clearTimeout(apiSaveTimerRef.current)
    apiSaveTimerRef.current = setTimeout(() => {
      tabs.forEach(tab => {
        const cells = (tab._cells || []).map(c => ({
          type: c.type || 'code',
          code: c.code || '',
          output: c.output || null,
          error: c.error || null,
          html: c.html || null,
          image: c.image || null,
          aiExplanation: c.aiExplanation || null,
        }))
        apiSaveNotebook({
          id: String(tab.id),
          name: tab.name,
          description: tab.description || '',
          tag: tab.tag || 'Drafts',
          cells,
          session_id: tab.sessionId || null,
          microvm_id: tab.microvmId || null,
          checkpoint_enabled: tab.checkpointEnabled || false,
        }).catch(() => {})  // Non-blocking — localStorage is the safety net
      })
    }, 3000)
    return () => { if (apiSaveTimerRef.current) clearTimeout(apiSaveTimerRef.current) }
  }, [tabs])

  // On first mount: try to load notebooks from API, migrate localStorage if needed
  useEffect(() => {
    async function loadFromApi() {
      // Try migration first (if localStorage has data but API doesn't)
      if (!localStorage.getItem('microvm-notebooks-migrated')) {
        await migrateFromLocalStorage()
      }

      // Fetch from API
      const apiNotebooks = await fetchNotebooks()
      if (apiNotebooks && apiNotebooks.length > 0) {
        if (tabs.length === 0) {
          // API has notebooks but local state is empty — load from API
          const loaded = apiNotebooks.map(nb => ({
            id: nb.id.includes('-') ? nb.id : parseInt(nb.id) || nb.id,
            name: nb.name,
            description: nb.description || '',
            tag: nb.tag || 'Drafts',
            _cells: nb.cells || [],
            microvmEndpoint: null,
            microvmId: nb.microvm_id || null,
            status: 'disconnected',
            mode: null,
            sessionId: nb.session_id || null,
            checkpointEnabled: nb.checkpoint_enabled || false,
          }))
          setTabs(loaded)
          if (loaded.length > 0 && !activeTabId) {
            setActiveTabId(loaded[0].id)
          }
        } else {
          // Enrich existing tabs with images from API (localStorage strips them)
          const apiMap = {}
          apiNotebooks.forEach(nb => { apiMap[nb.id] = nb })
          setTabs(prev => prev.map(tab => {
            const apiNb = apiMap[String(tab.id)]
            if (!apiNb || !apiNb.cells) return tab
            const apiCells = apiNb.cells
            const enrichedCells = (tab._cells || []).map((cell, idx) => {
              if (!cell.image && apiCells[idx]?.image) {
                return { ...cell, image: apiCells[idx].image }
              }
              return cell
            })
            return { ...tab, _cells: enrichedCells }
          }))
        }

        // Load chat messages from DB for each notebook (non-blocking)
        apiNotebooks.forEach(async (nb) => {
          const tabId = nb.id.includes('-') ? nb.id : parseInt(nb.id) || nb.id
          const sessionId = nb.session_id
          if (sessionId) {
            const msgs = await loadChatMessages(sessionId)
            if (msgs && msgs.length > 0) {
              setTabs(prev => prev.map(t => t.id === tabId ? { ...t, _chatMessages: msgs } : t))
            }
          }
        })
      }
    }
    loadFromApi()
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // Persist the active tab id
  useEffect(() => {
    localStorage.setItem('microvm-active-tab', JSON.stringify(activeTabId))
  }, [activeTabId])
}
