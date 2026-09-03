#!/usr/bin/env node

import { cp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { killRelayProcesses, killOrphanedServeProcesses, rmRetry } from "./lib/relay-process.mjs"
import { mergeSubagentDepth } from "./lib/merge-subagent-depth.mjs"
import { mergeSlashCommands } from "./lib/merge-commands.mjs"
import { mergeSchema } from "./lib/merge-schema.mjs"
import { resolveConfigRoot } from "./lib/config-root.mjs"
import { removeRuntimeStateDirs } from "./lib/runtime-state.mjs"
import { removeParkedPlugin } from "./lib/plugin-park.mjs"

// Config root is resolved lazily per action (NOT at module load): menu.mjs may
// install into the same shared root (~/.config/opencode for both modes; only
// the plugin placement differs) after this module was imported, and detection
// must see the markers once written. Legacy `.config/ocd` installs are still
// detected for cleanup via resolveConfigRoot().
let cachedRoot = null
function root() {
  if (!cachedRoot) cachedRoot = resolveConfigRoot()
  return cachedRoot
}

const VERSION_FILE = () => join(root(), ".installed-version")
const MODE_FILE = () => join(root(), ".installed-mode")
const BACKUP_ROOT = () => join(root(), ".backups")

// Directories/files to EXCLUDE from copy (regenerated or too large)
const EXCLUDE_DIRS = new Set(["node_modules", ".backups", ".git"])
const EXCLUDE_FILES = new Set([".relay-token", "bun.lock", "package-lock.json"])

// --- Recursively copy excluding unwanted dirs/files ---
async function copyTreeExcluded(source, target, excludeDirs, excludeFiles) {
  await mkdir(target, { recursive: true })
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(source, entry.name)
    const dstPath = join(target, entry.name)
    if (entry.isDirectory()) {
      if (!excludeDirs.has(entry.name)) {
        await copyTreeExcluded(srcPath, dstPath, excludeDirs, excludeFiles)
      }
    } else {
      if (!excludeFiles.has(entry.name)) {
        await cp(srcPath, dstPath, { force: true })
      }
    }
  }
}

// --- Helpers ---
async function getCurrentVersion() {
  if (!existsSync(VERSION_FILE())) return null
  return (await readFile(VERSION_FILE(), "utf-8")).trim()
}

// Installed mode: "full" | "agents". Legacy installs that predate the marker
// default to "full" so their uninstall behaves exactly as before.
async function getInstalledMode() {
  if (!existsSync(MODE_FILE())) return "full"
  const mode = (await readFile(MODE_FILE(), "utf-8")).trim()
  return mode === "agents" ? "agents" : "full"
}

async function listBackups() {
  if (!existsSync(BACKUP_ROOT())) return []
  const entries = await readdir(BACKUP_ROOT())
  const backups = []
  for (const name of entries) {
    const dir = join(BACKUP_ROOT(), name)
    let version = "unknown"
    try {
      version = (await readFile(join(dir, ".backup-version"), "utf-8")).trim()
    } catch {
      try {
        version = (await readFile(join(dir, ".installed-version"), "utf-8")).trim()
      } catch {}
    }
    backups.push({ name, dir, version })
  }
  return backups.sort((a, b) => b.name.localeCompare(a.name)) // newest first
}

// --- Actions ---

