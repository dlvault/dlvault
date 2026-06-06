<template>
  <div class="secret-input">
    <div class="si-field">
      <input
        class="sx-input mono"
        :type="reveal ? 'text' : 'password'"
        autocomplete="new-password"
        spellcheck="false"
        :placeholder="stored ? 'Gespeichert — neuen Wert eingeben zum Ersetzen' : placeholder"
        :value="displayValue"
        @input="onInput(($event.target as HTMLInputElement).value)"
      />
      <button
        v-if="dirty"
        type="button"
        class="si-reveal"
        :aria-label="reveal ? 'Wert verbergen' : 'Wert anzeigen'"
        :title="reveal ? 'Verbergen' : 'Anzeigen'"
        @click="reveal = !reveal"
      >
        <EyeOff v-if="reveal" :size="14" /><Eye v-else :size="14" />
      </button>
    </div>
    <span v-if="dirty" class="si-tag busy"><span class="dot"></span>Wird beim Speichern übernommen</span>
    <span v-else-if="stored" class="si-tag ok"><span class="dot"></span>Konfiguriert</span>
    <span v-else-if="!optional" class="si-tag warn"><span class="dot"></span>Fehlt</span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Eye, EyeOff } from 'lucide-vue-next';

/**
 * Input for secret-typed settings (API keys, tokens, passwords).
 *
 * The backend masks stored secrets as '••••••••' in GET /api/settings, and
 * the old pattern put that mask string straight into a password field. That
 * was triply broken: a stored secret and a freshly typed one looked identical
 * (the field masks anyway), editing the mask by one character saved the
 * mangled mask AS the new secret, and the stored state had no badge.
 *
 * Here the mask never enters the field: stored secret = EMPTY input with an
 * explanatory placeholder + "Konfiguriert" badge. Typing replaces, clearing
 * the field restores "no change" (the remembered mask goes back into the
 * model, so the delta save sends nothing).
 */
const props = withDefaults(defineProps<{
  modelValue?: string;
  placeholder?: string;
  /** Hide the "Fehlt" badge for secrets that are genuinely optional. */
  optional?: boolean;
}>(), { modelValue: '', placeholder: 'API key / token', optional: false });

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const MASK_RE = /^[•]+$/;
const reveal = ref(false);

// The exact mask string the backend sent — restored when the field is cleared
// so "emptied the input" means "keep the stored secret", not "wipe it".
const knownMask = ref<string | null>(MASK_RE.test(props.modelValue) ? props.modelValue : null);
watch(() => props.modelValue, v => {
  if (v && MASK_RE.test(v)) {
    knownMask.value = v;
    reveal.value = false;
  }
});

const stored = computed(() => !!props.modelValue && MASK_RE.test(props.modelValue));
const dirty = computed(() => !!props.modelValue && !MASK_RE.test(props.modelValue));
const displayValue = computed(() => (stored.value ? '' : props.modelValue));

function onInput(v: string) {
  if (v === '') {
    reveal.value = false;
    emit('update:modelValue', knownMask.value ?? '');
    return;
  }
  emit('update:modelValue', v);
}
</script>

<style scoped>
.secret-input {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.si-field { position: relative; display: flex; }
.si-field .sx-input { width: 100%; }
.si-field:has(.si-reveal) .sx-input { padding-right: 38px; }
.si-reveal {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 6px;
  border: none;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  border-radius: var(--r-sm);
  transition: color 0.15s;
}
.si-reveal:hover { color: var(--text-primary); }

.si-tag {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px 3px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
}
.si-tag .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.si-tag.ok {
  color: var(--ok);
  border: 1px solid color-mix(in srgb, var(--ok) 30%, transparent);
  background: color-mix(in srgb, var(--ok) 8%, transparent);
}
.si-tag.ok .dot { box-shadow: 0 0 6px currentColor; }
.si-tag.warn {
  color: var(--warn);
  border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent);
  background: color-mix(in srgb, var(--warn) 8%, transparent);
}
.si-tag.busy {
  color: var(--accent-2);
  border: 1px solid color-mix(in srgb, var(--accent-2) 30%, transparent);
  background: color-mix(in srgb, var(--accent-2) 8%, transparent);
}
</style>
