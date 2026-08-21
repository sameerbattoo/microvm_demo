/**
 * appViewModel — pure helpers that define the "App view" projection of a notebook:
 * which cells are presentation content, the display variable/label for a cell's
 * output, and the flattened list of @param inputs. Shared by the live AppView
 * component and the static App export builders so both agree on what an app shows.
 */
import { parseParams } from '../components/ParamWidgets'

// Decide whether a cell is "presentation" content worth showing to a consumer.
//   - markdown with content -> show
//   - code/sql with a chart (image) or table/plotly (html) -> show
//   - code/sql with only short text output -> show (treat as a metric/summary)
//   - everything else (imports, loads, joins, long dumps, empty) -> hide
export function appShows(cell) {
  if (cell.type === 'markdown') return !!cell.code?.trim()
  if (cell.image || cell.html) return true
  if (cell.output) {
    const text = cell.output.trim()
    const lines = text.split('\n')
    if (lines.length <= 8 && text.length <= 600) return true
  }
  return false
}

// The name of the DataFrame/variable a cell's output represents, for a caption
// above the table (context now that code is hidden).
export function deriveDisplayVar(cell) {
  if (cell.type === 'sql') {
    if (cell.outputVariable) return cell.outputVariable
    const code = cell.code || ''
    const m = code.match(/\bFROM\s+dynamodb\."?([a-zA-Z_][\w-]*)"?/i)
      || code.match(/\bFROM\s+'\/tmp\/([^']+)'/i)
      || code.match(/\bFROM\s+read_(?:csv|json|parquet)\('[^']*\/([^'/]+)'\)/i)
      || code.match(/\bFROM\s+[a-zA-Z_]\w*\.([a-zA-Z_]\w*)/i)
      || code.match(/\bFROM\s+([a-zA-Z_]\w*)/i)
    if (m) return m[1].replace(/\.\w+$/, '').replace(/[^a-zA-Z0-9_]/g, '_') || 'result'
    return 'result'
  }
  // code cell: only meaningful when the cell renders a DataFrame table
  if (!cell.html || cell.html.includes('data-plotly="true"')) return null
  const lines = (cell.code || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  if (!lines.length) return null
  const last = lines[lines.length - 1]
  if (/^(print|display|plot_\w+)\s*\(/.test(last)) return null
  const m = last.match(/^([A-Za-z_]\w*)/)
  if (!m) return null
  const name = m[1]
  const KEYWORDS = ['print', 'display', 'return', 'import', 'from', 'for', 'if', 'while', 'with', 'def', 'class', 'try', 'except']
  return KEYWORDS.includes(name) ? null : name
}

// Flatten every @param across all cells into a display-ready inputs list.
export function collectInputs(cells = []) {
  const inputs = []
  for (const cell of cells) {
    for (const p of parseParams(cell.code || '')) {
      let value = p.currentValue
      if (typeof value === 'string') value = value.replace(/^["']|["']$/g, '')  // strip quotes for text/dropdown/date
      inputs.push({
        label: (p.config && p.config.label) || p.varName,
        varName: p.varName,
        type: p.type,
        value,
      })
    }
  }
  return inputs
}
