/**
 * What to tell the user about a failed API call: the server's own (German)
 * words when it sent any — `error` or `message`, both are used — "Server nicht
 * erreichbar" when there was no answer at all, else the caller's fallback.
 * Never axios' English ("Request failed with status code 400").
 */
export function apiMessage(e: unknown, fallback: string): string {
  const err = e as { response?: { data?: { error?: unknown; message?: unknown } }; request?: unknown };
  const d = err?.response?.data;
  if (d && typeof d.error === 'string' && d.error) return d.error;
  if (d && typeof d.message === 'string' && d.message) return d.message;
  if (err && !err.response && err.request) return 'Server nicht erreichbar';
  return fallback;
}
