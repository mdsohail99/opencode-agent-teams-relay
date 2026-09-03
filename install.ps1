# Agent-Teams installer (PowerShell)
# Modes:
#   -AgentsOnly : install ONLY curated agents + AGENTS.md orchestration block
#                 (no plugin, no relay, no npm dependency). For native-fork users.
#   (default)   : full mode — agents + plugin + relay + @opencode-ai/plugin npm dep.
#
# Both modes install into the SAME config root (~/.config/opencode). In
# agents-only mode the plugin is PARKED into plugins-disabled\ (out of
# autodiscovery, which only scans {plugin,plugins}/*.{ts,js}) so the native
# fork's compiled-in Task/next_agent/agents_status run collision-free; full
# mode moves it back into plugins\ (and drops any parked copy).

[CmdletBinding()]
param(
    [switch]$AgentsOnly,
    [string]$ConfigDir
)

$ErrorActionPreference = "Stop"

$PackageRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$UserHome = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($HOME) { $HOME } else { [Environment]::GetFolderPath("UserProfile") }
# Single config root for BOTH modes; mode decides plugin placement (parked vs active).
$ConfigDefaultSubdir = ".config\opencode"
$ConfigRoot = if ($ConfigDir) { $ConfigDir } elseif ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $UserHome $ConfigDefaultSubdir }

function Stop-AgentTeamsRelays {
    $Procs = Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match 'agent-teams-relay.mjs' }
    foreach ($P in $Procs) { Stop-Process -Id $P.ProcessId -Force -ErrorAction SilentlyContinue }
    # Wait for port 25800 to fully release (TCP TIME_WAIT drain) before returning.
    # Without this wait, the supervisor fires concurrent respawn attempts into a
    # port still in TIME_WAIT, each timing out and falling through to the aux-server
    # fallback — producing the split-brain cascade seen in the server.log.
    $RelayPort = if ($env:RELAY_PORT) { [int]$env:RELAY_PORT } else { 25800 }
    $Deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $Deadline) {
        $listening = netstat -ano 2>$null | Select-String "127\.0\.0\.1:$RelayPort\s.*LISTENING"
        if (-not $listening) { break }
        Start-Sleep -Milliseconds 200
    }
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
# Runtime relay state root — mirrors plugins/agent-teams.ts stateRoot().
# One per-port dir per relay: root/<port>/{token, token.tmp, relay.log, server.log,
# agent-teams-relay.wal, agent-teams-relay-state.json + transient .tmp files}
# (mirrors bin/lib/runtime-state.mjs).
$StateRoot = $null
if ($env:AGENT_TEAMS_STATE_DIR) { $StateRoot = $env:AGENT_TEAMS_STATE_DIR }
elseif ($env:LOCALAPPDATA) { $StateRoot = Join-Path $env:LOCALAPPDATA "opencode\agent-teams" }
elseif ($env:HOME) { $StateRoot = Join-Path $env:HOME ".local\state\opencode\agent-teams" }
$StatePluginFiles = @("token", "token.tmp", "relay.log", "server.log", "agent-teams-relay.wal", "agent-teams-relay-state.json", "agent-teams-relay.wal.tmp", "agent-teams-relay-state.json.tmp")
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

