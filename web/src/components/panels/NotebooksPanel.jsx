import { useState } from 'react'
import { IconPlus, IconX, IconNotebook } from '../Icons'
import { PROXY_URL } from '../../config'

export default function NotebooksPanel({
  tabs,
  activeTabId,
  onSelectTab,
  onNewNotebook,
  onCloseTab,
  onRenameTab,
  onUpdateTabTag,
  onClose,
}) {
  const [editingId, setEditingId] = useState(null)
  const [editValue, setEditValue] = useState('')
  const [editingTagId, setEditingTagId] = useState(null)
  const [editTagValue, setEditTagValue] = useState('')
  const [collapsedTags, setCollapsedTags] = useState({})

  const startRename = (e, tab) => {
    e.stopPropagation()
    setEditingId(tab.id)
    setEditValue(tab.name)
  }

  const commitRename = () => {
    if (editingId && editValue.trim()) {
      onRenameTab(editingId, editValue.trim())
    }
    setEditingId(null)
  }

  return (
    <div className="sidebar-panel-content">
      <div className="sidebar-panel-header">
        <span className="sidebar-panel-title">Notebooks</span>
        <button
          className="sidebar-panel-action"
          onClick={onNewNotebook}
          title="New notebook"
        >
          <IconPlus width={14} height={14} />
        </button>
        <button className="sidebar-panel-close" onClick={onClose} title="Close panel"><IconX width={12} height={12} /></button>
      </div>
      <div className="sidebar-panel-body">
        {tabs.length === 0 && (
          <div className="sidebar-empty">No notebooks open</div>
        )}
        {(() => {
          // Group tabs by tag
          const groups = {}
          tabs.forEach(tab => {
            const tag = tab.tag || 'Untitled'
            if (!groups[tag]) groups[tag] = []
            groups[tag].push(tab)
          })
          const tagOrder = Object.keys(groups).sort((a, b) => {
            // Drafts first, Samples last, rest alphabetical
            if (a === 'Drafts') return -1
            if (b === 'Drafts') return 1
            if (a === 'Samples') return 1
            if (b === 'Samples') return -1
            return a.localeCompare(b)
          })
          return tagOrder.map(tag => (
            <div key={tag} className="nb-tag-group">
              <div
                className="nb-tag-header"
                onClick={() => setCollapsedTags(prev => ({ ...prev, [tag]: !prev[tag] }))}
              >
                <span className="nb-tag-chevron">{collapsedTags[tag] ? <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor"><path d="M9 6l6 6-6 6z"/></svg> : <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor"><path d="M6 9l6 6 6-6z"/></svg>}</span>
                <svg className="nb-tag-icon" width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>
                </svg>
                <span className="nb-tag-name">{tag}</span>
                {tag === 'Drafts' && (
                  <button
                    className="nb-tag-autotag-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      groups[tag].forEach(t => {
                        const cellData = (t._cells || []).slice(0, 4).map(c => ({ type: c.type || 'code', code: (c.code || '').slice(0, 200) }))
                        if (cellData.length >= 2) {
                          fetch(`${PROXY_URL}/ai/suggest-tag`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: t.name, description: t.description || '', cells: cellData }),
                          })
                            .then(r => r.json())
                            .then(data => { if (data.tag && data.tag !== 'Drafts') onUpdateTabTag(t.id, data.tag) })
                            .catch(() => {})
                        }
                      })
                    }}
                    title="Auto-tag all drafts with AI"
                  >
                    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                  </button>
                )}
                <span className="nb-tag-count">{groups[tag].length}</span>
              </div>
              {!collapsedTags[tag] && groups[tag].map(tab => (
                <div
                  key={tab.id}
                  className={`sidebar-item ${tab.id === activeTabId ? 'sidebar-item-active' : ''}`}
                  onClick={() => onSelectTab(tab.id)}
                  onDoubleClick={(e) => startRename(e, tab)}
                  title={tab.description || ''}
                >
                  <span className={`sidebar-item-dot sidebar-dot-${tab.status}`} />
                  {editingId === tab.id ? (
                    <input
                      className="sidebar-rename-input"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename()
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                    />
                  ) : (
                    <span className="sidebar-item-label">{tab.name}</span>
                  )}
                  {/* Tag edit */}
                  {editingTagId === tab.id ? (
                    <input
                      className="sidebar-tag-input"
                      value={editTagValue}
                      onChange={(e) => setEditTagValue(e.target.value)}
                      onBlur={() => { if (editTagValue.trim()) onUpdateTabTag(tab.id, editTagValue.trim()); setEditingTagId(null) }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { if (editTagValue.trim()) onUpdateTabTag(tab.id, editTagValue.trim()); setEditingTagId(null) }
                        if (e.key === 'Escape') setEditingTagId(null)
                      }}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                      placeholder="Tag name"
                    />
                  ) : (
                    <button
                      className="sidebar-tag-btn"
                      onClick={(e) => { e.stopPropagation(); setEditingTagId(tab.id); setEditTagValue(tab.tag || '') }}
                      title="Change tag"
                    >
                      #
                    </button>
                  )}
                  <button
                    className="sidebar-item-close"
                    onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id) }}
                    title="Close"
                  >
                    <IconX width={12} height={12} />
                  </button>
                </div>
              ))}
            </div>
          ))
        })()}
      </div>
    </div>
  )
}
