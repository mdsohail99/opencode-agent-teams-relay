# Agent-Teams installer (PowerShell)
# Modes:
#   -AgentsOnly : install ONLY curated agents + AGENTS.md orchestration block
#                 (no plugin, no relay, no npm dependency). For native-fork users.
#   (default)   : full mode — agents + plugin + relay + @opencode-ai/plugin npm dep.

[CmdletBinding()]
param(
    [switch]$AgentsOnly
)

$ErrorActionPreference = "Stop"

$PackageRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$UserHome = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($HOME) { $HOME } else { "C:\Users\moham" }
$ConfigDefaultSubdir = if ($AgentsOnly) { ".config\ocd" } else { ".config\opencode" }
$ConfigRoot = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $UserHome $ConfigDefaultSubdir }

function Stop-AgentTeamsRelays {
    $Procs = Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match 'agent-teams-relay.mjs' }
    foreach ($P in $Procs) { Stop-Process -Id $P.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
}

function Remove-WithRetry([string]$Path) {
    for ($i = 0; $i -lt 5; $i++) {
        try {
            Remove-Item $Path -Recurse -Force -ErrorAction Stop
            return
        } catch {
            if ($i -eq 4) { throw }
            Start-Sleep -Milliseconds 300
        }
    }
}

$AgentDir = Join-Path $ConfigRoot "agents"
$PluginDir = Join-Path $ConfigRoot "plugins"
$RelayDir = Join-Path $ConfigRoot "relay"
$VersionFile = Join-Path $ConfigRoot ".installed-version"
$ModeFile = Join-Path $ConfigRoot ".installed-mode"
$BackupRoot = Join-Path $ConfigRoot ".backups"
$PluginFile = Join-Path $PluginDir "agent-teams.ts"
$TokenFile = Join-Path $ConfigRoot ".relay-token"
$StartMarker = "<!-- agent-teams-orchestration:start -->"
$EndMarker = "<!-- agent-teams-orchestration:end -->"

# --- Merge AGENTS.md (append-or-replace our marked block, never clobber user content) ---
# Mirrors bin/install.mjs mergeAgentsMd(): idempotent on re-install/upgrade.
function Merge-AgentsMd {
    $Source = Join-Path $PackageRoot "AGENTS.md"
    if (-not (Test-Path $Source)) { return }

    $Content = ([System.IO.File]::ReadAllText($Source)).TrimEnd()

    # Ensure the package content is wrapped with our markers
    if (-not $Content.Contains($StartMarker)) {
        $Content = "$StartMarker`n$Content`n$EndMarker"
    }

    $Target = Join-Path $ConfigRoot "AGENTS.md"

    # Fresh install — no AGENTS.md exists yet
    if (-not (Test-Path $Target)) {
        [System.IO.File]::WriteAllText($Target, $Content + "`n")
        Write-Host "  Creating AGENTS.md with orchestration rules" -ForegroundColor Green
        return
    }

    $Existing = [System.IO.File]::ReadAllText($Target)

    # Re-install / upgrade — replace only our marked block, preserve everything else
    if ($Existing.Contains($StartMarker) -and $Existing.Contains($EndMarker)) {
        $StartIdx = $Existing.IndexOf($StartMarker)
        $EndIdx = $Existing.IndexOf($EndMarker) + $EndMarker.Length
        $Before = $Existing.Substring(0, $StartIdx).TrimEnd()
        $After = $Existing.Substring($EndIdx).TrimStart()
        $Merged = $Before + "`n`n" + $Content + "`n" + $After
        [System.IO.File]::WriteAllText($Target, $Merged)
        Write-Host "  Updated orchestration rules in AGENTS.md" -ForegroundColor Green
        return
    }

    # First install on a user who already has their own AGENTS.md — append our block
    $Merged = $Existing.TrimEnd() + "`n`n" + $Content + "`n"
    [System.IO.File]::WriteAllText($Target, $Merged)
    Write-Host "  Appended orchestration rules to existing AGENTS.md" -ForegroundColor Green
}

