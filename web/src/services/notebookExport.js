/**
 * Notebook export/save builders — pure functions that turn a notebook
 * (tab metadata + cells) into downloadable content. Extracted from Notebook.jsx
 * to keep the component focused on rendering/state.
 *
 * Each builder returns { content, mime, filename }. Call downloadTextFile() with
 * that result to trigger the browser download.
 */
import { marked } from 'marked'
import { sanitizeMarkdown } from './sanitize'
import { appShows, deriveDisplayVar, collectInputs } from './appViewModel'

/** Trigger a browser download for text content. */
export function downloadTextFile({ content, mime, filename }) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Native .notebook.json (our own format). */
export function buildNativeNotebook(tab, cells) {
  const notebook = {
    name: tab.name,
    description: tab.description || '',
    tag: tab.tag || null,
    microvmId: tab.microvmId || null,
    savedAt: new Date().toISOString(),
    cells: cells.map(c => ({
      type: c.type || 'code',
      code: c.code,
      output: c.output,
      error: c.error,
      html: c.html,
      image: c.image,
      executionNumber: c.executionNumber,
      aiExplanation: c.aiExplanation || null,
      aiExplanationEdited: c.aiExplanationEdited || false,
      outputVariable: c.outputVariable || null,
      generated: c.generated || null,
    })),
  }
  return {
    content: JSON.stringify(notebook, null, 2),
    mime: 'application/json',
    filename: `${(tab.name || 'Notebook').replace(/\s+/g, '_')}.notebook.json`,
  }
}

/** Self-contained styled HTML export. */
export function buildNotebookHTML(tab, cells) {
  const nbName = tab.name || 'Notebook'
  let html = `<html><head><meta charset="UTF-8"><title>${nbName}</title><style>body{font-family:system-ui;padding:20px;max-width:1000px;margin:0 auto;background:#1a1a2e;color:#e0e0e0}h1{color:#89b4fa}h2{color:#cdd6f4;font-size:16px;margin-top:24px}.desc{color:#888;margin-bottom:24px}.cell{margin:16px 0;border:1px solid #333;border-radius:8px;overflow:hidden}.md-cell{padding:4px 16px 12px;border-color:#2a2a3a}.cell-header{background:#2a2a4a;padding:8px 12px;font-size:11px;color:#888;display:flex;justify-content:space-between}details{margin:0}summary{padding:8px 12px;cursor:pointer;font-weight:600;font-size:12px;color:#a6adc8;background:#1e2a3a}pre{margin:0;padding:12px;background:#0d1117;overflow-x:auto;font-size:13px;color:#e0e0e0}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #444;padding:6px 10px;text-align:left;font-size:12px}th{background:#2a2a4a}.table-scroll{max-height:420px;overflow:auto;border:1px solid #444;border-radius:8px;margin:8px 0}.table-scroll table{margin:0}.table-scroll thead th{position:sticky;top:0;z-index:1;box-shadow:inset 0 -1px 0 #444}.output{padding:12px;background:#11111b}.ai-note{padding:8px 12px;background:#1e2a3a;border-top:1px solid #333;font-size:12px;color:#a6adc8;font-style:italic}img{max-width:100%}.error{color:#f38ba8}footer{text-align:center;padding:24px;color:#555;font-size:11px;border-top:1px solid #333;margin-top:32px}</style></head><body>`
  html += `<h1>${nbName}</h1>`
  if (tab.description) html += `<p class="desc">${tab.description}</p>`
  html += `<p style="color:#666;font-size:12px">Generated: ${new Date().toLocaleString()} · ${cells.length} cells</p>`
  cells.forEach((cell, i) => {
    const cellType = cell.type || 'code'
    // Markdown cells render as prose — no "Code" collapsible.
    if (cellType === 'markdown') {
      html += `<div class="cell md-cell">${sanitizeMarkdown(marked.parse(cell.code || ''))}</div>`
      return
    }
    html += `<div class="cell">`
    html += `<div class="cell-header"><span>${cellType === 'sql' ? `SQL — Cell ${i + 1}` : `Code — Cell ${i + 1}`}</span>${cell.executionNumber ? `<span>[${cell.executionNumber}]</span>` : ''}</div>`
    html += `<details open><summary>${cellType === 'sql' ? 'SQL' : 'Code'}</summary><pre>${(cell.code || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></details>`
    if (cell.output || cell.html || cell.image || cell.error) {
      html += `<div class="output">`
      if (cell.output) html += `<pre>${cell.output}</pre>`
      if (cell.html) html += _wrapHtmlOutput(cell.html)
      if (cell.image) html += `<img src="${cell.image}" alt="Plot"/>`
      if (cell.error) html += `<pre class="error">${cell.error}</pre>`
      html += `</div>`
    }
    if (cell.aiExplanation) html += `<div class="ai-note">✨ ${cell.aiExplanation}</div>`
    html += `</div>`
  })
  html += `<footer><strong>Lambda MicroVM Notebook</strong><br>Developed by the AWS Startup SA Team<br>&copy; ${new Date().getFullYear()} Amazon Web Services, Inc.</footer></body></html>`
  return {
    content: html,
    mime: 'text/html',
    filename: `${nbName.replace(/\s+/g, '-')}.html`,
  }
}

