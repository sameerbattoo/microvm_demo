// Transparent full-window overlay used during drag-resize.
//
// Problem: our resize handles listen for mousemove/mouseup on `document`. When the
// cursor passes over an <iframe> (e.g. an embedded Plotly chart), the iframe's own
// document swallows those events, so the parent stops receiving mousemove and may
// never see mouseup — the drag gets stuck / behaves erratically.
//
// Fix: while dragging, cover the whole window with a transparent element that sits
// ABOVE any iframe (very high z-index). All mouse events then hit this overlay in the
// parent document, so drag tracking keeps working over charts. The overlay also lets
// us pin the resize cursor consistently for the duration of the drag.

let _overlay = null

export function showDragOverlay(cursor = 'row-resize') {
  if (_overlay) return _overlay
  const el = document.createElement('div')
  el.style.position = 'fixed'
  el.style.inset = '0'
  el.style.zIndex = '2147483647' // max — above any iframe/chart
  el.style.cursor = cursor
  // Transparent but still event-capturing. background must be set (even transparent)
  // so the element reliably receives pointer events across browsers.
  el.style.background = 'transparent'
  el.setAttribute('data-drag-overlay', 'true')
  document.body.appendChild(el)
  _overlay = el
  return el
}

export function hideDragOverlay() {
  if (_overlay && _overlay.parentNode) {
    _overlay.parentNode.removeChild(_overlay)
  }
  _overlay = null
}
