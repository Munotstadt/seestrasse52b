# Dashboard auf dem NAS aktualisieren (PowerShell, aus dem Repo-Ordner, z. B. C:\MunotstadtTools\52b)
#   .\dash-local\deploy-nas.ps1
# Nimmt DASSELBE UI (public\dash) wie die Online-Version, baut das Docker-Image neu und startet den Container.
# secrets\.env auf dem NAS bleibt unangetastet.
param(
  [string]$Nas = "munotstadt_admin@192.168.86.30",
  [string]$Dir = "/volume1/docker/dashboard52b"
)
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent

Push-Location $repo
node scripts/dash-check.mjs          # lokal = online?
node scripts/dash-version.mjs        # schreibt public\dash\version.json (Hash des UI-Stands)
Pop-Location

$tmp = Join-Path $env:TEMP "dash52b-bundle"
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory $tmp | Out-Null
Get-ChildItem "$repo\dash-local" -Force | Where-Object { $_.Name -notin @("secrets", "node_modules", "deploy-nas.ps1") } |
  ForEach-Object { Copy-Item $_.FullName $tmp -Recurse }
New-Item -ItemType Directory "$tmp\public" | Out-Null
Copy-Item "$repo\public\dash" "$tmp\public\dash" -Recurse

$tgz = "$tmp.tgz"
tar -czf $tgz -C $tmp .
scp -O $tgz "${Nas}:$Dir/bundle.tgz"
ssh -t $Nas "cd $Dir && tar -xzf bundle.tgz && rm bundle.tgz && sudo docker compose up -d --build"

Write-Host "Fertig. Lokal: http://192.168.86.30:8888/dash/  – Hash im Kopfbereich mit https://52b.munot.app/dash vergleichen."