/** Markdown export. */
export function buildNotebookMarkdown(tab, cells) {
  const nbName = tab.name || 'Notebook'
  let md = `# ${nbName}\n\n`
  if (tab.description) md += `> ${tab.description}\n\n`
  md += `*Generated: ${new Date().toLocaleString()} · ${cells.length} cells*\n\n---\n\n`
  cells.forEach((cell, i) => {
    const cellType = cell.type || 'code'
    // Markdown cells emit their content directly — no "Code" collapsible.
    if (cellType === 'markdown') {
      md += `${cell.code || ''}\n\n---\n\n`
      return
    }
    md += `## ${cellType === 'sql' ? `SQL — Cell ${i + 1}` : `Code — Cell ${i + 1}`}${cell.executionNumber ? ` [${cell.executionNumber}]` : ''}\n\n`
    md += `<details><summary>${cellType === 'sql' ? 'SQL' : 'Code'}</summary>\n\n\`\`\`${cellType === 'sql' ? 'sql' : 'python'}\n${cell.code || ''}\n\`\`\`\n</details>\n\n`
    if (cell.output) md += `**Output:**\n\`\`\`\n${cell.output}\n\`\`\`\n\n`
    if (cell.html) md += `*(DataFrame table — view HTML export for full rendering)*\n\n`
    if (cell.image) md += `![Plot](plot-cell-${i + 1}.png)\n\n`
    if (cell.error) md += `**Error:** \`${cell.error}\`\n\n`
    if (cell.aiExplanation) md += `> ✨ *${cell.aiExplanation}*\n\n`
    md += `---\n\n`
  })
  md += `\n*Lambda MicroVM Notebook — Developed by the AWS Startup SA Team*\n`
  return {
    content: md,
    mime: 'text/markdown',
    filename: `${nbName.replace(/\s+/g, '-')}.md`,
  }
}

