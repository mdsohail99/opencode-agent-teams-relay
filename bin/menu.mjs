#!/usr/bin/env node

import { createInterface } from "node:readline"
import { cp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { uninstall, revert, status, deleteBackup } from "./uninstall.mjs"
import { killRelayProcesses, rmRetry } from "./lib/relay-process.mjs"
import { mergeSubagentDepth } from "./lib/merge-subagent-depth.mjs"

// --- ANSI colors ---
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgBlue: "\x1b[44m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const configRoot = process.env.OPENCODE_CONFIG_DIR || join(process.env.USERPROFILE || process.env.HOME, ".config", "opencode")

const MANAGED_DIRS = ["agents", "plugins", "relay"]
const MANAGED_FILES = [".relay-token"]
const VERSION_FILE = join(configRoot, ".installed-version")
const BACKUP_ROOT = join(configRoot, ".backups")

// --- Helpers ---

async function getCurrentVersion() {
  if (!existsSync(VERSION_FILE)) return null
  return (await readFile(VERSION_FILE, "utf-8")).trim()
}

async function listBackups() {
  if (!existsSync(BACKUP_ROOT)) return []
  const entries = await readdir(BACKUP_ROOT)
  const backups = []
  for (const name of entries) {
    const dir = join(BACKUP_ROOT, name)
    let version = "unknown"
    // New backups use .backup-version, old ones use .installed-version
    for (const vf of [".backup-version", ".installed-version"]) {
      try {
        version = (await readFile(join(dir, vf), "utf-8")).trim()
        break
      } catch {}
    }
    backups.push({ name, dir, version })
  }
  return backups.sort((a, b) => b.name.localeCompare(a.name))
}

function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[H")
}

function printHeader() {
  console.log("")
  console.log(`${c.bold}${c.cyan}  ╔══════════════════════════════════════════╗${c.reset}`)
  console.log(`${c.bold}${c.cyan}  ║     ${c.white}Agent-Teams Orchestration${c.cyan}           ║${c.reset}`)
  console.log(`${c.bold}${c.cyan}  ╚══════════════════════════════════════════╝${c.reset}`)
  console.log("")
}

function printBox(lines) {
  const maxLen = Math.max(...lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").length))
  console.log(`${c.dim}  ┌${"─".repeat(maxLen + 2)}┐${c.reset}`)
  for (const line of lines) {
    const plainLen = line.replace(/\x1b\[[0-9;]*m/g, "").length
    const pad = " ".repeat(maxLen - plainLen)
    console.log(`${c.dim}  │${c.reset} ${line}${pad} ${c.dim}│${c.reset}`)
  }
  console.log(`${c.dim}  └${"─".repeat(maxLen + 2)}┘${c.reset}`)
}

function prompt(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()))
  })
}

function promptChoice(rl, question, options) {
  return new Promise((resolve) => {
    console.log("")
    for (let i = 0; i < options.length; i++) {
      console.log(`  ${c.cyan}${i + 1}${c.reset}  ${options[i].label}`)
    }
    console.log("")
    rl.question(`  ${c.dim}Choose [1-${options.length}]${c.reset}: `, (answer) => {
      const idx = parseInt(answer, 10) - 1
      if (idx >= 0 && idx < options.length) {
        resolve(options[idx])
      } else {
        resolve(null)
      }
    })
  })
}

// --- Install logic ---

const EXCLUDE_DIRS = new Set(["node_modules", ".backups", ".git"])
const EXCLUDE_FILES = new Set([".relay-token", "bun.lock", "package-lock.json"])

async function copyTree(source, target) {
  await mkdir(target, { recursive: true })
  await cp(source, target, { recursive: true, force: true })
}

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

async function backupExisting() {
  if (!existsSync(VERSION_FILE) && !existsSync(join(configRoot, "agents"))) return null

  const prevVersion = existsSync(VERSION_FILE)
    ? (await readFile(VERSION_FILE, "utf-8")).trim()
    : "pre-install"
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const backupDir = join(BACKUP_ROOT, `${prevVersion}-${timestamp}`)

  console.log(`  ${c.dim}Backing up config directory...${c.reset}`)
  await copyTreeExcluded(configRoot, backupDir, EXCLUDE_DIRS, EXCLUDE_FILES)
  await writeFile(join(backupDir, ".backup-version"), prevVersion, "utf-8")
  return { version: prevVersion, dir: backupDir }
}

