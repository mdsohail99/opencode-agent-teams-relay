#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import readline from "node:readline/promises"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "..")

const args = process.argv.slice(2)
const binName = path.basename(process.argv[1] || "")

// ANSI styling
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
}

function resolveConfigRoot(globalMode = true) {
  if (globalMode) {
    if (process.env.OPENCODE_CONFIG_DIR) {
      return path.resolve(process.env.OPENCODE_CONFIG_DIR)
    }
    return path.join(os.homedir(), ".config", "opencode")
  }
  return process.cwd()
}

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

function getStatus(globalMode = true) {
  const targetDir = resolveConfigRoot(globalMode)
  const configPath = path.resolve(targetDir, "opencode.json")
  const agentsDir = globalMode
    ? path.resolve(targetDir, "agents")
    : path.resolve(targetDir, ".opencode", "agents")

  let configExists = false
  let subagentDepth = null
  let isPluginRegistered = false
  let agentCount = 0

  if (fs.existsSync(configPath)) {
    configExists = true
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"))
      subagentDepth = parsed.subagent_depth ?? null
      if (Array.isArray(parsed.plugins)) {
        isPluginRegistered = parsed.plugins.some(
          (p) => typeof p === "string" && (p.includes("agent-teams") || p.includes("orchestration"))
        )
      }
    } catch {}
  }

  if (fs.existsSync(agentsDir)) {
    try {
      agentCount = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md")).length
    } catch {}
  }

  const isInstalled = isPluginRegistered && agentCount > 0
  return {
    targetDir,
    configPath,
    agentsDir,
    configExists,
    subagentDepth,
    isPluginRegistered,
    agentCount,
    isInstalled,
  }
}

async function doInstall(globalMode = true) {
  const targetDir = resolveConfigRoot(globalMode)
  const configPath = path.resolve(targetDir, "opencode.json")
  const agentsTargetDir = globalMode
    ? path.resolve(targetDir, "agents")
    : path.resolve(targetDir, ".opencode", "agents")
  const manifestPath = path.resolve(agentsTargetDir, ".agent-teams-manifest.json")

  console.log(`\n${c.cyan}Installing Agent-Teams (${globalMode ? "Global" : "Local"})...${c.reset}`)
  console.log(`${c.dim}Target directory: ${targetDir}${c.reset}`)

  let config = {
    $schema: "https://opencode.ai/config.json",
    subagent_depth: 2,
    plugins: [],
  }

  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
    } catch (err) {
      console.warn("Notice: Creating fresh config structure due to parse error.")
    }
  }

  config.subagent_depth = 2

  const pluginRef = fs.existsSync(path.join(rootDir, "src", "index.ts"))
    ? rootDir.replace(/\\/g, "/")
    : "@mdsohail99/opencode-agent-teams"

  if (!Array.isArray(config.plugins)) {
    config.plugins = []
  }
  if (!config.plugins.includes(pluginRef)) {
    config.plugins.push(pluginRef)
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8")
  console.log(`  ${c.green}✓${c.reset} Configured opencode.json (subagent_depth: 2, plugin: ${pluginRef})`)

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
      JSON.stringify({ plugin: "@mdsohail99/opencode-agent-teams", version: "2.0.0", files: installedList }, null, 2),
      "utf-8"
    )
    console.log(`  ${c.green}✓${c.reset} Installed ${installedList.length} curated agents into ${agentsTargetDir}`)
  }

  console.log(`\n${c.green}${c.bold}✓ Setup complete!${c.reset} Launch OpenCode with ${c.bold}opencode${c.reset} and select agent-teams.\n`)
}

async function doUninstall(globalMode = true) {
  const targetDir = resolveConfigRoot(globalMode)
  const configPath = path.resolve(targetDir, "opencode.json")
  const agentsTargetDir = globalMode
    ? path.resolve(targetDir, "agents")
    : path.resolve(targetDir, ".opencode", "agents")
  const manifestPath = path.resolve(agentsTargetDir, ".agent-teams-manifest.json")

  console.log(`\n${c.yellow}Uninstalling Agent-Teams (${globalMode ? "Global" : "Local"})...${c.reset}`)
  console.log(`${c.dim}Target directory: ${targetDir}${c.reset}`)

  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8")
      const config = JSON.parse(raw)
      if (Array.isArray(config.plugins)) {
        const beforeCount = config.plugins.length
        config.plugins = config.plugins.filter((p) => {
          if (typeof p === "string" && (p.includes("agent-teams") || p.includes("orchestration"))) return false
          return true
        })
        if (config.plugins.length !== beforeCount) {
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8")
          console.log(`  ${c.green}✓${c.reset} Removed plugin from opencode.json`)
        }
      }
    } catch {}
  }

  let filesRemoved = 0
  if (fs.existsSync(agentsTargetDir)) {
    let filesToDelete = []
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
        if (Array.isArray(manifest.files)) filesToDelete = manifest.files
      } catch {}
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

    try {
      const remaining = fs.readdirSync(agentsTargetDir)
      if (remaining.length === 0) fs.rmdirSync(agentsTargetDir)
    } catch {}

    console.log(`  ${c.green}✓${c.reset} Removed ${filesRemoved} agent markdown files from ${agentsTargetDir}`)
  }

  console.log(`\n${c.green}${c.bold}✓ Uninstall complete!${c.reset} Agent-Teams cleanly removed.\n`)
}