export async function uninstall() {
  const version = await getCurrentVersion()
  if (!version) {
    console.log("\n  No Agent-Teams installation found.\n")
    return false
  }

  const mode = await getInstalledMode()

  console.log("  Stopping any running Agent-Teams relay...")
  await killRelayProcesses()

  // Reap orphaned auxiliary `opencode serve` processes (parent already dead)
  // so their old in-memory plugin can't respawn relays/state dirs after the
  // uninstall. Only opencode.exe processes with a `serve` argument whose
  // parent PID no longer exists are killed — live instances' servers and any
  // other process are never touched.
  await killOrphanedServeProcesses()

  // Scrub RUNTIME token/state dirs the relay wrote under
  // %LOCALAPPDATA%\opencode\agent-teams\<port> (plugin stateRoot). This is the
  // live shared-secret the plugin actually reads — removing it is what truly
  // kills a leaked token. removeRuntimeStateDirs only touches plugin-owned
  // per-port dirs (token/token.tmp/relay.log/server.log and the WAL + checkpoint
  // durable store agent-teams-relay.wal/agent-teams-relay-state.json + transient .tmp files),
  // never user files.
  const runtime = await removeRuntimeStateDirs({ removeDatabase: true })
  if (runtime.removed > 0) {
    console.log(`  Removed ${runtime.removed} stale runtime token/log dir(s) under ${runtime.root}`)
  }
  if (runtime.skipped > 0) {
    console.warn(`  Skipped ${runtime.skipped} dir(s) under ${runtime.root}: contain non-plugin files (kept)`)
  }

  // Remove managed files only (don't nuke user config). Mode-aware:
  //  - full:   the whole agents/plugins/relay set (historical behavior)
  //  - agents: ONLY our artifacts — never other user plugins, node_modules,
  //            opencode.json, or package.json
  //
  // NOTE (legacy scrub): `<configRoot>/.relay-token` is a deprecated vestige of
  // early installs — NO current runtime code reads it (relay + plugin use the
  // per-port token under LOCALAPPDATA/opencode/agent-teams, scrubbed above).
  // We still remove it here for historical compatibility / world-readable secret.
  if (mode === "agents") {
    const MANAGED_PATHS = [
      join(root(), "agents"),
      join(root(), "relay"),
      join(root(), "plugins", "agent-teams.ts"),
      // Parked plugin from agents-only installs sharing the config root
      // (out of autodiscovery under plugins-disabled/).
      join(root(), "plugins-disabled", "agent-teams.ts"),
      join(root(), ".relay-token"),
    ]
    for (const target of MANAGED_PATHS) {
      if (existsSync(target)) await rmRetry(target)
    }
    await removeParkedPlugin(root())
  } else {
    const MANAGED_DIRS = ["agents", "plugins", "relay", "plugins-disabled"]
    const MANAGED_FILES = [".relay-token"]

    for (const dir of MANAGED_DIRS) {
      const target = join(root(), dir)
      if (existsSync(target)) await rmRetry(target)
    }
    for (const file of MANAGED_FILES) {
      const target = join(root(), file)
      if (existsSync(target)) await rmRetry(target)
    }
  }
  if (existsSync(VERSION_FILE())) await rm(VERSION_FILE(), { force: true })
  if (existsSync(MODE_FILE())) await rm(MODE_FILE(), { force: true })

  // Strip subagent_depth and slash commands from global opencode.json so stock opencode core can start
  await mergeSubagentDepth(root(), console.log, "uninstall")
  await mergeSlashCommands(root(), console.log, "uninstall")
  await mergeSchema(root(), console.log, "uninstall")

  // Remove only our marked block from AGENTS.md — preserve user content
  const agentsMdPath = join(root(), "AGENTS.md")
  const START_MARKER = "<!-- agent-teams-orchestration:start -->"
  const END_MARKER   = "<!-- agent-teams-orchestration:end -->"
  if (existsSync(agentsMdPath)) {
    const content = await readFile(agentsMdPath, "utf-8")
    if (content.includes(START_MARKER) && content.includes(END_MARKER)) {
      const before = content.slice(0, content.indexOf(START_MARKER)).trimEnd()
      const after  = content.slice(content.indexOf(END_MARKER) + END_MARKER.length).trimStart()
      const cleaned = [before, after].filter(Boolean).join("\n\n").trimEnd()
      if (cleaned.length === 0) {
        await rm(agentsMdPath, { force: true })
        console.log("  Removed AGENTS.md (was only our content)")
      } else {
        await writeFile(agentsMdPath, cleaned + "\n", "utf-8")
        console.log("  Removed orchestration rules from AGENTS.md (user content preserved)")
      }
    }
  }

  console.log(`\n  Agent-Teams v${version} uninstalled.`)
  console.log(`  Mode: ${mode}${mode === "agents" ? " (other user plugins preserved)" : ""}`)
  console.log(`  Config directory preserved: ${root()}`)

  const backups = await listBackups()
  if (backups.length > 0) {
    console.log(`\n  Available backups (${backups.length}):`)
    for (const b of backups) {
      console.log(`    - v${b.version}  (${b.name})`)
    }
    console.log(`\n  To restore a backup: npx opencode-agent-teams-relay-uninstall revert`)
  }
  console.log("")
  return true
}

