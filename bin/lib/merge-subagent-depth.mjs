// Shared: merge the Agent-Teams `experimental.subagent_depth` default into the USER's global
// opencode config WITHOUT overwriting their existing keys (MCP servers, model,
// provider, etc.). Idempotent and additive-only: we never clobber a value the
// user already set, and we never remove keys we don't own.
//
// MODE-AWARE (important): `subagent_depth` is a **fork-core-only** config key.
// The native fork core understands it via `experimental.subagent_depth` (V2 schema-compliant);
// the older stock opencode core (1.2.27) rejects root `subagent_depth`.
// Therefore this helper applies the key in `agents` mode (fork users),
// and cleans up root/experimental depth in `full` mode (stock users).
import { readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

export const SUBAGENT_DEPTH = 2

/**
 * Apply (agents mode) or remove (full mode) `experimental.subagent_depth` in
 * `configRoot/opencode.json`, preserving every other key. Additive in agents
 * mode: sets the value only when absent (respects any explicit user choice).
 * Self-healing in full mode: strips the key when present.
 */
export async function mergeSubagentDepth(configRoot, log = console.log, mode = "full") {
  const configPath = join(configRoot, "opencode.json")
  let config = {}

  if (existsSync(configPath)) {
    try {
      config = JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/, ""))
    } catch (err) {
      throw new Error(`Cannot parse ${configPath}; fix it before installing Agent-Teams: ${err.message}`)
    }
  } else {
    config = { $schema: "https://opencode.ai/config.json" }
  }

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`${configPath} does not contain a JSON object; refusing to overwrite it.`)
  }

  if (mode === "agents") {
    let changed = false

    // 1. Migrate legacy root subagent_depth if present
    if (config.subagent_depth !== undefined) {
      if (!config.experimental || typeof config.experimental !== "object" || Array.isArray(config.experimental)) {
        config.experimental = {}
      }
      if (config.experimental.subagent_depth === undefined) {
        config.experimental.subagent_depth = config.subagent_depth
      }
      delete config.subagent_depth
      changed = true
    }

    // 2. Ensure experimental.subagent_depth exists
    if (!config.experimental || typeof config.experimental !== "object" || Array.isArray(config.experimental)) {
      config.experimental = {}
    }

    if (config.experimental.subagent_depth === undefined) {
      config.experimental.subagent_depth = SUBAGENT_DEPTH
      if (config.$schema === undefined) config.$schema = "https://opencode.ai/config.json"
      changed = true
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
      log(`  ${wrote(configPath)} with experimental.subagent_depth=${SUBAGENT_DEPTH} (existing keys preserved)`)
    } else {
      if (changed) {
        await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
      }
      log(`  experimental.subagent_depth already set to ${config.experimental.subagent_depth} in ${configPath} (kept)`)
    }
  } else {
    // Stock/full mode: clean up both legacy root and experimental subagent_depth
    let changed = false
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
    if (changed) {
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
      log(`  removed subagent_depth from ${configPath} (not supported by stock opencode core)`)
    }
  }
  return config

  function wrote(path) {
    return existsSync(path) ? "updated" : "created"
  }
}