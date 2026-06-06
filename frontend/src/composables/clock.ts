import { ref } from 'vue';
import { setClockSource } from './useFormatters';

/** Ticks every 30 s; timeAgo() reads it so relative times update by themselves. */
export const nowTick = ref(Date.now());

export function startClock(): void {
  setInterval(() => { nowTick.value = Date.now(); }, 30_000);
  setClockSource(() => nowTick.value);
}