# --- Merge subagent_depth and max_concurrent_agents defaults into global opencode.json ---
# MODE-AWARE:
# - agents-only (fork) APPLIES subagent_depth=2 (V2 schema compliant at root);
# - full (stock opencode) STRIPS subagent_depth — stock core rejects it.
# - BOTH modes additively set max_concurrent_agents=20 if absent (preserving user values,
#   and migrating any misplaced experimental.max_concurrent_agents to root).
function Merge-SubagentDepth {
    param([string]$ConfigPath, [string]$Mode = "full")

    if (-not (Test-Path $ConfigPath)) {
        if ($Mode -eq "uninstall") { return }
        $Initial = [ordered]@{ 
            '$schema' = "https://opencode.ai/config.json"
            max_concurrent_agents = 20
        }
        if ($Mode -eq "agents") {
            $Initial['subagent_depth'] = 2
        }
        $Initial | ConvertTo-Json -Depth 20 | Set-Content -Path $ConfigPath -Encoding UTF8
        Write-Host "  created $ConfigPath with default agent settings" -ForegroundColor Green
        return
    }

    try {
        $Config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    } catch {
        throw "Cannot parse $ConfigPath; fix it before installing Agent-Teams."
    }

    $changed = $false

    # 1. max_concurrent_agents (both full and agents mode)
    if ($Mode -eq "full" -or $Mode -eq "agents") {
        if ($null -ne $Config.experimental -and $null -ne $Config.experimental.max_concurrent_agents) {
            if ($null -eq $Config.max_concurrent_agents) {
                $Config | Add-Member -NotePropertyName 'max_concurrent_agents' -NotePropertyValue $Config.experimental.max_concurrent_agents -ErrorAction SilentlyContinue
            }
            $Config.experimental.psobject.properties.remove('max_concurrent_agents')
            if (@($Config.experimental.psobject.properties).Count -eq 0) {
                $Config.psobject.properties.remove('experimental')
            }
            $changed = $true
        }

        if ($null -eq $Config.max_concurrent_agents) {
            if ($null -eq $Config.'$schema') { 
                $Config | Add-Member -NotePropertyName '$schema' -NotePropertyValue "https://opencode.ai/config.json" -ErrorAction SilentlyContinue 
            }
            $Config | Add-Member -NotePropertyName 'max_concurrent_agents' -NotePropertyValue 20 -ErrorAction SilentlyContinue
            $changed = $true
            Write-Host "  max_concurrent_agents=20 merged into $ConfigPath" -ForegroundColor Green
        } else {
            Write-Host "  max_concurrent_agents already set to $($Config.max_concurrent_agents) in $ConfigPath (kept)" -ForegroundColor DarkGray
        }
    }

    # 2. subagent_depth
    if ($Mode -eq "agents") {
        # Migrate misplaced experimental.subagent_depth back to root if present
        if ($null -ne $Config.experimental -and $null -ne $Config.experimental.subagent_depth) {
            if ($null -eq $Config.subagent_depth) {
                $Config | Add-Member -NotePropertyName 'subagent_depth' -NotePropertyValue $Config.experimental.subagent_depth -ErrorAction SilentlyContinue
            }
            $Config.experimental.psobject.properties.remove('subagent_depth')
            if (@($Config.experimental.psobject.properties).Count -eq 0) {
                $Config.psobject.properties.remove('experimental')
            }
            $changed = $true
        }

        # Set root subagent_depth = 2 if absent
        if ($null -eq $Config.subagent_depth) {
            if ($null -eq $Config.'$schema') { 
                $Config | Add-Member -NotePropertyName '$schema' -NotePropertyValue "https://opencode.ai/config.json" -ErrorAction SilentlyContinue 
            }
            $Config | Add-Member -NotePropertyName 'subagent_depth' -NotePropertyValue 2 -ErrorAction SilentlyContinue
            $changed = $true
            Write-Host "  subagent_depth=2 merged into $ConfigPath (existing keys preserved)" -ForegroundColor Green
        } else {
            Write-Host "  subagent_depth already set to $($Config.subagent_depth) in $ConfigPath (kept)" -ForegroundColor DarkGray
        }
    } else {
        if ($null -ne $Config.subagent_depth) {
            $Config.psobject.properties.remove('subagent_depth')
            $changed = $true
        }
        if ($null -ne $Config.experimental -and $null -ne $Config.experimental.subagent_depth) {
            $Config.experimental.psobject.properties.remove('subagent_depth')
            if (@($Config.experimental.psobject.properties).Count -eq 0) {
                $Config.psobject.properties.remove('experimental')
            }
            $changed = $true
        }
        if ($changed -and $Mode -ne "agents") {
            Write-Host "  removed subagent_depth from $ConfigPath (not supported by stock opencode core)" -ForegroundColor DarkGray
        }
    }

    if ($changed) {
        $Config | ConvertTo-Json -Depth 20 | Set-Content -Path $ConfigPath -Encoding UTF8
    }
}

