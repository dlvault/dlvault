import { onMounted, onUnmounted, type Ref } from 'vue';

/**
 * Registers "/" keyboard shortcut to focus a search input.
 * Skips when focus is already in an input/textarea/select.
 */
export function useSearchShortcut(inputRef: Ref<HTMLInputElement | undefined>) {
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) {
      e.preventDefault();
      inputRef.value?.focus();
    }
  }

  onMounted(() => document.addEventListener('keydown', handleKeydown));
  onUnmounted(() => document.removeEventListener('keydown', handleKeydown));
}
