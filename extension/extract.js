/**
 * Runs inside the page's main world. It is serialized by
 * chrome.scripting.executeScript, so it must not reference anything outside
 * its own body: no imports, no closure over module state.
 */
export function extractRenderedText() {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK'])
  const BLOCK = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV',
    'UL', 'OL', 'DL', 'TABLE', 'THEAD', 'TBODY', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'PRE', 'BLOCKQUOTE', 'FORM', 'FIELDSET', 'FIGURE', 'HR', 'BR',
  ])
  const out = []

  const ownText = (el) => {
    let text = ''
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent
    }
    return text.replace(/[ \t\u00a0]+/gu, ' ').trim()
  }

  const walk = (root) => {
    for (const el of root.children) {
      if (SKIP.has(el.tagName)) continue
      const tag = el.tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea') {
        const value = el.value ?? el.getAttribute('value') ?? ''
        const label = el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? ''
        if (value || label) out.push(`[${tag}] ${label}${value ? `: ${value}` : ''}`.trim())
        continue
      }
      if (tag === 'img') {
        const alt = String(el.alt ?? '').trim()
        if (alt) out.push(`[img] ${alt}`)
        continue
      }
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue
      if (el.getAttribute('aria-hidden') === 'true') continue
      const direct = ownText(el)
      if (direct) out.push(direct)
      if (BLOCK.has(el.tagName)) out.push('')
      walk(el)
      if (BLOCK.has(el.tagName)) out.push('')
    }
  }

  try {
    walk(document.body ?? document.documentElement)
  } catch {
    // A page can throw from getComputedStyle on detached nodes; keep whatever we collected.
  }

  // Collapse DOM-level duplication (carousels render the same banner twice) and
  // repeated blank separators, while keeping every distinct line in order.
  const cleaned = []
  let lastLine = ''
  for (const line of out) {
    if (line === '') {
      if (cleaned.length > 0 && cleaned[cleaned.length - 1] !== '') cleaned.push('')
      continue
    }
    if (line === lastLine) {
      if (cleaned[cleaned.length - 1] === '') cleaned.pop()
      continue
    }
    cleaned.push(line)
    lastLine = line
  }

  const text = cleaned
    .join('\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()

  return { text, title: document.title, url: location.href, frames: 1 }
}