async function getInstalledMode() {
  const modeFile = join(configRoot, ".installed-mode")
  if (existsSync(modeFile)) {
    return (await readFile(modeFile, "utf-8")).trim() === "agents" ? "agents" : "full"
  }
  return "full"
}

async function cleanManaged(mode) {
  console.log("  Stopping any running Agent-Teams relay...")
  await killRelayProcesses()

  if (mode === "agents") {
    // Surgical: remove only agent-teams artifacts, never other user plugins.
    for (const dir of ["agents", "relay"]) {
      const target = join(configRoot, dir)
      if (existsSync(target)) await rmRetry(target)
    }
    const pluginFile = join(configRoot, "plugins", "agent-teams.ts")
    if (existsSync(pluginFile)) await rmRetry(pluginFile)
    const token = join(configRoot, ".relay-token")
    if (existsSync(token)) await rmRetry(token)
  } else {
    for (const dir of MANAGED_DIRS) {
      const target = join(configRoot, dir)
      if (existsSync(target)) await rmRetry(target)
    }
    for (const file of MANAGED_FILES) {
      const target = join(configRoot, file)
      if (existsSync(target)) await rmRetry(target)
    }
  }
}

async function installFiles(mode) {
  await copyTree(join(packageRoot, "agents", "orchestrators"), join(configRoot, "agents"))
  await copyTree(join(packageRoot, "agents", "specialists"), join(configRoot, "agents"))
  if (mode === "agents") {
    // Fork-correct Agent-Teams: on the native fork (no relay) the orchestrator
    // must use Task(background=true)/next_agent/agents_status, not running_agents.
    // Overwrite the relay-based orchestrator with the fork variant.
    const forkAgent = join(packageRoot, "agents", "orchestrators-fork", "orchestrator-agent-teams.md")
    if (existsSync(forkAgent)) {
      await cp(forkAgent, join(configRoot, "agents", "orchestrator-agent-teams.md"), { force: true })
      console.log(`  ${c.dim}Fork mode: installed native Agent-Teams orchestrator.${c.reset}`)
    }
  }
  if (mode === "full") {
    await copyTree(join(packageRoot, "plugins"), join(configRoot, "plugins"))
    await copyTree(join(packageRoot, "relay"), join(configRoot, "relay"))
  }
}

async function writeModeMarker(mode) {
  await writeFile(join(configRoot, ".installed-mode"), mode, "utf-8")
}

async function promptMode(rl) {
  const options = [
    {
      label: `${c.bold}Full${c.reset}       — agents + plugin + relay (stock opencode)`,
      value: "full",
    },
    {
      label: `${c.bold}Agents-only${c.reset} — curated agents + AGENTS.md only (native fork)`,
      value: "agents",
    },
  ]
  const choice = await promptChoice(rl, "  Select install mode:", options)
  return choice?.value ?? "full"
}

async function pruneBackups() {
  if (!existsSync(BACKUP_ROOT)) return
  const entries = await readdir(BACKUP_ROOT)
  if (entries.length <= 5) return
  const sorted = entries.sort()
  for (const name of sorted.slice(0, sorted.length - 5)) {
    await rm(join(BACKUP_ROOT, name), { recursive: true, force: true })
  }
}

