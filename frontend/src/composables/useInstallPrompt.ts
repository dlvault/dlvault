import { ref } from 'vue';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// Persisted across sessions AND across the browser-tab vs installed-app contexts,
// so a user who already installed is never re-prompted — even when they open
// dlvault in a plain browser tab (where display-mode is not standalone).
const INSTALLED_KEY = 'pwa-installed';
// "Dismiss" is a snooze, stored as an expiry timestamp. sessionStorage cleared on
// every launch, which is why the banner used to reappear every single time.
const DISMISS_UNTIL_KEY = 'pwa-install-dismiss-until';
const DISMISS_DAYS = 30;

const deferredPrompt = ref<BeforeInstallPromptEvent | null>(null);
const isInstallable = ref(false);
const isInstalled = ref(detectInstalled());
const dismissed = ref(isSnoozed());

function detectStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

function detectInstalled(): boolean {
  if (localStorage.getItem(INSTALLED_KEY) === '1') return true;
  // Running standalone is proof of install — persist it so the browser-tab
  // context learns about it too on the next visit.
  if (detectStandalone()) {
    localStorage.setItem(INSTALLED_KEY, '1');
    return true;
  }
  return false;
}

function isSnoozed(): boolean {
  return Date.now() < Number(localStorage.getItem(DISMISS_UNTIL_KEY) || 0);
}

function markInstalled() {
  localStorage.setItem(INSTALLED_KEY, '1');
  isInstalled.value = true;
  isInstallable.value = false;
  deferredPrompt.value = null;
}

// Only arm the banner if we don't already know we're installed.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt.value = e as BeforeInstallPromptEvent;
  if (!isInstalled.value) isInstallable.value = true;
});

window.addEventListener('appinstalled', markInstalled);

// If the launch mode flips to standalone while open, treat as installed.
window.matchMedia('(display-mode: standalone)')
  .addEventListener?.('change', (e) => { if (e.matches) markInstalled(); });

// Best-effort: Chrome can confirm the installed PWA even from a browser tab.
const navRelated = navigator as Navigator & { getInstalledRelatedApps?: () => Promise<unknown[]> };
navRelated.getInstalledRelatedApps?.()
  .then((apps) => { if (apps && apps.length > 0) markInstalled(); })
  .catch(() => { /* unsupported / not permitted — the localStorage flag covers it */ });

export function useInstallPrompt() {
  async function install() {
    if (!deferredPrompt.value) return false;
    await deferredPrompt.value.prompt();
    const { outcome } = await deferredPrompt.value.userChoice;
    if (outcome === 'accepted') markInstalled();
    return outcome === 'accepted';
  }

  function dismiss() {
    isInstallable.value = false;
    dismissed.value = true;
    localStorage.setItem(DISMISS_UNTIL_KEY, String(Date.now() + DISMISS_DAYS * 24 * 60 * 60 * 1000));
  }

  return {
    isInstallable,
    isInstalled,
    install,
    dismiss,
    dismissed,
  };
}
