// Shared: merge the Agent-Teams `subagent_depth` default into the USER's globglobal
// opencode config WITHOUT overwriting their existing keys (MCP servers, model,
// provider, etc.). Idempotent and additive-only: we never clobber a value the
// user already set, and we never remove keys we don't own.
import { readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

export const SUBAGENT_DEPTH = 2

/**
 * Merge `subagent_depth` into `configRoot/opencode.json`, preserving every other
 * key. Sets the value only when the key is absent (respects any explicit user
 * choice), and never touches unrelated config. Returns a short human string
 * describing what happened (or "" when there is nothing to report).
 */
export async function mergeSubagentDepth(configRoot, log = console.log) {
  const configPath = join(configRoot, "opencode.json")
  let config = {}
  let wrote = "wrote"

  if (existsSync(configPath)) {
    try {
      config = JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/, ""))
    } catch (err) {
      throw new Error(`Cannot parse ${configPath}; fix it before installing Agent-Teams: ${err.message}`)
    }
  } else {
    wrote = "created"
    config = { $schema: "https://opencode.ai/config.json" }
  }

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`${configPath} does not contain a JSON object; refusing to overwrite it.`)
  }

  if (config.subagent_depth === undefined) {
    config.subagent_depth = SUBAGENT_DEPTH
    if (config.$schema === undefined) config.$schema = "https://opencode.ai/config.json"
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
    log(`  ${wrote} ${configPath} with subagent_depth=${SUBAGENT_DEPTH} (existing keys preserved)`)
    return config
  }

  // Already present — leave the user's explicit value untouched (additive-only).
  log(`  subagent_depth already set to ${config.subagent_depth} in ${configPath} (kept)`)
  return config
}