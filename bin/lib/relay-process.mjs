import { execFileSync } from "node:child_process"
import { rm } from "node:fs/promises"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Kill any node process running the agent-teams relay. The relay is spawned
// detached with cwd = the config relay directory, so on Windows it holds that
// directory open and blocks rmdir/rm during install/uninstall (EBUSY).
export async function killRelayProcesses() {
  const pattern = "agent-teams-relay.mjs"
  if (process.platform === "win32") {
    const ps =
      `Get-CimInstance Win32_Process -Filter "name='node.exe'" | ` +
      `Where-Object { $_.CommandLine -match '${pattern}' } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    try {
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
        stdio: "ignore",
        timeout: 15000,
      })
    } catch {
      // No relay processes found — nothing to kill.
    }
  } else {
    try {
      execFileSync("pkill", ["-f", pattern], { stdio: "ignore", timeout: 15000 })
    } catch {
      // No relay processes found — nothing to kill.
    }
  }
  // Give the OS a moment to release the file handles.
  await sleep(500)
}

// Remove a path, retrying on transient EBUSY/EPERM (Windows releases handles
// asynchronously after the owning process exits).
export async function rmRetry(target, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      await rm(target, { recursive: true, force: true })
      return
    } catch (error) {
      if (i === retries - 1) throw error
      await sleep(300)
    }
  }
}
