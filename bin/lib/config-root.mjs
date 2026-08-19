// Shared config-directory resolver for Agent-Teams install/uninstall/menu.
//
// BOTH modes install into <home>/.config/opencode (single config world).
//   - full:        agents + plugin (plugins/agent-teams.ts) + relay + npm dep
//   - agents-only: agents + AGENTS.md only; the plugin is PARKED in
//                  plugins-disabled/ (out of autodiscovery) so the native fork
//                  runs collision-free.
//
// resolveConfigRoot() without a mode detects where an existing installation
// lives: a config dir with installation markers (`.installed-mode`,
// `.installed-version`, or an `agents/` folder) is preferred. The legacy
// `.config/ocd` location (pre-1.0.4 agents-only installs) is still honored for
// upgrades/uninstalls, but new installs never target it.
import { join } from "node:path"
import { existsSync } from "node:fs"

export function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || process.cwd()
}

export function defaultConfigSubdir(mode) {
  // Agents-only and full share the stock config root; the mode determines
  // plugin placement (parked vs active), not the directory.
  return "opencode"
}

function looksLikeInstalled(dir) {
  return (
    existsSync(join(dir, ".installed-mode")) ||
    existsSync(join(dir, ".installed-version")) ||
    existsSync(join(dir, "agents"))
  )
}

/**
 * Resolve the config directory.
 * @param {"agents"|"full"|undefined} mode  explicit install mode, or undefined
 *   for auto-detection (favour a marked/agents install, else stock opencode).
 */
export function resolveConfigRoot(mode) {
  const override = process.env.OPENCODE_CONFIG_DIR
  if (override) return override
  const base = join(homeDir(), ".config")
  if (mode === "agents" || mode === "full") return join(base, defaultConfigSubdir(mode))

  const opencode = join(base, "opencode")
  if (looksLikeInstalled(opencode)) return opencode
  const ocd = join(base, "ocd")
  if (looksLikeInstalled(ocd)) return ocd
  return opencode
}