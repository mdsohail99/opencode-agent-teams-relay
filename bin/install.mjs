#!/usr/bin/env node

import { cp, mkdir, readFile, writeFile, rm, readdir, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, dirname, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { killRelayProcesses, rmRetry } from "./lib/relay-process.mjs"
import { mergeSubagentDepth } from "./lib/merge-subagent-depth.mjs"

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const configRoot = process.env.OPENCODE_CONFIG_DIR || join(process.env.USERPROFILE || process.env.HOME, ".config", "opencode")

// ANSI colors
const c = { reset: "\x1b[0m", green: "\x1b[32m", yellow: "\x1b[33m", dim: "\x1b[2m", red: "\x1b[31m", bold: "\x1b[1m" }

// --- Install mode -----------------------------------------------------------
//   full   (default)  : curated agents + AGENTS.md block + plugin + relay + npm dep
//   agents (--agents-only): curated agents + AGENTS.md block ONLY (fork users)
const argv = process.argv.slice(2)
const MODE = argv.includes("--agents-only") ? "agents" : "full"
const MODE_LABEL = MODE === "agents" ? "agents-only" : "full"

// --- Read version ---
const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
const NEW_VERSION = pkg.version

// --- Paths ---
const VERSION_FILE = join(configRoot, ".installed-version")
const MODE_FILE = join(configRoot, ".installed-mode")
const BACKUP_ROOT = join(configRoot, ".backups")

// Directories/files to EXCLUDE from backup (they are regenerated or too large)
const EXCLUDE_DIRS = new Set(["node_modules", ".backups", ".git"])
const EXCLUDE_FILES = new Set([".relay-token", "bun.lock", "package-lock.json"])

const copyTree = async (source, target) => {
  await mkdir(target, { recursive: true })
  await cp(source, target, { recursive: true, force: true })
}

// --- Recursively copy, excluding unwanted dirs/files ---
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

// --- Backup ENTIRE config directory ---
async function backupExisting() {
  const hasInstallation = existsSync(VERSION_FILE) || existsSync(join(configRoot, "agents"))

  if (!hasInstallation) {
    // Check if config dir has any content at all
    if (!existsSync(configRoot)) {
      return null
    }
    const entries = await readdir(configRoot)
    const meaningful = entries.filter((e) => !e.startsWith(".") && e !== "node_modules")
    if (meaningful.length === 0) {
      return null
    }
  }

  const prevVersion = existsSync(VERSION_FILE)
    ? (await readFile(VERSION_FILE, "utf-8")).trim()
    : "pre-install"
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const backupDir = join(BACKUP_ROOT, `${prevVersion}-${timestamp}`)

  console.log(`  ${c.dim}Backing up entire config directory...${c.reset}`)
  await copyTreeExcluded(configRoot, backupDir, EXCLUDE_DIRS, EXCLUDE_FILES)

  // Save the version we're backing up
  await writeFile(join(backupDir, ".backup-version"), prevVersion, "utf-8")

  console.log(`  ${c.green}✓${c.reset} Full backup saved to ${backupDir}`)
  return { version: prevVersion, dir: backupDir }
}

// --- Restore from backup (full restore) ---
export async function restoreFromBackup(backupDir) {
  // Read what version this backup is
  let backupVersion = "unknown"
  try {
    backupVersion = (await readFile(join(backupDir, ".backup-version"), "utf-8")).trim()
  } catch {}

  console.log(`  ${c.dim}Restoring from backup (v${backupVersion})...${c.reset}`)

  // Clean the config dir completely (except .backups)
  if (existsSync(configRoot)) {
    const entries = await readdir(configRoot)
    for (const entry of entries) {
      if (entry === ".backups") continue
      await rm(join(configRoot, entry), { recursive: true, force: true })
    }
  }

  // Restore everything from backup (except .backups and node_modules)
  await copyTreeExcluded(backupDir, configRoot, EXCLUDE_DIRS, EXCLUDE_FILES)

  // Ensure subagent_depth default is (re)applied additively — never overwrite a
  // value the user set in the backup; just guarantee the key exists. Agents-only
  // (fork) applies it; full (stock) strips it — the key is invalid on stock.
  await mergeSubagentDepth(configRoot, console.log, MODE)

  // Run npm install to restore dependencies
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"
  spawnSync(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact"], {
    cwd: configRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  })

  console.log(`  ${c.green}✓${c.reset} Restored to v${backupVersion}`)
  return backupVersion
}

