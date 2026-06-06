import type { InjectionKey, Ref } from 'vue';

/** The enclosing SettingsRow's label, for controls that have no text of their own. */
export const ROW_LABEL_KEY: InjectionKey<Ref<string>> = Symbol('settingsRowLabel');