async function mergePluginDependency() {
  const packagePath = join(configRoot, "package.json")
  let config = {}
  if (existsSync(packagePath)) {
    try {
      config = JSON.parse(await readFile(packagePath, "utf8"))
    } catch {
      throw new Error(`Cannot parse ${packagePath}; fix it before installing.`)
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

async function mergeAgentsMd() {
  const target = join(configRoot, "AGENTS.md")
  const AGENTS_MD = join(packageRoot, "AGENTS.md")
  const marker = "<!-- agent-teams-orchestration:start -->"

  let packageContent = ""
  try {
    packageContent = await readFile(AGENTS_MD, "utf-8")
  } catch {
    return
  }

  if (!existsSync(target)) {
    await writeFile(target, packageContent, "utf-8")
    console.log(`  ${c.green}✓${c.reset} Created AGENTS.md`)
    return
  }

  const existing = await readFile(target, "utf-8")
  if (existing.includes(marker)) {
    console.log(`  ${c.dim}  AGENTS.md already contains orchestration rules, skipping${c.reset}`)
    return
  }

  await writeFile(target, existing + "\n\n" + packageContent + "\n", "utf-8")
  console.log(`  ${c.green}✓${c.reset} Appended orchestration rules to existing AGENTS.md`)
}

async function doInstall(rl) {
  const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
  const NEW_VERSION = pkg.version
  const currentVersion = await getCurrentVersion()

  if (currentVersion) {
    printBox([
      `${c.yellow}Current version:${c.reset} v${currentVersion}`,
      `${c.yellow}New version:${c.reset}     v${NEW_VERSION}`,
    ])
    console.log("")

    if (currentVersion === NEW_VERSION) {
      console.log(`  ${c.yellow}Already up to date.${c.reset}`)
      const answer = await prompt(rl, `  Reinstall anyway? [y/N] `)
      if (answer.toLowerCase() !== "y") return
    } else {
      const answer = await prompt(rl, `  Upgrade from v${currentVersion} to v${NEW_VERSION}? [Y/n] `)
      if (answer.toLowerCase() === "n") return
    }

    // Backup
    console.log(`\n  ${c.dim}Backing up current installation...${c.reset}`)
    const backup = await backupExisting()
    if (backup) {
      console.log(`  ${c.green}✓${c.reset} Backed up v${backup.version} to ${backup.dir}`)
    }
  } else {
    console.log(`  Installing Agent-Teams v${NEW_VERSION} fresh.\n`)
  }

  const mode = await promptMode(rl)

  // Clean + Install
  console.log(`  ${c.dim}Cleaning old files...${c.reset}`)
  await cleanManaged(mode)

  console.log(`  ${c.dim}Copying ${mode === "agents" ? "agents" : "agents, plugins, relay"}...${c.reset}`)
  await installFiles(mode)

  await writeFile(VERSION_FILE, NEW_VERSION, "utf-8")
  await writeModeMarker(mode)

  console.log(`  ${c.dim}Merging AGENTS.md rules...${c.reset}`)
  await mergeAgentsMd()

  console.log(`  ${c.dim}Ensuring subagent_depth default in global config...${c.reset}`)
  await mergeSubagentDepth(configRoot)

  if (mode === "full") {
    console.log(`  ${c.dim}Installing npm dependencies...${c.reset}`)
    await mergePluginDependency()
  }

  await pruneBackups()

  console.log("")
  printBox([
    `${c.green}${c.bold}✓ Installed Agent-Teams v${NEW_VERSION}${c.reset}`,
    `${c.dim}Mode: ${mode === "agents" ? "agents-only" : "full"}${c.reset}`,
  ])
  console.log(`\n  ${c.bold}Restart opencode${c.reset} to load the new agents${mode === "full" ? " and plugin" : ""}.\n`)
}

// --- Main TUI ---

async function main() {
  clearScreen()
  printHeader()

  const rl = createInterface({ input: process.stdin, output: process.stdout })

  try {
    const currentVersion = await getCurrentVersion()
    const installedMode = await getInstalledMode()
    const backups = await listBackups()
    const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))

    // Status line
    if (currentVersion) {
      console.log(
        `  ${c.green}●${c.reset} Installed: ${c.bold}v${currentVersion}${c.reset}${currentVersion === pkg.version ? "" : `  ${c.dim}(new: v${pkg.version})${c.reset}`}  ${c.dim}|${c.reset}  Mode: ${c.bold}${installedMode === "agents" ? "agents-only" : "full"}${c.reset}  ${c.dim}|${c.reset}  Backups: ${backups.length}`,
      )
    } else {
      console.log(`  ${c.red}●${c.reset} Not installed  ${c.dim}|  available: v${pkg.version}${c.reset}`)
    }
    console.log(`  ${c.dim}Config: ${configRoot}${c.reset}`)
    console.log("")

    const options = [
      {
        label: currentVersion ? `${c.bold}Upgrade${c.reset}  (backup + install latest)` : `${c.bold}Install${c.reset}  (fresh setup)`,
        value: "install",
      },
      ...(currentVersion
        ? [
            {
              label: `${c.bold}Reinstall${c.reset} (same version, no backup)`,
              value: "reinstall",
            },
          ]
        : []),
      ...(backups.length > 0
        ? [
            {
              label: `${c.bold}Revert${c.reset}   (restore a previous version)`,
              value: "revert",
            },
            {
              label: `${c.bold}Clean Backups${c.reset} (delete old backup files)`,
              value: "clean-backups",
            },
          ]
        : []),
      ...(currentVersion
        ? [
            {
              label: `${c.bold}Uninstall${c.reset} (remove Agent-Teams)`,
              value: "uninstall",
            },
          ]
        : []),
      {
        label: `${c.bold}Status${c.reset}   (show version and backups)`,
        value: "status",
      },
      {
        label: `${c.dim}Exit${c.reset}`,
        value: "exit",
      },
    ]

    const choice = await promptChoice(rl, "", options)

    if (!choice || choice.value === "exit") {
      console.log(`\n  ${c.dim}Bye!${c.reset}\n`)
      return
    }

    console.log("")

    switch (choice.value) {
      case "install":
        await doInstall(rl)
        break

      case "reinstall": {
        // Reinstall without backup
        const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
        console.log(`  ${c.dim}Reinstalling v${pkg.version}...${c.reset}\n`)
        const mode = await promptMode(rl)
        await cleanManaged(mode)
        await installFiles(mode)
        await writeFile(VERSION_FILE, pkg.version, "utf-8")
        await writeModeMarker(mode)
        await mergeAgentsMd()
        await mergeSubagentDepth(configRoot)
        if (mode === "full") await mergePluginDependency()
        console.log("")
        printBox([`${c.green}${c.bold}✓ Reinstalled v${pkg.version}${c.reset}`, `${c.dim}Mode: ${mode === "agents" ? "agents-only" : "full"}${c.reset}`])
        console.log(`\n  ${c.bold}Restart opencode${c.reset} to load the agents${mode === "full" ? " and plugin" : ""}.\n`)
        break
      }

      case "revert": {
        if (backups.length === 1) {
          await revert(backups[0].name)
        } else {
          const revertOptions = backups.map((b) => ({
            label: `v${b.version}  (${b.name})`,
            value: b.name,
          }))
          revertOptions.push({ label: `${c.dim}Cancel${c.reset}`, value: null })

          const target = await promptChoice(rl, "  Select backup to restore:", revertOptions)
          if (target && target.value) {
            await revert(target.value)
          } else {
            console.log(`\n  ${c.dim}Cancelled.${c.reset}\n`)
          }
        }
        break
      }

      case "clean-backups": {
        const cleanOptions = backups.map((b) => ({
          label: `Delete v${b.version} (${b.name})`,
          value: b.name,
        }))
        cleanOptions.push({ label: `${c.red}Delete ALL backups${c.reset}`, value: "all" })
        cleanOptions.push({ label: `${c.dim}Cancel${c.reset}`, value: null })

        const choice = await promptChoice(rl, "  Select backup to delete:", cleanOptions)
        if (choice && choice.value) {
          await deleteBackup(choice.value)
        } else {
          console.log(`\n  ${c.dim}Cancelled.${c.reset}\n`)
        }
        break
      }

      case "uninstall": {
        const answer = await prompt(rl, `  ${c.red}Remove Agent-Teams completely?${c.reset} [y/N] `)
        if (answer.toLowerCase() === "y") {
          await uninstall()
        } else {
          console.log(`\n  ${c.dim}Cancelled.${c.reset}\n`)
        }
        break
      }

      case "status":
        await status()
        break
    }
  } finally {
    rl.close()
  }
}

main().catch((e) => {
  console.error(`\n  ${c.red}Error:${c.reset} ${e?.message ?? e}\n`)
  process.exit(1)
})
