import { useState, useMemo } from 'react'

/**
 * SortableTable — parses DataFrame HTML into data, renders with sortable headers.
 * No DOM manipulation, no refs — pure React state-driven rendering.
 */
export default function SortableTable({ html, sanitizer }) {
  const [sortCol, setSortCol] = useState(null)
  const [sortDir, setSortDir] = useState(null) // 'asc' | 'desc'

  // Parse the HTML table into structured data
  const tableData = useMemo(() => {
    if (!html) return null

    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')
    const table = doc.querySelector('table')
    if (!table) return null

    // Extract headers
    const thead = table.querySelector('thead')
    const headers = []
    if (thead) {
      const ths = thead.querySelectorAll('th')
      ths.forEach(th => headers.push(th.textContent.trim()))
    }

    // Extract rows (each row has th for index + td for data)
    const tbody = table.querySelector('tbody')
    const rows = []
    if (tbody) {
      tbody.querySelectorAll('tr').forEach(tr => {
        const cells = []
        const indexTh = tr.querySelector('th')
        if (indexTh) cells.push({ html: indexTh.innerHTML, text: indexTh.textContent.trim(), isIndex: true })
        tr.querySelectorAll('td').forEach(td => {
          cells.push({ html: td.innerHTML, text: td.textContent.trim(), isIndex: false })
        })
        rows.push(cells)
      })
    }

    // Extract truncation note if present
    const truncNote = doc.querySelector('.df-truncation-note')

    return { headers, rows, truncNote: truncNote?.outerHTML || null }
  }, [html])

  // Sort rows
  const sortedRows = useMemo(() => {
    if (!tableData || sortCol === null || sortDir === null) return tableData?.rows || []

    const dataColIdx = sortCol // index into the data columns (0-based, after the row-index column)
    const rows = [...tableData.rows]

    // Detect type from first 20 non-empty values
    const samples = rows
      .map(r => r[dataColIdx + 1]?.text || '') // +1 because first cell is index
      .filter(t => t && !['NaN', 'nan', 'None', 'NaT'].includes(t))
      .slice(0, 20)

    let type = 'string'
    if (samples.length > 0) {
      if (samples.every(s => /^\d{4}-\d{2}-\d{2}/.test(s))) type = 'date'
      else if (samples.every(s => !isNaN(parseFloat(s.replace(/[$,€£%\s]/g, ''))) && !/^\d{4}-\d{2}/.test(s))) type = 'number'
    }

    rows.sort((a, b) => {
      const va = a[dataColIdx + 1]?.text || ''
      const vb = b[dataColIdx + 1]?.text || ''

      const aEmpty = !va || ['NaN', 'nan', 'None', 'NaT'].includes(va)
      const bEmpty = !vb || ['NaN', 'nan', 'None', 'NaT'].includes(vb)
      if (aEmpty && bEmpty) return 0
      if (aEmpty) return 1
      if (bEmpty) return -1

      let cmp = 0
      if (type === 'number') {
        cmp = parseFloat(va.replace(/[$,€£%\s]/g, '')) - parseFloat(vb.replace(/[$,€£%\s]/g, ''))
      } else if (type === 'date') {
        cmp = new Date(va) - new Date(vb)
      } else {
        cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' })
      }
      return sortDir === 'desc' ? -cmp : cmp
    })

    return rows
  }, [tableData, sortCol, sortDir])

  // If we couldn't parse the table, fall back to raw HTML
  if (!tableData || tableData.headers.length === 0) {
    return <div className="output-html" dangerouslySetInnerHTML={{ __html: sanitizer(html) }} />
  }

  const handleHeaderClick = (colIdx) => {
    if (sortCol !== colIdx) {
      setSortCol(colIdx)
      setSortDir('asc')
    } else if (sortDir === 'asc') {
      setSortDir('desc')
    } else {
      setSortCol(null)
      setSortDir(null)
    }
  }

  return (
    <div className="output-html">
      <table>
        <thead>
          <tr>
            {tableData.headers.map((h, i) => {
              if (i === 0 && h === '') {
                // Row index column — no sort
                return <th key={i}></th>
              }
              const dataIdx = i - 1
              const isActive = sortCol === dataIdx
              return (
                <th
                  key={i}
                  onClick={() => handleHeaderClick(dataIdx)}
                  data-sort={isActive ? sortDir : undefined}
                >
                  {h}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, rowIdx) => (
            <tr key={rowIdx}>
              {row.map((cell, cellIdx) => {
                if (cell.isIndex) {
                  return <th key={cellIdx}>{cell.text}</th>
                }
                return <td key={cellIdx} dangerouslySetInnerHTML={{ __html: cell.html }} />
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {tableData.truncNote && (
        <div className="df-truncation-note" dangerouslySetInnerHTML={{ __html: tableData.truncNote }} />
      )}
    </div>
  )
}
