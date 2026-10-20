#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "..")

console.log("==================================================")
console.log(" Agent-Teams v2 Setup for OpenCode")
console.log("==================================================")

const cwd = process.cwd()
const configPath = path.resolve(cwd, "opencode.json")

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
    console.error("Failed to parse existing opencode.json:", err.message)
  }
}

// Ensure subagent_depth: 2 for hierarchical swarm orchestration
config.subagent_depth = 2

// Ensure plugin entry is present
if (!Array.isArray(config.plugins)) {
  config.plugins = []
}
if (!config.plugins.includes("opencode-agent-teams")) {
  config.plugins.push("opencode-agent-teams")
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8")
console.log("✓ Configured opencode.json with subagent_depth: 2 and plugin registration")

// Copy curated agents to .opencode/agents if not present
const targetAgentsDir = path.resolve(cwd, ".opencode", "agents")
const sourceAgentsDir = path.resolve(rootDir, "agents")

if (fs.existsSync(sourceAgentsDir)) {
  fs.mkdirSync(targetAgentsDir, { recursive: true })
  
  function copyRecursive(src, dest) {
    for (const item of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, item.name)
      const destPath = path.join(dest, item.name)
      if (item.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true })
        copyRecursive(srcPath, destPath)
      } else if (item.isFile() && item.name.endsWith(".md")) {
        fs.copyFileSync(srcPath, destPath)
      }
    }
  }

  copyRecursive(sourceAgentsDir, targetAgentsDir)
  console.log("✓ Installed curated Department Leads and Specialists into .opencode/agents")
}

console.log("\nSetup complete! You can now launch OpenCode with full hierarchical multi-agent teams.")
