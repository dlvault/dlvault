import { ref, onMounted } from 'vue';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const deferredPrompt = ref<BeforeInstallPromptEvent | null>(null);
const isInstallable = ref(false);
const isInstalled = ref(false);

// Check if already installed (standalone mode)
function checkInstalled() {
  isInstalled.value =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
}

// Listen for the browser's install prompt
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt.value = e as BeforeInstallPromptEvent;
  isInstallable.value = true;
});

window.addEventListener('appinstalled', () => {
  deferredPrompt.value = null;
  isInstallable.value = false;
  isInstalled.value = true;
});

export function useInstallPrompt() {
  onMounted(checkInstalled);

  async function install() {
    if (!deferredPrompt.value) return false;
    await deferredPrompt.value.prompt();
    const { outcome } = await deferredPrompt.value.userChoice;
    if (outcome === 'accepted') {
      deferredPrompt.value = null;
      isInstallable.value = false;
    }
    return outcome === 'accepted';
  }

  function dismiss() {
    isInstallable.value = false;
    sessionStorage.setItem('pwa-install-dismissed', '1');
  }

  const wasDismissed = sessionStorage.getItem('pwa-install-dismissed') === '1';

  return {
    isInstallable,
    isInstalled,
    install,
    dismiss,
    wasDismissed,
  };
}
