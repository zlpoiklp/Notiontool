const BLOCKED_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'svg',
  'math',
]);

const URL_ATTRIBUTES = new Set(['href', 'src']);
const DANGEROUS_STYLE_PATTERN = /expression\s*\(|javascript:|vbscript:|@import|url\s*\(\s*['"]?\s*javascript:/i;

function isSafeUrl(rawUrl: string): boolean {
  const value = rawUrl.trim();
  if (!value) return true;
  if (value.startsWith('#') || value.startsWith('/')) return true;
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) return true;

  try {
    const parsed = new URL(value, window.location.origin);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function sanitizeStyle(value: string): string {
  if (DANGEROUS_STYLE_PATTERN.test(value)) {
    return '';
  }
  return value;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeHtml(html: string): string {
  if (!html) return '';

  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
    return escapeHtml(html);
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT);
  const nodesToRemove: Node[] = [];

  while (walker.nextNode()) {
    const node = walker.currentNode;

    if (node.nodeType === Node.COMMENT_NODE) {
      nodesToRemove.push(node);
      continue;
    }

    const element = node as Element;
    const tagName = element.tagName.toLowerCase();
    if (BLOCKED_TAGS.has(tagName)) {
      nodesToRemove.push(element);
      continue;
    }

    const attributes = Array.from(element.attributes);
    for (const attr of attributes) {
      const name = attr.name.toLowerCase();
      const value = attr.value;

      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') {
        element.removeAttribute(attr.name);
        continue;
      }

      if (name === 'style') {
        const safeStyle = sanitizeStyle(value);
        if (safeStyle) {
          element.setAttribute(attr.name, safeStyle);
        } else {
          element.removeAttribute(attr.name);
        }
        continue;
      }

      if (URL_ATTRIBUTES.has(name) && !isSafeUrl(value)) {
        element.removeAttribute(attr.name);
        continue;
      }
    }

    if (element.getAttribute('target') === '_blank') {
      element.setAttribute('rel', 'noopener noreferrer');
    }
  }

  for (const node of nodesToRemove) {
    node.parentNode?.removeChild(node);
  }

  return doc.body.innerHTML;
}

export function textToSafeHtml(text: string): string {
  return sanitizeHtml(escapeHtml(text).replace(/\n/g, '<br/>'));
}
