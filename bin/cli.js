#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "..")

const args = process.argv.slice(2)
const binName = path.basename(process.argv[1] || "")
const isUninstallCommand =
  binName.includes("uninstall") ||
  args.includes("uninstall") ||
  args.includes("--uninstall") ||
  args.includes("-u")

const isLocal = args.includes("--local") || args.includes("-l")
const isGlobal = !isLocal
const isHelp = args.includes("--help") || args.includes("-h")

if (isHelp) {
  console.log(`
Agent-Teams v2 CLI for OpenCode

Usage:
  npx opencode-agent-teams [install] [options]    Install Agent-Teams plugin and agents (Global by default)
  npx opencode-agent-teams uninstall [options]    Uninstall Agent-Teams cleanly (Global by default)
  npx opencode-agent-teams-uninstall [options]    Direct uninstall shortcut

Options:
  -l, --local      Target current project directory only instead of global OpenCode (~/.config/opencode)
  -u, --uninstall  Uninstall Agent-Teams and remove associated agents
  -h, --help       Show this help message
`)
  process.exit(0)
}

function resolveTargetDir() {
  if (isGlobal) {
    if (process.env.OPENCODE_CONFIG_DIR) {
      return path.resolve(process.env.OPENCODE_CONFIG_DIR)
    }
    return path.join(os.homedir(), ".config", "opencode")
  }
  return process.cwd()
}

const targetDir = resolveTargetDir()
const configPath = path.resolve(targetDir, "opencode.json")
const agentsTargetDir = isGlobal
  ? path.resolve(targetDir, "agents")
  : path.resolve(targetDir, ".opencode", "agents")
const manifestPath = path.resolve(agentsTargetDir, ".agent-teams-manifest.json")

console.log("==================================================")
console.log(` Agent-Teams v2: ${isUninstallCommand ? "Uninstall" : "Install"} (${isGlobal ? "Global" : "Local"})`)
console.log("==================================================")
console.log(`Target directory: ${targetDir}`)

// Helper to collect all shipped markdown agent files
function getShippedAgents() {
  const shipped = []
  const sourceAgentsDir = path.resolve(rootDir, "agents")
  if (!fs.existsSync(sourceAgentsDir)) return shipped

  function scan(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, item.name)
      if (item.isDirectory()) {
        scan(p)
      } else if (item.isFile() && item.name.endsWith(".md")) {
        shipped.push({
          name: item.name,
          sourcePath: p,
        })
      }
    }
  }
  scan(sourceAgentsDir)
  return shipped
}

// -------------------------------------------------------------
// UNINSTALL FLOW
// -------------------------------------------------------------
if (isUninstallCommand) {
  let modifiedConfig = false

  // 1. Remove from opencode.json
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8")
      const config = JSON.parse(raw)
      if (Array.isArray(config.plugins)) {
        const beforeCount = config.plugins.length
        config.plugins = config.plugins.filter((p) => {
          if (p === "opencode-agent-teams") return false
          if (typeof p === "string" && (p.includes("orchestration") || p.endsWith("agent-teams"))) return false
          return true
        })
        if (config.plugins.length !== beforeCount) {
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8")
          console.log("✓ Removed opencode-agent-teams from plugins in opencode.json")
          modifiedConfig = true
        }
      }
    } catch (err) {
      console.warn("Notice: Failed to update opencode.json during uninstall:", err.message)
    }
  }

  // 2. Remove installed agents
  let filesRemoved = 0
  if (fs.existsSync(agentsTargetDir)) {
    let filesToDelete = []

    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
        if (Array.isArray(manifest.files)) {
          filesToDelete = manifest.files
        }
      } catch {
        // Fallback to scanning shipped agents
      }
    }

    if (filesToDelete.length === 0) {
      filesToDelete = getShippedAgents().map((a) => a.name)
    }

    for (const file of filesToDelete) {
      const targetFile = path.resolve(agentsTargetDir, file)
      if (fs.existsSync(targetFile)) {
        try {
          fs.unlinkSync(targetFile)
          filesRemoved++
        } catch {}
      }
    }

    if (fs.existsSync(manifestPath)) {
      try {
        fs.unlinkSync(manifestPath)
      } catch {}
    }

    // If agents directory is now empty, clean it up
    try {
      const remaining = fs.readdirSync(agentsTargetDir)
      if (remaining.length === 0) {
        fs.rmdirSync(agentsTargetDir)
      }
    } catch {}

    console.log(`✓ Removed ${filesRemoved} Agent-Teams agent markdown files from ${agentsTargetDir}`)
  }

  console.log("\nUninstall complete! Agent-Teams has been cleanly removed.")
  process.exit(0)
}

// -------------------------------------------------------------
// INSTALL FLOW
// -------------------------------------------------------------
let config = {
  $schema: "https://opencode.ai/config.json",
  subagent_depth: 2,
  plugins: ["opencode-agent-teams"],
}

if (fs.existsSync(configPath)) {
  try {
    const raw = fs.readFileSync(configPath, "utf-8")
    config = JSON.parse(raw)
  } catch (err) {
    console.error("Notice: Could not parse existing opencode.json, creating clean config:", err.message)
  }
}

// Ensure subagent_depth: 2 for hierarchical swarm orchestration
config.subagent_depth = 2

// Ensure plugin entry is present (uses local repo path if running from local checkout, or package name if installed via npm)
const pluginRef = fs.existsSync(path.join(rootDir, "src", "index.ts"))
  ? rootDir.replace(/\\/g, "/")
  : "opencode-agent-teams"

if (!Array.isArray(config.plugins)) {
  config.plugins = []
}
if (!config.plugins.includes(pluginRef)) {
  config.plugins.push(pluginRef)
}

fs.mkdirSync(path.dirname(configPath), { recursive: true })
fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8")
console.log("✓ Configured opencode.json with subagent_depth: 2 and plugin registration")

// Copy curated agents to agents directory and write manifest
const shippedAgents = getShippedAgents()
if (shippedAgents.length > 0) {
  fs.mkdirSync(agentsTargetDir, { recursive: true })
  const installedList = []

  for (const agent of shippedAgents) {
    const dest = path.resolve(agentsTargetDir, agent.name)
    fs.copyFileSync(agent.sourcePath, dest)
    installedList.push(agent.name)
  }

  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ plugin: "opencode-agent-teams", version: "2.0.0", files: installedList }, null, 2),
    "utf-8"
  )
  console.log(`✓ Installed ${installedList.length} curated Department Leads and Specialists into ${agentsTargetDir}`)
}

console.log("\nSetup complete! You can now launch OpenCode with full hierarchical multi-agent teams.")
