/**
 * LogsPanel — Bottom panel that streams CloudWatch logs from the MicroVM in real-time.
 * 
 * Uses Server-Sent Events (SSE) to tail logs from GET /logs/stream.
 * Shows lifecycle events, code executions, errors — everything happening inside the VM.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { PROXY_URL } from '../config'
import { IconX, IconEraser } from './Icons'
import { showDragOverlay, hideDragOverlay } from '../utils/dragOverlay'
import './LogsPanel.css'

const LOG_LEVEL_COLORS = {
  ERROR: 'log-error',
  WARN: 'log-warn',
  INFO: 'log-info',
  DEBUG: 'log-debug',
}

const MAX_LOG_LINES = 2000  // Cap to prevent memory issues

export default function LogsPanel({ activeTab, onClose, embedded = false }) {
  const [logs, setLogs] = useState([])
  const [filter, setFilter] = useState('ALL')  // ALL, INFO, WARN, ERROR
  const [autoScroll, setAutoScroll] = useState(true)
  const [connected, setConnected] = useState(false)
  const logsEndRef = useRef(null)
  const containerRef = useRef(null)
  const eventSourceRef = useRef(null)
  const [panelHeight, setPanelHeight] = useState(200)
  const resizing = useRef(false)

  const sessionId = activeTab?.sessionId

  // Connect to SSE stream
  useEffect(() => {
    if (!sessionId) {
      setConnected(false)
      setLogs([])
      return
    }

    let aborted = false
    const abortController = new AbortController()

    // First fetch history
    fetch(`${PROXY_URL}/logs/history?limit=200`, {
      headers: { 'X-Session-Id': sessionId },
      signal: abortController.signal,
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.events && !aborted) {
          setLogs(data.events.map((e, i) => ({ ...e, id: `hist-${i}` })))
        }
      })
      .catch(() => {})

    // Then connect SSE for real-time
    const connectSSE = async () => {
      try {
        const resp = await fetch(`${PROXY_URL}/logs/stream?since=${Date.now() - 5000}`, {
          headers: { 'X-Session-Id': sessionId },
          signal: abortController.signal,
        })

        if (!resp.ok || aborted) {
          setConnected(false)
          return
        }

        setConnected(true)
        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done || aborted) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''  // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const event = JSON.parse(line.slice(6))
                if (event.type === 'log') {
                  setLogs(prev => {
                    const next = [...prev, { ...event, id: `sse-${Date.now()}-${Math.random()}` }]
                    return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next
                  })
                }
              } catch {}
            }
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          setConnected(false)
        }
      }
    }

    connectSSE()

    return () => {
      aborted = true
      abortController.abort()
      setConnected(false)
    }
  }, [sessionId])

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'auto' })
    }
  }, [logs, autoScroll])

  // Detect manual scroll (disable auto-scroll when user scrolls up)
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 40
    setAutoScroll(isAtBottom)
  }, [])

  // Resize handle
  const handleResizeStart = useCallback((e) => {
    e.preventDefault()
    resizing.current = true
    const startY = e.clientY
    const startHeight = panelHeight
    // Overlay prevents an embedded Plotly iframe from stealing the drag's mouse events.
    showDragOverlay('row-resize')

    const handleMove = (moveEvent) => {
      if (!resizing.current) return
      const delta = startY - moveEvent.clientY
      setPanelHeight(Math.max(100, Math.min(window.innerHeight * 0.7, startHeight + delta)))
    }

    const handleUp = () => {
      resizing.current = false
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
      hideDragOverlay()
    }

    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
  }, [panelHeight])

  const clearLogs = () => setLogs([])

  const filteredLogs = filter === 'ALL'
    ? logs
    : logs.filter(l => l.level === filter)

  return (
    <div className="logs-bottom-panel" style={{ height: panelHeight }}>
      <div className="logs-resize-handle" onMouseDown={handleResizeStart} />
      <div className="logs-panel-header">
        <span className="logs-panel-title">Logs</span>
        <span className={`logs-status ${connected ? 'logs-status-connected' : 'logs-status-disconnected'}`} />

        <select
          className="logs-filter-select"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        >
          <option value="ALL">All</option>
          <option value="INFO">Info</option>
          <option value="WARN">Warn</option>
          <option value="ERROR">Error</option>
        </select>

        <label className="logs-autoscroll">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={e => setAutoScroll(e.target.checked)}
          />
          Auto-scroll
        </label>

        <span className="logs-count">{filteredLogs.length} lines</span>

        <button className="logs-panel-btn" onClick={clearLogs} title="Clear logs">
          <IconEraser width={12} height={12} />
        </button>
        <button className="logs-panel-btn" onClick={onClose} title="Close logs panel">
          <IconX width={12} height={12} />
        </button>
      </div>

      <div className="logs-container" ref={containerRef} onScroll={handleScroll}>
        {!sessionId && (
          <div className="logs-empty">No active session — launch a notebook to see logs</div>
        )}
        {sessionId && filteredLogs.length === 0 && (
          <div className="logs-empty">Waiting for logs...</div>
        )}
        {filteredLogs.map(log => (
          <div key={log.id} className={`log-line ${LOG_LEVEL_COLORS[log.level] || 'log-info'}`}>
            <span className="log-msg">{log.message}</span>
          </div>
        ))}
        <div ref={logsEndRef} />
      </div>
    </div>
  )
}
