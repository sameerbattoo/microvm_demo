import { useState, useEffect, useCallback } from 'react'
import { PROXY_URL } from '../config'
import { fetchWithTimeout } from '../services/fetchWithTimeout'

/**
 * useDataSources — registry-driven discovery of external data sources for the
 * Data Sources panel + editor autocomplete. Owns the generic `sources` +
 * `sourceTypes` list and the enriched `/datasources/catalog` entries (column
 * schemas + entity-doc flags), and the fetch lifecycle:
 *   - lazy-load when the Data panel opens
 *   - (re)fetch on connect once a sessionId lands, retrying until the enriched
 *     catalog resolves (so entity-intel icons never get stuck missing)
 *   - re-fetch on the 'refresh-datasources' event (e.g. after intel generation)
 *
 * The raw /datasources response is forwarded to the parent via onSyncDataSources
 * (for consumers like the editor autocomplete).
 */
export function useDataSources({ activePanel, activeTab, onRefreshFiles, onSyncDataSources }) {
  const [sources, setSources] = useState([])
  const [sourceTypes, setSourceTypes] = useState([])
  const [catalogEntries, setCatalogEntries] = useState([])  // enriched entries from /datasources/catalog
  const [dsLoading, setDsLoading] = useState(false)
  const [dsFetched, setDsFetched] = useState(false)
  // True once the enriched /datasources/catalog (has_entity_doc + schemas) has
  // been successfully loaded for the current session. Distinct from dsFetched,
  // which only tracks the plain source list. Drives the connect re-fetch so the
  // entity intel icons appear without a manual refresh.
  const [catalogLoaded, setCatalogLoaded] = useState(false)

  // NOTE: this callback MUST depend on activeTab.sessionId. The enriched catalog
  // (which carries has_entity_doc → the entity intel icons) is only fetched when
  // a sessionId is present. If this closed over a stale activeTab, the catalog
  // fetch would be skipped on the first connect, dsFetched would latch true, and
  // the icons would never appear until a manual refresh.
  const sessionId = activeTab?.sessionId
  const fetchDataSources = useCallback(async () => {
    setDsLoading(true)
    // Also refresh local VM files
    if (onRefreshFiles) onRefreshFiles()
    // Track whether we got everything we need. We only "latch" dsFetched=true once
    // the enriched catalog has actually been retrieved (or there is genuinely no
    // session to enrich against). Otherwise we leave it false so the connect
    // effect retries once the session id lands / the VM stops returning 502.
    let catalogResolved = false
    try {
      const resp = await fetchWithTimeout(`${PROXY_URL}/datasources`)
      if (resp.ok) {
        const data = await resp.json()
        setSources(data.sources || [])
        setSourceTypes(data.source_types || [])

        // Fetch full catalog (with column schemas + entity-doc enrichment) when a
        // session is active. The proxy retries the VM internally on transient 502s.
        if (sessionId) {
          try {
            const catalogResp = await fetch(`${PROXY_URL}/datasources/catalog`, {
              headers: { 'X-Session-Id': sessionId },
            })
            if (catalogResp.ok) {
              const catalog = await catalogResp.json()
              data._catalog = catalog  // Attach catalog entries with column info
              setCatalogEntries(catalog.entries || [])
              catalogResolved = true
              setCatalogLoaded(true)
            }
          } catch {}
        }

        if (onSyncDataSources) onSyncDataSources(data)
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.warn('[datasources] Fetch timed out')
      }
    }
    setDsLoading(false)
    // Only mark as fetched once the enriched catalog resolved. When there is no
    // session yet, mark fetched so the panel isn't stuck in a loading state — the
    // connect effect will re-run and re-fetch once a sessionId is available.
    if (catalogResolved || !sessionId) {
      setDsFetched(true)
    }
  }, [onRefreshFiles, onSyncDataSources, sessionId])

  // Lazy-load data sources when panel is active
  useEffect(() => {
    if (activePanel === 'data' && !dsFetched) {
      fetchDataSources()
    }
  }, [activePanel, dsFetched, fetchDataSources])

  // Also fetch data sources on connect (so AI chat always has the info).
  // This re-fires when the sessionId lands (not just on the status flip), and
  // keeps trying until the enriched catalog has actually loaded — so a transient
  // VM 502 or a status-before-sessionId race can't leave the icons missing.
  useEffect(() => {
    if (activeTab?.status === 'connected' && sessionId && !catalogLoaded) {
      fetchDataSources()
    }
  }, [activeTab?.status, sessionId, catalogLoaded, fetchDataSources])

  // Reset the catalog-loaded flag whenever the active session changes, so a newly
  // linked VM re-fetches its enriched catalog (entity docs are session-scoped for
  // local files and VM-catalog-scoped for schemas).
  useEffect(() => {
    setCatalogLoaded(false)
  }, [sessionId])

  // Re-fetch data sources when intel generation completes (local file entity
  // docs are created during intel generation — this ensures sparkle icons
  // appear for local files without requiring the user to manually refresh)
  useEffect(() => {
    const handler = () => fetchDataSources()
    window.addEventListener('refresh-datasources', handler)
    return () => window.removeEventListener('refresh-datasources', handler)
  }, [fetchDataSources])

  return { sources, sourceTypes, catalogEntries, dsLoading, fetchDataSources }
}
