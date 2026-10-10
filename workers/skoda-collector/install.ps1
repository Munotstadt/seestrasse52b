# Installation Škoda-Collector: Datenbank «car», Tabellen, Worker «skoda_collector», API-Key.
# PowerShell, aus dem Repo-Ordner (z. B. C:\MunotstadtTools\52b):
#   .\workers\skoda-collector\install.ps1            # installieren (Collector bleibt AUS)
#   .\workers\skoda-collector\install.ps1 -Enable    # später: Collector einschalten (nachdem der NAS-Collector gestoppt ist)
# Der API-Key wird nur hier im Terminal eingegeben und geht direkt an Cloudflare (nicht in Dateien, nicht in den Chat).
# Voraussetzung: einmalig «npx wrangler login».
param([switch]$Enable)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$repo = Split-Path (Split-Path $here -Parent) -Parent
$cfgCol = Join-Path $here "wrangler.jsonc"
$cfgMain = Join-Path $repo "wrangler.jsonc"
$utf8 = New-Object System.Text.UTF8Encoding($false)
Set-Location $repo

function Replace-InFile($file, $from, $to) {
  $t = [IO.File]::ReadAllText($file)
  [IO.File]::WriteAllText($file, $t.Replace($from, $to), $utf8)
}

if ($Enable) {
  Replace-InFile $cfgCol '"COLLECT_ENABLED": "0"' '"COLLECT_ENABLED": "1"'
  npx wrangler deploy --config $cfgCol
  Write-Host "Collector eingeschaltet (alle 5 Min). Prüfen: npx wrangler tail skoda-collector"
  exit 0
}

# 1) Datenbank «car» (vorhandene wird weiterverwendet)
function Get-CarId {
  $l = npx wrangler d1 list --json | ConvertFrom-Json
  ($l | Where-Object { $_.name -eq "car" } | Select-Object -First 1).uuid
}
$id = Get-CarId
if (-not $id) {
  Write-Host "Lege Datenbank 'car' an … (Frage nach Konfigurations-Update mit n beantworten)"
  npx wrangler d1 create car
  $id = Get-CarId
}
if (-not $id) { throw "Datenbank 'car' nicht gefunden/angelegt." }
Write-Host "Datenbank car: $id"

# 2) ID in beide Konfigurationen eintragen (Collector + Dashboard-Worker)
Replace-InFile $cfgCol "__CAR_DB_ID__" $id
Replace-InFile $cfgMain "__CAR_DB_ID__" $id

# 3) VIN (Enter = Wert aus wrangler.jsonc behalten)
$cur = [regex]::Match([IO.File]::ReadAllText($cfgCol), '"SKODA_VIN":\s*"([^"]+)"').Groups[1].Value
$vin = Read-Host "VIN [$cur]"
if ($vin) {
  if ($vin -notmatch '^[A-HJ-NPR-Z0-9]{17}$') { throw "VIN muss 17 Zeichen haben (ohne I, O, Q)." }
  Replace-InFile $cfgCol "`"SKODA_VIN`": `"$cur`"" "`"SKODA_VIN`": `"$vin`""
}

# 4) Tabellen anlegen
npx wrangler d1 execute car --remote --file="$repo\schema\car_db.sql"
npx wrangler d1 execute seestrasse52b --remote --file="$repo\schema\dash_migrations.sql"   # Index für Innensensor-Verläufe

# 5) Worker deployen (Collector noch AUS), danach API-Key als Secret
npx wrangler deploy --config $cfgCol
Write-Host "`nJetzt den Škoda API-Key einfügen (Eingabe bleibt unsichtbar):"
npx wrangler secret put SKODA_API_KEY --config $cfgCol

Write-Host @"

Fertig. Nächste Schritte:
  1. Geänderte Dateien committen und pushen: wrangler.jsonc, workers/skoda-collector/wrangler.jsonc
     (enthalten jetzt die Datenbank-ID; ohne Push scheitert der nächste Deploy am Platzhalter-Check).
  2. NAS-Collector 'skoda-enyaq-collector' stoppen (Limit: 20 API-Aufrufe/Stunde für alle zusammen).
  3. .\workers\skoda-collector\install.ps1 -Enable
"@
