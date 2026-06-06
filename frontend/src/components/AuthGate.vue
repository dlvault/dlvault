<template>
  <!--
    Shown only on instances started with API_TOKEN. The server rejects every
    /api call until this browser exchanges the token for its session cookie, so
    without this dialog a token-protected instance would simply look broken.
  -->
  <div v-if="visible" class="auth-overlay" role="dialog" aria-modal="true" aria-labelledby="auth-title">
    <div class="auth-card">
      <div class="auth-icon"><Lock :size="22" /></div>
      <h2 id="auth-title">Zugriffstoken erforderlich</h2>
      <p class="auth-sub">
        Diese dlvault-Instanz läuft mit <code>API_TOKEN</code>. Einmalig eintragen —
        danach merkt sich der Browser die Anmeldung.
      </p>

      <form @submit.prevent="submit">
        <input
          ref="input"
          v-model="token"
          type="password"
          class="auth-input"
          placeholder="API-Token"
          autocomplete="current-password"
          :disabled="busy"
        />
        <p v-if="error" class="auth-error">{{ error }}</p>
        <button type="submit" class="auth-btn" :disabled="busy || !token">
          {{ busy ? 'Prüfe…' : 'Anmelden' }}
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import { Lock } from 'lucide-vue-next';
import { authRequired, authLogin } from '../api/index';

const visible = authRequired;
const token = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const input = ref<HTMLInputElement | null>(null);

watch(visible, async (v) => {
  if (!v) return;
  await nextTick();
  input.value?.focus();
});

async function submit() {
  if (!token.value || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    await authLogin(token.value);
    token.value = '';
    authRequired.value = false;
    // Every store fetched against a 401 while locked out — reload so the whole
    // app re-fetches with the cookie in place rather than patching each store.
    window.location.reload();
  } catch (e: any) {
    error.value = e?.response?.status === 429
      ? 'Zu viele Versuche. Bitte 15 Minuten warten.'
      : 'Token abgelehnt.';
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.auth-overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(8px);
}
.auth-card {
  width: 100%;
  max-width: 380px;
  padding: 28px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  text-align: center;
}
.auth-icon {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  margin: 0 auto 14px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--accent-2) 14%, transparent);
  color: var(--accent-2);
}
.auth-card h2 { margin: 0 0 8px; font-size: 18px; font-weight: 600; color: var(--text-primary); }
.auth-sub { margin: 0 0 18px; font-size: 13px; line-height: 1.5; color: var(--text-2); }
.auth-sub code { font-family: var(--font-mono); font-size: 12px; }
.auth-input {
  width: 100%;
  padding: 10px 12px;
  font-size: 14px;
  color: var(--text-primary);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
}
.auth-input:focus { outline: none; border-color: var(--accent-2); }
.auth-error { margin: 10px 0 0; font-size: 12.5px; color: var(--danger, #e5484d); }
.auth-btn {
  width: 100%;
  margin-top: 14px;
  padding: 10px 12px;
  font-size: 14px;
  font-weight: 500;
  color: var(--bg);
  background: var(--text-primary);
  border: none;
  border-radius: var(--r-md);
  cursor: pointer;
}
.auth-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