# --- Merge subagent_depth default into the user's global opencode.json ---
# MODE-AWARE: agents-only (fork) APPLIES the key (the fork core understands it);
# full (stock opencode) STRIPS it — the stable core rejects `subagent_depth` as
# an unrecognized key and refuses to start. Additive in agents mode: preserves
# every existing key (MCP servers, model, provider, etc.).
function Merge-SubagentDepth {
    param([string]$ConfigPath, [string]$Mode = "full")

    if (-not (Test-Path $ConfigPath)) {
        if ($Mode -ne "agents") { return }
        $Initial = @{ '$schema' = "https://opencode.ai/config.json"; subagent_depth = 2 }
        $Initial | ConvertTo-Json -Depth 20 | Set-Content -Path $ConfigPath -Encoding UTF8
        Write-Host "  subagent_depth=2 merged into $ConfigPath" -ForegroundColor Green
        return
    }

    try {
        $Config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    } catch {
        throw "Cannot parse $ConfigPath; fix it before installing Agent-Teams."
    }

    if ($Mode -eq "agents") {
        if ($null -eq $Config.subagent_depth) {
            if ($null -eq $Config.'$schema') { $Config | Add-Member -NotePropertyName '$schema' -NotePropertyValue "https://opencode.ai/config.json" -ErrorAction SilentlyContinue }
            $Config | Add-Member -NotePropertyName 'subagent_depth' -NotePropertyValue 2 -ErrorAction SilentlyContinue
            $Config | ConvertTo-Json -Depth 20 | Set-Content -Path $ConfigPath -Encoding UTF8
            Write-Host "  subagent_depth=2 merged into $ConfigPath (existing keys preserved)" -ForegroundColor Green
        } else {
            Write-Host "  subagent_depth already set to $($Config.subagent_depth) in $ConfigPath (kept)" -ForegroundColor DarkGray
        }
    } else {
        if ($null -ne $Config.subagent_depth) {
            $Config.psobject.properties.remove('subagent_depth')
            $Config | ConvertTo-Json -Depth 20 | Set-Content -Path $ConfigPath -Encoding UTF8
            Write-Host "  removed subagent_depth from $ConfigPath (not supported by stock opencode core)" -ForegroundColor DarkGray
        }
    }
}

$Mode = if ($AgentsOnly) { "agents" } else { "full" }
$ModeLabel = if ($AgentsOnly) { "agents-only" } else { "full" }

# Read new version from package.json
$Pkg = Get-Content (Join-Path $PackageRoot "package.json") -Raw | ConvertFrom-Json
$NewVersion = $Pkg.version

Write-Host ""
Write-Host "  Agent-Teams v$NewVersion installer" -ForegroundColor Cyan
Write-Host "  Mode: $ModeLabel" -ForegroundColor Yellow
Write-Host ""

# --- Backup existing installation ---
# Agents-only backs up only the agents dir (plus plugin/relay backups if they
# exist and are ours) so a conversion never destroys the previous profile.
$CurrentVersion = $null
if (Test-Path $VersionFile) {
    $CurrentVersion = Get-Content $VersionFile -Raw
    $CurrentVersion = $CurrentVersion.Trim()
    $Timestamp = (Get-Date).ToString("yyyy-MM-ddTHH-mm-ss")
    $BackupDir = Join-Path $BackupRoot "$CurrentVersion-$Timestamp"

    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

    $BackupDirs = if ($AgentsOnly) { @($AgentDir, $PluginDir, $RelayDir) } else { @($AgentDir, $PluginDir, $RelayDir) }
    foreach ($Dir in $BackupDirs) {
        if (Test-Path $Dir) {
            $DestName = Split-Path $Dir -Leaf
            $Dest = Join-Path $BackupDir $DestName
            Copy-Item $Dir $Dest -Recurse -Force
        }
    }

    Set-Content -Path (Join-Path $BackupDir ".installed-version") -Value $CurrentVersion

    Write-Host "  Backed up v$CurrentVersion to $BackupDir" -ForegroundColor Green
}

# --- Clean old files (mode-aware: never remove other user plugins in agents mode) ---
Write-Host "  Stopping any running Agent-Teams relay..." -ForegroundColor DarkGray
Stop-AgentTeamsRelays

