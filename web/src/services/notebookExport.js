/**
 * Notebook export/save builders — pure functions that turn a notebook
 * (tab metadata + cells) into downloadable content. Extracted from Notebook.jsx
 * to keep the component focused on rendering/state.
 *
 * Each builder returns { content, mime, filename }. Call downloadTextFile() with
 * that result to trigger the browser download.
 */

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
      outputVariable: c.outputVariable || null,
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
  let html = `<html><head><meta charset="UTF-8"><title>${nbName}</title><style>body{font-family:system-ui;padding:20px;max-width:1000px;margin:0 auto;background:#1a1a2e;color:#e0e0e0}h1{color:#89b4fa}h2{color:#cdd6f4;font-size:16px;margin-top:24px}.desc{color:#888;margin-bottom:24px}.cell{margin:16px 0;border:1px solid #333;border-radius:8px;overflow:hidden}.cell-header{background:#2a2a4a;padding:8px 12px;font-size:11px;color:#888;display:flex;justify-content:space-between}details{margin:0}summary{padding:8px 12px;cursor:pointer;font-weight:600;font-size:12px;color:#a6adc8;background:#1e2a3a}pre{margin:0;padding:12px;background:#0d1117;overflow-x:auto;font-size:13px;color:#e0e0e0}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #444;padding:6px 10px;text-align:left;font-size:12px}th{background:#2a2a4a}.output{padding:12px;background:#11111b}.ai-note{padding:8px 12px;background:#1e2a3a;border-top:1px solid #333;font-size:12px;color:#a6adc8;font-style:italic}img{max-width:100%}.error{color:#f38ba8}footer{text-align:center;padding:24px;color:#555;font-size:11px;border-top:1px solid #333;margin-top:32px}</style></head><body>`
  html += `<h1>${nbName}</h1>`
  if (tab.description) html += `<p class="desc">${tab.description}</p>`
  html += `<p style="color:#666;font-size:12px">Exported: ${new Date().toLocaleString()} · ${cells.length} cells</p>`
  cells.forEach((cell, i) => {
    const cellType = cell.type || 'code'
    html += `<div class="cell">`
    html += `<div class="cell-header"><span>${cellType === 'markdown' ? 'Text' : cellType === 'sql' ? `SQL — Cell ${i + 1}` : `Code — Cell ${i + 1}`}</span>${cell.executionNumber ? `<span>[${cell.executionNumber}]</span>` : ''}</div>`
    html += `<details open><summary>${cellType === 'sql' ? 'SQL' : 'Code'}</summary><pre>${(cell.code || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></details>`
    if (cell.output || cell.html || cell.image || cell.error) {
      html += `<div class="output">`
      if (cell.output) html += `<pre>${cell.output}</pre>`
      if (cell.html) html += cell.html
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
  md += `*Exported: ${new Date().toLocaleString()} · ${cells.length} cells*\n\n---\n\n`
  cells.forEach((cell, i) => {
    const cellType = cell.type || 'code'
    md += `## ${cellType === 'markdown' ? 'Text' : cellType === 'sql' ? `SQL — Cell ${i + 1}` : `Code — Cell ${i + 1}`}${cell.executionNumber ? ` [${cell.executionNumber}]` : ''}\n\n`
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
