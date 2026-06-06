import { h, type VNode } from 'vue';

/**
 * Splits text into highlighted/unhighlighted fragments based on a search query.
 * Returns an array of VNodes with <mark> tags around matches.
 */
export function highlightText(text: string, query: string): (string | VNode)[] {
  if (!query || !text) return [text || ''];

  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const result: (string | VNode)[] = [];
  let lastIndex = 0;

  let idx = lower.indexOf(q, lastIndex);
  while (idx !== -1) {
    if (idx > lastIndex) {
      result.push(text.slice(lastIndex, idx));
    }
    result.push(h('mark', { class: 'search-highlight' }, text.slice(idx, idx + query.length)));
    lastIndex = idx + query.length;
    idx = lower.indexOf(q, lastIndex);
  }

  if (lastIndex < text.length) {
    result.push(text.slice(lastIndex));
  }

  return result.length > 0 ? result : [text];
}