if ($AgentsOnly) {
    foreach ($Dir in @($AgentDir, $RelayDir)) {
        if (Test-Path $Dir) { Remove-WithRetry $Dir }
    }
    if (Test-Path $PluginFile) { Remove-WithRetry $PluginFile }
} else {
    foreach ($Dir in @($AgentDir, $PluginDir, $RelayDir)) {
        if (Test-Path $Dir) { Remove-WithRetry $Dir }
    }
}
if (Test-Path $TokenFile) { Remove-WithRetry $TokenFile }

# --- Install new files (agents-only copies agents only) ---
New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null

Copy-Item (Join-Path $PackageRoot "agents\orchestrators\*.md") $AgentDir -Force
Copy-Item (Join-Path $PackageRoot "agents\specialists\*.md") $AgentDir -Force

# Fork-correct Agent-Teams: on the native fork (no relay) the orchestrator must
# use Task(background=true)/next_agent/agents_status, not running_agents.
# Overwrite the relay-based orchestrator with the fork variant in agents mode.
if ($AgentsOnly) {
    $ForkAgent = Join-Path $PackageRoot "agents\orchestrators-fork\orchestrator-agent-teams.md"
    if (Test-Path $ForkAgent) {
        Copy-Item $ForkAgent (Join-Path $AgentDir "orchestrator-agent-teams.md") -Force
        Write-Host "  Agents-only: installed native Agent-Teams orchestrator" -ForegroundColor DarkGray
    }
}

if (-not $AgentsOnly) {
    New-Item -ItemType Directory -Force -Path $PluginDir, $RelayDir | Out-Null
    Copy-Item (Join-Path $PackageRoot "plugins\agent-teams.ts") $PluginDir -Force
    Copy-Item (Join-Path $PackageRoot "relay\agent-teams-relay.mjs") $RelayDir -Force
}

# --- Merge orchestration rules into AGENTS.md ---
Merge-AgentsMd

# --- Merge subagent_depth default into the user's global opencode.json (mode-aware) ---
Merge-SubagentDepth -ConfigPath (Join-Path $ConfigRoot "opencode.json") -Mode $Mode

# --- Write version + mode markers ---
Set-Content -Path $VersionFile -Value $NewVersion
Set-Content -Path $ModeFile -Value $Mode

# --- npm install (full mode only; agents-only never touches package.json) ---
if (-not $AgentsOnly) {
    Push-Location $ConfigRoot
    try {
        npm install --ignore-scripts --no-audit --no-fund --save-exact "@opencode-ai/plugin@1.2.27" | Out-Host
    } finally {
        Pop-Location
    }
} else {
    Write-Host "  Skipping npm install (agents-only mode)" -ForegroundColor DarkGray
}

# --- Prune old backups (keep last 5) ---
if (Test-Path $BackupRoot) {
    $Backups = Get-ChildItem $BackupRoot -Directory | Sort-Object Name
    if ($Backups.Count -gt 5) {
        $ToRemove = $Backups | Select-Object -First ($Backups.Count - 5)
        foreach ($B in $ToRemove) {
            Remove-Item $B.FullName -Recurse -Force
            Write-Host "  Pruned old backup: $($B.Name)" -ForegroundColor DarkGray
        }
    }
}

Write-Host ""
Write-Host "  Installed Agent-Teams v$NewVersion ($ModeLabel mode) to $ConfigRoot" -ForegroundColor Green
if ($CurrentVersion) {
    Write-Host "  Previous version (v$CurrentVersion) backed up" -ForegroundColor Yellow
    Write-Host "  To revert: npx opencode-agent-teams-relay-uninstall revert" -ForegroundColor Yellow
}
if ($AgentsOnly) {
    Write-Host "  Agents-only: plugin/relay/npm were NOT installed (native-fork mode)" -ForegroundColor Yellow
}
Write-Host ""
if ($AgentsOnly) {
    Write-Host "  Restart opencode to load the new agents." -ForegroundColor Cyan
} else {
    Write-Host "  Restart opencode to load the new agents and plugin." -ForegroundColor Cyan
}
Write-Host ""
