# ============================================================
#  dlvault - Windows Setup
#  Pulls the latest image from GHCR and starts the container.
#  No git clone, no docker build, no GitHub token required.
# ============================================================

$ErrorActionPreference = "Continue"
$Host.UI.RawUI.WindowTitle = "dlvault Setup"

$MAIN_IMAGE    = "ghcr.io/dlvault/dlvault:latest"
$UPDATER_IMAGE = "ghcr.io/dlvault/dlvault-updater:latest"

function Write-Step($text) { Write-Host "  [>] $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "  [!] $text" -ForegroundColor Yellow }
function Write-Err($text)  { Write-Host "  [X] $text" -ForegroundColor Red }

function Fail($message) {
    Write-Err $message
    Write-Host ""
    # No pause here: the launcher (setup-windows.bat) pauses on a non-zero exit,
    # so the error stays on screen. A Read-Host here would force a second keypress.
    exit 1
}

# ---- Banner ----
Write-Host ""
Write-Host "  ===============================" -ForegroundColor Cyan
Write-Host "   dlvault - Windows Setup" -ForegroundColor White
Write-Host "  ===============================" -ForegroundColor Cyan
Write-Host ""

# ---- Check Docker ----
$dockerOk = $false
try {
    $v = & docker version --format '{{.Server.Version}}' 2>$null
    if ($LASTEXITCODE -eq 0 -and $v) {
        Write-Step "Docker gefunden (v$v)"
        $dockerOk = $true
    }
} catch {}

if (-not $dockerOk) {
    Write-Err "Docker ist nicht installiert oder laeuft nicht!"
    Write-Host ""
    Write-Host "  1. Docker Desktop installieren:" -ForegroundColor White
    Write-Host "     https://www.docker.com/products/docker-desktop/" -ForegroundColor DarkCyan
    Write-Host "  2. Docker Desktop starten und warten bis es laeuft" -ForegroundColor White
    Write-Host "  3. Dieses Script erneut ausfuehren" -ForegroundColor White
    Fail "Docker wird benoetigt."
}

# ---- Verzeichnisse vorbereiten ----
$installDir = "$env:USERPROFILE\dlvault"
$dataDir    = Join-Path $installDir "data"
$logsDir    = Join-Path $installDir "logs"
$configFile = Join-Path $installDir "paths.conf"

try { New-Item -ItemType Directory -Path $installDir -Force | Out-Null } catch {}
try { New-Item -ItemType Directory -Path $dataDir     -Force | Out-Null } catch {}
try { New-Item -ItemType Directory -Path $logsDir     -Force | Out-Null } catch {}

# ---- Pfade abfragen ----
Write-Host ""
Write-Host "  ===============================" -ForegroundColor Cyan
Write-Host "   Verzeichnisse konfigurieren" -ForegroundColor White
Write-Host "  ===============================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  dlvault braucht Zugriff auf JDownloaders Download-Ordner," -ForegroundColor Gray
Write-Host "  damit fertige Downloads automatisch verschoben werden." -ForegroundColor Gray
Write-Host ""
Write-Host "  WICHTIG: Das ist der Ordner, in den JDownloader fertige Dateien" -ForegroundColor Yellow
Write-Host "  SPEICHERT  --  NICHT der JDownloader-Programm-/Installationsordner!" -ForegroundColor Yellow
Write-Host "  Findest du in JDownloader unter: Einstellungen -> Allgemein ->" -ForegroundColor Gray
Write-Host "  Standard-Download-Ordner." -ForegroundColor Gray
Write-Host ""
Write-Host "  Gib die vollen Windows-Pfade an, z.B.:" -ForegroundColor Gray
Write-Host "    D:\Downloads\JDownloader   (JD-Speicherordner, NICHT der Programmordner)" -ForegroundColor DarkCyan
Write-Host "    D:\Mediathek\Filme" -ForegroundColor DarkCyan
Write-Host "    D:\Mediathek\Serien" -ForegroundColor DarkCyan
Write-Host ""

# Load existing config if available (paths only - token from older versions is ignored).
$savedDownloads  = ""
$savedMovies     = ""
$savedSeries     = ""
$savedKidsMovies = ""
$savedKidsSeries = ""
if (Test-Path $configFile) {
    Get-Content $configFile | ForEach-Object {
        if ($_ -match '^DOWNLOADS=(.+)$')   { $savedDownloads  = $Matches[1] }
        if ($_ -match '^MOVIES=(.+)$')      { $savedMovies     = $Matches[1] }
        if ($_ -match '^SERIES=(.+)$')      { $savedSeries     = $Matches[1] }
        if ($_ -match '^KIDS_MOVIES=(.+)$') { $savedKidsMovies = $Matches[1] }
        if ($_ -match '^KIDS_SERIES=(.+)$') { $savedKidsSeries = $Matches[1] }
    }
}

function Ask-Path($label, $default) {
    if ($default) { $prompt = "  $label [$default]" } else { $prompt = "  $label" }
    $val = Read-Host $prompt
    $val = $val.Trim()
    if (-not $val -and $default) { return $default }
    return $val
}

$pathDownloads = Ask-Path "Download-Verzeichnis = JD-Speicherordner (NICHT Installationsordner!)" $savedDownloads
$pathMovies    = Ask-Path "Film-Verzeichnis (Mediathek/Filme)"        $savedMovies
$pathSeries    = Ask-Path "Serien-Verzeichnis (Mediathek/Serien)"     $savedSeries

Write-Host ""
Write-Host "  Optional: Kinderfilme/-serien per Genre in eigene Ordner trennen" -ForegroundColor Gray
Write-Host "  (z.B. fuer ein eigenes, eingeschraenktes Plex/Jellyfin-Kinderkonto)." -ForegroundColor Gray
Write-Host "  Einfach Enter druecken zum Ueberspringen - dann landet alles wie gewohnt" -ForegroundColor Gray
Write-Host "  in den Hauptverzeichnissen." -ForegroundColor Gray
$pathKidsMovies = Ask-Path "Kinder-Filme-Ordner (optional, leer = aus)"  $savedKidsMovies
$pathKidsSeries = Ask-Path "Kinder-Serien-Ordner (optional, leer = aus)" $savedKidsSeries

# Create missing host directories so Docker can bind-mount them.
$pathsOk = $true
foreach ($entry in @(@("Downloads", $pathDownloads), @("Filme", $pathMovies), @("Serien", $pathSeries))) {
    $name = $entry[0]; $p = $entry[1]
    if (-not $p) {
        Write-Warn "${name}: uebersprungen (leer)"
        continue
    }
    if (-not (Test-Path $p)) {
        Write-Warn "${name}: Verzeichnis '$p' existiert nicht - wird erstellt"
        try {
            New-Item -ItemType Directory -Path $p -Force | Out-Null
            Write-Step "${name}: erstellt"
        } catch {
            Write-Err "${name}: konnte '$p' nicht erstellen!"
            $pathsOk = $false
        }
    } else {
        Write-Step "${name}: OK ($p)"
    }
}

if (-not $pathsOk) {
    Write-Warn "Manche Pfade konnten nicht erstellt werden. Trotzdem fortfahren?"
    $cont = Read-Host "  Weiter? (j/n)"
    if ($cont -ne "j") { Fail "Abgebrochen." }
}

# Optional kids directories - only touched when the user provided a path, and
# no "skipped (empty)" noise when they didn't (separation is off by default).
foreach ($entry in @(@("Kinder-Filme", $pathKidsMovies), @("Kinder-Serien", $pathKidsSeries))) {
    $name = $entry[0]; $p = $entry[1]
    if (-not $p) { continue }
    if (-not (Test-Path $p)) {
        Write-Warn "${name}: Verzeichnis '$p' existiert nicht - wird erstellt"
        try {
            New-Item -ItemType Directory -Path $p -Force | Out-Null
            Write-Step "${name}: erstellt"
        } catch {
            Write-Err "${name}: konnte '$p' nicht erstellen!"
        }
    } else {
        Write-Step "${name}: OK ($p)"
    }
}

# Persist paths for re-runs.
$configLines = @(
    "DOWNLOADS=$pathDownloads"
    "MOVIES=$pathMovies"
    "SERIES=$pathSeries"
    "KIDS_MOVIES=$pathKidsMovies"
    "KIDS_SERIES=$pathKidsSeries"
)
$configLines | Set-Content -Path $configFile -Encoding UTF8
Write-Step "Pfade gespeichert in paths.conf"

# ---- Image pullen ----
Write-Host ""
Write-Step "Lade Image aus der Registry (dauert beim ersten Mal ca. 30s)..."
Write-Host ""

& docker pull $MAIN_IMAGE 2>&1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
    Fail "Image-Pull fehlgeschlagen! (Pruefe Internetverbindung + Docker Desktop)"
}
Write-Step "Image bereit!"

