# Install project Agency Agents into Cursor user dirs (all repos on this machine).
# Run from PowerShell:
#   powershell -ExecutionPolicy Bypass -File .cursor\scripts\install-agency-agents.ps1

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path (Split-Path -Parent $scriptDir) "agents"
$destCursor = if ($env:CURSOR_AGENTS_DIR) { $env:CURSOR_AGENTS_DIR } else { Join-Path $env:USERPROFILE ".cursor\agents" }
$destClaude = if ($env:CLAUDE_AGENTS_DIR) { $env:CLAUDE_AGENTS_DIR } else { Join-Path $env:USERPROFILE ".claude\agents" }

if (-not (Test-Path $src)) {
    throw "Agent files not found at $src. Run this from the agent_max checkout after switching to the agency-agents branch."
}

New-Item -ItemType Directory -Force -Path $destCursor | Out-Null
New-Item -ItemType Directory -Force -Path $destClaude | Out-Null

$files = Get-ChildItem -Path $src -Filter *.md -File
if ($files.Count -eq 0) {
    throw "No .md agent files in $src"
}

$claudeWritten = 0
foreach ($file in $files) {
    Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $destCursor $file.Name) -Force
    $claudeDest = Join-Path $destClaude $file.Name
    $item = Get-Item -LiteralPath $claudeDest -ErrorAction SilentlyContinue
    if ($item -and $item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        $claudeDest = Join-Path $destClaude ("agency-" + $file.Name)
        $item = Get-Item -LiteralPath $claudeDest -ErrorAction SilentlyContinue
        if ($item -and $item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            continue
        }
    }
    Copy-Item -LiteralPath $file.FullName -Destination $claudeDest -Force
    $claudeWritten++
}

$cursorCount = (Get-ChildItem -Path $destCursor -Filter *.md -File).Count
Write-Host "Installed $cursorCount Cursor subagents -> $destCursor"
Write-Host "Claude mirrors written: $claudeWritten -> $destClaude"
Write-Host "Start a new Cursor Agent chat so it picks them up."
