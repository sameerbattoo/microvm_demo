/**
 * Smart variable preview renderer for the Variable Explorer.
 * Renders different data types with appropriate visual representations.
 */

// Check if a string looks like a hex color
const isHexColor = (s) => /^['"]?#[0-9a-fA-F]{3,8}['"]?$/.test(s.trim())

// Parse a list/tuple preview string into individual items
function parseListItems(value) {
  if (!value) return null
  const match = value.match(/^\[(.+?)(?:,\s*\.\.\.])?]$/) || value.match(/^\((.+?)(?:,\s*\.\.\.\))?$/)
  if (!match) return null
  const items = []
  let current = ''
  let inQuote = false
  let quoteChar = ''
  for (const ch of match[1]) {
    if ((ch === "'" || ch === '"') && !inQuote) { inQuote = true; quoteChar = ch; current += ch }
    else if (ch === quoteChar && inQuote) { inQuote = false; current += ch }
    else if (ch === ',' && !inQuote) { items.push(current.trim()); current = '' }
    else { current += ch }
  }
  if (current.trim()) items.push(current.trim())
  return items
}

// Parse a dict repr into key-value pairs
function parseDictItems(value) {
  if (!value || !value.startsWith('{')) return null
  const items = []
  const dictContent = value.slice(1, -1)
  let depth = 0; let current = ''; let inStr = false; let strCh = ''
  for (const ch of dictContent) {
    if ((ch === "'" || ch === '"') && !inStr) { inStr = true; strCh = ch; current += ch }
    else if (ch === strCh && inStr) { inStr = false; current += ch }
    else if ((ch === '{' || ch === '[' || ch === '(') && !inStr) { depth++; current += ch }
    else if ((ch === '}' || ch === ']' || ch === ')') && !inStr) { depth--; current += ch }
    else if (ch === ',' && depth === 0 && !inStr) { items.push(current.trim()); current = '' }
    else { current += ch }
  }
  if (current.trim()) items.push(current.trim())
  return items
}

export default function VariablePreviewRenderer({ info }) {
  // HTML preview (DataFrames, Series)
  if (info.preview_type === 'html') {
    return <div className="var-preview-html" dangerouslySetInnerHTML={{ __html: info.preview }} />
  }

  const value = info.preview || info.value || ''
  const type = info.type

  // Boolean — colored badge
  if (type === 'bool') {
    const isTrue = value === 'True'
    return (
      <div className={`var-preview-badge ${isTrue ? 'var-badge-true' : 'var-badge-false'}`}>
        <span className="var-badge-dot" />{value}
      </div>
    )
  }

  // NoneType — muted null pill
  if (type === 'NoneType') {
    return <div className="var-preview-badge var-badge-null">null</div>
  }

  // Matplotlib axes/figures — show as "Plot object" badge
  if (value.includes('<Axes') || value.includes('<Figure') || value.includes('AxesSubplot') ||
      (type === 'ndarray' && value.includes('Axes'))) {
    return <div className="var-preview-badge var-badge-plot">Plot object</div>
  }

  // Numbers — format with commas for large values
  if ((type === 'int' || type === 'float') && !value.includes('e')) {
    const num = parseFloat(value)
    if (!isNaN(num) && Math.abs(num) >= 1000) {
      const formatted = type === 'int'
        ? parseInt(value).toLocaleString()
        : parseFloat(value).toLocaleString(undefined, { maximumFractionDigits: 4 })
      return <div className="var-preview-number">{formatted}</div>
    }
    return <div className="var-preview-number">{value}</div>
  }

  // Datetime — format nicely
  if (type === 'datetime' || type === 'Timestamp') {
    const dateMatch = value.match(/(\d{4})[-,]\s*(\d{1,2})[-,]\s*(\d{1,2})/)
    if (dateMatch) {
      try {
        const d = new Date(parseInt(dateMatch[1]), parseInt(dateMatch[2]) - 1, parseInt(dateMatch[3]))
        const formatted = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
        return <div className="var-preview-date">{formatted}<span className="var-preview-date-raw">{value}</span></div>
      } catch { /* fall through */ }
    }
  }

  // Strings — check for URLs and paths
  if (type === 'str') {
    const unquoted = value.replace(/^['"]|['"]$/g, '')
    if (/^https?:\/\//.test(unquoted)) {
      return <div className="var-preview-url"><a href={unquoted} target="_blank" rel="noopener">{unquoted}</a></div>
    }
    if (/^[\/~].*\//.test(unquoted) || /^[A-Z]:\\/.test(unquoted)) {
      const parts = unquoted.split('/')
      const filename = parts.pop()
      const dir = parts.join('/') + '/'
      return <div className="var-preview-path"><span className="var-path-dir">{dir}</span><span className="var-path-file">{filename}</span></div>
    }
    return <pre>{value}</pre>
  }

  // Dict — render as key-value pairs
  if (type === 'dict' && value.startsWith('{')) {
    const items = parseDictItems(value)
    if (items && items.length > 0) {
      const pairs = items.slice(0, 5).map(item => {
        const colonIdx = item.indexOf(':')
        if (colonIdx === -1) return { key: item, val: '' }
        return { key: item.slice(0, colonIdx).trim(), val: item.slice(colonIdx + 1).trim() }
      })
      return (
        <div className="var-preview-dict">
          {pairs.map((pair, i) => (
            <div key={i} className="var-dict-row">
              <span className="var-dict-key">{pair.key}</span>
              <span className="var-dict-val">{pair.val.length > 30 ? pair.val.slice(0, 30) + '…' : pair.val}</span>
            </div>
          ))}
          {items.length > 5 && <div className="var-dict-row var-dict-more">… {items.length - 5} more</div>}
        </div>
      )
    }
  }

  // List/tuple with color values
  if ((type === 'list' || type === 'tuple') && value.includes('#')) {
    const items = parseListItems(value)
    if (items && items.some(item => isHexColor(item))) {
      return (
        <div className="var-preview-colors">
          {items.map((item, i) => {
            const color = item.replace(/['"]/g, '')
            return (
              <div key={i} className="var-color-item">
                <span className="var-color-swatch" style={{ background: color }} />
                <span className="var-color-value">{color}</span>
              </div>
            )
          })}
          {value.includes('...') && <div className="var-color-item var-color-more">...</div>}
        </div>
      )
    }
  }

  // Regular list/tuple — render as vertical list
  if ((type === 'list' || type === 'tuple') && info.shape) {
    const items = parseListItems(value)
    if (items && items.length > 0) {
      return (
        <div className="var-preview-list">
          {items.map((item, i) => (
            <div key={i} className="var-list-item">
              <span className="var-list-index">{i}</span>
              <span className="var-list-value">{item}</span>
            </div>
          ))}
          {value.includes('...') && <div className="var-list-item var-list-more">…</div>}
        </div>
      )
    }
  }

  // Default: monospace text
  return <pre>{value}</pre>
}
