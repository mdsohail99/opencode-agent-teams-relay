// Shared: configure OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true by default
// so stock OpenCode users automatically get native background subagents (Ctrl+B)
// enabled out of the box without manual configuration.

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

const FLAG_NAME = "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"
const EXPORT_LINE = `export ${FLAG_NAME}=true`

/**
 * Configure or revert OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS in user environment.
 * @param {(msg: string) => void} log
 * @param {"full" | "agents" | "uninstall"} mode
 */
export async function mergeEnvFlags(log = console.log, mode = "full") {
  const isWindows = process.platform === "win32"

  if (mode === "full" || mode === "agents") {
    process.env[FLAG_NAME] = "true"

    if (isWindows) {
      try {
        spawnSync(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `[Environment]::SetEnvironmentVariable("${FLAG_NAME}", "true", "User")`,
          ],
          { stdio: "ignore" },
        )
        log(`  configured ${FLAG_NAME}=true in Windows user environment`)
      } catch (err) {
        log(`  warning: could not set ${FLAG_NAME} in user environment: ${err.message}`)
      }
    } else {
      // Unix: append to ~/.bashrc or ~/.zshrc if present
      const home = homedir()
      const targets = [join(home, ".bashrc"), join(home, ".zshrc")].filter(existsSync)
      for (const target of targets) {
        try {
          const content = await readFile(target, "utf8")
          if (!content.includes(FLAG_NAME)) {
            await writeFile(target, `${content}\n# OpenCode Agent-Teams\n${EXPORT_LINE}\n`, "utf8")
            log(`  configured ${FLAG_NAME}=true in ${target}`)
          }
        } catch (err) {
          log(`  warning: could not update ${target}: ${err.message}`)
        }
      }
    }
  } else if (mode === "uninstall") {
    if (isWindows) {
      try {
        spawnSync(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `[Environment]::SetEnvironmentVariable("${FLAG_NAME}", $null, "User")`,
          ],
          { stdio: "ignore" },
        )
        log(`  reverted ${FLAG_NAME} in Windows user environment`)
      } catch (err) {
        log(`  warning: could not revert ${FLAG_NAME}: ${err.message}`)
      }
    } else {
      const home = homedir()
      const targets = [join(home, ".bashrc"), join(home, ".zshrc")].filter(existsSync)
      for (const target of targets) {
        try {
          const content = await readFile(target, "utf8")
          if (content.includes(FLAG_NAME)) {
            const cleaned = content
              .split("\n")
              .filter((line) => !line.includes(FLAG_NAME) && !line.includes("# OpenCode Agent-Teams"))
              .join("\n")
            await writeFile(target, cleaned, "utf8")
            log(`  reverted ${FLAG_NAME} from ${target}`)
          }
        } catch (err) {
          log(`  warning: could not update ${target}: ${err.message}`)
        }
      }
    }
  }
}
