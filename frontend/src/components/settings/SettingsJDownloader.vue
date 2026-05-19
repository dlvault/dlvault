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
      :error="jdDeviceError"
    >
      <input
        class="sx-input mono"
        type="text"
        list="jd-devices"
        placeholder="JDownloader@Unraid"
        v-model="settings['jdownloader.device_name']"
      />
      <datalist id="jd-devices">
        <option v-for="d in jdStatus.devices" :key="d.name" :value="d.name" />
      </datalist>
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
// Configured device name was set but matched no real device → downloads will
// silently never reach JD. Shown as an inline error so the green "connected"
// badge can't give false confidence (the friend's 2-instance "@Windows" bug).
const jdDeviceError = computed(() =>
  jdStatus.value.connected
    && !!jdStatus.value.deviceNameConfigured
    && !jdStatus.value.selectedDevice
    ? `Gerät „${jdStatus.value.deviceNameConfigured}" nicht gefunden. Verfügbar: ${jdStatus.value.devices.map(d => d.name).join(', ')}`
    : '',
);

const meta = computed(() => {
  const out: { lbl: string; val: string }[] = [];
  // The device that will actually be driven (tolerant match from the backend),
  // not just devices[0] — those can differ when several instances share an account.
  const devName = jdStatus.value.selectedDevice
    || settings.value['jdownloader.device_name']
    || jdStatus.value.devices?.[0]?.name;
  out.push({ lbl: 'Gerät', val: devName || 'auto' });
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
      jdStatus.value = {
        configured: true,
        connected: true,
        devices: res.data.devices,
        deviceNameConfigured: res.data.deviceNameConfigured,
        selectedDevice: res.data.selectedDevice,
      };
      if (jdStatus.value.deviceNameConfigured && !jdStatus.value.selectedDevice) {
        toast.value?.add(
          `Achtung: Gerät „${jdStatus.value.deviceNameConfigured}" ist keiner der ${res.data.devices.length} gefundenen Instanzen — Downloads würden NICHT ankommen. Verfügbar: ${res.data.devices.map((d: { name: string }) => d.name).join(', ')}`,
          'error',
        );
      }
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
