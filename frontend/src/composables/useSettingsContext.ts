import { inject, type Ref } from 'vue';

export const SETTINGS_KEY = Symbol('settings');
export const ERRORS_KEY = Symbol('errors');
export const SAVE_KEY = Symbol('saveAll');
export const RELOAD_KEY = Symbol('loadSettings');

export function useSettingsContext() {
  const settings = inject<Ref<Record<string, string>>>(SETTINGS_KEY)!;
  const errors = inject<Ref<Record<string, string>>>(ERRORS_KEY)!;
  const saveAll = inject<() => Promise<void>>(SAVE_KEY)!;
  const loadSettings = inject<() => Promise<void>>(RELOAD_KEY)!;

  function validateUrl(key: string) {
    const val = settings.value[key];
    if (val && !/^https?:\/\/.+/.test(val)) {
      errors.value[key] = 'Muss mit http:// oder https:// beginnen';
    } else {
      delete errors.value[key];
    }
  }

  function validateEmail(key: string) {
    const val = settings.value[key];
    if (val && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
      errors.value[key] = 'Keine gültige E-Mail-Adresse';
    } else {
      delete errors.value[key];
    }
  }

  return { settings, errors, saveAll, loadSettings, validateUrl, validateEmail };
}