export async function revert(backupName) {
  const backups = await listBackups()
  if (backups.length === 0) {
    console.log("\n  No backups available to revert to.\n")
    return false
  }

  let target
  if (backupName) {
    target = backups.find((b) => b.name === backupName || b.version === backupName)
    if (!target) {
      console.log(`\n  Backup '${backupName}' not found.`)
      console.log("  Available backups:")
      for (const b of backups) {
        console.log(`    - v${b.version}  (${b.name})`)
      }
      console.log("")
      return false
    }
  } else {
    target = backups[0] // default to most recent
  }

  const currentVersion = await getCurrentVersion()
  console.log(`\n  Reverting: v${currentVersion || "?"} -> v${target.version}`)
  console.log(`  ${target.dir}\n`)

  // Step 0: Stop the relay before touching any files it holds open.
  // Without this, the relay keeps relay.log, server.log, and agent-teams.ts
  // locked on Windows (EBUSY), causing the rm below to fail or leave the relay
  // running against a half-wiped config directory.
  console.log("  Stopping any running Agent-Teams relay...")
  await killRelayProcesses()
  await killOrphanedServeProcesses()

  // Step 1: Clean the config dir completely (except .backups)
  if (existsSync(root())) {
    const entries = await readdir(root())
    for (const entry of entries) {
      if (entry === ".backups") continue
      await rm(join(root(), entry), { recursive: true, force: true })
    }
  }

  // Step 2: Restore everything from backup
  await copyTreeExcluded(target.dir, root(), EXCLUDE_DIRS, EXCLUDE_FILES)

  // Step 2.5: Ensure subagent_depth default is (re)applied additively after a restore —
  // never overwrite a value the user set in the backup; just guarantee the key exists.
  // Mode-aware: agents (fork) applies it; full (stock) strips it (invalid on stock).
  const installedMode = await getInstalledMode()
  console.log(`  Ensuring subagent_depth and slash commands in global config (mode: ${installedMode})...`)
  await mergeSubagentDepth(root(), console.log, installedMode)
  await mergeSlashCommands(root(), console.log, installedMode)
  await mergeSchema(root(), console.log, installedMode)

  // Step 3: Run npm install to restore dependencies
  console.log("  Restoring npm dependencies...")
  const npmCmd = process.env.ComSpec || "cmd.exe"
  const npmArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact"]
    : ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact"]
  const npmBin = process.platform === "win32" ? npmCmd : "npm"
  spawnSync(npmBin, npmArgs, {
    cwd: root(),
    stdio: "inherit",
  })

  console.log(`\n  ${currentVersion ? `Restored from v${currentVersion}` : "Installed"} to v${target.version}`)
  console.log(`  Config: ${root()}`)
  console.log(`  Backup kept at: ${target.dir}`)
  console.log(`\n  Restart opencode to load the restored version.\n`)

  return true
}

export async function status() {
  const version = await getCurrentVersion()
  const backups = await listBackups()
  const mode = await getInstalledMode()

  console.log("\n  Agent-Teams Status")
  console.log("  ==================")

  if (version) {
    console.log(`\n  Installed version: v${version}`)
    console.log(`  Installed mode:    ${mode}${mode === "agents" ? " (agents only)" : ""}`)
    console.log(`  Install location:  ${root()}`)
  } else {
    console.log("\n  Not installed.")
  }

  if (backups.length > 0) {
    console.log(`\n  Backups (${backups.length}):`)
    for (const b of backups) {
      console.log(`    - v${b.version}  (${b.name})`)
    }
  } else {
    console.log("\n  No backups available.")
  }

  console.log("")
  return { version, backups }
}

export async function deleteBackup(backupName) {
  const backups = await listBackups()
  if (backups.length === 0) {
    console.log("\n  No backups available to delete.\n")
    return false
  }

  if (backupName === "all") {
    for (const b of backups) {
      await rm(b.dir, { recursive: true, force: true })
    }
    console.log(`\n  Deleted all ${backups.length} backups.\n`)
    return true
  }

  const target = backups.find((b) => b.name === backupName || b.version === backupName)
  if (!target) {
    console.log(`\n  Backup '${backupName}' not found.\n`)
    return false
  }

  await rm(target.dir, { recursive: true, force: true })
  console.log(`\n  Deleted backup: ${target.name}\n`)
  return true
}

// --- CLI entry point ---
const args = process.argv.slice(2)
const command = args[0]

if (command === "uninstall") {
  await uninstall()
} else if (command === "revert") {
  await revert(args[1])
} else if (command === "clean-backups") {
  await deleteBackup(args[1] || "all")
} else if (command === "status") {
  await status()
} else {
  console.log("\n  Usage:")
  console.log("    node uninstall.mjs uninstall          Remove Agent-Teams (keep config)")
  console.log("    node uninstall.mjs revert [ver]       Restore full config from backup")
  console.log("    node uninstall.mjs clean-backups [ver] Delete backup(s)")
  console.log("    node uninstall.mjs status             Show installed version and backups\n")
}
