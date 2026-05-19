<script lang="ts">
import { defineComponent, h, type VNode } from 'vue';

export default defineComponent({
  name: 'HighlightText',
  props: {
    text: { type: String, default: '' },
    query: { type: String, default: '' },
  },
  render() {
    const { text, query } = this;
    if (!query || !text) return h('span', text || '');

    const q = query.toLowerCase();
    const lower = text.toLowerCase();
    const nodes: (string | VNode)[] = [];
    let lastIndex = 0;

    let idx = lower.indexOf(q, lastIndex);
    while (idx !== -1) {
      if (idx > lastIndex) nodes.push(text.slice(lastIndex, idx));
      nodes.push(h('mark', { class: 'search-highlight' }, text.slice(idx, idx + query.length)));
      lastIndex = idx + query.length;
      idx = lower.indexOf(q, lastIndex);
    }
    if (lastIndex < text.length) nodes.push(text.slice(lastIndex));

    return h('span', nodes.length > 0 ? nodes : [text]);
  },
});
</script>
