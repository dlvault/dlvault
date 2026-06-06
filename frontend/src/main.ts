import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { startPwa } from './composables/pwaUpdate';
import router from './router/index';
import App from './App.vue';
import { startClock } from './composables/clock';
import './assets/style.css';

startClock();
const app = createApp(App);
app.use(createPinia());
app.use(router);
// After the initial route resolves: App reads ?action=sync (the PWA "Sync"
// shortcut) on mount, and before isReady the route is still the empty start.
// isReady rejects when the first route's chunk is missing — mount anyway, a
// blank page with no shell would be worse than a failed view.
router.isReady().catch(() => { /* mount anyway */ }).then(() => app.mount('#app'));

// After a dlvault update the old hashed chunks are gone: a tab that was open
// for days failed silently on the next lazy view ("Failed to fetch dynamically
// imported module"). Reload once onto the new build; the session flag stops a
// reload loop if the chunk is missing for another reason.
const RELOAD_FLAG = 'dlvault_chunk_reload';
function reloadForNewBuild(target?: string) {
  try {
    if (sessionStorage.getItem(RELOAD_FLAG)) return;
    sessionStorage.setItem(RELOAD_FLAG, '1');
  } catch { /* storage blocked — reload anyway, at worst once per error */ }
  // onError fires before the URL changes: load the TARGET, not the page we leave.
  if (target) window.location.assign(target);
  else window.location.reload();
}
window.addEventListener('vite:preloadError', (e) => { e.preventDefault(); reloadForNewBuild(); });
router.onError((err, to) => {
  if (/dynamically imported module|Importing a module script failed|error loading dynamically/i.test(String(err?.message || err))) {
    reloadForNewBuild(to?.fullPath);
  }
});
// Cleared only once a navigation actually completed, so a chunk that is
// still missing after the reload cannot loop.
router.afterEach((_to, _from, failure) => {
  if (failure) return;
  try { sessionStorage.removeItem(RELOAD_FLAG); } catch { /* ignore */ }
});

startPwa();
