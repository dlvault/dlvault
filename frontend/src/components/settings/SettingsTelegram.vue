<template>
  <ConnectionHero
    name="Telegram Bot"
    mark="TG"
    mark-color="#26a5e4"
    :tint="tgTint"
    :pill-state="tgPillState"
    :pill-label="tgPillLabel"
    :meta="tgMeta"
    testable
    @test="testTelegramConnection"
  />

  <SettingsSection label="Bot">
    <SettingsRow
      label="Aktiv"
      hint="Wenn aus, antwortet der Bot nicht."
      toggle
    >
      <Toggle :model-value="enabled" @update:model-value="setEnabled" />
    </SettingsRow>
    <SettingsRow
      label="Bot Token"
      required
      hint='Erstelle einen Bot bei <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> auf Telegram. <code>/newbot</code>, Namen geben, Token kopieren.'
    >
      <input
        class="sx-input mono"
        type="password"
        placeholder="123456:ABC-DEF..."
        v-model="settings['telegram.bot_token']"
      />
    </SettingsRow>
    <SettingsRow
      label="Erlaubte Chat-IDs"
      hint='Kommagetrennte Liste — z.B. <code>123456,987654</code>. Eigene ID findest du bei <a href="https://t.me/userinfobot" target="_blank" rel="noopener">@userinfobot</a>. Leer = jeder kann den Bot nutzen.'
    >
      <input
        class="sx-input mono"
        type="text"
        placeholder="123456, 987654"
        v-model="settings['telegram.allowed_chat_ids']"
      />
      <div v-if="unrestricted" class="warning-note">
        <strong>Achtung:</strong> Der Bot ist öffentlich zugänglich — jeder, der den Bot findet, kann Downloads auslösen.
      </div>
    </SettingsRow>
  </SettingsSection>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import api from '../../api/index';
import { useSettingsContext } from '../../composables/useSettingsContext';
import { useToast } from '../../composables/useApp';
import ConnectionHero from './ConnectionHero.vue';
import SettingsSection from './SettingsSection.vue';
import SettingsRow from './SettingsRow.vue';
import Toggle from './Toggle.vue';

const { settings, saveAll } = useSettingsContext();
const toast = useToast();

const testingTelegram = ref(false);
const telegramStatus = ref<'ok' | 'error' | ''>('');
const telegramBotName = ref('');

const enabled = computed(() => settings.value['telegram.enabled'] === 'true');
function setEnabled(v: boolean) {
  settings.value['telegram.enabled'] = v ? 'true' : 'false';
}

const unrestricted = computed(() =>
  enabled.value &&
  settings.value['telegram.bot_token'] &&
  settings.value['telegram.bot_token'] !== '' &&
  !settings.value['telegram.allowed_chat_ids']
);

// ── Hero state ─────────────────────────────────────────────
const tgPillState = computed<'ok' | 'err' | 'na' | 'testing'>(() => {
  if (testingTelegram.value) return 'testing';
  if (telegramStatus.value === 'ok') return 'ok';
  if (telegramStatus.value === 'error') return 'err';
  if (!settings.value['telegram.bot_token']) return 'na';
  return 'na';
});
const tgPillLabel = computed(() => {
  if (testingTelegram.value) return 'Teste…';
  if (telegramStatus.value === 'ok') return 'Verbunden';
  if (telegramStatus.value === 'error') return 'Fehler';
  if (!settings.value['telegram.bot_token']) return 'Nicht konfiguriert';
  return 'Nicht getestet';
});
const tgTint = computed(() => {
  if (testingTelegram.value) return 'var(--info)';
  if (telegramStatus.value === 'ok') return 'var(--ok)';
  if (telegramStatus.value === 'error') return 'var(--err)';
  return 'var(--text-3)';
});
const tgMeta = computed(() => {
  const out: { lbl: string; val: string }[] = [];
  if (telegramBotName.value) out.push({ lbl: 'Bot', val: telegramBotName.value });
  if (settings.value['telegram.allowed_chat_ids']) {
    const n = settings.value['telegram.allowed_chat_ids'].split(',').filter(Boolean).length;
    out.push({ lbl: 'Whitelist', val: `${n} Chat${n === 1 ? '' : 's'}` });
  } else if (settings.value['telegram.bot_token']) {
    out.push({ lbl: 'Whitelist', val: 'leer (öffentlich)' });
  }
  return out;
});

async function testTelegramConnection() {
  await saveAll();
  testingTelegram.value = true;
  telegramStatus.value = '';
  try {
    const res = await api.post('/settings/telegram/test');
    if (res.data.success) {
      telegramStatus.value = 'ok';
      telegramBotName.value = '@' + res.data.botName;
      toast.value?.add(`Telegram Bot verbunden: @${res.data.botName}`, 'success');
    } else {
      telegramStatus.value = 'error';
    }
  } catch (e: unknown) {
    telegramStatus.value = 'error';
    const axiosErr = e as { response?: { data?: { error?: string } } };
    toast.value?.add(axiosErr.response?.data?.error || 'Telegram Verbindung fehlgeschlagen', 'error');
  } finally {
    testingTelegram.value = false;
  }
}
</script>

<style scoped>
.warning-note {
  margin-top: 8px;
  font-size: 12.5px;
  color: var(--warn);
  background: rgba(245, 176, 65, 0.08);
  border: 1px solid rgba(245, 176, 65, 0.25);
  border-radius: var(--r-sm);
  padding: 8px 12px;
  line-height: 1.5;
}
.warning-note strong { color: var(--warn); }
</style>
