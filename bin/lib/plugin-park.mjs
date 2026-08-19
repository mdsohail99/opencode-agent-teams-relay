// Shared "disabled plugin" helpers for Agent-Teams install/uninstall/menu.
//
// Native-fork (agents-only) mode installs into the SAME config root as full
// mode (~/.config/opencode) but DISABLES the plugin by parking it OUT of the
// autodiscovery directory. The core only scans `{plugin,plugins}/*.{ts,js}`
// under the config root, so a file parked in `plugins-disabled/` is never
// loaded — the native fork's compiled-in Task/next_agent/agents_status then
// run collision-free (Issue 1), while `full` mode re-enables it by copying it
// back into `plugins/`.
import { join } from "node:path"
import { existsSync, mkdirSync, renameSync, copyFileSync, rmSync } from "node:fs"
import { rmRetry } from "./relay-process.mjs"

export const DISABLED_PLUGIN_DIR = "plugins-disabled"
export const PARKED_PLUGIN_FILE = join(DISABLED_PLUGIN_DIR, "agent-teams.ts")

/** Park our plugin out of autodiscovery (agents-only mode). No-op when absent. */
export function parkPlugin(configRoot) {
  const active = join(configRoot, "plugins", "agent-teams.ts")
  const parked = join(configRoot, PARKED_PLUGIN_FILE)
  if (!existsSync(active)) return false
  mkdirSync(join(configRoot, DISABLED_PLUGIN_DIR), { recursive: true })
  try {
    renameSync(active, parked)
  } catch {
    // Locked/cross-volume rename fallback: copy then remove.
    copyFileSync(active, parked)
    try {
      rmSync(active, { force: true })
    } catch {
      // Leave the active copy; the parked one still guarantees disablement.
    }
  }
  return true
}

/** Remove the parked copy (full-mode installs / uninstall). Also drops the
 *  reserved dir when it becomes empty. */
export async function removeParkedPlugin(configRoot) {
  const parkedDir = join(configRoot, DISABLED_PLUGIN_DIR)
  const parked = join(parkedDir, "agent-teams.ts")
  if (existsSync(parked)) await rmRetry(parked)
  if (existsSync(parkedDir)) {
    const { readdir } = await import("node:fs/promises")
    const entries = await readdir(parkedDir).catch(() => [])
    if (entries.length === 0) await rmRetry(parkedDir)
  }
}
