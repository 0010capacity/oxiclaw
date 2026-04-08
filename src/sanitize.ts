/**
 * Telegram HTML Sanitization for oxiclaw
 *
 * Telegram's HTML parse mode supports a limited subset of HTML tags.
 * This module sanitizes agent output before sending via Telegram HTML mode
 * to prevent XSS, broken formatting, or API errors from unsupported tags.
 *
 * Allowed tags: b, i, u, s, code, pre, em, strong, a (href only), span (class only)
 * Allowed attributes: href, class
 *
 * Telegram HTML docs: https://core.telegram.org/bots/api#html-style
 */

const ALLOWED_TAGS = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'strike',
  'del',
  'code',
  'pre',
  'a',
  'span',
]);

const ALLOWED_ATTRS = new Set(['href', 'class']);

/**
 * Sanitize a string for safe use with Telegram HTML parse mode.
 *
 * - Strips all tags not in the allowed list
 * - Removes all attributes except href and class
 * - Escapes < and > in plain text
 * - Strips dangerous patterns like javascript:, data:, vbscript: in href
 * - Removes <script>, <style>, <iframe>, <object>, <embed> entirely
 */
export function sanitizeHtmlForTelegram(html: string): string {
  if (!html) return '';

  let result = html;

  // Step 1: Remove dangerous entire tags (strip content too)
  const dangerousTags =
    /<(script|style|iframe|object|embed|form|input|button|select|textarea|svg|math)[^>]*>[\s\S]*?<\/\1>/gi;
  result = result.replace(dangerousTags, '');

  // Step 2: Remove tags by stripping their content and tags
  // First remove self-closing dangerous tags
  result = result.replace(/<(script|style|iframe|object|embed)[^>]*\/?>/gi, '');

  // Step 3: Remove any tag with onclick, onerror, onload, etc.
  result = result.replace(/\s(on\w+)\s*=/gi, ' data-removed-$1=');

  // Step 4: Process remaining tags
  result = result.replace(
    /<(\/?)(\w+)([^>]*?)(\/?)>/g,
    (_match, closing, tag, attrs, selfClose) => {
      const lowerTag = tag.toLowerCase();

      // Strip unknown tags entirely (but keep their content)
      if (!ALLOWED_TAGS.has(lowerTag)) {
        return '';
      }

      // Process attributes — only keep href and class.
      // attrs may have a leading space (e.g. " href="url""), so prepend a space
      // when joining so the result is "<a href="url">" not "<ahref="url">".
      if (attrs.trim()) {
        const cleanParts: string[] = [];
        let match: RegExpExecArray | null;
        const attrRegex = /(\w+)\s*=\s*["'][^"']*["']/g;
        while ((match = attrRegex.exec(attrs)) !== null) {
          const [, attrName] = match;
          const lowerAttr = attrName.toLowerCase();
          if (!ALLOWED_ATTRS.has(lowerAttr)) continue;

          const value = match[0].match(/=["']([^"']*)["']/)?.[1] || '';

          // Sanitize href values — block javascript:, data:, vbscript:, etc.
          if (lowerAttr === 'href') {
            const hrefLower = value.toLowerCase().trim();
            if (
              hrefLower.startsWith('javascript:') ||
              hrefLower.startsWith('data:') ||
              hrefLower.startsWith('vbscript:') ||
              hrefLower.startsWith('on')
            ) {
              continue;
            }
          }

          cleanParts.push(match[0]);
        }

        if (cleanParts.length > 0) {
          return `<${closing}${tag} ${cleanParts.join(' ')}${selfClose}>`;
        }
      }

      return `<${closing}${tag}>`;
    },
  );

  // Step 5: Escape remaining < and > that are not part of valid tags
  // This handles cases where content contains HTML-like text
  result = result.replace(/<([^>]*)$/gm, '&lt;$1');

  // Step 6: Unescape our own escaped sequences that turned out to be text
  // Re-check: if something looks like a legitimate tag after all, re-tag it
  result = result.replace(
    /&lt;(\/?)(\w+)([^&]*)(&gt;)?/g,
    (match, closing, tag, content, gt) => {
      const lowerTag = tag.toLowerCase();
      if (ALLOWED_TAGS.has(lowerTag)) {
        return `<${closing}${tag}${content}${gt || '>'}`;
      }
      // It was truly text — keep the escaped version
      return match;
    },
  );

  return result.trim();
}