# Updater-Image ziehen wir hier vorab, damit der erste Klick auf "Update" im
# WebUI nicht erst den Pull abwartet. Schlaegt das fehl, ist's nicht kritisch -
# das Backend pullt es beim ersten Update-Click selbst nach.
Write-Step "Lade Updater-Image vor..."
& docker pull $UPDATER_IMAGE 2>&1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
    Write-Warn "Updater-Image konnte nicht vorgeladen werden - wird beim ersten Update-Click nachgeladen."
}

# ---- Container starten ----
Write-Host ""
Write-Step "Starte Container..."

$null = & docker rm -f dlvault 2>&1

$dataDocker = $dataDir -replace '\\', '/'
$logsDocker = $logsDir -replace '\\', '/'

$dockerArgs = @(
    "run", "-d",
    "--name", "dlvault",
    "--restart", "unless-stopped",
    "-p", "3000:3000",
    "-e", "NODE_ENV=production",
    "-e", "PORT=3000",
    "-e", "HOST_DATA_DIR=$dataDocker",
    "-e", "MAIN_CONTAINER=dlvault",
    "-e", "MAIN_IMAGE=$MAIN_IMAGE",
    "-e", "UPDATER_IMAGE=$UPDATER_IMAGE",
    "-v", "${dataDocker}:/app/data",
    "-v", "${logsDocker}:/app/logs",
    # Docker socket so the app can spawn the updater container for one-click updates.
    "-v", "/var/run/docker.sock:/var/run/docker.sock"
)