/** Jupyter .ipynb export (SQL cells get a %%sql magic prefix). */
export function buildIPYNB(tab, cells) {
  const nbName = tab.name || 'Notebook'
  const ipynb = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python', version: '3.11' },
    },
    cells: cells.map(cell => {
      const cellType = cell.type === 'markdown' ? 'markdown' : 'code'
      // For SQL cells exported as ipynb code cells, prepend %%sql magic
      const codeContent = cell.type === 'sql' ? `%%sql\n${cell.code || ''}` : (cell.code || '')
      const source = codeContent.split('\n').map((line, i, arr) => i < arr.length - 1 ? line + '\n' : line)
      const outputs = []
      if (cellType === 'code') {
        if (cell.output) {
          outputs.push({ output_type: 'stream', name: 'stdout', text: cell.output.split('\n').map((l, i, a) => i < a.length - 1 ? l + '\n' : l) })
        }
        if (cell.error) {
          outputs.push({ output_type: 'stream', name: 'stderr', text: [cell.error] })
        }
      }
      return {
        cell_type: cellType,
        metadata: {},
        source,
        ...(cellType === 'code' ? { outputs, execution_count: cell.executionNumber || null } : {}),
      }
    }),
  }
  return {
    content: JSON.stringify(ipynb, null, 1),
    mime: 'application/json',
    filename: `${nbName.replace(/\s+/g, '_')}.ipynb`,
  }
}

// ============================================================
// App-view exports — the consumer projection (inputs + rendered markdown/charts/
// tables, no code). Used when exporting from App view instead of the workbook.
// ============================================================

const _esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const APP_HTML_STYLE = `
:root{--accent:#5b9fff;--accent-soft:rgba(91,159,255,.14);--accent-border:rgba(91,159,255,.38);--bg:#0f1017;--panel:#16161c;--text:#f2f4ff;--text-dim:#bfc4dc;--border:rgba(255,255,255,.08)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.55}
.app-doc{max-width:920px;margin:0 auto;padding:32px 28px 80px}
h1{font-size:26px;margin:0 0 6px}
.desc{color:var(--text-dim);margin:0 0 24px;font-size:14px}
.gen-meta{color:#5c6280;font-size:12px;margin:0 0 22px}
.inputs{background:linear-gradient(180deg,var(--accent-soft),transparent 62%),var(--panel);border:1px solid var(--accent-border);border-radius:12px;padding:16px 18px;margin-bottom:26px;box-shadow:0 0 22px rgba(91,159,255,.16),0 12px 30px rgba(0,0,0,.4)}
.inputs-title{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin-bottom:12px;display:flex;align-items:center;gap:8px}
.inputs-title::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px 1px rgba(91,159,255,.7)}
.inputs-grid{display:flex;flex-wrap:wrap;gap:12px}
.input{display:flex;flex-direction:column;gap:3px;background:rgba(91,159,255,.06);border:1px solid var(--accent-border);border-radius:8px;padding:8px 13px;min-width:120px}
.input-label{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;font-weight:600;color:var(--text-dim);letter-spacing:.02em}
.input-value{font-size:17px;font-weight:700;color:var(--accent);line-height:1.1}
.block{margin:0 0 26px}
.block.md{color:var(--text)}
.var{display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;font-weight:700;color:var(--accent);background:var(--accent-soft);border:1px solid var(--accent-border);border-radius:6px;padding:3px 10px;margin-bottom:10px;box-shadow:0 0 12px rgba(91,159,255,.16)}
h2{border-bottom:1px solid var(--accent-border);padding-bottom:6px}
table{border-collapse:collapse;width:100%;font-size:13px;margin:4px 0}
th,td{border:1px solid var(--border);padding:6px 10px;text-align:left}
th{background:rgba(255,255,255,.04);color:var(--text)}
.table-scroll{max-height:420px;overflow:auto;border:1px solid var(--border);border-radius:8px;margin:4px 0}
.table-scroll table{margin:0}
.table-scroll thead th{position:sticky;top:0;z-index:1;background:#1c1d26;box-shadow:inset 0 -1px 0 var(--border)}
.out-text{background:#0b0c12;border:1px solid var(--border);border-radius:8px;padding:12px;overflow-x:auto;font-size:13px;color:var(--text)}
.out-img img{max-width:100%;border-radius:8px}
img{max-width:100%}
footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--border);color:#5c6280;font-size:12px;text-align:center}
`

