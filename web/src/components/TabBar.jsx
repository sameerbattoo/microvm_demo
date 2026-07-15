import { useState, useRef, useEffect } from 'react'
import './TabBar.css'

export default function TabBar({ tabs, activeTabId, onSelectTab, onAddTab, onCloseTab, onRenameTab }) {
  const [editingTabId, setEditingTabId] = useState(null)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (editingTabId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingTabId])

  const startRename = (e, tab) => {
    e.stopPropagation()
    setEditingTabId(tab.id)
    setEditValue(tab.name)
  }

  const commitRename = () => {
    if (editingTabId && editValue.trim()) {
      onRenameTab(editingTabId, editValue.trim())
    }
    setEditingTabId(null)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      commitRename()
    } else if (e.key === 'Escape') {
      setEditingTabId(null)
    }
  }

  return (
    <div className="tab-bar">
      <div className="tab-list">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={`tab ${tab.id === activeTabId ? 'tab-active' : ''}`}
            onClick={() => onSelectTab(tab.id)}
            onDoubleClick={(e) => startRename(e, tab)}
          >
            <span className={`tab-status tab-status-${tab.status}`} />
            {editingTabId === tab.id ? (
              <input
                ref={inputRef}
                className="tab-rename-input"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={handleKeyDown}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="tab-name">{tab.name}</span>
            )}
            <button
              className="tab-close"
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id) }}
              title="Close notebook"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button className="tab-add" onClick={onAddTab} title="New notebook (new MicroVM)">
        +
      </button>
    </div>
  )
}