# Forward an outbound HTTP proxy into the container if the Windows host uses one.
# Corporate / locked-down Windows Server installs often require a proxy for any
# internet access. Without it the container cannot reach Trakt, MyJDownloader or
# plugin sources, and the whole pipeline looks dead with no obvious error. axios
# honours NO_PROXY per request, so anything listed there stays a direct LAN call.
$proxyForwarded = $false
foreach ($pv in @("HTTP_PROXY", "HTTPS_PROXY")) {
    $pval = [Environment]::GetEnvironmentVariable($pv)
    if ($pval) {
        $dockerArgs += "-e"; $dockerArgs += "$pv=$pval"
        $proxyForwarded = $true
    }
}
if ($proxyForwarded) {
    $noProxy = [Environment]::GetEnvironmentVariable("NO_PROXY")
    if (-not $noProxy) {
        # Sensible default so loopback + the Docker host gateway never go through
        # the proxy. NOTE: add your LAN Plex/Jellyfin/JDownloader IPs here too -
        # NO_PROXY matches by host/suffix, not CIDR, so a subnet mask will NOT work.
        $noProxy = "localhost,127.0.0.1,host.docker.internal"
    }
    $dockerArgs += "-e"; $dockerArgs += "NO_PROXY=$noProxy"
    Write-Step "Outbound-Proxy an Container weitergereicht (NO_PROXY: $noProxy)"
}

if ($pathDownloads) {
    $dlDocker = $pathDownloads -replace '\\', '/'
    $dockerArgs += "-v"; $dockerArgs += "${dlDocker}:/downloads"
}
if ($pathMovies) {
    $mvDocker = $pathMovies -replace '\\', '/'
    $dockerArgs += "-v"; $dockerArgs += "${mvDocker}:/movies"
}
if ($pathSeries) {
    $srDocker = $pathSeries -replace '\\', '/'
    $dockerArgs += "-v"; $dockerArgs += "${srDocker}:/series"
}
if ($pathKidsMovies) {
    $kmDocker = $pathKidsMovies -replace '\\', '/'
    $dockerArgs += "-v"; $dockerArgs += "${kmDocker}:/kids_movies"
}
if ($pathKidsSeries) {
    $ksDocker = $pathKidsSeries -replace '\\', '/'
    $dockerArgs += "-v"; $dockerArgs += "${ksDocker}:/kids_series"
}

$dockerArgs += $MAIN_IMAGE

& docker @dockerArgs 2>&1 | Out-Host

if ($LASTEXITCODE -ne 0) {
    Write-Err "Container-Start fehlgeschlagen!"
    $logs = & docker logs dlvault 2>&1
    $logs | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
    Fail "Siehe Logs oben."
}

# ---- Health-Check ----
Write-Host ""
Write-Step "Warte auf Start..."

$healthy = $false
for ($i = 1; $i -le 12; $i++) {
    Start-Sleep -Seconds 5
    $running = & docker ps --filter "name=dlvault" --format "{{.Status}}" 2>$null
    if (-not $running) {
        Write-Err "Container gecrasht!"
        $logs = & docker logs dlvault --tail 20 2>&1
        $logs | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
        Fail "Container startet nicht."
    }
    try {
        $h = Invoke-WebRequest -Uri "http://localhost:3000/api/health" -TimeoutSec 5 -UseBasicParsing -ErrorAction SilentlyContinue
        if ($h.StatusCode -eq 200) { $healthy = $true; break }
    } catch {}
    Write-Host "  Warte... ($i/12)" -ForegroundColor Gray
}

