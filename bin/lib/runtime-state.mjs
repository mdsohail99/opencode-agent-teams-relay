// Shared: locate and SAFELY remove Agent-Teams runtime state/token dirs.
//
// The plugin keeps one relay state dir per PORT under a single root
// (see plugins/agent-teams.ts stateRoot()/stateDir() and
// relay/agent-teams-relay.mjs persistToken()):
//   root = AGENT_TEAMS_STATE_DIR
//        | %LOCALAPPDATA%\opencode\agent-teams          (Windows)
//        | $HOME/.local/state/opencode/agent-teams       (POSIX)
//   root/<port>/token        — shared-secret the relay writes and the plugin reads
//   root/<port>/token.tmp   — temp file during atomic persistToken()
//   root/<port>/relay.log   — relay stdout/stderr
//   root/<port>/server.log  — optional auxiliary opencode serve stdout/stderr
//   root/<port>/agent-teams-relay.wal          — append-only write-ahead log (durable hot path)
//   root/<port>/agent-teams-relay-state.json   — periodic atomic checkpoint
//   root/<port>/agent-teams-relay.wal.tmp      — transient temp during atomic WAL write (crash-scrub)
//   root/<port>/agent-teams-relay-state.json.tmp — transient temp during atomic checkpoint write (crash-scrub)
//
// SAFETY (critical): we ONLY delete
//   1. numeric per-port directories whose contents are EXACTLY plugin-owned
//      files from PLUGIN_STATE_FILES (or that are empty), and
//   2. stray plugin-named files sitting directly in the state root.
// Anything else — non-plugin files, foreign dirs, other users' data — is left
// untouched and skipped, so an uninstall can never delete user data that merely
// happens to live under the plugin's state root.
//
// Returns { root, removed, skipped } and never throws.

import { readdir, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { rmRetry } from "./relay-process.mjs"

// Filenames the relay/plugin may own, per port dir (see above). Includes the
// WAL + checkpoint durable store and the transient temp files that may briefly
// exist during atomic writes — an uninstall would otherwise skip every per-port
// dir containing a live relay store.
export const PLUGIN_STATE_FILES = new Set([
  "token",
  "token.tmp",
  "relay.log",
  "server.log",
  "agent-teams-relay.wal",
  "agent-teams-relay-state.json",
  "agent-teams-relay.wal.tmp",
  "agent-teams-relay-state.json.tmp",
])

// Mirrors plugins/agent-teams.ts stateRoot() exactly.
export function runtimeStateRoot() {
  if (process.env.AGENT_TEAMS_STATE_DIR) return process.env.AGENT_TEAMS_STATE_DIR
  if (process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "opencode", "agent-teams")
  if (process.env.HOME) return join(process.env.HOME, ".local", "state", "opencode", "agent-teams")
  return null
}

export const TRANSIENT_STATE_FILES = new Set([
  "token",
  "token.tmp",
  "relay.log",
  "server.log",
])

export async function removeRuntimeStateDirs(options = {}) {
  const { removeDatabase = true } = options
  const root = runtimeStateRoot()
  if (!root || !existsSync(root)) return { root, removed: 0, skipped: 0 }

  let removed = 0
  let skipped = 0
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    // Unreadable root — fail safe, report nothing removed.
    return { root, removed, skipped }
  }

  for (const entry of entries) {
    try {
      if (entry.isDirectory()) {
        if (!/^\d+$/.test(entry.name)) continue
        const dir = join(root, entry.name)
        const files = await readdir(dir)
        if (removeDatabase) {
          if (!files.every((f) => PLUGIN_STATE_FILES.has(f))) {
            skipped++
            continue
          }
          await rmRetry(dir)
          removed++
        } else {
          for (const file of files) {
            if (TRANSIENT_STATE_FILES.has(file)) {
              await rmRetry(join(dir, file))
            }
          }
        }
      } else if (PLUGIN_STATE_FILES.has(entry.name)) {
        await rmRetry(join(root, entry.name))
        removed++
      }
    } catch {
      skipped++
    }
  }

  // If the root is now empty it was purely plugin-created shells — remove it
  // so `LOCALAPPDATA\opencode\agent-teams` does not linger with a stale token
  // mtime. When anything non-plugin remains, the root stays.
  try {
    const after = await readdir(root)
    if (after.length === 0) await rm(root, { recursive: true, force: true })
  } catch {
    /* non-fatal */
  }

  return { root, removed, skipped }
}