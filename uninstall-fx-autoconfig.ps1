#Requires -Version 5.1
$ErrorActionPreference = "Stop"

# Removes the fx-autoconfig setup that previous palefox versions left in place.
# See uninstall-fx-autoconfig.sh header for full rationale.
#
# What it does:
#   1. Backs up user.js to user.js.bak.<timestamp>
#   2. Backs up <profile>\chrome\utils\ to chrome.utils.bak.<timestamp>\
#   3. Removes <install-root>\config.js + defaults\pref\config-prefs.js (admin)
#   4. Removes <profile>\chrome\utils\
#   5. Strips userChromeJS.enabled line from user.js
#
# What it does NOT touch:
#   - chrome\JS\, chrome\CSS\, userChrome.css, etc. — your files, your call.
#   - Other prefs in user.js — strip manually if desired.

$useLibrewolf = $false
foreach ($arg in $args) {
    switch ($arg) {
        "--librewolf" { $useLibrewolf = $true }
        "--help" {
            Get-Content $PSCommandPath | Select-Object -First 18 | Select-Object -Skip 2
            exit 0
        }
        default { Write-Error "Unknown option: $arg"; exit 1 }
    }
}

if ($useLibrewolf) {
    $browserName = "LibreWolf"
    $browserProcess = "librewolf"
    $profilePattern = "*.default-default"
    $profilesDir = Join-Path $env:APPDATA "librewolf\Profiles"
    $appDir = (Get-ItemProperty "HKLM:\SOFTWARE\LibreWolf" -ErrorAction SilentlyContinue).InstallDirectory
    if (-not $appDir) { $appDir = "${env:ProgramFiles}\LibreWolf" }
} else {
    $browserName = "Firefox"
    $browserProcess = "firefox"
    $profilePattern = "*.default-release"
    $profilesDir = Join-Path $env:APPDATA "Mozilla\Firefox\Profiles"
    $appDir = (Get-ItemProperty "HKLM:\SOFTWARE\Mozilla\Mozilla Firefox" -ErrorAction SilentlyContinue).InstallDirectory
    if (-not $appDir) { $appDir = "${env:ProgramFiles}\Mozilla Firefox" }
}

if (Get-Process $browserProcess -ErrorAction SilentlyContinue) {
    Write-Host "$browserName is currently running. Please close it before continuing."
    Read-Host "Press Enter to continue after closing $browserName"
}

if (-not (Test-Path $profilesDir)) {
    Write-Error "$browserName profile directory not found at $profilesDir"; exit 1
}

$profiles = Get-ChildItem -Path $profilesDir -Directory -Filter $profilePattern 2>$null
if (-not $profiles) {
    Write-Error "No $browserName profile matching $profilePattern"; exit 1
}

if ($profiles.Count -eq 1) {
    $profile = $profiles[0]
} else {
    Write-Host "Multiple profiles found:"
    for ($i = 0; $i -lt $profiles.Count; $i++) {
        Write-Host "  $($i + 1)) $($profiles[$i].Name)"
    }
    $choice = Read-Host "Select [1-$($profiles.Count)]"
    $profile = $profiles[[int]$choice - 1]
}

Write-Host "Profile: $($profile.Name)"
$chromeDir = Join-Path $profile.FullName "chrome"
$userJs = Join-Path $profile.FullName "user.js"
$ts = Get-Date -Format "yyyy-MM-dd-HHmmss"

# --- 1. Back up user.js ---
$userJsBackup = $null
if (Test-Path $userJs) {
    $userJsBackup = "${userJs}.bak.${ts}"
    Copy-Item -Path $userJs -Destination $userJsBackup
    Write-Host "Backed up user.js -> $(Split-Path $userJsBackup -Leaf)"
}

# --- 2. Back up chrome\utils\ ---
$utilsBackup = $null
$utilsDir = Join-Path $chromeDir "utils"
if (Test-Path $utilsDir) {
    $utilsBackup = Join-Path $profile.FullName "chrome.utils.bak.${ts}"
    Copy-Item -Path $utilsDir -Destination $utilsBackup -Recurse
    Write-Host "Backed up chrome\utils\ -> $(Split-Path $utilsBackup -Leaf)\"
}

# --- 3. Remove install-root bootstrap ---
if (Test-Path $appDir) {
    $bootstrap = Join-Path $appDir "config.js"
    $configPrefs = Join-Path $appDir "defaults\pref\config-prefs.js"
    foreach ($f in @($bootstrap, $configPrefs)) {
        if (Test-Path $f) {
            Write-Host "Removing $f..."
            try {
                Remove-Item -Path $f -Force
            } catch {
                Write-Host "Elevated privileges required. Retrying..."
                Start-Process powershell -Verb RunAs -Wait -ArgumentList @(
                    "-Command", "Remove-Item -Path '$f' -Force"
                )
            }
        }
    }
}

# --- 4. Remove profile-side loader machinery ---
if (Test-Path $utilsDir) {
    Remove-Item -Path $utilsDir -Recurse -Force
    Write-Host "Removed $utilsDir"
}

# --- 5. Strip userChromeJS.enabled from user.js ---
if ((Test-Path $userJs) -and (Select-String -Path $userJs -Pattern '"userChromeJS\.enabled"' -Quiet)) {
    $kept = Get-Content $userJs | Where-Object { $_ -notmatch '"userChromeJS\.enabled"' }
    Set-Content -Path $userJs -Value $kept
    Write-Host "Stripped userChromeJS.enabled from user.js"
}

Write-Host ""
Write-Host "Done. fx-autoconfig has been removed."
Write-Host ""
Write-Host "Backups (recover with Copy-Item if needed):"
if ($userJsBackup) { Write-Host "  $userJsBackup" }
if ($utilsBackup) { Write-Host "  $utilsBackup\" }
Write-Host ""
Write-Host "Verify:"
Write-Host "  if (-not (Test-Path '$appDir\config.js')) { Write-Host OK_bootstrap }"
Write-Host "  if (-not (Test-Path '$utilsDir')) { Write-Host OK_loader }"
Write-Host "  if (-not (Select-String -Path '$userJs' -Pattern 'userChromeJS.enabled' -Quiet)) { Write-Host OK_pref }"
