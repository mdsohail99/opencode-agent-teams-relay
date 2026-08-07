// Shared: merge the Agent-Teams `subagent_depth` default into the USER's globglobal
// opencode config WITHOUT overwriting their existing keys (MCP servers, model,
// provider, etc.). Idempotent and additive-only: we never clobber a value the
// user already set, and we never remove keys we don't own.
//
// MODE-AWARE (important): `subagent_depth` is a **fork-core-only** config key.
// The native fork core (anomalyco/opencode dev line, v1.18.x+) understands it;
// the stable/stock opencode core (1.2.27) REJECTS it as an unrecognized key and
// refuses to start. Therefore this helper must only APPLY the key in `agents`
// mode (fork users), and must REMOVE it in `full` mode (stock users) to keep
// their config valid.
import { readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

export const SUBAGENT_DEPTH = 2

/**
 * Apply (agents mode) or remove (full mode) the `subagent_depth` key in
 * `configRoot/opencode.json`, preserving every other key. Additive in agents
 * mode: sets the value only when the key is absent (respects any explicit user
 * choice). Self-healing in full mode: strips the key when present, since a
 * stale agents-mode install would otherwise leave stock opencode unable to
 * start. Returns a short human string describing what happened (or "" when
 * there is nothing to report).
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
    // Fork users: guarantee the key exists (additive-only, respect user value).
    if (config.subagent_depth === undefined) {
      config.subagent_depth = SUBAGENT_DEPTH
      if (config.$schema === undefined) config.$schema = "https://opencode.ai/config.json"
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
      log(`  ${wrote(configPath)} with subagent_depth=${SUBAGENT_DEPTH} (existing keys preserved)`)
    } else {
      log(`  subagent_depth already set to ${config.subagent_depth} in ${configPath} (kept)`)
    }
  } else {
    // Stock/full mode: `subagent_depth` is invalid on the stable core. Strip it
    // so opencode can start (self-healing a stale agents-mode install).
    if (config.subagent_depth !== undefined) {
      delete config.subagent_depth
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
      log(`  removed subagent_depth from ${configPath} (not supported by stock opencode core)`)
    }
  }
  return config

  function wrote(path) {
    return existsSync(path) ? "updated" : "created"
  }
}