// Wrap a DataFrame table in a bounded, scrollable container (≈15 rows + sticky
// header) to match the in-app table. Plotly snippets are left as-is (not tables).
function _wrapHtmlOutput(htmlStr) {
  if (!htmlStr) return ''
  if (htmlStr.includes('data-plotly')) return htmlStr
  return `<div class="table-scroll">${htmlStr}</div>`
}

function _appOutputHTML(cell) {
  if (cell.image) return `<div class="out-img"><img src="${cell.image}" alt="chart"/></div>`
  if (cell.html) return _wrapHtmlOutput(cell.html)   // DataFrame table (scrollable) or Plotly snippet
  if (cell.output) return `<pre class="out-text">${_esc(cell.output)}</pre>`
  return ''
}

/** App view → self-contained styled HTML (inputs + rendered content, no code). */
export function buildAppHTML(tab, cells) {
  const nbName = tab.name || 'App'
  const inputs = collectInputs(cells)
  const presentation = cells.filter(appShows)

  let body = `<h1>${_esc(nbName)}</h1>`
  if (tab.description) body += `<p class="desc">${_esc(tab.description)}</p>`
  body += `<p class="gen-meta">Generated: ${new Date().toLocaleString()}</p>`

  if (inputs.length) {
    body += `<div class="inputs"><div class="inputs-title">Inputs</div><div class="inputs-grid">`
    for (const inp of inputs) {
      body += `<div class="input"><span class="input-label">${_esc(inp.label)}</span><span class="input-value">${_esc(inp.value)}</span></div>`
    }
    body += `</div></div>`
  }

  for (const cell of presentation) {
    if (cell.type === 'markdown') {
      body += `<div class="block md">${sanitizeMarkdown(marked.parse(cell.code || ''))}</div>`
      continue
    }
    const varName = deriveDisplayVar(cell)
    body += `<div class="block">${varName ? `<div class="var">${_esc(varName)}</div>` : ''}${_appOutputHTML(cell)}</div>`
  }

  body += `<footer><strong>Lambda MicroVM Notebook</strong><br>Developed by the AWS Startup SA Team<br>&copy; ${new Date().getFullYear()} Amazon Web Services, Inc.</footer>`

  const html = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${_esc(nbName)}</title><style>${APP_HTML_STYLE}</style></head><body><div class="app-doc">${body}</div></body></html>`
  return {
    content: html,
    mime: 'text/html',
    filename: `${nbName.replace(/\s+/g, '-')}-app.html`,
  }
}

/** App view → Markdown (inputs + markdown/metrics; charts/tables noted). */
export function buildAppMarkdown(tab, cells) {
  const nbName = tab.name || 'App'
  const inputs = collectInputs(cells)
  const presentation = cells.filter(appShows)

  let md = `# ${nbName}\n\n`
  if (tab.description) md += `> ${tab.description}\n\n`
  md += `*Generated: ${new Date().toLocaleString()}*\n\n`

  if (inputs.length) {
    md += `## Inputs\n\n`
    for (const inp of inputs) md += `- **${inp.label}:** ${inp.value}\n`
    md += `\n`
  }

  for (const cell of presentation) {
    if (cell.type === 'markdown') {
      md += `${cell.code || ''}\n\n`
      continue
    }
    const varName = deriveDisplayVar(cell)
    if (varName) md += `### ${varName}\n\n`
    if (cell.image) {
      md += `_(chart — see HTML export for the rendered image)_\n\n`
    } else if (cell.html) {
      md += cell.html.includes('data-plotly')
        ? `_(interactive chart — see HTML export)_\n\n`
        : `_(table — see HTML export for full rendering)_\n\n`
    } else if (cell.output) {
      md += `\`\`\`\n${cell.output}\n\`\`\`\n\n`
    }
  }

  md += `\n*Lambda MicroVM Notebook — Developed by the AWS Startup SA Team*\n`
  return {
    content: md,
    mime: 'text/markdown',
    filename: `${nbName.replace(/\s+/g, '-')}-app.md`,
  }
}
