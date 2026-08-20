import { useState } from 'react'

/**
 * useBottomPanel — the resizable bottom panel's open tabs ('terminal'|'logs'|'intel'),
 * which one is active, and its height. Exposes toggle/close helpers plus the raw
 * setters (the Intel auto-show + keyboard shortcuts drive these directly).
 */
export function useBottomPanel() {
  const [bottomPanelTabs, setBottomPanelTabs] = useState(new Set()) // Set of 'terminal' | 'logs'
  const [bottomPanelActive, setBottomPanelActive] = useState(null) // which tab is visible
  const [bottomPanelHeight, setBottomPanelHeight] = useState(220) // resizable height

  const toggleBottomTab = (tab) => {
    setBottomPanelTabs(prev => {
      const next = new Set(prev)
      if (next.has(tab)) {
        // Close this tab
        next.delete(tab)
        // If it was active, switch to the other or close panel
        if (bottomPanelActive === tab) {
          const remaining = [...next]
          setBottomPanelActive(remaining.length > 0 ? remaining[0] : null)
        }
      } else {
        // Open this tab and make it active
        next.add(tab)
        setBottomPanelActive(tab)
      }
      return next
    })
  }

  const closeBottomTab = (tab) => {
    setBottomPanelTabs(prev => {
      const next = new Set(prev)
      next.delete(tab)
      if (bottomPanelActive === tab) {
        const remaining = [...next]
        setBottomPanelActive(remaining.length > 0 ? remaining[0] : null)
      }
      return next
    })
  }

  return {
    bottomPanelTabs,
    setBottomPanelTabs,
    bottomPanelActive,
    setBottomPanelActive,
    bottomPanelHeight,
    setBottomPanelHeight,
    toggleBottomTab,
    closeBottomTab,
  }
}
