# ============================================================
#  dlvault - Windows Update
#  Zieht die neueste Version und baut den Container neu.
# ============================================================

$ErrorActionPreference = "Continue"
$Host.UI.RawUI.WindowTitle = "dlvault Update"

function Write-Step($text) { Write-Host "  [>] $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "  [!] $text" -ForegroundColor Yellow }
function Write-Err($text) { Write-Host "  [X] $text" -ForegroundColor Red }

function Fail($message) {
    Write-Err $message
    Write-Host ""
    Read-Host "  Druecke Enter zum Beenden"
    exit 1
}

Write-Host ""
Write-Host "  ===============================" -ForegroundColor Cyan
Write-Host "   dlvault - Update" -ForegroundColor White
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
    Write-Host "  Bitte Docker Desktop starten und erneut versuchen." -ForegroundColor White
    Fail "Docker wird benoetigt."
}

# Finde das Repo-Verzeichnis
$defaultDir = "$env:USERPROFILE\dlvault\repo"
$scriptDir = Split-Path -Parent $PSScriptRoot

$repoDir = $null
foreach ($candidate in @($defaultDir, $scriptDir, (Join-Path $scriptDir "repo"))) {
    if (Test-Path (Join-Path $candidate ".git")) {
        $repoDir = $candidate
        break
    }
}

if (-not $repoDir) {
    Fail "Repo nicht gefunden! Bitte zuerst setup-windows.bat ausfuehren."
}

$installDir = Split-Path -Parent $repoDir
Write-Step "Repo gefunden: $repoDir"

# Load saved paths from config
$configFile = Join-Path $installDir "paths.conf"
$pathDownloads = ""
$pathMovies = ""
$pathSeries = ""
$ghToken = ""

if (Test-Path $configFile) {
    Get-Content $configFile | ForEach-Object {
        if ($_ -match '^DOWNLOADS=(.+)$') { $pathDownloads = $Matches[1] }
        if ($_ -match '^MOVIES=(.+)$') { $pathMovies = $Matches[1] }
        if ($_ -match '^SERIES=(.+)$') { $pathSeries = $Matches[1] }
        if ($_ -match '^GITHUB_TOKEN=(.+)$') { $ghToken = $Matches[1] }
    }
    Write-Step "Gespeicherte Pfade geladen"
    if ($pathDownloads) { Write-Host "    Downloads: $pathDownloads" -ForegroundColor Gray }
    if ($pathMovies)    { Write-Host "    Filme:     $pathMovies" -ForegroundColor Gray }
    if ($pathSeries)    { Write-Host "    Serien:    $pathSeries" -ForegroundColor Gray }
} else {
    Write-Warn "Keine paths.conf gefunden - Verzeichnisse werden nicht gemountet!"
    Write-Warn "Bitte setup-windows.bat erneut ausfuehren um Pfade zu konfigurieren."
}

Push-Location $repoDir

# Remember current commit before pull
$oldHash = (& git rev-parse --short HEAD 2>$null) | Out-String
$oldHash = $oldHash.Trim()

# Pull (use token for private repo if available)
Write-Step "Lade Updates..."
if ($ghToken) {
    $null = & git -c "http.extraheader=AUTHORIZATION: bearer $ghToken" pull --ff-only 2>&1
} else {
    $null = & git pull --ff-only 2>&1
}
if ($LASTEXITCODE -ne 0) {
    Pop-Location
    Fail "Git pull fehlgeschlagen! Privates Repo - GITHUB_TOKEN in paths.conf gesetzt?"
}

$newHash = (& git rev-parse --short HEAD 2>$null) | Out-String
$newHash = $newHash.Trim()

$needsBuild = ($oldHash -ne $newHash)

if ($needsBuild) {
    Write-Step "Code aktualisiert ($oldHash -> $newHash)"

    # Rebuild
    Write-Step "Baue neues Image..."
    & docker build --build-arg "GIT_COMMIT=$newHash" -t dlvault:latest . 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        Pop-Location
        Fail "Build fehlgeschlagen!"
    }
    Write-Step "Image gebaut ($newHash)"

    # Rebuild updater-image in case its Dockerfile changed
    Write-Step "Updater-Image aktualisieren..."
    & docker build -t dlvault-updater:latest "docker/updater/" 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "Updater-Image-Build fehlgeschlagen - One-Click-Update bleibt evtl. ohne neueste Updater-Logik."
    }
} else {
    Write-Step "Bereits auf dem neuesten Stand ($newHash)"
}

Pop-Location

# Check whether the container is currently running. If no rebuild is needed
# AND the container is already running, there's nothing to do.
$running = & docker ps --filter "name=dlvault" --format "{{.Names}}" 2>$null

if (-not $needsBuild -and $running) {
    Write-Host ""
    Write-Host "  Kein Update noetig - alles aktuell!" -ForegroundColor Green
    Write-Host "  Web-UI: http://localhost:3000" -ForegroundColor Cyan
    Write-Host ""
    Start-Sleep -Seconds 3
    exit 0
}

if (-not $needsBuild) {
    Write-Warn "Container laeuft nicht - starte ihn neu..."
}

# Cleanup old dangling images (only when we just built something)
if ($needsBuild) {
    $dangling = & docker images -f "dangling=true" -q 2>$null
    if ($dangling) {
        Write-Step "Raeume alte Images auf..."
        $null = & docker image prune -f 2>&1
    }
}

# Restart container
Write-Step "Starte Container neu..."
$null = & docker rm -f dlvault 2>&1

$dataDir = Join-Path $installDir "data"
$logsDir = Join-Path $installDir "logs"
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
    # Docker socket so the app can spawn the updater (One-Click-Update from WebUI)
    "-v", "/var/run/docker.sock:/var/run/docker.sock"
)

# Add GitHub token for update check + private-repo pulls
if ($ghToken) {
    $dockerArgs += "-e"
    $dockerArgs += "GITHUB_TOKEN=$ghToken"
}

# Add media path mounts from saved config
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

& docker @dockerArgs 2>&1 | ForEach-Object { "$_" } | Out-Host

if ($LASTEXITCODE -ne 0) {
    Write-Err "Container-Start fehlgeschlagen!"
    $logs = & docker logs dlvault --tail 10 2>&1
    $logs | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
    Write-Host ""
    Read-Host "  Druecke Enter zum Beenden"
    exit 1
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
    Write-Step "Update abgeschlossen!"
    Write-Host ""
    Write-Host "  Web-UI: http://localhost:3000" -ForegroundColor Cyan
} else {
    Write-Warn "Container laeuft, aber Web-UI antwortet noch nicht."
    Write-Host "  Versuche http://localhost:3000 in ein paar Sekunden." -ForegroundColor Gray
}
if ($pathDownloads -or $pathMovies -or $pathSeries) {
    Write-Host ""
    Write-Host "  Gemountete Verzeichnisse:" -ForegroundColor Gray
    if ($pathDownloads) { Write-Host "    Downloads: $pathDownloads -> /downloads" -ForegroundColor Gray }
    if ($pathMovies)    { Write-Host "    Filme:     $pathMovies -> /movies" -ForegroundColor Gray }
    if ($pathSeries)    { Write-Host "    Serien:    $pathSeries -> /series" -ForegroundColor Gray }
}

Write-Host ""
Start-Sleep -Seconds 3
