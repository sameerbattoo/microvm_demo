/**
 * Notebook API client — CRUD operations backed by SQLite via the proxy.
 * Falls back to localStorage for offline/migration scenarios.
 */

import { PROXY_URL } from '../config'

/**
 * Fetch all notebooks from the API.
 */
export async function fetchNotebooks() {
  try {
    const resp = await fetch(`${PROXY_URL}/notebooks`)
    if (resp.ok) {
      const data = await resp.json()
      return data.notebooks || []
    }
  } catch {
    // Proxy not available — fallback handled by caller
  }
  return null  // null = API unavailable (use localStorage fallback)
}

/**
 * Save/update a notebook to the API.
 */
export async function saveNotebook(notebook) {
  try {
    const resp = await fetch(`${PROXY_URL}/notebooks/${notebook.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: notebook.name,
        description: notebook.description || '',
        tag: notebook.tag || 'Drafts',
        cells: notebook.cells || [],
        session_id: notebook.session_id || null,
        microvm_id: notebook.microvm_id || null,
        checkpoint_enabled: notebook.checkpoint_enabled ? 1 : 0,
      }),
    })
    return resp.ok
  } catch {
    return false
  }
}

/**
 * Create a new notebook via the API.
 */
export async function createNotebook(notebook) {
  try {
    const resp = await fetch(`${PROXY_URL}/notebooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: String(notebook.id),
        name: notebook.name,
        description: notebook.description || '',
        tag: notebook.tag || 'Drafts',
        cells: notebook.cells || [],
      }),
    })
    if (resp.ok) return await resp.json()
  } catch {}
  return null
}

/**
 * Delete a notebook from the API.
 */
export async function deleteNotebook(notebookId) {
  try {
    const resp = await fetch(`${PROXY_URL}/notebooks/${notebookId}`, { method: 'DELETE' })
    return resp.ok
  } catch {
    return false
  }
}

/**
 * Migrate notebooks from localStorage to the API (one-time on first load).
 */
export async function migrateFromLocalStorage() {
  const saved = localStorage.getItem('microvm-notebooks')
  if (!saved) return false

  try {
    const parsed = JSON.parse(saved)
    if (!Array.isArray(parsed) || parsed.length === 0) return false

    // Check if API already has notebooks (don't overwrite)
    const existing = await fetchNotebooks()
    if (existing && existing.length > 0) {
      // API already has data — clear localStorage migration flag
      localStorage.setItem('microvm-notebooks-migrated', 'true')
      return false
    }

    // Migrate each notebook to the API
    for (const tab of parsed) {
      await createNotebook({
        id: String(tab.id),
        name: tab.name || `Notebook ${tab.id}`,
        description: tab.description || '',
        tag: tab.tag || 'Drafts',
        cells: (tab._cells || []).map(c => ({
          type: c.type || 'code',
          code: c.code || '',
          output: c.output || null,
          error: c.error || null,
          html: c.html || null,
          image: c.image || null,
          aiExplanation: c.aiExplanation || null,
        })),
      })
    }

    localStorage.setItem('microvm-notebooks-migrated', 'true')
    return true
  } catch {
    return false
  }
}

/**
 * Fetch metrics history for sparkline charts.
 */
export async function fetchMetricsHistory(microvmId, minutes = 5) {
  try {
    const resp = await fetch(`${PROXY_URL}/instances/metrics/history/${microvmId}?minutes=${minutes}`)
    if (resp.ok) return await resp.json()
  } catch {}
  return { history: [], latest: null }
}

/**
 * Fetch latest metrics for all running VMs.
 */
export async function fetchMetricsLatest() {
  try {
    const resp = await fetch(`${PROXY_URL}/instances/metrics/latest`)
    if (resp.ok) return await resp.json()
  } catch {}
  return { metrics: {} }
}


/**
 * Load AI chat messages for a session from the API.
 */
export async function loadChatMessages(sessionId) {
  if (!sessionId) return []
  try {
    const resp = await fetch(`${PROXY_URL}/ai/chat/${sessionId}/messages`)
    if (resp.ok) {
      const data = await resp.json()
      return data.messages || []
    }
  } catch {}
  return []
}

/**
 * Save AI chat messages for a session to the API.
 */
export async function saveChatMessages(sessionId, notebookId, messages) {
  if (!sessionId) return
  try {
    await fetch(`${PROXY_URL}/ai/chat/${sessionId}/messages`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, notebook_id: notebookId }),
    })
  } catch {}
}
