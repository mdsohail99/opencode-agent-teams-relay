// Shared: merge the Agent-Teams `subagent_depth` and `max_concurrent_agents` defaults
// into the USER's global opencode config WITHOUT overwriting their existing keys
// (MCP servers, model, provider, custom values, etc.). Idempotent and additive-only:
// we never clobber a value the user already set, and we never remove keys we don't own.
//
// - `subagent_depth` and `max_concurrent_agents` are supported at root in BOTH
//   `full` and `agents` modes (validated by local schema.json).
//   In both modes, they default additively (subagent_depth=2, max_concurrent_agents=20)
//   if absent, and migrate from `experimental.*` to root if misplaced.
//   Existing user values are preserved; on `uninstall`, both keys are cleaned up.
import { readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

export const SUBAGENT_DEPTH = 2
export const MAX_CONCURRENT_AGENTS = 20

/**
 * Apply subagent_depth and max_concurrent_agents (both modes)
 * in `configRoot/opencode.json`, preserving every other key.
 */
export async function mergeSubagentDepth(configRoot, log = console.log, mode = "full") {
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
    if (mode === "uninstall") {
      return config
    }
    config = { $schema: "https://opencode.ai/config.json" }
  }

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`${configPath} does not contain a JSON object; refusing to overwrite it.`)
  }

  let changed = false

  // ── 1. max_concurrent_agents (both full and agents mode) ──
  if (mode === "full" || mode === "agents") {
    // Migrate misplaced experimental.max_concurrent_agents to root if present
    if (config.experimental && typeof config.experimental === "object" && !Array.isArray(config.experimental)) {
      if (config.experimental.max_concurrent_agents !== undefined) {
        if (config.max_concurrent_agents === undefined) {
          config.max_concurrent_agents = config.experimental.max_concurrent_agents
        }
        delete config.experimental.max_concurrent_agents
        if (Object.keys(config.experimental).length === 0) {
          delete config.experimental
        }
        changed = true
      }
    }

    // Set root max_concurrent_agents = 20 additively if absent
    if (config.max_concurrent_agents === undefined) {
      config.max_concurrent_agents = MAX_CONCURRENT_AGENTS
      if (config.$schema === undefined) config.$schema = "https://opencode.ai/config.json"
      changed = true
      log(`  ${exists ? "updated" : "created"} ${configPath} with max_concurrent_agents=${MAX_CONCURRENT_AGENTS}`)
    } else {
      log(`  max_concurrent_agents already set to ${config.max_concurrent_agents} in ${configPath} (kept)`)
    }
  }

  // ── 2. subagent_depth (both full and agents mode) ──
  if (mode === "full" || mode === "agents") {
    // Migrate misplaced experimental.subagent_depth back to root if present
    if (config.experimental && typeof config.experimental === "object" && !Array.isArray(config.experimental)) {
      if (config.experimental.subagent_depth !== undefined) {
        if (config.subagent_depth === undefined) {
          config.subagent_depth = config.experimental.subagent_depth
        }
        delete config.experimental.subagent_depth
        if (Object.keys(config.experimental).length === 0) {
          delete config.experimental
        }
        changed = true
      }
    }

    // Ensure root subagent_depth exists additively
    if (config.subagent_depth === undefined) {
      config.subagent_depth = SUBAGENT_DEPTH
      if (config.$schema === undefined) config.$schema = "https://opencode.ai/config.json"
      changed = true
      log(`  ${exists ? "updated" : "created"} ${configPath} with subagent_depth=${SUBAGENT_DEPTH} (existing keys preserved)`)
    } else {
      log(`  subagent_depth already set to ${config.subagent_depth} in ${configPath} (kept)`)
    }
  } else if (mode === "uninstall") {
    // Clean up both root and experimental subagent_depth & max_concurrent_agents on uninstall
    if (config.subagent_depth !== undefined) {
      delete config.subagent_depth
      changed = true
    }
    if (config.max_concurrent_agents !== undefined) {
      delete config.max_concurrent_agents
      changed = true
    }
    if (config.experimental && typeof config.experimental === "object" && !Array.isArray(config.experimental)) {
      if (config.experimental.subagent_depth !== undefined) {
        delete config.experimental.subagent_depth
        changed = true
      }
      if (config.experimental.max_concurrent_agents !== undefined) {
        delete config.experimental.max_concurrent_agents
        changed = true
      }
      if (Object.keys(config.experimental).length === 0) {
        delete config.experimental
        changed = true
      }
    }
    if (changed) {
      log(`  removed subagent_depth and max_concurrent_agents from ${configPath}`)
    }
  }

  if (changed) {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
  }

  return config
}