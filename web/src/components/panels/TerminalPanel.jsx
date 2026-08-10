import { useState, useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { IconX, IconRefresh } from '../Icons'
import { PROXY_URL } from '../../config'

const IDLE_TIMEOUT = 60000 // 60s — matches VM idle suspend, disconnect terminal WS to allow suspend

const DARK_THEME = {
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
}

// VS Code Light-inspired — clean white background, muted colors
const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#383a42',
  cursor: '#526eff',
  selectionBackground: 'rgba(82, 110, 255, 0.15)',
  black: '#383a42',
  red: '#e45649',
  green: '#50a14f',
  yellow: '#c18401',
  blue: '#4078f2',
  magenta: '#a626a4',
  cyan: '#0184bc',
  white: '#fafafa',
  brightBlack: '#a0a1a7',
  brightRed: '#e06c75',
  brightGreen: '#98c379',
  brightYellow: '#e5c07b',
  brightBlue: '#61afef',
  brightMagenta: '#c678dd',
  brightCyan: '#56b6c2',
  brightWhite: '#ffffff',
}

const AI_PLACEHOLDERS = [
  "download iris dataset from GitHub",
  "install scikit-learn",
  "check disk space and memory usage",
  "clone a sample data repo",
  "list all CSV files recursively",
  "show system info (OS, Python version)",
  "compress all files in /tmp into a tar.gz",
]

export default function TerminalPanel({ activeTab, onClose, theme = 'dark' }) {
  const terminalRef = useRef(null)
  const xtermRef = useRef(null)
  const wsRef = useRef(null)
  const fitAddonRef = useRef(null)
  const searchAddonRef = useRef(null)
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
      // Welcome message
      if (xtermRef.current) {
        xtermRef.current.write('\x1b[2m  Connected to MicroVM shell (python3, pip, git, curl available)\x1b[0m\r\n')
      }
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
      theme: theme === 'light' ? LIGHT_THEME : DARK_THEME,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    const searchAddon = new SearchAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    term.loadAddon(searchAddon)
    term.open(terminalRef.current)
    fitAddon.fit()

    xtermRef.current = term
    fitAddonRef.current = fitAddon
    searchAddonRef.current = searchAddon

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

  // Update terminal theme when app theme changes
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = theme === 'light' ? LIGHT_THEME : DARK_THEME
    }
  }, [theme])

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

  const [showAiInput, setShowAiInput] = useState(false)
  const [aiQuery, setAiQuery] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiResult, setAiResult] = useState('') // Generated command shown for review
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const aiInputRef = useRef(null)
  const searchInputRef = useRef(null)

  const handleAiSuggest = async () => {
    if (!aiQuery.trim() || aiLoading) return
    setAiLoading(true)
    setAiResult('')
    resetIdleTimer() // Keep terminal alive while AI is working

    // Grab last 30 lines of terminal buffer for context
    let terminalHistory = ''
    if (xtermRef.current) {
      const buf = xtermRef.current.buffer.active
      const totalLines = buf.length
      const startLine = Math.max(0, totalLines - 30)
      const lines = []
      for (let i = startLine; i < totalLines; i++) {
        const line = buf.getLine(i)
        if (line) {
          const text = line.translateToString(true)
          if (text.trim()) lines.push(text)
        }
      }
      terminalHistory = lines.join('\n')
    }

    try {
      const resp = await fetch(`${PROXY_URL}/terminal/suggest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: aiQuery.trim(),
          terminal_history: terminalHistory,
        }),
      })
      if (resp.ok) {
        const data = await resp.json()
        if (data.command) {
          setAiResult(data.command)
          setAiQuery('')
        }
      }
    } catch {}
    setAiLoading(false)
  }

  const handleAiExecute = () => {
    if (!aiResult || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    wsRef.current.send(aiResult + '\r')
    setAiResult('')
    setShowAiInput(false)
    resetIdleTimer()
    idleDisconnectedRef.current = false
  }

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
        <button
          className={`terminal-panel-btn ${showSearch ? 'terminal-panel-btn-active' : ''}`}
          onClick={() => {
            setShowSearch(v => !v)
            setShowAiInput(false)
            setTimeout(() => searchInputRef.current?.focus(), 50)
          }}
          title="Search terminal (Ctrl+F)"
        >
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </button>
        <button
          className={`terminal-panel-btn ${showAiInput ? 'terminal-panel-btn-active' : ''}`}
          onClick={() => {
            setShowAiInput(v => !v)
            setShowSearch(false)
            setTimeout(() => aiInputRef.current?.focus(), 50)
          }}
          title="AI: describe what you want"
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" stroke="none">
            <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z"/>
          </svg>
        </button>
        <button className="terminal-panel-btn" onClick={handleReconnect} title="Reconnect">
          <IconRefresh width={13} height={13} />
        </button>
        <button className="terminal-panel-btn" onClick={onClose} title="Close terminal">
          <IconX width={12} height={12} />
        </button>
      </div>
      {showAiInput && (
        <div className="terminal-ai-bar">
          {!aiResult ? (
            <>
              <input
                ref={aiInputRef}
                className="terminal-ai-input"
                type="text"
                placeholder={`e.g. '${AI_PLACEHOLDERS[Math.floor(Date.now() / 10000) % AI_PLACEHOLDERS.length]}'`}
                value={aiQuery}
                onChange={e => setAiQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleAiSuggest()
                  if (e.key === 'Escape') { setShowAiInput(false); setAiQuery('') }
                }}
                disabled={aiLoading}
              />
              <button
                className="terminal-ai-submit"
                onClick={handleAiSuggest}
                disabled={aiLoading || !aiQuery.trim()}
              >
                {aiLoading ? <span className="terminal-ai-spinner" /> : '→'}
              </button>
            </>
          ) : (
            <>
              <code className="terminal-ai-result">{aiResult}</code>
              <button className="terminal-ai-submit terminal-ai-run" onClick={handleAiExecute} title="Run command">▶</button>
              <button className="terminal-ai-submit terminal-ai-discard" onClick={() => setAiResult('')} title="Discard">✕</button>
            </>
          )}
        </div>
      )}
      {showSearch && (
        <div className="terminal-ai-bar">
          <input
            ref={searchInputRef}
            className="terminal-ai-input"
            type="text"
            placeholder="Search terminal output..."
            value={searchQuery}
            onChange={e => {
              setSearchQuery(e.target.value)
              if (searchAddonRef.current && e.target.value) {
                searchAddonRef.current.findNext(e.target.value)
              }
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && searchAddonRef.current) {
                if (e.shiftKey) {
                  searchAddonRef.current.findPrevious(searchQuery)
                } else {
                  searchAddonRef.current.findNext(searchQuery)
                }
              }
              if (e.key === 'Escape') { setShowSearch(false); setSearchQuery('') }
            }}
          />
          <button className="terminal-ai-submit" onClick={() => searchAddonRef.current?.findPrevious(searchQuery)} title="Previous">↑</button>
          <button className="terminal-ai-submit" onClick={() => searchAddonRef.current?.findNext(searchQuery)} title="Next">↓</button>
        </div>
      )}
      <div
        ref={terminalRef}
        className="terminal-container"
        style={{
          display: activeTab?.sessionId ? 'block' : 'none',
          background: theme === 'light' ? LIGHT_THEME.background : DARK_THEME.background,
        }}
      />
      {!activeTab?.sessionId && (
        <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: '12px' }}>
          Connect to a MicroVM to use the terminal.
        </div>
      )}
    </div>
  )
}
