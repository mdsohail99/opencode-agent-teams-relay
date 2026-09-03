// Shared: merge Agent-Teams slash commands into the USER's global opencode config
// WITHOUT overwriting user-defined custom commands.
//
// MODE-AWARE:
// - In `full` mode (stock opencode): injects the 6 managed slash commands:
//   /agents, /status, /ask, /resume, /stop, /errors
//   CRITICAL: Every injected command explicitly declares `"agent": "Agent-Teams"`.
// - In `agents` mode (native fork) or `uninstall`: strips only the 6 managed
//   commands. If `config.command` becomes empty, deletes `config.command`.
//   Preserves all user-defined custom commands.
import { readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

export const MANAGED_COMMANDS = {
  agents: {
    agent: "Agent-Teams",
    description: "display the live hierarchical swarm status tree: /agents [filter]",
    template: "Call agents_status to inspect and display the live agent hierarchy tree, elapsed times, and progress.",
  },
  status: {
    agent: "Agent-Teams",
    description: "synthesize current progress and work done across all leads and specialists: /status [filter]",
    template: "Call agents_status to retrieve running and completed children, inspect their deliverables, and synthesize an executive summary.",
  },
  ask: {
    agent: "Agent-Teams",
    description: "query any running lead or specialist agent out-of-band: /ask <agent> <question>",
    template: "Call ask_agent with target_id and prompt parsed from: $ARGUMENTS",
  },
  resume: {
    agent: "Agent-Teams",
    description: "resume or restart a stalled, failed, or paused agent: /resume <agent> [instructions]",
    template: "Call resume_agent with target_id and prompt parsed from: $ARGUMENTS",
  },
  stop: {
    agent: "Agent-Teams",
    description: "halt a specific agent or all running agents in the swarm: /stop [agent|all]",
    template: "Call manage_agents with action='kill' or 'kill_all' based on: $ARGUMENTS",
  },
  errors: {
    agent: "Agent-Teams",
    description: "scan swarm for failed, errored, or stalled agents and show diagnostics: /errors",
    template: "Call agents_status to find any workers with status 'error' or '[stalled]', then inspect their outputs and recommend fixes.",
  },
}

export const MANAGED_COMMAND_NAMES = Object.keys(MANAGED_COMMANDS)

/**
 * Apply (full mode) or strip (agents/uninstall mode) managed Agent-Teams slash
 * commands in `configRoot/opencode.json`, preserving every user-defined command.
 */
export async function mergeSlashCommands(configRoot, log = console.log, mode = "full") {
  const configPath = configRoot.endsWith("opencode.json") ? configRoot : join(configRoot, "opencode.json")
  let config = {}
  let exists = false

  if (existsSync(configPath)) {
    exists = true
    try {
      config = JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/, ""))
    } catch (err) {
      throw new Error(`Cannot parse ${configPath}; fix it before installing Agent-Teams: ${err.message}`)
    }
  } else {
    if (mode !== "full") {
      return config
    }
    config = { $schema: "https://opencode.ai/config.json" }
  }

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`${configPath} does not contain a JSON object; refusing to overwrite it.`)
  }

  let changed = false

  if (mode === "full") {
    if (!config.command || typeof config.command !== "object" || Array.isArray(config.command)) {
      config.command = {}
      changed = true
    }

    for (const [name, def] of Object.entries(MANAGED_COMMANDS)) {
      const existing = config.command[name]
      if (
        !existing ||
        existing.agent !== def.agent ||
        existing.description !== def.description ||
        existing.template !== def.template
      ) {
        config.command[name] = { ...def }
        changed = true
      }
    }

    if (changed) {
      if (config.$schema === undefined) config.$schema = "https://opencode.ai/config.json"
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
      log(`  ${exists ? "updated" : "created"} ${configPath} with Agent-Teams slash commands (user commands preserved)`)
    } else {
      log(`  Agent-Teams slash commands already up to date in ${configPath}`)
    }
  } else {
    // agents or uninstall mode: strip managed commands
    if (config.command && typeof config.command === "object" && !Array.isArray(config.command)) {
      for (const name of MANAGED_COMMAND_NAMES) {
        if (name in config.command) {
          delete config.command[name]
          changed = true
        }
      }
      if (Object.keys(config.command).length === 0) {
        delete config.command
        changed = true
      }
    }

    if (changed) {
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
      log(`  removed Agent-Teams slash commands from ${configPath}`)
    }
  }

  return config
}

export const mergeCommands = mergeSlashCommands
