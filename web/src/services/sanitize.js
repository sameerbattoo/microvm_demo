/**
 * HTML sanitization utility using DOMPurify.
 * All user-generated or executor-generated HTML must pass through this
 * before being rendered via dangerouslySetInnerHTML to prevent XSS attacks.
 */
import DOMPurify from 'dompurify'

/**
 * Sanitize HTML string, allowing safe tags/attributes only.
 * Strips <script>, event handlers (onerror, onclick, etc.), and dangerous URIs.
 */
export function sanitizeHtml(dirty) {
  if (!dirty) return ''
  return DOMPurify.sanitize(dirty, {
    // Allow common formatting, tables (DataFrame output), images, links
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'hr', 'blockquote', 'pre', 'code',
      'ul', 'ol', 'li', 'dl', 'dt', 'dd',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
      'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'sub', 'sup',
      'a', 'img', 'figure', 'figcaption',
      'div', 'span', 'details', 'summary',
      'input',  // for checkboxes in markdown task lists
    ],
    ALLOWED_ATTR: [
      'href', 'src', 'alt', 'title', 'class', 'id',
      'width', 'height', 'style',
      'target', 'rel',
      'colspan', 'rowspan', 'scope',
      'type', 'checked', 'disabled',  // for checkbox inputs
    ],
    // Only allow safe URL protocols
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    // Strip all data-* attributes to prevent data exfiltration
    ALLOW_DATA_ATTR: false,
  })
}

/**
 * Sanitize markdown-rendered HTML (more permissive for code blocks).
 * Used for AI responses and user markdown cells.
 */
export function sanitizeMarkdown(dirty) {
  if (!dirty) return ''
  return DOMPurify.sanitize(dirty, {
    // Allow everything except scripts and event handlers (DOMPurify default)
    ADD_TAGS: ['input', 'button'],
    ADD_ATTR: ['target', 'class', 'checked', 'disabled', 'type', 'data-lang'],
    ALLOW_DATA_ATTR: true,
  })
}