# --- Merge Agent-Teams slash commands into global opencode.json ---
# In full mode: injects /agents, /status, /ask, /resume, /stop, /errors
# with "agent": "Agent-Teams", preserving user custom commands.
# In agents mode or uninstall: strips the managed commands.
function Merge-SlashCommands {
    param([string]$ConfigPath, [string]$Mode = "full")

    $ManagedCommands = [ordered]@{
        agents = [ordered]@{
            agent = "Agent-Teams"
            description = "display the live hierarchical swarm status tree: /agents [filter]"
            template = "Call agents_status to inspect and display the live agent hierarchy tree, elapsed times, and progress."
        }
        status = [ordered]@{
            agent = "Agent-Teams"
            description = "synthesize current progress and work done across all leads and specialists: /status [filter]"
            template = "Call agents_status to retrieve running and completed children, inspect their deliverables, and synthesize an executive summary."
        }
        ask = [ordered]@{
            agent = "Agent-Teams"
            description = "query any running lead or specialist agent out-of-band: /ask <agent> <question>"
            template = "Call ask_agent with target_id and prompt parsed from: $ARGUMENTS"
        }
        resume = [ordered]@{
            agent = "Agent-Teams"
            description = "resume or restart a stalled, failed, or paused agent: /resume <agent> [instructions]"
            template = "Call resume_agent with target_id and prompt parsed from: $ARGUMENTS"
        }
        stop = [ordered]@{
            agent = "Agent-Teams"
            description = "halt a specific agent or all running agents in the swarm: /stop [agent|all]"
            template = "Call manage_agents with action='kill' or 'kill_all' based on: $ARGUMENTS"
        }
        errors = [ordered]@{
            agent = "Agent-Teams"
            description = "scan swarm for failed, errored, or stalled agents and show diagnostics: /errors"
            template = "Call agents_status to find any workers with status 'error' or '[stalled]', then inspect their outputs and recommend fixes."
        }
    }

    if (-not (Test-Path $ConfigPath)) {
        if ($Mode -ne "full") { return }
        $Initial = [ordered]@{
            '$schema' = "https://opencode.ai/config.json"
            command = $ManagedCommands
        }
        $Initial | ConvertTo-Json -Depth 20 | Set-Content -Path $ConfigPath -Encoding UTF8
        Write-Host "  injected Agent-Teams slash commands into $ConfigPath" -ForegroundColor Green
        return
    }

    try {
        $Config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    } catch {
        throw "Cannot parse $ConfigPath; fix it before installing Agent-Teams."
    }

    $changed = $false
    if ($Mode -eq "full") {
        if ($null -eq $Config.command) {
            $Config | Add-Member -NotePropertyName 'command' -NotePropertyValue (New-Object PSObject) -ErrorAction SilentlyContinue
            $changed = $true
        }
        foreach ($cmdKey in $ManagedCommands.Keys) {
            $cmdVal = $ManagedCommands[$cmdKey]
            $cmdObj = New-Object PSObject
            foreach ($prop in $cmdVal.Keys) {
                $cmdObj | Add-Member -NotePropertyName $prop -NotePropertyValue $cmdVal[$prop] -ErrorAction SilentlyContinue
            }
            if ($null -eq $Config.command.psobject.properties[$cmdKey]) {
                $Config.command | Add-Member -NotePropertyName $cmdKey -NotePropertyValue $cmdObj -ErrorAction SilentlyContinue
                $changed = $true
            } else {
                $existingCmd = $Config.command.psobject.properties[$cmdKey].Value
                if ($existingCmd.agent -ne $cmdVal.agent -or $existingCmd.description -ne $cmdVal.description -or $existingCmd.template -ne $cmdVal.template) {
                    $Config.command.$cmdKey = $cmdObj
                    $changed = $true
                }
            }
        }
        if ($changed) {
            Write-Host "  injected Agent-Teams slash commands into $ConfigPath (user commands preserved)" -ForegroundColor Green
        }
    } else {
        if ($null -ne $Config.command) {
            foreach ($cmdKey in $ManagedCommands.Keys) {
                if ($null -ne $Config.command.psobject.properties[$cmdKey]) {
                    $Config.command.psobject.properties.remove($cmdKey)
                    $changed = $true
                }
            }
            if (@($Config.command.psobject.properties).Count -eq 0) {
                $Config.psobject.properties.remove('command')
                $changed = $true
            }
            if ($changed) {
                Write-Host "  removed Agent-Teams slash commands from $ConfigPath" -ForegroundColor DarkGray
            }
        }
    }

    if ($changed) {
        $Config | ConvertTo-Json -Depth 20 | Set-Content -Path $ConfigPath -Encoding UTF8
    }
}

