import { registerSW } from 'virtual:pwa-register';

/**
 * Service worker in autoUpdate mode: a new build takes over and the page
 * reloads onto it. (A prompt-based banner was tried and dropped: tabs still
 * running the old client never activated the waiting worker, and a reload right
 * after the one-click update came back on the old UI.) Unsaved settings are
 * still protected — Settings asks before the page unloads.
 */
let registration: ServiceWorkerRegistration | undefined;

export function startPwa(): void {
  registerSW({
    immediate: true,
    onRegisteredSW(_url, reg) {
      registration = reg;
      if (!reg) return;
      // Look for a new build hourly and whenever the tab comes back — the UI
      // stays open for days and the browser only checks on navigation.
      const check = () => { reg.update().catch(() => { /* offline */ }); };
      setInterval(check, 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    },
  });
}

/**
 * After the one-click update: fetch the new service worker first. It takes
 * over and reloads the page by itself; a plain reload before that would serve
 * the old cached UI. Falls back to a reload after a few seconds.
 */
export async function applyUpdate(): Promise<void> {
  const fallback = setTimeout(() => window.location.reload(), 6000);
  try {
    if (registration) await registration.update();
    if (!registration?.installing && !registration?.waiting) {
      clearTimeout(fallback);
      window.location.reload();
    }
  } catch {
    clearTimeout(fallback);
    window.location.reload();
  }
}
