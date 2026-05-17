# ============================================================
#  dlvault - Windows Setup
#  Klont das Repo, baut das Image, startet den Container.
# ============================================================

$ErrorActionPreference = "Continue"
$Host.UI.RawUI.WindowTitle = "dlvault Setup"

$REPO_URL = "https://github.com/dlvault/dlvault.git"

function Write-Step($text) { Write-Host "  [>] $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "  [!] $text" -ForegroundColor Yellow }
function Write-Err($text) { Write-Host "  [X] $text" -ForegroundColor Red }

function Fail($message) {
    Write-Err $message
    Write-Host ""
    Read-Host "  Druecke Enter zum Beenden"
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

# ---- Check Git ----
$gitOk = $false
try {
    $gv = & git --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $gv) {
        Write-Step "Git gefunden"
        $gitOk = $true
    }
} catch {}

if (-not $gitOk) {
    Write-Err "Git ist nicht installiert!"
    Write-Host "  https://git-scm.com/download/win" -ForegroundColor DarkCyan
    Fail "Git wird benoetigt."
}

# ---- Clone/Pull ----
$installDir = "$env:USERPROFILE\dlvault"
$repoDir = Join-Path $installDir "repo"
$dataDir = Join-Path $installDir "data"
$logsDir = Join-Path $installDir "logs"
$configFile = Join-Path $installDir "paths.conf"

# Load existing token early so it can authenticate the clone/pull on a private repo.
$earlyToken = ""
if (Test-Path $configFile) {
    Get-Content $configFile | ForEach-Object {
        if ($_ -match '^GITHUB_TOKEN=(.+)$') { $earlyToken = $Matches[1] }
    }
}

if (Test-Path (Join-Path $repoDir ".git")) {
    Write-Step "Repo existiert, aktualisiere..."
    Push-Location $repoDir
    if ($earlyToken) {
        $null = & git -c "http.extraheader=AUTHORIZATION: bearer $earlyToken" pull --ff-only 2>&1
    } else {
        $null = & git pull --ff-only 2>&1
    }
    Pop-Location
} else {
    Write-Step "Klone Repository..."
    if (-not (Test-Path $installDir)) {
        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    }
    if ($earlyToken) {
        $cloneUrl = $REPO_URL -replace 'https://', "https://x-access-token:$earlyToken@"
        $null = & git clone $cloneUrl $repoDir 2>&1
        # Strip token from remote URL so it doesn't sit in plain text inside .git/config.
        if ($LASTEXITCODE -eq 0) {
            & git -C $repoDir remote set-url origin $REPO_URL 2>$null | Out-Null
        }
    } else {
        $null = & git clone $REPO_URL $repoDir 2>&1
    }
    if ($LASTEXITCODE -ne 0) {
        Fail "Git clone fehlgeschlagen! Privates Repo - hast du einen GITHUB_TOKEN in paths.conf und Zugriff auf das Repository?"
    }
}
Write-Step "Repository OK"

# ---- Verzeichnisse ----
try { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null } catch {}
try { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null } catch {}

# ---- Pfade abfragen ----
Write-Host ""
Write-Host "  ===============================" -ForegroundColor Cyan
Write-Host "   Verzeichnisse konfigurieren" -ForegroundColor White
Write-Host "  ===============================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  dlvault braucht Zugriff auf deine Verzeichnisse," -ForegroundColor Gray
Write-Host "  damit fertige Downloads automatisch verschoben werden." -ForegroundColor Gray
Write-Host ""
Write-Host "  Gib die vollen Windows-Pfade an, z.B.:" -ForegroundColor Gray
Write-Host "    D:\Downloads\JDownloader" -ForegroundColor DarkCyan
Write-Host "    D:\Mediathek\Filme" -ForegroundColor DarkCyan
Write-Host "    D:\Mediathek\Serien" -ForegroundColor DarkCyan
Write-Host ""

# Load existing config if available
$savedDownloads = ""
$savedMovies = ""
$savedSeries = ""
$savedGhToken = ""
if (Test-Path $configFile) {
    Get-Content $configFile | ForEach-Object {
        if ($_ -match '^DOWNLOADS=(.+)$') { $savedDownloads = $Matches[1] }
        if ($_ -match '^MOVIES=(.+)$') { $savedMovies = $Matches[1] }
        if ($_ -match '^SERIES=(.+)$') { $savedSeries = $Matches[1] }
        if ($_ -match '^GITHUB_TOKEN=(.+)$') { $savedGhToken = $Matches[1] }
    }
}

function Ask-Path($label, $default) {
    if ($default) {
        $prompt = "  $label [$default]"
    } else {
        $prompt = "  $label"
    }
    $input = Read-Host $prompt
    $input = $input.Trim()
    if (-not $input -and $default) { return $default }
    if (-not $input) { return "" }
    return $input
}

$pathDownloads = Ask-Path "Download-Verzeichnis (JDownloader Output)" $savedDownloads
$pathMovies = Ask-Path "Film-Verzeichnis (Mediathek/Filme)" $savedMovies
$pathSeries = Ask-Path "Serien-Verzeichnis (Mediathek/Serien)" $savedSeries

Write-Host ""
Write-Host "  ===============================" -ForegroundColor Cyan
Write-Host "   Update-Check (optional)" -ForegroundColor White
Write-Host "  ===============================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Fuer automatische Update-Benachrichtigungen wird ein" -ForegroundColor Gray
Write-Host "  GitHub Token benoetigt (privates Repo)." -ForegroundColor Gray
Write-Host "  Erstelle einen unter: github.com/settings/tokens" -ForegroundColor Gray
Write-Host "  Scope: nur 'repo' (read) reicht." -ForegroundColor Gray
Write-Host "  Leer lassen um zu ueberspringen." -ForegroundColor Gray
Write-Host ""
$ghToken = Ask-Path "GitHub Token" $savedGhToken

# Validate paths
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

# Save paths for update script
$configLines = @(
    "DOWNLOADS=$pathDownloads"
    "MOVIES=$pathMovies"
    "SERIES=$pathSeries"
)
if ($ghToken) { $configLines += "GITHUB_TOKEN=$ghToken" }
$configLines | Set-Content -Path $configFile -Encoding UTF8
Write-Step "Pfade gespeichert in paths.conf"

# ---- Image bauen ----
Write-Host ""
Write-Step "Baue Docker-Image (dauert beim ersten Mal ca. 3-5 Min)..."
Write-Host ""

Push-Location $repoDir
$gitHash = (& git rev-parse --short HEAD 2>$null) | Out-String
$gitHash = $gitHash.Trim()
& docker build --build-arg "GIT_COMMIT=$gitHash" -t dlvault:latest . 2>&1 | ForEach-Object { Write-Host $_ }
$buildExit = $LASTEXITCODE
Pop-Location

if ($buildExit -ne 0) {
    Fail "Build fehlgeschlagen! (Exit-Code: $buildExit)"
}
Write-Step "Image gebaut!"

# ---- Updater-Image bauen (fuer One-Click-Update aus dem WebUI) ----
Write-Host ""
Write-Step "Baue Updater-Image..."
Push-Location $repoDir
& docker build -t dlvault-updater:latest "docker/updater/" 2>&1 | ForEach-Object { Write-Host $_ }
$updaterExit = $LASTEXITCODE
Pop-Location
if ($updaterExit -ne 0) {
    Write-Warn "Updater-Image konnte nicht gebaut werden. One-Click-Update steht nicht zur Verfuegung,"
    Write-Warn "der Banner zeigt dann weiter den Copy-Paste-Befehl an."
} else {
    Write-Step "Updater-Image bereit!"
}

# ---- Container starten ----
Write-Host ""
Write-Step "Starte Container..."

$null = & docker rm -f dlvault 2>&1

$dataDocker = $dataDir -replace '\\', '/'
$logsDocker = $logsDir -replace '\\', '/'
$repoDocker = $repoDir -replace '\\', '/'

# Build docker run arguments
$dockerArgs = @(
    "run", "-d",
    "--name", "dlvault",
    "--restart", "unless-stopped",
    "-p", "3000:3000",
    "-e", "NODE_ENV=production",
    "-e", "PORT=3000",
    "-e", "HOST_REPO_DIR=${repoDocker}",
    "-e", "HOST_DATA_DIR=${dataDocker}",
    "-e", "MAIN_CONTAINER=dlvault",
    "-e", "MAIN_IMAGE=dlvault:latest",
    "-e", "UPDATER_IMAGE=dlvault-updater:latest",
    "-v", "${dataDocker}:/app/data",
    "-v", "${logsDocker}:/app/logs",
    # Docker socket so the app can spawn the updater container (One-Click-Update)
    "-v", "/var/run/docker.sock:/var/run/docker.sock"
)

# Add GitHub token for update check + private-repo pulls
if ($ghToken) {
    $dockerArgs += "-e"
    $dockerArgs += "GITHUB_TOKEN=$ghToken"
}

# Add media path mounts
if ($pathDownloads) {
    $dlDocker = $pathDownloads -replace '\\', '/'
    $dockerArgs += "-v"
    $dockerArgs += "${dlDocker}:/downloads"
}
if ($pathMovies) {
    $mvDocker = $pathMovies -replace '\\', '/'
    $dockerArgs += "-v"
    $dockerArgs += "${mvDocker}:/movies"
}
if ($pathSeries) {
    $srDocker = $pathSeries -replace '\\', '/'
    $dockerArgs += "-v"
    $dockerArgs += "${srDocker}:/series"
}

$dockerArgs += "dlvault:latest"

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

# ---- Verify volume mounts are accessible inside container ----
if ($healthy) {
    try {
        $valResp = Invoke-WebRequest -Uri "http://localhost:3000/api/settings/validate-paths" -Method POST `
            -ContentType "application/json" -Body "{}" -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
        $valResult = $valResp.Content | ConvertFrom-Json

        $mountIssues = @()
        foreach ($key in @("paths.downloads", "paths.movies", "paths.series")) {
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
    if ($pathMovies)    { Write-Host "    Filme:     $pathMovies -> /movies" -ForegroundColor Gray }
    if ($pathSeries)    { Write-Host "    Serien:    $pathSeries -> /series" -ForegroundColor Gray }
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
}

Write-Host ""
Read-Host "  Druecke Enter zum Beenden"