function Merge-Schema {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ConfigDir,
        [Parameter(Mandatory = $true)]
        [string]$Mode
    )

    $SourceSchema = Join-Path $PackageRoot "schema.json"
    $TargetSchema = Join-Path $ConfigDir "schema.json"
    $ConfigPath = Join-Path $ConfigDir "opencode.json"

    if ($Mode -eq "uninstall") {
        if (Test-Path $TargetSchema) {
            Remove-Item $TargetSchema -Force -ErrorAction SilentlyContinue
            Write-Host "  removed schema.json from $ConfigDir" -ForegroundColor Yellow
        }
        if (Test-Path $ConfigPath) {
            try {
                $Raw = Get-Content $ConfigPath -Raw -Encoding UTF8
                $Json = $Raw | ConvertFrom-Json
                if ($Json.'$schema' -eq "./schema.json") {
                    $Json.'$schema' = "https://opencode.ai/config.json"
                    $Json | ConvertTo-Json -Depth 20 | Set-Content -Path $ConfigPath -Encoding UTF8
                    Write-Host "  reverted `$schema in opencode.json to remote schema" -ForegroundColor Yellow
                }
            } catch {}
        }
        return
    }

    if (Test-Path $SourceSchema) {
        Copy-Item $SourceSchema $TargetSchema -Force
        Write-Host "  installed schema.json into $ConfigDir" -ForegroundColor Green
    }

    if (Test-Path $ConfigPath) {
        try {
            $Raw = Get-Content $ConfigPath -Raw -Encoding UTF8
            $Json = $Raw | ConvertFrom-Json
            if (-not $Json.'$schema' -or $Json.'$schema' -eq "https://opencode.ai/config.json") {
                $Json.'$schema' = "./schema.json"
                $Json | ConvertTo-Json -Depth 20 | Set-Content -Path $ConfigPath -Encoding UTF8
                Write-Host "  updated `$schema in opencode.json to ./schema.json" -ForegroundColor Green
            }
        } catch {}
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
    # Park (not delete) our plugin: moving it into plugins-disabled\ takes it out
    # of autodiscovery ({plugin,plugins}/*.{ts,js}) so the native fork's compiled-in
    # next_agent/agents_status run collision-free; a later full install restores it.
    $DisabledPluginDir = Join-Path $ConfigRoot "plugins-disabled"
    if (Test-Path $PluginFile) {
        New-Item -ItemType Directory -Force -Path $DisabledPluginDir | Out-Null
        try {
            Move-Item -Path $PluginFile -Destination (Join-Path $DisabledPluginDir "agent-teams.ts") -Force
            Write-Host "  Agents-only: parked plugin in plugins-disabled\ (native-fork mode)" -ForegroundColor DarkGray
        } catch {
            # Locked file: copy-park fallback
            Copy-Item -Path $PluginFile -Destination (Join-Path $DisabledPluginDir "agent-teams.ts") -Force
            Remove-Item $PluginFile -Force -ErrorAction SilentlyContinue
            Write-Host "  Agents-only: parked plugin in plugins-disabled\ (copy fallback)" -ForegroundColor DarkGray
        }
    }
} else {
    foreach ($Dir in @($AgentDir, $PluginDir, $RelayDir)) {
        if (Test-Path $Dir) { Remove-WithRetry $Dir }
    }
    # Full mode re-activates the plugin: drop any parked copy from an earlier
    # agents-only install in this same config root.
    $ParkedFile = Join-Path $ConfigRoot "plugins-disabled\agent-teams.ts"
    if (Test-Path $ParkedFile) {
        Remove-WithRetry $ParkedFile
        if ((Test-Path (Join-Path $ConfigRoot "plugins-disabled")) -and -not (Get-ChildItem (Join-Path $ConfigRoot "plugins-disabled") -Force)) {
            Remove-Item (Join-Path $ConfigRoot "plugins-disabled") -Force
        }
    }
}
# Legacy scrub: `.relay-token` is deprecated — no current runtime code reads it
# (relay + plugin use per-port tokens under the state root below). Removed for
# historical compatibility / world-readable secret.
if (Test-Path $TokenFile) { Remove-WithRetry $TokenFile }

