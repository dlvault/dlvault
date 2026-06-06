import { watch, onScopeDispose, type Ref } from 'vue';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Body-scroll-lock + focus-trap for modal-style overlays.
 * Pass the visibility ref and a ref to the container element.
 */
export function useModalA11y(
  visible: Ref<boolean>,
  container: Ref<HTMLElement | undefined>,
) {
  let prevOverflow = '';
  let prevActiveElement: HTMLElement | null = null;
  let active = false;

  function getFocusable(): HTMLElement[] {
    const root = container.value;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Tab') return;
    const focusables = getFocusable();
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const current = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (current === first || !container.value?.contains(current)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (current === last || !container.value?.contains(current)) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function activate() {
    if (active) return;
    active = true;
    prevActiveElement = document.activeElement as HTMLElement | null;
    prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeydown);
  }

  function deactivate() {
    if (!active) return;
    active = false;
    document.body.style.overflow = prevOverflow;
    document.removeEventListener('keydown', onKeydown);
    if (prevActiveElement && typeof prevActiveElement.focus === 'function') {
      try { prevActiveElement.focus(); } catch { /* element gone */ }
    }
    prevActiveElement = null;
  }

  watch(visible, (now, before) => {
    if (now && !before) activate();
    else if (!now && before) deactivate();
  }, { immediate: true });

  onScopeDispose(deactivate);
}