# ---- Apply optional kids paths to dlvault settings ----
# The Docker mount alone is not enough: the genre-based routing only kicks in
# once these settings point at the container mounts (default is empty = off).
if ($healthy -and ($pathKidsMovies -or $pathKidsSeries)) {
    $kidsSettings = @{}
    if ($pathKidsMovies) { $kidsSettings["paths.kids_movies"] = "/kids_movies" }
    if ($pathKidsSeries) { $kidsSettings["paths.kids_series"] = "/kids_series" }
    try {
        $kidsBody = $kidsSettings | ConvertTo-Json -Compress
        Invoke-WebRequest -Uri "http://localhost:3000/api/settings" -Method PUT -ContentType "application/json" -Body $kidsBody -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop | Out-Null
        Write-Step "Kinder-Bibliothek aktiviert (Genre-Trennung nach /kids_movies, /kids_series)"
    } catch {
        Write-Warn "Kinder-Pfade konnten nicht automatisch gesetzt werden: $($_.Exception.Message)"
        Write-Warn "Nachtragbar unter Einstellungen -> Mediathek (Kinder-Bibliothek)."
    }
}

# ---- Verify volume mounts are accessible inside container ----
if ($healthy) {
    try {
        $valResp = Invoke-WebRequest -Uri "http://localhost:3000/api/settings/validate-paths" -Method POST -ContentType "application/json" -Body "{}" -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
        $valResult = $valResp.Content | ConvertFrom-Json

        $mountIssues = @()
        foreach ($key in @("paths.downloads", "paths.movies", "paths.series", "paths.kids_movies", "paths.kids_series")) {
            $val = $valResult.$key
            if (-not $val) { continue }
            if (-not $val.exists) {
                $mountIssues += "  $key -> Volume-Mount fehlt im Container"
            } elseif (-not $val.writable) {
                $mountIssues += "  $key -> nicht beschreibbar (Berechtigungen pruefen!)"
            }
        }

        if ($mountIssues.Count -gt 0) {
            Write-Host ""
            Write-Err "ACHTUNG: Docker Volume-Mount Probleme erkannt!"
            foreach ($issue in $mountIssues) {
                Write-Err $issue
            }
            Write-Host ""
            Write-Warn "Stelle sicher, dass die Windows-Pfade existieren und Docker Desktop darauf zugreifen darf."
            Write-Warn "Docker Desktop -> Settings -> Resources -> File Sharing: Laufwerk freigeben!"
        } else {
            Write-Step "Volume-Mounts verifiziert - alle Verzeichnisse erreichbar"
        }
    } catch {
        Write-Warn "Volume-Mount Pruefung fehlgeschlagen: $($_.Exception.Message)"
    }
}

# ---- Fertig ----
Write-Host ""
if ($healthy) {
    Write-Host "  ===============================" -ForegroundColor Green
    Write-Host "   dlvault laeuft!" -ForegroundColor White
    Write-Host "  ===============================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Oeffne jetzt im Browser:" -ForegroundColor White
    Write-Host "  http://localhost:3000" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Verzeichnisse:" -ForegroundColor Gray
    if ($pathDownloads) { Write-Host "    Downloads: $pathDownloads -> /downloads" -ForegroundColor Gray }
    if ($pathMovies)    { Write-Host "    Filme:     $pathMovies -> /movies"       -ForegroundColor Gray }
    if ($pathSeries)    { Write-Host "    Serien:    $pathSeries -> /series"       -ForegroundColor Gray }
    Write-Host ""
    Write-Host "  Noch einzurichten:" -ForegroundColor Gray
    Write-Host "    - Watchlist (Plex/Trakt)" -ForegroundColor Gray
    Write-Host "    - JDownloader Zugangsdaten" -ForegroundColor Gray
    Write-Host ""
    Start-Process "http://localhost:3000"
} else {
    Write-Warn "Container laeuft, aber Web-UI antwortet noch nicht."
    Write-Host "  Versuche http://localhost:3000 in ein paar Sekunden." -ForegroundColor Gray
    Write-Host ""
    $logs = & docker logs dlvault --tail 10 2>&1
    $logs | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
    Write-Host ""
    # UI not up yet: keep the window open so the logs above stay readable.
    Read-Host "  Druecke Enter zum Beenden"
}

# Clean success: no pause. The window closes by itself once setup is done.