# Scrub RUNTIME token/log files from previous runs while preserving state files.
if ($StateRoot -and (Test-Path $StateRoot)) {
    $PortDirs = Get-ChildItem $StateRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d+$' }
    foreach ($PortDir in $PortDirs) {
        $TransientFiles = @("token", "token.tmp", "relay.log", "server.log")
        foreach ($TF in $TransientFiles) {
            $FilePath = Join-Path $PortDir.FullName $TF
            if (Test-Path $FilePath) { Remove-WithRetry $FilePath }
        }
        Write-Host "  Removed transient relay state for port $($PortDir.Name) (preserved state files remain)" -ForegroundColor DarkGray
    }
}

# --- Install new files (agents-only copies agents only) ---
New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null

Copy-Item (Join-Path $PackageRoot "agents\orchestrators\*.md") $AgentDir -Force
Copy-Item (Join-Path $PackageRoot "agents\specialists\*.md") $AgentDir -Force

# Fork-correct Agent-Teams: on the native fork (no relay) the orchestrator must
# use Task(background=true)/next_agent/agents_status, not running_agents.
# Agents-only -> overwrite the relay-based orchestrator with the fork variant.
# Full mode    -> restore the relay-based orchestrator OVER any fork variant
#                 left by an earlier agents-only install (the Copy-Item above
#                 already overwrites; this makes the restore explicit).
if ($AgentsOnly) {
    $ForkAgent = Join-Path $PackageRoot "agents\orchestrators-fork\orchestrator-agent-teams.md"
    if (Test-Path $ForkAgent) {
        Copy-Item $ForkAgent (Join-Path $AgentDir "orchestrator-agent-teams.md") -Force
        Write-Host "  Agents-only: installed native Agent-Teams orchestrator" -ForegroundColor DarkGray
    }
} else {
    $OriginalAgent = Join-Path $PackageRoot "agents\orchestrators\orchestrator-agent-teams.md"
    if (Test-Path $OriginalAgent) {
        Copy-Item $OriginalAgent (Join-Path $AgentDir "orchestrator-agent-teams.md") -Force
        Write-Host "  Full mode: installed relay-based Agent-Teams orchestrator" -ForegroundColor DarkGray
    }
}

if (-not $AgentsOnly) {
    New-Item -ItemType Directory -Force -Path $PluginDir, $RelayDir | Out-Null
    Copy-Item (Join-Path $PackageRoot "plugins\agent-teams.ts") $PluginDir -Force
    Copy-Item (Join-Path $PackageRoot "relay\agent-teams-relay.mjs") $RelayDir -Force
}

# --- Merge orchestration rules into AGENTS.md ---
Merge-AgentsMd

# --- Merge subagent_depth & max_concurrent_agents defaults into global opencode.json (mode-aware) ---
Merge-SubagentDepth -ConfigPath (Join-Path $ConfigRoot "opencode.json") -Mode $Mode

# --- Merge slash commands into global opencode.json (mode-aware) ---
Merge-SlashCommands -ConfigPath (Join-Path $ConfigRoot "opencode.json") -Mode $Mode

# --- Merge schema.json and ensure $schema points to ./schema.json (mode-aware) ---
Merge-Schema -ConfigDir $ConfigRoot -Mode $Mode

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
    Write-Host "  Agents-only: no plugin/relay/npm. Plugin file parked in plugins-disabled\ (native-fork mode; restored by a full install)" -ForegroundColor Yellow
}
Write-Host ""
if ($AgentsOnly) {
    Write-Host "  Restart opencode to load the new agents." -ForegroundColor Cyan
} else {
    Write-Host "  Restart opencode to load the new agents and plugin." -ForegroundColor Cyan
}
Write-Host ""
