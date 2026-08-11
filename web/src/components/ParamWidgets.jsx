/**
 * @param Input Widgets — Parse annotations from cell code and render interactive controls.
 * 
 * Syntax: # @param {type: "slider", min: 0, max: 100, step: 1, default: 50}
 *         variable_name = 50
 * 
 * Supported types: slider, dropdown, text, number, checkbox, date
 * 
 * When a widget value changes, the code is updated (variable assignment line)
 * and the cell is auto-executed.
 */

import { useState, useEffect, useMemo, useRef } from 'react'

/**
 * Parse @param annotations from cell code.
 * Returns array of: { varName, type, config, lineIndex, valueLine }
 */
export function parseParams(code) {
  if (!code || !code.includes('@param')) return []

  const lines = code.split('\n')
  const params = []

  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].trim()
    // Match: # @param {type: "slider", ...}
    const match = line.match(/^#\s*@param\s*(\{.+\})\s*$/)
    if (!match) continue

    // Parse the JSON-like config (allow single quotes → convert to double)
    let config
    try {
      const jsonStr = match[1].replace(/'/g, '"')
      config = JSON.parse(jsonStr)
    } catch {
      continue
    }

    // Next non-empty line should be the variable assignment
    let assignLine = i + 1
    while (assignLine < lines.length && !lines[assignLine].trim()) assignLine++
    if (assignLine >= lines.length) continue

    const assignMatch = lines[assignLine].match(/^(\w+)\s*=\s*(.+)$/)
    if (!assignMatch) continue

    const varName = assignMatch[1]
    const currentValue = assignMatch[2].trim()

    params.push({
      varName,
      type: config.type || 'text',
      config,
      paramLineIndex: i,
      valueLineIndex: assignLine,
      currentValue,
    })
  }

  return params
}

/**
 * Format a value for insertion into Python code.
 */
function formatPythonValue(value, type) {
  if (type === 'checkbox') return value ? 'True' : 'False'
  if (type === 'text' || type === 'date' || type === 'dropdown') return `"${value}"`
  return String(value)
}

/**
 * Parse current Python value from code.
 */
function parsePythonValue(valueStr, type) {
  const trimmed = valueStr.trim()
  if (type === 'checkbox') return trimmed === 'True'
  if (type === 'text' || type === 'date' || type === 'dropdown') {
    return trimmed.replace(/^["']|["']$/g, '')
  }
  const num = Number(trimmed)
  return isNaN(num) ? trimmed : num
}

/**
 * Widget bar component — rendered above the code editor when @param annotations are detected.
 * 
 * Does NOT modify cell.code directly (avoids CellEditor remount issues).
 * Instead, stores widget values and provides them for execution via onExecuteWithParams.
 */
export default function ParamWidgets({ code, onCodeChange, onExecute }) {
  const params = useMemo(() => parseParams(code), [code])
  const [values, setValues] = useState({})
  const userChanging = useRef(false)  // guard: true while a widget-initiated change propagates
  const executeTimer = useRef(null)   // debounce auto-execution

  // Sync values from code on mount / code change — but NOT when the change
  // came from a widget interaction (to avoid overwriting mid-drag state)
  const paramKey = params.map(p => p.varName + p.currentValue).join(',')
  useEffect(() => {
    if (userChanging.current) {
      userChanging.current = false
      return
    }
    const newValues = {}
    for (const param of params) {
      newValues[param.varName] = parsePythonValue(param.currentValue, param.type)
    }
    setValues(newValues)
  }, [paramKey])

  if (params.length === 0) return null

  const handleChange = (param, newValue) => {
    userChanging.current = true  // prevent the sync effect from overwriting
    setValues(prev => ({ ...prev, [param.varName]: newValue }))

    // Build the modified code with updated values and execute
    const lines = code.split('\n')
    for (const p of params) {
      const val = p.varName === param.varName ? newValue : values[p.varName]
      const formatted = formatPythonValue(val !== undefined ? val : parsePythonValue(p.currentValue, p.type), p.type)
      lines[p.valueLineIndex] = `${p.varName} = ${formatted}`
    }
    const newCode = lines.join('\n')
    onCodeChange(newCode)

    // Debounced auto-execute: waits 400ms after last change (avoids flooding during slider drag)
    if (executeTimer.current) clearTimeout(executeTimer.current)
    executeTimer.current = setTimeout(() => onExecute(), 400)
  }

  return (
    <div className="param-widgets-bar">
      {params.map(param => (
        <div key={param.varName} className="param-widget">
          <label className="param-label">{param.varName}</label>
          {param.type === 'slider' && (
            <div className="param-slider-group">
              <input
                type="range"
                className="param-slider"
                min={param.config.min ?? 0}
                max={param.config.max ?? 100}
                step={param.config.step ?? 1}
                value={values[param.varName] ?? param.config.default ?? 50}
                onChange={e => handleChange(param, Number(e.target.value))}
              />
              <span className="param-value">{values[param.varName] ?? param.config.default}</span>
            </div>
          )}
          {param.type === 'number' && (
            <input
              type="number"
              className="param-number"
              min={param.config.min}
              max={param.config.max}
              step={param.config.step ?? 1}
              value={values[param.varName] ?? param.config.default ?? 0}
              onChange={e => handleChange(param, Number(e.target.value))}
            />
          )}
          {param.type === 'dropdown' && (
            <select
              className="param-select"
              value={values[param.varName] ?? param.config.default ?? ''}
              onChange={e => handleChange(param, e.target.value)}
            >
              {(param.config.options || []).map(opt => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          )}
          {param.type === 'text' && (
            <input
              type="text"
              className="param-text"
              placeholder={param.config.placeholder || ''}
              value={values[param.varName] ?? param.config.default ?? ''}
              onChange={e => handleChange(param, e.target.value)}
            />
          )}
          {param.type === 'checkbox' && (
            <input
              type="checkbox"
              className="param-checkbox"
              checked={values[param.varName] ?? param.config.default ?? false}
              onChange={e => handleChange(param, e.target.checked)}
            />
          )}
          {param.type === 'date' && (
            <input
              type="date"
              className="param-date"
              value={values[param.varName] ?? param.config.default ?? ''}
              onChange={e => handleChange(param, e.target.value)}
            />
          )}
        </div>
      ))}
    </div>
  )
}
