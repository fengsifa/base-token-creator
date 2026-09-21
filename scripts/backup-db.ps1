$ErrorActionPreference = "Stop"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDirectory = Join-Path (Get-Location) "backups"
New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null
$backupFile = Join-Path $backupDirectory "token_creator-$timestamp.dump"
$containerId = (docker compose ps -q postgres).Trim()
if (-not $containerId) { throw "PostgreSQL container is not running." }
docker compose exec -T postgres sh -c "pg_dump -U token_creator -d token_creator -Fc > /tmp/token_creator.dump"
docker cp ($containerId + ":/tmp/token_creator.dump") $backupFile
docker compose exec -T postgres rm -f /tmp/token_creator.dump
Write-Output "Backup written to $backupFile"
