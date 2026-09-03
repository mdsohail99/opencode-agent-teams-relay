// bin/lib/merge-schema.mjs
// Manages local schema.json and $schema reference in opencode.json
//
// In both full and agents mode:
//   - Copies schema.json to <configRoot>/schema.json
//   - Updates opencode.json to point "$schema": "./schema.json"
//   This eliminates IDE warnings (e.g. "Property max_concurrent_agents is not allowed")
//   while providing full autocomplete and tooltips in VS Code.
//
// On uninstall:
//   - Removes <configRoot>/schema.json
//   - Reverts "$schema": "https://opencode.ai/config.json" if opencode.json remains.

import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..")
const SCHEMA_FILE = join(packageRoot, "schema.json")
const REMOTE_SCHEMA = "https://opencode.ai/config.json"
const LOCAL_SCHEMA = "./schema.json"

export function mergeSchema(configDir, log = console.log, mode = "full") {
  const targetSchema = join(configDir, "schema.json")
  const opencodeJsonPath = join(configDir, "opencode.json")

  if (mode === "uninstall") {
    if (existsSync(targetSchema)) {
      try {
        rmSync(targetSchema, { force: true })
        log("removed schema.json from " + configDir)
      } catch (e) {
        log("warning: failed to remove schema.json: " + (e?.message || e))
      }
    }

    if (existsSync(opencodeJsonPath)) {
      try {
        const raw = readFileSync(opencodeJsonPath, "utf-8").replace(/^\uFEFF/, "")
        const parsed = JSON.parse(raw)
        if (parsed.$schema === LOCAL_SCHEMA) {
          parsed.$schema = REMOTE_SCHEMA
          writeFileSync(opencodeJsonPath, JSON.stringify(parsed, null, 2) + "\n", "utf-8")
          log("reverted $schema in opencode.json to " + REMOTE_SCHEMA)
        }
      } catch (e) {
        log("warning: failed to revert $schema in opencode.json: " + (e?.message || e))
      }
    }
    return
  }

  // Install mode (full or agents)
  if (existsSync(SCHEMA_FILE)) {
    try {
      copyFileSync(SCHEMA_FILE, targetSchema)
      log("installed schema.json into " + configDir)
    } catch (e) {
      log("warning: failed to copy schema.json: " + (e?.message || e))
    }
  }

  if (existsSync(opencodeJsonPath)) {
    try {
      const raw = readFileSync(opencodeJsonPath, "utf-8").replace(/^\uFEFF/, "")
      const parsed = JSON.parse(raw)
      if (!parsed.$schema || parsed.$schema === REMOTE_SCHEMA) {
        parsed.$schema = LOCAL_SCHEMA
        const ordered = { $schema: LOCAL_SCHEMA, ...parsed }
        writeFileSync(opencodeJsonPath, JSON.stringify(ordered, null, 2) + "\n", "utf-8")
        log("updated $schema in opencode.json to " + LOCAL_SCHEMA)
      }
    } catch (e) {
      log("warning: failed to update $schema in opencode.json: " + (e?.message || e))
    }
  }
}
