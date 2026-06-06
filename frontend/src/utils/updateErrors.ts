/** The updater reports machine codes; the dialog shows them in German. */
const UPDATE_ERRORS: Record<string, string> = {
  missing_confirm_header: 'Update-Anfrage unvollständig — bitte erneut versuchen',
  docker_socket_unreachable: 'Docker ist nicht erreichbar — /var/run/docker.sock fehlt im Container',
  host_data_dir_missing: 'HOST_DATA_DIR ist nicht gesetzt',
  updater_image_unavailable: 'Das Updater-Image konnte nicht geladen werden',
  update_already_running: 'Ein Update läuft bereits',
  start_failed: 'Update konnte nicht gestartet werden',
  healthcheck_failed: 'Die neue Version hat den Health-Check nicht bestanden — die alte läuft weiter',
  pull_failed: 'Das neue Image konnte nicht geladen werden',
  container_start_failed: 'Der neue Container ließ sich nicht starten — die alte Version läuft weiter',
  main_container_not_found: 'Der dlvault-Container wurde nicht gefunden',
  new_image_inspect_failed: 'Das neue Image ist unlesbar — Update abgebrochen',
};
export function updateErrorText(code: string): string {
  const key = code.trim().replace(/ /g, '_');
  if (key.startsWith('unexpected_exit_rc')) return `Updater unerwartet beendet (Code ${key.slice('unexpected_exit_rc'.length) || '?'})`;
  return UPDATE_ERRORS[key] || code.replace(/_/g, ' ');
}
