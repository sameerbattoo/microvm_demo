import { useState, useRef, useEffect } from 'react'
import { IconPlus, IconX, IconNotebook } from './Icons'
import { PROXY_URL } from '../config'
import { marked } from 'marked'
import { sanitizeMarkdown } from '../services/sanitize'
import { useSpeechToText } from '../hooks/useSpeechToText'
import './AiChatPanel.css'

export default function AiChatPanel({ activeTab, uploadedFiles = [], onClose, onUpdateCell, onInsertCells, onUpdateMessages }) {
  // Messages are stored on the tab so they persist when switching notebooks
  const messages = activeTab?._chatMessages || []
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [width, setWidth] = useState(320)
  const endRef = useRef(null)
  const isResizing = useRef(false)
  const chatAbortRef = useRef(null)

  // Speech-to-text (Whisper in browser)
  const {
    isListening,
    isProcessing,
    isModelLoading,
    transcript,
    error: speechError,
    recordingDuration,
    startListening,
    stopListening,
    resetTranscript,
    isSupported: speechSupported,
  } = useSpeechToText({
    silenceTimeout: 2000,
    onSilenceDetected: () => stopListening(),
  })

  // When transcript arrives after recording stops, put it in input and auto-send
  useEffect(() => {
    if (transcript && !isListening && !isProcessing) {
      setInput(transcript)
      resetTranscript()
      // Auto-submit after a brief delay
      setTimeout(() => {
        const btn = document.querySelector('.ai-panel-send')
        if (btn && !btn.disabled) btn.click()
      }, 100)
    }
  }, [transcript, isListening, isProcessing])

  // Abort pending request on unmount
  useEffect(() => {
    return () => { if (chatAbortRef.current) chatAbortRef.current.abort() }
  }, [])

  const handleResizeStart = (e) => {
    e.preventDefault()
    isResizing.current = true
    const startX = e.clientX
    const startWidth = width

    const handleMouseMove = (e) => {
      if (!isResizing.current) return
      const delta = startX - e.clientX
      setWidth(Math.min(600, Math.max(240, startWidth + delta)))
    }

    const handleMouseUp = () => {
      isResizing.current = false
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const handleSend = async () => {
    if (!input.trim() || loading || !activeTab) return

    const userMessage = input.trim()
    setInput('')
    const newMessages = [...messages, { role: 'user', content: userMessage }]
    onUpdateMessages(newMessages)
    setLoading(true)

    // Scroll to bottom immediately so user sees their message
    setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)

    try {
      const controller = new AbortController()
      chatAbortRef.current = controller

      const resp = await fetch(`${PROXY_URL}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          session_id: activeTab.sessionId || activeTab.id?.toString(),
          message: userMessage,
          active_cell_index: activeTab._activeCellIndex ?? null,
          cells: (activeTab._cells || []).slice(0, 10).map(c => ({
            type: c.type || 'code',
            code: (c.code || '').slice(0, 300),
            output: (c.output || '').slice(0, 200),
            error: (c.error || '').slice(0, 200),
          })),
          microvm_id: activeTab.microvmId || '',
          microvm_endpoint: activeTab.microvmRealEndpoint || '',
          packages: activeTab._packages || [],
          data_sources: activeTab._dataSources || null,
          uploaded_files: uploadedFiles.map(f => ({ name: f.name, size: f.size, path: `/tmp/${f.name}` })),
        }),
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        onUpdateMessages([...newMessages, { role: 'assistant', content: `Error: ${err.error || resp.statusText}`, isError: true }])
        setLoading(false)
        return
      }

      // Stream SSE response token by token
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let assistantContent = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6))
              if (event.type === 'text') {
                assistantContent += event.content
                onUpdateMessages([...newMessages, { role: 'assistant', content: assistantContent }])
                // Auto-scroll as content streams in
                endRef.current?.scrollIntoView({ behavior: 'smooth' })
              } else if (event.type === 'done') {
                // Stream complete
              } else if (event.type === 'error') {
                assistantContent += `\n\nError: ${event.content}`
                onUpdateMessages([...newMessages, { role: 'assistant', content: assistantContent, isError: true }])
              }
            } catch {}
          }
        }
      }

      // Final update with complete content
      if (assistantContent) {
        onUpdateMessages([...newMessages, { role: 'assistant', content: assistantContent }])
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        onUpdateMessages([...newMessages, { role: 'assistant', content: `Connection error: ${err.message}`, isError: true }])
      }
    }

    setLoading(false)
    setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
  }

  const handleExportHTML = () => {
    const nbName = activeTab?.name || 'Notebook'
    let html = `<html><head><meta charset="UTF-8"><title>${nbName} — AI Chat</title><style>body{font-family:system-ui;padding:20px;max-width:900px;margin:0 auto;background:#1a1a2e;color:#e0e0e0}.msg{margin:12px 0;padding:12px;border-radius:8px}.user{background:#2d3a5c;text-align:right}.assistant{background:#1e2a3a}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #444;padding:6px 10px;text-align:left}th{background:#2a2a4a}pre{background:#0d1117;padding:10px;border-radius:4px;overflow-x:auto}code{font-size:13px}img{max-width:100%}h1,h2,h3{color:#89b4fa}strong{color:#cdd6f4}</style></head><body>`
    html += `<h2>${nbName} — AI Chat History</h2>`
    html += `<p style="color:#888">Exported: ${new Date().toLocaleString()}</p>`
    messages.forEach(msg => {
      const cls = msg.role === 'user' ? 'user' : 'assistant'
      const content = msg.role === 'assistant' ? marked.parse(msg.content || '', { breaks: true }) : (msg.content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      html += `<div class="msg ${cls}"><strong>${msg.role === 'user' ? 'You' : 'AI Assistant'}</strong><br>${content}</div>`
    })
    html += `<hr style="margin-top:32px;border:none;border-top:1px solid #333"><footer style="text-align:center;padding:12px;color:#666;font-size:11px"><strong>Lambda MicroVM Notebook</strong><br>Developed by the AWS Startup SA Team<br>&copy; ${new Date().getFullYear()} Amazon Web Services, Inc.</footer>`
    html += '</body></html>'
    const blob = new Blob([html], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${nbName.replace(/\s+/g, '-')}-ai-chat.html`; a.click()
    URL.revokeObjectURL(url)
    setShowExportMenu(false)
  }

  const handleExportMD = () => {
    const nbName = activeTab?.name || 'Notebook'
    let md = `# ${nbName} — AI Chat History\n\n`
    md += `*Exported: ${new Date().toLocaleString()}*\n\n---\n\n`
    messages.forEach(msg => {
      if (msg.role === 'user') {
        md += `**You:** ${msg.content}\n\n`
      } else {
        md += `**AI Assistant:**\n\n${msg.content}\n\n---\n\n`
      }
    })
    md += `\n---\n\n*Lambda MicroVM Notebook — Developed by the AWS Startup SA Team*\n`
    const blob = new Blob([md], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${nbName.replace(/\s+/g, '-')}-ai-chat.md`; a.click()
    URL.revokeObjectURL(url)
    setShowExportMenu(false)
  }

  const handleClear = () => {
    if (activeTab?.sessionId) {
      fetch(`${PROXY_URL}/ai/chat/${activeTab.sessionId}`, { method: 'DELETE' }).catch(() => {})
    }
    onUpdateMessages([])
  }

  return (
    <div className="ai-panel" style={{ width: `${width}px`, minWidth: `${width}px` }}>
      <div className="ai-panel-resize" onMouseDown={handleResizeStart} />
      <div className="ai-panel-header">
        <span className="ai-panel-title">✨ AI Assistant</span>
        <div className="ai-panel-header-actions">
          <div className="ai-export-wrapper">
            <button className="ai-panel-action" onClick={() => setShowExportMenu(!showExportMenu)} title="Export chat" disabled={messages.length === 0}>
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>
            {showExportMenu && (
              <div className="ai-export-menu">
                <button onClick={handleExportHTML}>HTML</button>
                <button onClick={handleExportMD}>Markdown</button>
              </div>
            )}
          </div>
          <button className="ai-panel-action" onClick={handleClear} title="New thread">
            <IconPlus width={14} height={14} />
          </button>
          <button className="ai-panel-action" onClick={onClose} title="Close">
            <IconX width={14} height={14} />
          </button>
        </div>
      </div>
      {activeTab && (
        <div className="ai-panel-scope">
          <IconNotebook width={12} height={12} /> {activeTab.name}
        </div>
      )}

      <div className="ai-panel-messages">
        {messages.length === 0 && (
          <div className="ai-panel-empty">
            <div className="ai-panel-empty-icon">✨</div>
            <p>Ask me anything about your notebook.</p>
            <p className="ai-panel-hints">Try: "Plot monthly revenue" or "Fix the error in cell 3" or "Explain the output"</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`ai-msg ai-msg-${msg.role} ${msg.isError ? 'ai-msg-error' : ''}`}>
            <div className="ai-msg-content">
              {msg.role === 'assistant' ? (
                <>
                  <div className="ai-msg-md" dangerouslySetInnerHTML={{ __html: sanitizeMarkdown(marked.parse(msg.content, { breaks: true })) }} />
                  {/* Show Apply button if response contains code blocks */}
                  {msg.content.includes('```') && (onUpdateCell || onInsertCells) && (() => {
                    const codeBlocks = [...msg.content.matchAll(/```(?:python)?\n([\s\S]*?)```/g)].map(m => m[1].trim())
                    if (codeBlocks.length === 0) return null
                    return (
                      <div className="ai-apply-multi">
                        <button className="ai-apply-code-btn" onClick={() => {
                          if (onInsertCells) onInsertCells(codeBlocks)
                        }}>
                          {codeBlocks.length === 1 ? 'Insert Cell' : `Insert ${codeBlocks.length} Cells`}
                        </button>
                        {codeBlocks.length === 1 && onUpdateCell && (
                          <button className="ai-apply-code-btn ai-apply-single" onClick={() => onUpdateCell(codeBlocks[0])}>
                            Replace Active Cell
                          </button>
                        )}
                      </div>
                    )
                  })()}
                </>
              ) : (
                <span>{msg.content}</span>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="ai-msg ai-msg-assistant">
            <div className="ai-msg-content ai-msg-typing">
              <span className="ai-dot" /><span className="ai-dot" /><span className="ai-dot" />
              <button className="ai-typing-cancel" onClick={() => { if (chatAbortRef.current) chatAbortRef.current.abort(); setLoading(false) }}>Stop</button>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="ai-panel-input-area">
        {/* Listening indicator with waveform */}
        {(isListening || isProcessing || isModelLoading) && (
          <div className={`ai-speech-status ${isListening ? 'ai-speech-listening' : 'ai-speech-processing'}`}>
            {isModelLoading ? (
              <><span className="ai-speech-spinner" /> Loading speech model (first time only)...</>
            ) : isProcessing ? (
              <><span className="ai-speech-spinner" /> Transcribing...</>
            ) : (
              <div className="ai-speech-listening-row">
                <div className="ai-speech-waves">
                  <span className="ai-wave-bar" /><span className="ai-wave-bar" /><span className="ai-wave-bar" /><span className="ai-wave-bar" /><span className="ai-wave-bar" />
                </div>
                <span>Listening...</span>
                <span className="ai-speech-timer">{Math.floor(recordingDuration / 60)}:{(recordingDuration % 60).toString().padStart(2, '0')}</span>
              </div>
            )}
          </div>
        )}
        {speechError && <div className="ai-speech-error">{speechError}</div>}
        <div className="ai-panel-input-row">
          <textarea
            className="ai-panel-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
            placeholder={isListening ? 'Listening...' : 'Ask the AI assistant...'}
            rows={2}
            disabled={loading || !activeTab || isListening}
          />
          <div className="ai-panel-buttons">
            {speechSupported && (
              <button
                className={`ai-panel-mic ${isListening ? 'ai-panel-mic-active' : ''}`}
                onClick={() => isListening ? stopListening() : startListening()}
                disabled={loading || isModelLoading || isProcessing || !activeTab}
                title={isListening ? 'Stop recording' : 'Voice input (Whisper)'}
              >
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                  <line x1="12" y1="19" x2="12" y2="22"/>
                </svg>
              </button>
            )}
            <button
              className="ai-panel-send"
              onClick={handleSend}
              disabled={!input.trim() || loading || !activeTab}
              title="Send (Enter)"
            >
              <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