// --- Clean managed files only (for fresh install on top) ---
// Mode-aware: full mode manages the whole agents/plugins/relay set; agents-only
// mode manages ONLY our own artifacts and never touches other users' plugins.
async function cleanManaged() {
  console.log("  Stopping any running Agent-Teams relay...")
  await killRelayProcesses()

  if (MODE === "agents") {
    // Remove our dirs and files only. The `plugins` dir is NOT removed as a
    // whole — only our specific plugin file is deleted so other user plugins
    // survive a conversion from full -> agents.
    const MANAGED_PATHS = [
      join(configRoot, "agents"),
      join(configRoot, "relay"),
      join(configRoot, "plugins", "agent-teams.ts"),
      join(configRoot, ".relay-token"),
    ]
    for (const target of MANAGED_PATHS) {
      if (!existsSync(target)) continue
      try {
        await rmRetry(target)
      } catch {
        // Still locked by an active background process; copyTree will overwrite in place
      }
    }
    return
  }

  const MANAGED_DIRS = ["agents", "plugins", "relay"]
  const MANAGED_FILES = [".relay-token"]

  for (const dir of MANAGED_DIRS) {
    const target = join(configRoot, dir)
    if (existsSync(target)) {
      try {
        await rmRetry(target)
      } catch {
        // Directory locked by active background process; copyTree will overwrite files in place
      }
    }
  }
  for (const file of MANAGED_FILES) {
    const target = join(configRoot, file)
    if (existsSync(target)) {
      try {
        await rm(target, { force: true })
      } catch {
        // File locked; copyTree will overwrite
      }
    }
  }
}

// --- Prune old backups, keep only the last 5 ---
async function pruneBackups() {
  if (!existsSync(BACKUP_ROOT)) return
  const entries = await readdir(BACKUP_ROOT)
  if (entries.length <= 5) return

  const sorted = entries.sort()
  const toRemove = sorted.slice(0, sorted.length - 5)
  for (const name of toRemove) {
    await rm(join(BACKUP_ROOT, name), { recursive: true, force: true })
    console.log(`  ${c.dim}Pruned old backup: ${name}${c.reset}`)
  }
}

