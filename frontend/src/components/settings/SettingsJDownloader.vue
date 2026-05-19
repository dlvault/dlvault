<template>
  <ConnectionHero
    name="JDownloader"
    mark="JD"
    mark-color="#ff8800"
    :tint="tint"
    :pill-state="pillState"
    :pill-label="pillLabel"
    :meta="meta"
    testable
    @test="testJD"
  />

  <SettingsSection label="Authentication">
    <SettingsRow
      label="E-Mail"
      required
      hint="Login-E-Mail deines MyJDownloader-Accounts."
      :error="errors['jdownloader.email']"
    >
      <input
        class="sx-input"
        type="email"
        placeholder="myjdownloader@email.com"
        v-model="settings['jdownloader.email']"
        @blur="validateEmail('jdownloader.email')"
        :class="{ error: errors['jdownloader.email'] }"
      />
    </SettingsRow>
    <SettingsRow
      label="Passwort"
      required
      hint="Wird verschlüsselt gespeichert."
    >
      <input
        class="sx-input"
        type="password"
        placeholder="••••••••"
        v-model="settings['jdownloader.password']"
      />
    </SettingsRow>
    <SettingsRow
      label="Gerätename"
      hint='Leer = erstes Gerät im Account. Beispiel: <code>JDownloader@Unraid</code>'
    >
      <input
        class="sx-input mono"
        type="text"
        placeholder="JDownloader@Unraid"
        v-model="settings['jdownloader.device_name']"
      />
    </SettingsRow>
  </SettingsSection>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { getJDownloaderStatus, testJDownloader } from '../../api/index';
import type { JDStatus } from '../../types/index';
import { useSettingsContext } from '../../composables/useSettingsContext';
import { useToast } from '../../composables/useApp';
import ConnectionHero from './ConnectionHero.vue';
import SettingsSection from './SettingsSection.vue';
import SettingsRow from './SettingsRow.vue';

const { settings, errors, saveAll, loadSettings, validateEmail } = useSettingsContext();
const toast = useToast();

const jdStatus = ref<JDStatus>({ configured: false, connected: false, devices: [] });
const testing = ref(false);

const pillState = computed<'ok' | 'err' | 'na' | 'testing'>(() => {
  if (testing.value) return 'testing';
  if (jdStatus.value.connected) return 'ok';
  if (jdStatus.value.configured) return 'err';
  return 'na';
});
const pillLabel = computed(() => {
  if (testing.value) return 'Teste…';
  if (jdStatus.value.connected) return 'Verbunden';
  if (jdStatus.value.configured) return 'Nicht verbunden';
  return 'Nicht konfiguriert';
});
const tint = computed(() => {
  if (testing.value) return 'var(--info)';
  if (jdStatus.value.connected) return 'var(--ok)';
  if (jdStatus.value.configured) return 'var(--err)';
  return 'var(--text-3)';
});
const meta = computed(() => {
  const out: { lbl: string; val: string }[] = [];
  const devName = jdStatus.value.devices?.[0]?.name;
  out.push({ lbl: 'Gerät', val: devName || (settings.value['jdownloader.device_name'] || 'auto') });
  out.push({ lbl: 'Verbindungstyp', val: 'MyJDownloader API' });
  if (jdStatus.value.devices.length > 1) {
    out.push({ lbl: 'Geräte', val: String(jdStatus.value.devices.length) });
  }
  return out;
});

async function testJD() {
  testing.value = true;
  await saveAll();
  try {
    const res = await testJDownloader();
    if (res.data.success) {
      toast.value?.add(`JDownloader verbunden! ${res.data.devices.length} Gerät(e) gefunden.`, 'success');
      await loadSettings();
      jdStatus.value = { configured: true, connected: true, devices: res.data.devices };
    }
  } catch (e: unknown) {
    const axiosErr = e as { response?: { data?: { error?: string } } };
    toast.value?.add(axiosErr.response?.data?.error || 'JDownloader Verbindung fehlgeschlagen', 'error');
  } finally {
    testing.value = false;
  }
}

onMounted(async () => {
  const res = await getJDownloaderStatus().catch(() => ({ data: { configured: false, connected: false, devices: [] } }));
  jdStatus.value = res.data;
});
</script>
