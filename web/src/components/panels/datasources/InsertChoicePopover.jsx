import { useState, useEffect, useRef } from 'react'
import { PROXY_URL } from '../../../config'
import { IconCode, IconDatabase } from '../../Icons'

/**
 * Small popover that appears on a datasource item click to let user choose Python or SQL insertion.
 * Fetches the code snippet from the backend DataSourceProvider.
 */
export default function InsertChoicePopover({ sourceType, sourceId, onInsert, onClose }) {
  const popRef = useRef(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const handleClick = (e) => {
      if (popRef.current && !popRef.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

  const handleInsert = async (language) => {
    setLoading(true)
    try {
      const resp = await fetch(
        `${PROXY_URL}/datasources/snippet?source_type=${encodeURIComponent(sourceType)}&source_id=${encodeURIComponent(sourceId)}&language=${language}`
      )
      if (resp.ok) {
        const data = await resp.json()
        onInsert(data.code, data.cell_type)
      }
    } catch (e) {
      console.warn('Snippet fetch failed:', e)
    }
    setLoading(false)
    onClose()
  }

  return (
    <div className="ds-insert-popover" ref={popRef}>
      <button className="ds-insert-btn ds-insert-python" onClick={() => handleInsert('python')} disabled={loading}>
        <IconCode width={11} height={11} /> Python
      </button>
      <button className="ds-insert-btn ds-insert-sql" onClick={() => handleInsert('sql')} disabled={loading}>
        <IconDatabase width={11} height={11} /> SQL
      </button>
    </div>
  )
}