// --- Merge plugin dependency ---
const mergePluginDependency = async () => {
  const packagePath = join(configRoot, "package.json")
  let config = {}
  if (existsSync(packagePath)) {
    try {
      config = JSON.parse(await readFile(packagePath, "utf8"))
    } catch {
      throw new Error(`Cannot parse ${packagePath}; fix it before installing Agent-Teams.`)
    }
  }
  config.dependencies = { ...(config.dependencies || {}), "@opencode-ai/plugin": "1.2.27" }
  await writeFile(packagePath, `${JSON.stringify(config, null, 2)}\n`, "utf8")

  const npm = process.platform === "win32" ? "npm.cmd" : "npm"
  const result = spawnSync(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact"], {
    cwd: configRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}

// --- Merge AGENTS.md (append-or-replace our marked block, never clobber user content) ---
async function mergeAgentsMd() {
  const target = join(configRoot, "AGENTS.md")
  const AGENTS_MD = join(packageRoot, "AGENTS.md")
  const START_MARKER = "<!-- agent-teams-orchestration:start -->"
  const END_MARKER   = "<!-- agent-teams-orchestration:end -->"

  let packageContent = ""
  try {
    packageContent = (await readFile(AGENTS_MD, "utf-8")).trimEnd()
  } catch {
    return // No AGENTS.md in package — nothing to do
  }

  // Ensure the package content is wrapped with our markers
  if (!packageContent.includes(START_MARKER)) {
    packageContent = `${START_MARKER}\n${packageContent}\n${END_MARKER}`
  }

  // Fresh install — no AGENTS.md exists yet
  if (!existsSync(target)) {
    await writeFile(target, packageContent + "\n", "utf-8")
    console.log(`  ${c.green}✓${c.reset} Created AGENTS.md`)
    return
  }

  const existing = await readFile(target, "utf-8")

  // Re-install / upgrade — replace only our marked block, preserve everything else
  if (existing.includes(START_MARKER) && existing.includes(END_MARKER)) {
    const before = existing.slice(0, existing.indexOf(START_MARKER))
    const after  = existing.slice(existing.indexOf(END_MARKER) + END_MARKER.length)
    const merged = before.trimEnd() + "\n\n" + packageContent + "\n" + after.trimStart()
    await writeFile(target, merged, "utf-8")
    console.log(`  ${c.green}✓${c.reset} Updated orchestration rules in AGENTS.md`)
    return
  }

  // First install on a user who already has their own AGENTS.md — append our block
  const merged = existing.trimEnd() + "\n\n" + packageContent + "\n"
  await writeFile(target, merged, "utf-8")
  console.log(`  ${c.green}✓${c.reset} Appended orchestration rules to existing AGENTS.md`)
}

// ============================================================
// MAIN INSTALL
// ============================================================

console.log(`\n  Agent-Teams v${NEW_VERSION} installer\n`)
console.log(`  ${c.dim}Mode: ${MODE_LABEL}${MODE === "agents" ? " (agents only — no plugin/relay/npm)" : " (agents + plugin + relay + npm)"}${c.reset}\n`)

// Step 1: Full backup of everything
const backup = await backupExisting()

// Step 2: Clean only managed files (mode-aware)
await cleanManaged()

// Step 3: Copy new agent-teams files (mode-aware: agents-only copies agents only)
await copyTree(join(packageRoot, "agents", "orchestrators"), join(configRoot, "agents"))
await copyTree(join(packageRoot, "agents", "specialists"), join(configRoot, "agents"))
if (MODE === "agents") {
  // Fork-correct Agent-Teams: on the native fork (no relay) the orchestrator
  // must use Task(background=true)/next_agent/agents_status, not running_agents.
  // Overwrite the relay-based orchestrator with the fork variant.
  const forkAgent = join(packageRoot, "agents", "orchestrators-fork", "orchestrator-agent-teams.md")
  if (existsSync(forkAgent)) {
    await cp(forkAgent, join(configRoot, "agents", "orchestrator-agent-teams.md"), { force: true })
    console.log(`  ${c.dim}Fork mode: installed native Agent-Teams orchestrator.${c.reset}`)
  }
}
if (MODE === "full") {
  await copyTree(join(packageRoot, "plugins"), join(configRoot, "plugins"))
  await copyTree(join(packageRoot, "relay"), join(configRoot, "relay"))
}

// Step 4: Write version + mode markers (mode marker in BOTH modes — also upgrades
// legacy installs that predate the marker to have one on their next run)
await writeFile(VERSION_FILE, NEW_VERSION, "utf-8")
await writeFile(MODE_FILE, MODE, "utf-8")

// Step 5: Merge AGENTS.md (both modes — it is part of the curated profile)
await mergeAgentsMd()

// Step 6: Merge subagent_depth default into the user's global opencode.json.
// MODE-AWARE: agents-only (fork) APPLIES the key (the fork core understands it);
// full (stock opencode) STRIPS it — the stable core rejects `subagent_depth` as
// an unrecognized key and refuses to start. Additive in agents mode: preserves
// every existing key (MCP servers, model, provider, etc.).
await mergeSubagentDepth(configRoot, console.log, MODE)

// Step 7: Merge dependency and run npm install (FULL mode only; agents-only does
// NOT touch configRoot package.json and performs no npm install)
if (MODE === "full") {
  await mergePluginDependency()
} else {
  console.log(`  ${c.dim}Skipping npm dependency install (agents-only mode).${c.reset}`)
}

// Step 7: Prune old backups (keep last 5)
await pruneBackups()

console.log(`\n  ${c.green}${c.bold}✓ Installed Agent-Teams v${NEW_VERSION} (${MODE_LABEL} mode)${c.reset}`)
console.log(`  ${c.dim}Location: ${configRoot}${c.reset}`)
if (backup) {
  console.log(`  ${c.yellow}Full backup:${c.reset} ${backup.dir}`)
  console.log(`  ${c.yellow}To revert:${c.reset}   npx opencode-agent-teams-relay-uninstall revert`)
}
if (MODE === "agents") {
  console.log(`\n  ${c.yellow}Agents-only mode:${c.reset} plugin/relay/npm were NOT installed (intended for the native fork where the plugin is redundant).`)
}
console.log(`\n  ${c.bold}Restart opencode${c.reset} to load the new ${MODE === "agents" ? "agents" : "agents and plugin"}.\n`)
