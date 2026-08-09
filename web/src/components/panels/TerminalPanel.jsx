import { useState, useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { IconX, IconRefresh } from '../Icons'
import { PROXY_URL } from '../../config'

const IDLE_TIMEOUT = 30000 // 30s — disconnect terminal WS to allow VM idle suspend

export default function TerminalPanel({ activeTab, onClose }) {
  const terminalRef = useRef(null)
  const xtermRef = useRef(null)
  const wsRef = useRef(null)
  const fitAddonRef = useRef(null)
  const idleTimerRef = useRef(null)
  const idleDisconnectedRef = useRef(false) // True when WS was closed by idle timer
  const [status, setStatus] = useState('disconnected')

  // Idle timer: disconnects WebSocket after IDLE_TIMEOUT of no user input
  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    idleDisconnectedRef.current = false
    idleTimerRef.current = setTimeout(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        idleDisconnectedRef.current = true
        wsRef.current.close()
        wsRef.current = null
        setStatus('disconnected')
      }
    }, IDLE_TIMEOUT)
  }, [])

  const connect = useCallback(() => {
    if (!activeTab?.sessionId) {
      setStatus('error')
      return
    }
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) {
      return
    }
    // Don't auto-reconnect if we were idle-disconnected (user must type to reconnect)
    if (idleDisconnectedRef.current) {
      return
    }

    setStatus('connecting')

    const wsProxyUrl = PROXY_URL.replace('http://', 'ws://').replace('https://', 'wss://')
    const wsUrl = `${wsProxyUrl}/ws/terminal?session_id=${encodeURIComponent(activeTab.sessionId)}`

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      setStatus('connected')
      resetIdleTimer() // Start idle countdown immediately on connect
    }

    ws.onmessage = (event) => {
      if (!xtermRef.current) return
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'session_init') return
          if (msg.type === 'session_error') {
            xtermRef.current.write(`\r\n\x1b[31m Shell error: ${msg.reason || msg.error}\x1b[0m\r\n`)
            return
          }
        } catch {}
        xtermRef.current.write(event.data)
      } else if (event.data instanceof Blob) {
        event.data.arrayBuffer().then(buf => {
          xtermRef.current?.write(new Uint8Array(buf))
        })
      }
    }

    ws.onerror = () => {
      idleDisconnectedRef.current = false // Allow retry on error
      setStatus('error')
    }
    ws.onclose = () => setStatus('disconnected')
  }, [activeTab?.sessionId, resetIdleTimer])

  // Initialize xterm.js (once)
  useEffect(() => {
    if (!terminalRef.current || xtermRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Cascadia Code', 'Menlo', 'Consolas', monospace",
      theme: {
        background: '#0a0a0f',
        foreground: '#e2e4f0',
        cursor: '#5b9fff',
        selectionBackground: 'rgba(91, 159, 255, 0.3)',
        black: '#1a1a2e',
        red: '#ff5c5c',
        green: '#34eaad',
        yellow: '#ffc14d',
        blue: '#5b9fff',
        magenta: '#b97aff',
        cyan: '#5cc2d4',
        white: '#e2e4f0',
        brightBlack: '#5c6280',
        brightRed: '#ff7a7a',
        brightGreen: '#5cffc4',
        brightYellow: '#ffd580',
        brightBlue: '#7db5ff',
        brightMagenta: '#d4a0ff',
        brightCyan: '#7dd8e6',
        brightWhite: '#ffffff',
      },
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(terminalRef.current)
    fitAddon.fit()

    xtermRef.current = term
    fitAddonRef.current = fitAddon

    term.onData((data) => {
      resetIdleTimer() // User typed — reset idle countdown
      idleDisconnectedRef.current = false // Allow reconnection
      // Reconnect if disconnected
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        connect()
        const waitAndSend = () => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(data)
          } else {
            setTimeout(waitAndSend, 100)
          }
        }
        setTimeout(waitAndSend, 300)
        return
      }
      wsRef.current.send(data)
    })

    const observer = new ResizeObserver(() => {
      try { fitAddon.fit() } catch {}
    })
    observer.observe(terminalRef.current)

    if (activeTab?.sessionId) {
      setTimeout(() => connect(), 100)
    }

    return () => {
      observer.disconnect()
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      term.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
    }
  }, [])

  // Reconnect when active session changes (switching notebooks)
  const prevSessionRef = useRef(activeTab?.sessionId)
  useEffect(() => {
    const newSession = activeTab?.sessionId
    if (newSession !== prevSessionRef.current) {
      prevSessionRef.current = newSession
      idleDisconnectedRef.current = false // Reset idle flag for new session
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      if (xtermRef.current) {
        xtermRef.current.clear()
        xtermRef.current.write('\x1b[2J\x1b[H')
      }
      if (newSession && xtermRef.current) {
        setStatus('disconnected')
        // Delay to allow VM to resume from suspended state
        setTimeout(() => connect(), 3000)
      } else {
        setStatus('disconnected')
      }
    }
  }, [activeTab?.sessionId, connect])

  useEffect(() => {
    if (fitAddonRef.current) {
      setTimeout(() => { try { fitAddonRef.current?.fit() } catch {} }, 50)
    }
  })

  const [panelHeight, setPanelHeight] = useState(240)
  const isResizing = useRef(false)

  const handleResizeStart = useCallback((e) => {
    e.preventDefault()
    isResizing.current = true
    const startY = e.clientY
    const startHeight = panelHeight

    const handleMouseMove = (e) => {
      const delta = startY - e.clientY
      const newHeight = Math.min(Math.max(startHeight + delta, 120), window.innerHeight * 0.7)
      setPanelHeight(newHeight)
    }

    const handleMouseUp = () => {
      isResizing.current = false
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (fitAddonRef.current) {
        setTimeout(() => { try { fitAddonRef.current?.fit() } catch {} }, 50)
      }
    }

    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [panelHeight])

  const handleReconnect = () => {
    idleDisconnectedRef.current = false // Allow reconnection
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    if (xtermRef.current) {
      xtermRef.current.clear()
    }
    setTimeout(() => connect(), 200)
  }

  return (
    <div className="terminal-bottom-panel" style={{ height: panelHeight }}>
      <div className="terminal-resize-handle" onMouseDown={handleResizeStart} />
      <div className="terminal-panel-header">
        <span className="terminal-panel-title">Terminal</span>
        <span className={`terminal-status terminal-status-${status}`} />
        <button className="terminal-panel-btn" onClick={handleReconnect} title="Reconnect">
          <IconRefresh width={13} height={13} />
        </button>
        <button className="terminal-panel-btn" onClick={onClose} title="Close terminal">
          <IconX width={12} height={12} />
        </button>
      </div>
      <div
        ref={terminalRef}
        className="terminal-container"
        style={{ display: activeTab?.sessionId ? 'block' : 'none' }}
      />
      {!activeTab?.sessionId && (
        <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: '12px' }}>
          Connect to a MicroVM to use the terminal.
        </div>
      )}
    </div>
  )
}