function printStatus() {
  const globalStat = getStatus(true)
  const localStat = getStatus(false)

  console.log(`\n${c.bold}${c.cyan}Agent-Teams v2 Status Report${c.reset}\n`)
  console.log(`${c.bold}Global Configuration (~/.config/opencode):${c.reset}`)
  console.log(`  Status:         ${globalStat.isInstalled ? c.green + "Installed (Active)" + c.reset : c.dim + "Not Installed" + c.reset}`)
  console.log(`  Config Path:    ${globalStat.configPath}`)
  console.log(`  Subagent Depth: ${globalStat.subagentDepth ?? "not set"}`)
  console.log(`  Plugin Linked:  ${globalStat.isPluginRegistered ? c.green + "Yes" + c.reset : "No"}`)
  console.log(`  Agents Count:   ${globalStat.agentCount} agents in ${globalStat.agentsDir}`)

  console.log(`\n${c.bold}Local Directory Configuration (.opencode):${c.reset}`)
  console.log(`  Status:         ${localStat.isInstalled ? c.green + "Installed (Local Active)" + c.reset : c.dim + "Not Installed" + c.reset}`)
  console.log(`  Config Path:    ${localStat.configPath}`)
  console.log(`  Plugin Linked:  ${localStat.isPluginRegistered ? c.green + "Yes" + c.reset : "No"}`)
  console.log(`  Agents Count:   ${localStat.agentCount} agents\n`)
}

async function runInteractiveMenu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  while (true) {
    const stat = getStatus(true)
    console.log(`
${c.bold}${c.cyan}┌────────────────────────────────────────────────────────┐${c.reset}
${c.bold}${c.cyan}│          Agent-Teams v2 Setup & Management             │${c.reset}
${c.bold}${c.cyan}└────────────────────────────────────────────────────────┘${c.reset}
  ${c.dim}Global Config:${c.reset} ${stat.targetDir}
  ${c.dim}Status:${c.reset}        ${stat.isInstalled ? c.green + "● Installed & Active" + c.reset : c.yellow + "○ Not Installed" + c.reset} ${stat.isInstalled ? `(Agents: ${stat.agentCount}, Depth: ${stat.subagentDepth})` : ""}

  ${c.cyan}1${c.reset}  Install / Update Agent-Teams ${c.green}(Global - Recommended)${c.reset}
  ${c.cyan}2${c.reset}  Install to Current Project Only ${c.dim}(Local)${c.reset}
  ${c.cyan}3${c.reset}  Inspect Status & Registered Agents
  ${c.cyan}4${c.reset}  Uninstall Agent-Teams
  ${c.cyan}5${c.reset}  Exit
`)

    const choice = (await rl.question(`  ${c.bold}Choose option [1-5]:${c.reset} `)).trim()

    if (choice === "1") {
      await doInstall(true)
    } else if (choice === "2") {
      await doInstall(false)
    } else if (choice === "3") {
      printStatus()
    } else if (choice === "4") {
      await doUninstall(true)
    } else if (choice === "5" || choice.toLowerCase() === "q" || choice.toLowerCase() === "exit") {
      console.log(`\n${c.dim}Goodbye!${c.reset}\n`)
      break
    } else {
      console.log(`\n${c.red}Invalid choice. Please select 1-5.${c.reset}`)
    }

    await rl.question(`\n${c.dim}Press Enter to return to menu...${c.reset}`)
  }

  rl.close()
}

// -------------------------------------------------------------
// CLI EXECUTION DISPATCHER
// -------------------------------------------------------------
const isUninstallCommand =
  binName.includes("uninstall") ||
  args.includes("uninstall") ||
  args.includes("--uninstall") ||
  args.includes("-u")

const isLocal = args.includes("--local") || args.includes("-l")
const isGlobal = !isLocal
const isHelp = args.includes("--help") || args.includes("-h")
const isStatus = args.includes("status") || args.includes("--status")
const isInstallExplicit = args.includes("install") || args.includes("--install")

if (isHelp) {
  console.log(`
Agent-Teams v2 CLI for OpenCode

Usage:
  npx @mdsohail99/opencode-agent-teams                     Launch interactive menu (default)
  npx @mdsohail99/opencode-agent-teams install [options]   Install Agent-Teams plugin and agents
  npx @mdsohail99/opencode-agent-teams uninstall [options] Uninstall Agent-Teams cleanly
  npx @mdsohail99/opencode-agent-teams status              Inspect current status

Options:
  -l, --local      Target current project directory only instead of global OpenCode (~/.config/opencode)
  -u, --uninstall  Uninstall Agent-Teams and remove associated agents
  -h, --help       Show this help message
`)
  process.exit(0)
}

if (isStatus) {
  printStatus()
  process.exit(0)
}

if (isUninstallCommand) {
  await doUninstall(isGlobal)
  process.exit(0)
}

if (isInstallExplicit) {
  await doInstall(isGlobal)
  process.exit(0)
}

// If invoked without arguments:
// In an interactive TTY -> launch interactive menu!
// In a non-interactive/scripted environment -> default to install
if (process.stdin.isTTY && args.length === 0) {
  await runInteractiveMenu()
} else {
  await doInstall(isGlobal)
}
