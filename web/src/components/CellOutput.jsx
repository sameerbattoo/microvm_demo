import { useRef, useEffect, useState } from 'react'
import { sanitizeHtml } from '../services/sanitize'
import SortableTable from './SortableTable'

// Injected into the Plotly iframe so it can report its real rendered height back to
// the parent. The iframe is sandboxed (allow-scripts, no allow-same-origin), so the
// parent can't read its DOM — but postMessage still works across the opaque origin.
// We measure the actual .plotly-graph-div height (falling back to body scrollHeight),
// re-measure a few times as Plotly renders async, and observe later relayouts.
const PLOTLY_HEIGHT_REPORTER =
  '\n<script>(function(){' +
  'function report(){try{' +
  "var d=document.querySelector('.plotly-graph-div');" +
  'var ph=d?Math.ceil(d.getBoundingClientRect().height):0;' +
  'var bh=document.body?document.body.scrollHeight:0;' +
  'var v=Math.max(ph,bh)||0;' +
  "if(v>0){parent.postMessage({__plotlyHeight:v},'*');}" +
  '}catch(e){}}' +
  "window.addEventListener('load',function(){report();" +
  '[120,350,700,1200].forEach(function(t){setTimeout(report,t);});' +
  "try{var d=document.querySelector('.plotly-graph-div');" +
  'if(d&&window.ResizeObserver){new ResizeObserver(report).observe(d);}}catch(e){}' +
  '});})();<\/script>'

function PlotlyFrame({ html }) {
  const iframeRef = useRef(null)
  const [height, setHeight] = useState(600)

  const srcDoc = html.includes('</body>')
    ? html.replace('</body>', PLOTLY_HEIGHT_REPORTER + '</body>')
    : html + PLOTLY_HEIGHT_REPORTER

  useEffect(() => {
    const onMessage = (e) => {
      // Only react to messages from THIS iframe's window.
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return
      const h = e.data && e.data.__plotlyHeight
      if (typeof h === 'number' && h > 0) {
        setHeight(Math.min(2400, Math.max(120, Math.round(h) + 8)))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  return (
    <div className="output-plotly">
      <iframe
        ref={iframeRef}
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        style={{ width: '100%', height: `${height}px`, border: 'none', borderRadius: '8px' }}
        title="Plotly Chart"
      />
    </div>
  )
}

/**
 * CellOutput — renders a cell's execution output (image, text, Plotly chart, HTML
 * table, error, and timing). Presentational and read-only; extracted from Cell.jsx
 * so both the notebook editor and (later) App mode can share the same renderers.
 *
 * Pass onFix (+ aiBusy/aiFixing) to show the inline "Fix with AI" button on errors;
 * omit onFix for a purely read-only render (e.g. App mode).
 */
export default function CellOutput({ cell, isConnected = false, onFix = null, aiBusy = false, aiFixing = false }) {
  return (
    <>
      {cell.image && (
        <div className="output-image">
          <img src={cell.image} alt="Plot output" />
        </div>
      )}
      {cell.output && (
        <pre className="output-text">{cell.output}</pre>
      )}
      {cell.html && (
        cell.html.includes('data-plotly="true"') ? (
          <PlotlyFrame html={cell.html} />
        ) : (
          <SortableTable html={cell.html} sanitizer={sanitizeHtml} />
        )
      )}
      {cell.error && (
        <div className="output-error-wrap">
          <pre className="output-error">{cell.error}</pre>
          {onFix && isConnected && (
            <button className="output-error-fix-btn" onClick={onFix} disabled={aiBusy} title="Fix this error with AI">
              {aiFixing ? 'Fixing...' : '⚡ Fix'}
            </button>
          )}
        </div>
      )}
      {cell.executionTime != null && (
        <div className="output-meta">
          Executed in {cell.executionTime.toFixed(1)}ms
        </div>
      )}
    </>
  )
}
