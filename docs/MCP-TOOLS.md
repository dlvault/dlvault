# dlvault MCP — Werkzeuge

Erzeugt aus der Werkzeug-Liste; nicht von Hand ändern.

## Morgenbericht (`report`)

Liest: was ist über Nacht passiert, Zahlen, Titelliste.

- **status** — Zahlen auf einen Blick: Titel je Status und gestartete Quellen-Suchen (letzte Stunde, 24 h, 7 Tage).
- **morning_report** — Morgenbericht: was in den letzten Stunden geladen wurde, was neu nicht gefunden ist, offene Probleme.
  - `hours` (number) — Zeitraum in Stunden (Vorgabe 24, höchstens 168).
- **list_titles** — Titel auflisten, optional nach Status gefiltert.
  - `status` (string) — Status-Filter.
  - `limit` (number) — Anzahl (Vorgabe 50, höchstens 200).

## Selbstheilung (`heal`)

Probleme erkennen und Titel neu suchen lassen (die Suche selbst macht der Planer).

- **problems** — Alles, was Aufmerksamkeit braucht (wie das Problem-Center), das Schwerste zuerst.
- **retry_title** ✎ schreibt, braucht `confirm: true` — Einen Titel zurück auf „pending“ setzen und den Zähler leeren. Gesucht wird beim nächsten Planer-Lauf, innerhalb des Such-Budgets — nicht sofort.
  - `id` (number, Pflicht) — Titel-ID.

## Bibliothek pflegen (`library`)

Titel als entfernt markieren oder erneut laden lassen.

- **mark_removed** ✎ schreibt, braucht `confirm: true` — Einen Titel als aus der Bibliothek entfernt markieren (löscht keine Dateien).
  - `id` (number, Pflicht) — Titel-ID.
  - `removed` (boolean) — true = entfernt, false = wieder aufheben (Vorgabe true).
- **redownload_title** ✎ schreibt, braucht `confirm: true` — Einen in der Bibliothek fehlenden Titel erneut laden lassen (Reparatur-Markierung + pending). Gesucht wird vom Planer, nicht sofort.
  - `id` (number, Pflicht) — Titel-ID.

