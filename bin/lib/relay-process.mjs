import { execFileSync } from "node:child_process"
import { writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  // Wait for port 25800 to fully release (TCP TIME_WAIT drain) before returning.
  // A flat 500ms sleep was not enough on Windows — the supervisor fired concurrent
  // respawn attempts into a port still in TIME_WAIT, each timing out and falling
  // through to the aux-server fallback, producing the split-brain storm seen in
  // server.log. Poll until the port is actually free, up to 5s.
  const relayPort = Number(process.env.RELAY_PORT ?? process.env.AGENT_TEAMS_RELAY_PORT ?? 25800)
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    let portFree = true
    try {
      if (process.platform === "win32") {
        const out = execFileSync("netstat.exe", ["-ano"], { encoding: "utf8", timeout: 3000 })
        portFree = !out.split(/\r?\n/).some((l) =>
          l.match(new RegExp(`127\\.0\\.0\\.1:${relayPort}\\s+\\S+\\s+LISTENING`))
        )
      } else {
        execFileSync("lsof", [`-tiTCP:${relayPort}`, "-sTCP:LISTEN"], { stdio: "ignore", timeout: 3000 })
        portFree = false // lsof exit 0 = something listening
      }
    } catch {
      portFree = true // lsof exit non-zero = nothing listening
    }
    if (portFree) break
    await sleep(200)
  }
}

// Kill auxiliary `opencode serve` processes whose PARENT is gone (Windows).
// Aux servers are spawned detached and survive their terminal's death; their
// in-memory plugin then keeps respawning relays + state dirs after every
// install/uninstall (the "Removed N stale dirs" churn). Windows preserves the
// dead parent's PID, so the orphan test is exact: parent PID not found = kill.
//
// SAFETY — only these processes may be killed, nothing else:
//   1. process name must be exactly `opencode.exe` (the npm/IDE binary), and
//   2. the command line must have `serve` as an argument (a real server, not
//      the TUI and not any other program), and
//   3. the parent PID must no longer exist (orphaned) — a live instance's
//      server has a live parent and is NEVER touched.
// POSIX reparents orphans to init (ppid=1), which can't be distinguished from
// a deliberately daemonized server — there the plugin's own parentIsAlive()
// watchdog handles self-exit instead, so no sweep is needed.
export async function killOrphanedServeProcesses() {
  if (process.platform !== "win32") return
  // A temp .ps1 file + -File avoids Windows command-line quoting hell with
  // embedded double quotes / $() (which broke -Command style).
  const script = [
    `Get-CimInstance Win32_Process -Filter "name='opencode.exe'" | ForEach-Object {`,
    `  if ($_.ParentProcessId -eq 0) { return }`,
    `  if ($_.CommandLine -notmatch ' serve(\\s|$)') { return }`,
    `  $par = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ParentProcessId)" -ErrorAction SilentlyContinue`,
    `  if (-not $par) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    `}`,
  ].join("\n")
  const scriptPath = join(tmpdir(), `agent-teams-orphan-sweep-${process.pid}.ps1`)
  writeFileSync(scriptPath, script)
  try {
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { stdio: "ignore", timeout: 30000 },
    )
  } catch {
    // No orphaned servers found — nothing to kill.
  } finally {
    rmSync(scriptPath, { force: true })
  }
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
