import { watch, nextTick, onScopeDispose, type Ref } from 'vue';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Body-scroll-lock + focus-trap for modal-style overlays.
 * Pass the visibility ref and a ref to the container element. On open, focus
 * moves into the dialog (unless the dialog already focused something itself);
 * `onEscape`, when given, closes it from anywhere on the page.
 */
export function useModalA11y(
  visible: Readonly<Ref<boolean>>,
  container: Ref<HTMLElement | undefined>,
  options: { onEscape?: () => void } = {},
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
    if (e.key === 'Escape' && options.onEscape) {
      e.preventDefault();
      options.onEscape();
      return;
    }
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
    nextTick(() => {
      const root = container.value;
      if (!root || root.contains(document.activeElement)) return;
      const target = getFocusable()[0] ?? root;
      if (target === root && !root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
      try { target.focus({ preventScroll: true }); } catch { /* detached */ }
    });
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
