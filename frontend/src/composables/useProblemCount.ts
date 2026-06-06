import { ref } from 'vue';
import { getProblems } from '../api/index';

/** Errors + warnings, for the sidebar badge. Refreshed every 2 min. */
export const problemCount = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;

async function refresh() {
  try {
    const res = await getProblems();
    problemCount.value = res.data.counts.error + res.data.counts.warning;
  } catch { /* keep the last value */ }
}

export function startProblemCount() {
  if (timer) return;
  refresh();
  timer = setInterval(refresh, 120_000);
}
