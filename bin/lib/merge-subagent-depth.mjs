// Shared: merge the Agent-Teams `subagent_depth` and `max_concurrent_agents` defaults
// into the USER's global opencode config WITHOUT overwriting their existing keys
// (MCP servers, model, provider, custom values, etc.). Idempotent and additive-only:
// we never clobber a value the user already set, and we never remove keys we don't own.
//
// MODE-AWARE (important):
// - `subagent_depth` is a **fork-core-only** config key. The native fork core
//   understands it via root `subagent_depth` (V2 schema-compliant); the stock
//   opencode core rejects root `subagent_depth`. Therefore, this helper applies
//   the key in `agents` mode (fork users) and cleans up root/experimental depth
//   in `full` mode (stock users) or `uninstall`.
// - `max_concurrent_agents` is supported at the root in BOTH native fork and stock relay.
//   In both `full` and `agents` mode, it defaults additively to 20 if absent (or
//   migrates from `experimental.max_concurrent_agents` to root). Existing user values
//   are preserved.
import { readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

export const SUBAGENT_DEPTH = 2
export const MAX_CONCURRENT_AGENTS = 20

/**
 * Apply subagent_depth (agents mode only) and max_concurrent_agents (both modes)
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

  // ── 2. subagent_depth (agents mode: set 2; full/uninstall: strip) ──
  if (mode === "agents") {
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
  } else {
    // Stock/full mode or uninstall: clean up both root and experimental subagent_depth
    if (config.subagent_depth !== undefined) {
      delete config.subagent_depth
      changed = true
    }
    if (config.experimental && typeof config.experimental === "object" && !Array.isArray(config.experimental)) {
      if (config.experimental.subagent_depth !== undefined) {
        delete config.experimental.subagent_depth
        if (Object.keys(config.experimental).length === 0) {
          delete config.experimental
        }
        changed = true
      }
    }
    if (changed && mode !== "agents") {
      log(`  removed subagent_depth from ${configPath} (not supported by stock opencode core)`)
    }
  }

  if (changed) {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
  }

  return config
}