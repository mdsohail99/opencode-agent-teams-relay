import { tool } from "@opencode-ai/plugin"
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync, spawn } from "node:child_process"

// Agent-Teams is the only async orchestration mode. Normal agents continue to
// use the built-in Task tool. Each opencode server instance gets one isolated
// relay, identified by its server URL and bound to a deterministic port.

const RELAY_HOST = "127.0.0.1"
const PORT_BASE = 20000
const PORT_RANGE = 30000
const ALLOWED_AGENTS = new Set([
  "Agent-Teams",
  "Frontend",
  "Backend",
  "Security",
  "DevOps",
  "AI & Data",
  "QA",
])

function isValidServerUrl(url: any): boolean {
  if (!url) return false
  const str = (url instanceof URL ? url.toString() : String(url)).trim()
  if (!str || str === "undefined" || str === "null" || str === "[object Object]") return false
  try {
    const parsed = new URL(str)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  return hash
}

const DEFAULT_RELAY_PORT = 25800

function relayPort(_serverUrl?: string): number {
  if (process.env.RELAY_PORT) return Number(process.env.RELAY_PORT)
  if (process.env.AGENT_TEAMS_RELAY_PORT) return Number(process.env.AGENT_TEAMS_RELAY_PORT)
  return DEFAULT_RELAY_PORT
}

function stateRoot(): string {
  if (process.env.AGENT_TEAMS_STATE_DIR) return process.env.AGENT_TEAMS_STATE_DIR
  if (process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "opencode", "agent-teams")
  return join(process.env.HOME || process.cwd(), ".local", "state", "opencode", "agent-teams")
}

function stateDir(port: number): string {
  const dir = join(stateRoot(), String(port))
  mkdirSync(dir, { recursive: true })
  return dir
}

function relayPath(): string {
  const override = process.env.AGENT_TEAMS_RELAY
  if (override && existsSync(override)) return override
  const relative = fileURLToPath(new URL("../relay/agent-teams-relay.mjs", import.meta.url))
  if (existsSync(relative)) return relative
  throw new Error(`Agent-Teams relay not found: ${relative}`)
}

function nodePath(): string {
  if (process.env.AGENT_TEAMS_NODE) return process.env.AGENT_TEAMS_NODE
  if (process.platform === "win32") {
    if (existsSync("C:/Program Files/nodejs/node.exe")) return "C:/Program Files/nodejs/node.exe"
    try {
      const found = execFileSync("where.exe", ["node"], { encoding: "utf8" })
        .split(/\r?\n/)
        .map((v: string) => v.trim())
        .filter(Boolean)
        .find((p: string) => p.toLowerCase().endsWith(".exe"))
      if (found) return found
    } catch {}
    return "node.exe"
  }
  return "node"
}

function tokenPath(port: number): string {
  return join(stateDir(port), "token")
}

function readToken(port: number): string | undefined {
  try {
    return readFileSync(tokenPath(port), "utf8").trim() || undefined
  } catch {
    return undefined
  }
}

function logPath(port: number): string {
  return join(stateDir(port), "relay.log")
}

function logPlugin(port: number, message: string): void {
  try {
    const file = join(stateDir(port), "server.log")
    appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    /* silent */
  }
}

// Cache of relay spawn state per serverUrl — the dedup point during startup.
// Entries carry the spawned child PIDs + aux-backing flags so the supervisor
// can heal a relay that was forced onto an auxiliary server (split-brain
// recovery, see healAuxBackedRelay). `auxUrl` is the aux upstream the relay
// watches when auxBacked — needed to locate/evict a stale aux server from a
// previous opencode session, whose pid this process never captured.
type RelayEntry = {
  port: number
  ready: Promise<boolean>
  relayPid?: number
  auxPid?: number
  auxUrl?: string
  auxBacked?: boolean
  healing?: boolean
}

const relays = new Map<string, RelayEntry>()

async function health(port: number, _serverUrl?: string): Promise<boolean> {
  try {
    const response = await fetch(`http://${RELAY_HOST}:${port}/health`, {
      // Bound the probe: a wedged relay must not hang a tool call. Localhost
      // health checks resolve in ms on a live relay, so 2s is generous.
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) return false
    const data = await response.json() as { ok?: boolean; eventsReady?: boolean; serverUrl?: string }
    // Accept any healthy relay on the correct port — it may have been started
    // with an auxiliary upstream URL that differs from the original serverUrl.
    // eventsReady is informational: a relay reconnecting its SSE stream is not
    // dead and must never be respawned (that would race the still-running relay
    // for the port and create duplicate-exit loops). Liveness = it responded.
    return data.ok === true
  } catch {
    return false
  }
}

async function waitForRelay(port: number, serverUrl: string): Promise<boolean> {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await health(port, serverUrl)) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

async function upstreamAvailable(serverUrl: string): Promise<boolean> {
  try {
    const base = serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`
    const response = await fetch(`${base}session?limit=1`)
    return response.ok
  } catch {
    return false
  }
}

// Probe the real upstream with a short retry window before concluding it is
// down. At opencode startup the plugin loads BEFORE the HTTP server binds — a
// single probe fails during that boot race and wrongly triggers the
// auxiliary-server fallback, permanently splitting the relay onto a second,
// invisible server. Retrying covers the bind window; only after the retries
// fail do we treat the upstream as genuinely unreachable (headless case).
// 15s: observed TUI boot races on Windows exceed 5s (aux spawned at +6s).
const UPSTREAM_RETRY_ATTEMPTS = 15
const UPSTREAM_RETRY_DELAY_MS = 1000

async function upstreamAvailableWithRetry(serverUrl: string): Promise<boolean> {
  if (!isValidServerUrl(serverUrl)) return false
  for (let attempt = 1; attempt <= UPSTREAM_RETRY_ATTEMPTS; attempt++) {
    if (await upstreamAvailable(serverUrl)) return true
    if (attempt < UPSTREAM_RETRY_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, UPSTREAM_RETRY_DELAY_MS))
    }
  }
  return false
}

// Compare upstream URLs ignoring a trailing slash (the relay stores
// OPENCODE_URL verbatim; serverUrl may or may not carry the slash).
function canonicalUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url
}

// The upstream URL the relay on this port is actually watching, from its
// /health serverUrl field. A relay spawned against an auxiliary server reports
// a DIFFERENT URL than the real opencode server — the definitive split-brain
// signal. Works even for relays spawned by a previous opencode session, where
// our spawn-time pid tracking is empty.
async function relayUpstream(port: number): Promise<string | undefined> {
  try {
    const response = await fetch(`http://${RELAY_HOST}:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) return undefined
    const data = await response.json() as { serverUrl?: string }
    return typeof data.serverUrl === "string" ? data.serverUrl : undefined
  } catch {
    return undefined
  }
}

// PID of the process listening on 127.0.0.1:port — used to evict a stale
// aux-backed relay (or its aux server) spawned by a previous opencode session,
// whose pid this plugin never captured. Best-effort: undefined when nothing
// listens or the platform lookup fails. Windows uses netstat (present on every
// build); POSIX uses lsof.
function pidListeningOnPort(port: number): number | undefined {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat.exe", ["-ano"], { encoding: "utf8", timeout: 5000 })
      for (const line of out.split(/\r?\n/)) {
        const match = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/)
        if (match && Number(match[1]) === port && match[2] !== "0") return Number(match[2])
      }
      return undefined
    }
    const out = execFileSync("lsof", ["-tiTCP:" + String(port), "-sTCP:LISTEN"], { encoding: "utf8", timeout: 5000 })
    const pid = out.split(/\s+/).map((p) => p.trim()).find(Boolean)
    return pid ? Number(pid) : undefined
  } catch {
    return undefined
  }
}

// Orphaned-server self-exit: `opencode serve` processes spawned as auxiliary
// servers by this plugin pass `AGENT_TEAMS_PARENT_PID`. If that parent PID is
// gone, the auxiliary server exits so zombie processes don't linger.
// Primary interactive OpenCode instances (launched by the user) do NOT set
// AGENT_TEAMS_PARENT_PID; they must NEVER self-terminate because launcher shell
// wrappers (e.g. opencode.cmd / transient node.exe wrapper) exit naturally.
function parentIsAlive(): boolean {
  const targetPidStr = process.env.AGENT_TEAMS_PARENT_PID
  if (!targetPidStr) return true // Primary OpenCode instance — always alive while running
  const targetPid = Number(targetPidStr)
  if (Number.isNaN(targetPid) || targetPid <= 1) return false
  try {
    process.kill(targetPid, 0)
    return true
  } catch (err: any) {
    return err?.code === "EPERM"
  }
}

function opencodeExecutable(directory?: string): string {
  if (process.env.AGENT_TEAMS_OPENCODE) return process.env.AGENT_TEAMS_OPENCODE
  if (process.platform !== "win32") return "opencode"

  // Prefer the real native executable (.exe) directly so no shell wrapping or cmd deprecation occurs.
  // Check local project node_modules first, then global npm paths.
  const appData = process.env.APPDATA || ""
  const candidates = [
    directory ? join(directory, "node_modules", "opencode-windows-x64", "bin", "opencode.exe") : "",
    directory ? join(directory, "node_modules", "opencode-ai", "bin", "opencode.exe") : "",
    directory ? join(directory, "node_modules", ".bin", "opencode.cmd") : "",
    join(appData, "npm", "node_modules", "opencode-ai", "node_modules", "opencode-windows-x64", "bin", "opencode.exe"),
    join(appData, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"),
    join(appData, "npm", "opencode.cmd"),
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  try {
    const found = execFileSync("where.exe", ["opencode"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((value: string) => value.trim())
      .filter(Boolean)
      .find((p: string) => p.toLowerCase().endsWith(".exe") || p.toLowerCase().endsWith(".cmd"))
    if (found) return found
  } catch {
    /* fall through to PATH lookup */
  }
  return "opencode.cmd"
}

// Ask the OS for a guaranteed-free port. Avoids all hardcoded range collisions
// (Docker, IDE language servers, Linux ephemeral 32768-60999, Windows 49152-65535).
// There is a small TOCTOU window between release and opencode binding, but this is
// far safer than any fixed range across all platforms.
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port as number
      srv.close((err?: Error | null) => (err ? reject(err) : resolve(port)))
    })
    srv.on("error", reject)
  })
}

async function startAuxiliaryServer(directory: string, originalUrl: string, port: number, state: string): Promise<{ base: string; pid?: number } | undefined> {
  // Let the OS pick a free port — no hardcoded range, no platform collisions.
  const auxiliaryPort = await findFreePort()
  const base = `http://127.0.0.1:${auxiliaryPort}/`
  // An existing server on the freed port (TOCTOU window): adopt it, but no
  // pid is ours to kill later.
  if (await upstreamAvailable(base)) return { base, pid: undefined }

  const log = openSync(join(state, "server.log"), "a")
  const executable = opencodeExecutable(directory)
  const isCmd = executable.toLowerCase().endsWith(".cmd") || executable.toLowerCase().endsWith(".bat")

  logPlugin(port, `[agent-teams] launching auxiliary server: ${executable} serve --hostname 127.0.0.1 --port ${auxiliaryPort}`)

  const child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(auxiliaryPort)], {
    cwd: directory,
    detached: true,
    windowsHide: true,
    shell: process.platform === "win32" && isCmd,
    env: {
      ...process.env,
      AGENT_TEAMS_PARENT_PID: String(process.pid),
      AGENT_TEAMS_PRIMARY_URL: originalUrl,
    },
    stdio: ["ignore", log, log],
  })

  child.on("error", (err) => {
    logPlugin(port, `[agent-teams] auxiliary server spawn error (${executable}): ${err.message}`)
  })

  child.unref()

  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (await upstreamAvailable(base)) {
      logPlugin(port, `[agent-teams] auxiliary server ready at ${base} (pid ${child.pid})`)
      return { base, pid: child.pid }
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  logPlugin(port, `[agent-teams] auxiliary server timed out waiting for ${base} (executable: ${executable})`)
  return undefined
}

// Auxiliary servers spawned by THIS plugin instance, keyed by the real
// serverUrl they back. At most ONE aux per serverUrl per plugin instance:
// a later respawn reuses the existing aux instead of spawning a fresh
// `opencode serve` on every failing call (that per-tick respawn loop was
// the cascade that multiplied servers 8x in 2.5 minutes).
const auxServers = new Map<string, { base: string; pid?: number }>()

// Global in-flight respawn locks: maps serverUrl -> promise for the active
// ensureRelay call. When a relay is unhealthy and multiple concurrent calls
// all detect it (supervisor tick + tool-handlers), only the FIRST proceeds
// into ensureRelayInternal. All subsequent callers await the same promise,
// preventing the cascade where each spawns its own relay+aux server.
const respawnInFlight = new Map<string, Promise<boolean>>()

function ensureRelay(directory: string, serverUrl: string): Promise<boolean> {
  const existing = relays.get(serverUrl)
  if (existing) {
    return (async () => {
      // If the original spawn is still in-flight, await it — do NOT race it
      // with a duplicate spawn (the cache is the dedup point during startup).
      const originallyReady = await existing.ready
      if (!originallyReady) {
        // First spawn attempt failed — retry the full spawn path.
        relays.delete(serverUrl)
        return serializedRespawn(directory, serverUrl)
      }
      // Original spawn succeeded — but re-probe liveness on EVERY call so a
      // relay that died since (heartbeat exit, crash, install/uninstall) gets
      // respawned instead of making every tool call fail until opencode restart.
      if (await health(existing.port)) return true
      relays.delete(serverUrl)
      const port = relayPort(serverUrl)
      logPlugin(port, `[agent-teams] relay on port ${port} is not healthy — respawning`)
      return serializedRespawn(directory, serverUrl)
    })()
  }
  return serializedRespawn(directory, serverUrl)
}

// Serializes respawn attempts: if one is already in-flight for this serverUrl,
// return that same promise instead of spawning a competing one. This is the
// primary fix for the installer-triggered respawn storm where 10 concurrent
// supervisor ticks all raced into ensureRelayInternal simultaneously.
function serializedRespawn(directory: string, serverUrl: string): Promise<boolean> {
  const inFlight = respawnInFlight.get(serverUrl)
  if (inFlight) return inFlight
  const promise = ensureRelayInternal(directory, serverUrl).finally(() => {
    respawnInFlight.delete(serverUrl)
  })
  respawnInFlight.set(serverUrl, promise)
  return promise
}

async function ensureRelayInternal(directory: string, serverUrl: string): Promise<boolean> {
  const port = relayPort(serverUrl)
  const ready = (async () => {
    // Fast path: if a relay is already running and healthy on this port, reuse
    // it. This avoids the auxiliary server cascade entirely. A reused relay
    // may be a STALE aux-backed one from a previous opencode session — mark it
    // so the supervisor heals it once the real upstream answers.
    if (await health(port)) {
      await markAuxBackedIfMismatched(serverUrl, port)
      return true
    }

    const state = stateDir(port)
    let backendUrl = serverUrl
    let auxBacked = false
    let auxPid: number | undefined
    let auxUrl: string | undefined
    // Retry the real upstream before any aux fallback — a single probe fails
    // during the opencode boot race (the plugin loads before the HTTP server
    // binds) and would wrongly split the relay onto an auxiliary server that
    // is invisible to the real TUI.
    if (!(await upstreamAvailableWithRetry(backendUrl))) {
      // Reuse an aux spawned by an earlier attempt in THIS plugin instance —
      // never spawn a second server while the first is still alive. This is
      // what bounds the aux count to one per serverUrl per session: without
      // it, every failing tick/tool call spawns a fresh `opencode serve`.
      const existingAux = auxServers.get(serverUrl)
      if (existingAux && (await upstreamAvailable(existingAux.base))) {
        backendUrl = existingAux.base
        auxBacked = true
        auxPid = existingAux.pid
        auxUrl = backendUrl
        logPlugin(port, `[agent-teams] upstream unreachable after retries — reusing auxiliary opencode serve ${backendUrl}`)
      } else {
        const auxiliary = await startAuxiliaryServer(directory, serverUrl, port, state)
        if (!auxiliary) return false
        backendUrl = auxiliary.base
        auxBacked = true
        auxPid = auxiliary.pid
        auxUrl = backendUrl
        auxServers.set(serverUrl, { base: backendUrl, pid: auxiliary.pid })
        // Visible fallback signal: written to server.log, not stderr/TUI console.
        logPlugin(port, `[agent-teams] upstream unreachable after retries — using auxiliary opencode serve ${backendUrl}`)
      }
    }
    // Re-check after auxiliary — another process may have started the relay
    if (await health(port)) {
      await markAuxBackedIfMismatched(serverUrl, port)
      return true
    }

    const log = openSync(join(state, "relay.log"), "a")
    const child = spawn(nodePath(), [relayPath()], {
      cwd: dirname(relayPath()),
      detached: true,
      windowsHide: true,
      env: {
        ...process.env,
        OPENCODE_URL: backendUrl,
        OPENCODE_DIR: directory,
        RELAY_PORT: String(port),
        RELAY_STATE_DIR: state,
        PARENT_PID: String(process.pid),
        CASCADE_GRACE_PERIOD_MS: process.env.CASCADE_GRACE_PERIOD_MS || "300000",
      },
      stdio: ["ignore", log, log],
    })
    child.on("error", (err) => {
      logPlugin(port, `[agent-teams] relay spawn error: ${err.message}`)
    })
    child.unref()
    // Record the spawned pids + aux-backing on the cached entry so the
    // supervisor can evict this relay later (split-brain self-heal). The entry
    // was set synchronously below BEFORE the first await above, so it is
    // guaranteed to exist here.
    const entry = relays.get(serverUrl)
    if (entry) {
      entry.relayPid = child.pid
      entry.auxBacked = auxBacked
      entry.auxPid = auxPid
      entry.auxUrl = auxUrl
    }
    const ok = await waitForRelay(port, backendUrl)
    if (!ok) {
      logPlugin(port, `[agent-teams] waitForRelay timed out waiting on port ${port} (backendUrl: ${backendUrl})`)
    }
    return ok
  })().then((ok) => {
    if (!ok) relays.delete(serverUrl)
    return ok
  }).catch(() => {
    relays.delete(serverUrl)
    return false
  })

  relays.set(serverUrl, { port, ready })
  return ready
}

// When a relay is reused (not spawned by us), derive auxBacked from the
// upstream URL it reports: any healthy relay watching a DIFFERENT server than
// the real one is aux-backed and must be healed. This is what lets the
// supervisor heal a stale relay from a previous opencode session.
async function markAuxBackedIfMismatched(serverUrl: string, port: number): Promise<void> {
  const upstream = await relayUpstream(port)
  const entry = relays.get(serverUrl)
  if (entry && upstream && canonicalUrl(upstream) !== canonicalUrl(serverUrl)) {
    entry.auxBacked = true
    entry.auxUrl = upstream
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Supervisor — always-on relay supervision + reconciliation push (spec §5/§6).
//
// Started ONCE per opencode server at PLUGIN LOAD (in the AgentTeams export),
// never inside a tool handler. Every SUPERVISOR_INTERVAL_MS the tick:
//   1. health-checks the relay; if unhealthy, respawns it via the existing
//      ensureRelay path (tool handlers keep calling ensureRelay per call too
//      — belt and suspenders, unchanged and cheap).
//   2. fetches the FULL live session list from the opencode server and pushes
//      it to the relay's /reconcile, so the relay sees every session on the
//      instance — not just the ones it spawned itself.
//
// Upstream-unreachable handling: when the opencode server cannot be reached,
// the /reconcile push for that tick is SKIPPED (an empty list is never
// fabricated and posted — reconciliation is driven by the live list; the
// relay's confirmed-vs-unknown rules protect state). The health check part
// still runs, and the failure is logged once per episode.
//
// Split-brain self-heal: a relay that was spawned against an auxiliary server
// (real upstream was down at spawn time) is evicted and respawned on the REAL
// URL on the first tick where the /reconcile push to the real server succeeds
// (see healAuxBackedRelay). This also heals stale aux-backed relays left over
// from a previous opencode session.
//
// Boundary per spec §5: if the opencode process itself dies, the plugin (and
// the supervisor inside it) die with it — by design. Nothing is left running
// without a supervisor, and there are no live sessions to supervise either;
// the next opencode start brings the supervisor back automatically.
// ─────────────────────────────────────────────────────────────────────────────

const SUPERVISOR_INTERVAL_MS = Number(process.env.AGENT_TEAMS_SUPERVISOR_INTERVAL_MS) || 60_000

// One supervisor per serverUrl — mirrors the `relays` cache pattern and IS the
// single-instance guard: a second startSupervisor for the same serverUrl is a
// no-op, so re-loads can never double the interval or the /reconcile traffic.
const supervisors = new Map<string, { timer: NodeJS.Timeout; upstreamFailureLogged: boolean }>()

function startSupervisor(directory: string, serverUrl: string, port: number): void {
  if (!isValidServerUrl(serverUrl)) return
  if (supervisors.has(serverUrl)) return
  const timer = setInterval(() => {
    void superviseTick(directory, serverUrl, port)
  }, SUPERVISOR_INTERVAL_MS)
  // The supervisor must never keep the opencode process alive on its own.
  timer.unref()
  supervisors.set(serverUrl, { timer, upstreamFailureLogged: false })
  logPlugin(port, `[agent-teams] supervisor started for ${serverUrl} (relay port ${port}, every ${SUPERVISOR_INTERVAL_MS}ms)`)
  // Immediate first tick: a dead relay is respawned the moment opencode loads
  // instead of after the first 60s interval (default) — closing spec gap #4 from t=0.
  void superviseTick(directory, serverUrl, port)
}

async function superviseTick(directory: string, serverUrl: string, port: number): Promise<void> {
  // Orphaned host (its TUI/terminal died): no live sessions to supervise, and
  // lingering would keep respawning relays + recreating state dirs after every
  // install/uninstall. Exit — the relay's heartbeat watchdog reaps it within 60s.
  if (!parentIsAlive()) {
    logPlugin(port, `[agent-teams] parent process target is gone — orphaned server, exiting`)
    process.exit(0)
  }

  // 1. Relay health → respawn if needed. ensureRelay dedups via its own cache
  //    and re-probes liveness internally, so a concurrent tool-handler call
  //    and this tick can never double-spawn.
  if (!(await health(port))) {
    const ok = await ensureRelay(directory, serverUrl)
    if (!ok || !(await health(port))) {
      // Relay still down — nothing to reconcile against. ensureRelay already
      // logged the respawn attempt on its own; avoid logging every tick here.
      return
    }
  }

  // 2. Full-visibility push: live session list → relay /reconcile.
  const pushed = await pushReconciliation(serverUrl, port)
  const state = supervisors.get(serverUrl)
  if (!pushed) {
    if (state && !state.upstreamFailureLogged) {
      state.upstreamFailureLogged = true
      logPlugin(
        port,
        `[agent-teams] supervisor: upstream opencode server unreachable for ${serverUrl} — ` +
          `skipping /reconcile push this tick (relay state is protected; retrying next tick)`,
      )
    }
  } else if (state) {
    state.upstreamFailureLogged = false
  }

  // 3. Split-brain self-heal: the real upstream now answers a push, but the
  //    relay may still be aux-backed (spawned while the real server was down,
  //    or a stale one from a previous opencode session). Evict it and respawn
  //    against the REAL URL so spawns land on the visible server again.
  if (pushed) {
    const entry = relays.get(serverUrl)
    if (entry?.auxBacked && !entry.healing) {
      await healAuxBackedRelay(directory, serverUrl, port, entry)
    }
  }
}

// Evict an aux-backed relay and respawn it against the REAL opencode server —
// split-brain recovery. A relay forced onto an auxiliary server (real upstream
// was down at spawn time) would otherwise watch an invisible server forever.
// Called only after a /reconcile push proved the real upstream reachable. The
// relay's SQLite durable store replays all state on boot — the respawn is
// lossless by design. `entry.healing` prevents a concurrent tick or tool call
// from double-healing.
async function healAuxBackedRelay(directory: string, serverUrl: string, port: number, entry: RelayEntry): Promise<void> {
  if (entry.healing) return
  entry.healing = true
  try {
    // Locate both victims. Pids captured at spawn when WE spawned the relay;
    // for a stale relay from a previous opencode session, fall back to an OS
    // port→pid lookup (relay port + the aux port reported by /health).
    const auxUrl = entry.auxUrl ?? (await relayUpstream(port))
    let auxPort: number | undefined
    try {
      const parsed = auxUrl ? new URL(auxUrl).port : ""
      auxPort = parsed ? Number(parsed) : undefined
    } catch {
      auxPort = undefined
    }
    const relayPid = entry.relayPid ?? pidListeningOnPort(port)

    // Kill ONLY the relay first. The aux server is kept alive on purpose: if
    // the real-URL respawn below fails (real upstream down again), the next
    // failure path reuses the aux via auxServers instead of spawning yet
    // another `opencode serve` — this was the aux cascade amplifier.
    if (relayPid && relayPid > 0) {
      try {
        // SIGTERM-style kill — on win32 Node maps it to a hard kill (POSIX
        // signals do not exist there). Best-effort: already-gone pids throw
        // ESRCH and are fine.
        process.kill(relayPid)
      } catch {
        /* already gone — fine */
      }
    }

    // Wait for the relay port to actually release; otherwise the respawn's
    // port-guard (EADDRINUSE) makes the fresh relay exit immediately.
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (!(await health(port))) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    relays.delete(serverUrl)
    const ok = await ensureRelay(directory, serverUrl)
    if (ok) {
      // Respawned on the real server — the aux is now surplus. Reap it (and
      // its record) so the next episode starts clean instead of accumulating.
      const auxPid = entry.auxPid ?? (auxPort && auxPort > 0 ? pidListeningOnPort(auxPort) : undefined)
      if (auxPid && auxPid > 0) {
        try {
          process.kill(auxPid)
        } catch {
          /* already gone — fine */
        }
      }
      auxServers.delete(serverUrl)
      logPlugin(port, `[agent-teams] relay was aux-backed; real upstream reachable — respawned on real server (aux reaped)`)
    } else {
      // Keep the aux alive — the next failure path reuses it (no new server).
      logPlugin(port, `[agent-teams] relay heal: evicted aux-backed relay but respawn failed — reusing aux next tick`)
    }
  } finally {
    entry.healing = false
  }
}

// Fetch the FULL live session list from the opencode server (same HTTP helper
// pattern the plugin already uses for upstream probes — no SDK import) and
// push it to the relay. Returns true when the push reached the relay.
// Deliberately plain HTTP (option (a) from the redesign spec): GET /session
// returns Array<Session> (id, parentID?, title, time) — the same wire shape
// client.session.list() wraps on the relay side — and the plugin already talks
// to the opencode server over fetch() everywhere else.
async function pushReconciliation(serverUrl: string, port: number): Promise<boolean> {
  const base = parentBase(serverUrl)
  let sessions: Array<{ sessionID: string; parentID: string; title: string; status: "idle" }>
  try {
    const res = await fetch(`${base}session`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return false
    const data = (await res.json()) as unknown
    // Tolerate a { sessions: [...] } envelope in case a future core changes
    // the wire shape; today the endpoint returns a bare array.
    const list: Array<{ id?: string; parentID?: string; title?: string }> = Array.isArray(data)
      ? data
      : (data as { sessions?: Array<{ id?: string; parentID?: string; title?: string }> })?.sessions ?? []
    sessions = list.map((s) => ({
      sessionID: s.id ?? "",
      parentID: s.parentID ?? "",
      title: s.title ?? "",
      status: "idle",
    }))
  } catch {
    // Upstream unreachable → skip the push for this tick (see superviseTick).
    return false
  }
  try {
    await request(port, "POST", "/reconcile", readToken(port), { sessions })
    return true
  } catch (e) {
    logPlugin(port, `[agent-teams] supervisor: /reconcile push failed: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

async function request(
  port: number,
  method: string,
  path: string,
  token: string | undefined,
  body?: unknown,
  timeoutMs?: number,
): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Terminal-PID": String(process.pid),
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const budgetMs = timeoutMs ?? 130_000
  const response = await fetch(`http://${RELAY_HOST}:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(budgetMs),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data?.error || `relay request failed: ${response.status}`)
  return data
}

function denied(agent: string): string {
  return JSON.stringify({
    error: `Agent-Teams tools are reserved for Agent-Teams and Department Lead orchestrators; ${agent} must use the regular Task tool.`,
  })
}

function classifyAgent(prompt: string, requestedAgent?: string): string {
  if (requestedAgent && requestedAgent !== "auto" && requestedAgent.trim() !== "") {
    return requestedAgent
  }
  const lower = prompt.toLowerCase()
  if (/\b(sec|security|auth|jwt|oauth|secret|credential|token|vulnerability|penetration|privacy|compliance)\b/.test(lower)) {
    return "Security"
  }
  if (/\b(ui|ux|frontend|css|react|vue|component|style|accessibility|design|html|dom|wcag)\b/.test(lower)) {
    return "Frontend"
  }
  if (/\b(api|backend|database|sql|postgres|server|orm|endpoint|rest|graphql|stripe|billing)\b/.test(lower)) {
    return "Backend"
  }
  if (/\b(devops|docker|ci|cd|pipeline|k8s|kubernetes|infra|terraform|aws|sre|deploy|nginx|caddy)\b/.test(lower)) {
    return "DevOps"
  }
  if (/\b(ai|ml|llm|prompt|rag|model|embedding|vector|data|search)\b/.test(lower)) {
    return "AI & Data"
  }
  if (/\b(test|qa|coverage|e2e|playwright|jest|vitest|benchmark)\b/.test(lower)) {
    return "QA"
  }
  return "Frontend Developer"
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline sub-agent mode — renders children as native `│ Task` widgets in the
// parent session using the core's subtask-part machinery.
//
// HARD CONSTRAINTS (from core analysis — do not re-litigate):
//  1. The parent session loop is single-turn-busy: while a plugin tool is
//     executing, a new message posted to the SAME session is queued behind the
//     current turn. The inline path MUST therefore use the fire-and-forget
//     `prompt_async` endpoint, NOT a blocking message post (which deadlocks).
//  2. Subtask parts are processed sequentially by the core, one at a time, each
//     blocking until the child finishes. Inline mode is inherently sequential
//     per child — parallel fan-out stays on the relay path.
//  3. The installed/stable core (1.2.27) accepts the subtask part (HTTP 204,
//     persisted) but NEVER processes it into a child session (silent no-op).
//     HTTP status alone cannot detect this — we probe for actual child-session
//     spawning on a throwaway session and fall back to the relay on failure.
// ─────────────────────────────────────────────────────────────────────────────

const INLINE_CORES_MIN_VERSION = [1, 18] // fork dev line (v1.18.x+) is subtask-aware

// Cache the support decision per server URL so the probe runs at most once.
const inlineSupportCache = new Map<string, Promise<{ supported: boolean; reason: string }>>()

function parentBase(serverUrl: string): string {
  return serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`
}

// Fast path: /global/health reports the core version. Cores older than the
// fork's dev line (1.18.x) are known to be non-subtask-aware — skip the probe.
async function probeVersionFastPath(base: string): Promise<{ version?: string; tooOld: boolean }> {
  try {
    const res = await fetch(`${base}global/health`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return { tooOld: true }  // unhealthy endpoint → assume not subtask-aware
    const data = (await res.json()) as { version?: string }
    const version = typeof data?.version === "string" ? data.version : undefined
    // Version absent: core doesn't expose it — conservatively assume too old.
    // This avoids creating a throwaway probe session on stock cores that don't
    // publish a version field on /global/health (e.g. stable 1.2.27).
    if (!version) return { tooOld: true }
    const m = version.match(/^(\d+)\.(\d+)/)
    if (!m) return { tooOld: true }  // unparseable version → assume not subtask-aware
    const major = Number(m[1])
    const minor = Number(m[2])
    const tooOld = major < INLINE_CORES_MIN_VERSION[0] ||
      (major === INLINE_CORES_MIN_VERSION[0] && minor < INLINE_CORES_MIN_VERSION[1])
    return { version, tooOld }
  } catch {
    // Network error or parse failure → cannot determine version → assume too old.
    return { tooOld: true }
  }
}

// Authoritative probe: create a throwaway session, POST a subtask part via
// prompt_async, then check whether a CHILD session was spawned or a
// `tool:"task"` part appeared. A subtask-aware core does one of these; a
// no-op core (stable 1.2.27) does neither.
async function probeInlineSupport(serverUrl: string): Promise<{ supported: boolean; reason: string }> {
  const base = parentBase(serverUrl)
  let probeID: string | undefined

  try {
    const versionCheck = await probeVersionFastPath(base)
    if (versionCheck.tooOld) {
      return {
        supported: false,
        reason: `core version ${versionCheck.version ?? "unknown"} predates subtask-part support (needs >= ${INLINE_CORES_MIN_VERSION.join(".")})`,
      }
    }

    const created = await fetch(`${base}session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "__agent_teams_subtask_probe__" }),
      signal: AbortSignal.timeout(5000),
    })
    if (!created.ok) return { supported: false, reason: `probe session create failed: HTTP ${created.status}` }
    probeID = ((await created.json()) as { id?: string })?.id
    if (!probeID) return { supported: false, reason: "probe session create returned no id" }

    const subBody = {
      agent: "build",
      parts: [{ type: "subtask", prompt: "Reply with OK.", description: "subtask support probe", agent: "build" }],
    }
    const post = await fetch(`${base}session/${probeID}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subBody),
      signal: AbortSignal.timeout(5000),
    })
    // Schema-level rejection (400) or missing endpoint (404) = not supported.
    if (post.status === 400 || post.status === 404) {
      return { supported: false, reason: `subtask part rejected: HTTP ${post.status}` }
    }
    if (!post.ok) return { supported: false, reason: `subtask POST failed: HTTP ${post.status}` }

    // Poll briefly for a child session or a task tool-part.
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 400))
      const childRes = await fetch(`${base}session/${probeID}/children`, {
        signal: AbortSignal.timeout(3000),
      }).catch(() => undefined)
      if (childRes?.ok) {
        const childData = (await childRes.json()) as { children?: Array<{ id: string }> } | Array<{ id: string }>
        const children = Array.isArray(childData) ? childData : (childData?.children ?? [])
        if (children.length > 0) {
          return { supported: true, reason: `child session spawned (${children.length})` }
        }
      }
      const msgRes = await fetch(`${base}session/${probeID}/message?limit=20`, {
        signal: AbortSignal.timeout(3000),
      }).catch(() => undefined)
      if (msgRes?.ok) {
        const msgData = (await msgRes.json()) as Array<{ parts?: Array<{ type?: string; tool?: string }> }> | { messages?: Array<{ parts?: Array<{ type?: string; tool?: string }> }> }
        const msgs = Array.isArray(msgData) ? msgData : (msgData?.messages ?? [])
        const hasTaskPart = msgs.some((m) =>
          Array.isArray(m?.parts) && m.parts.some((p) => p?.type === "tool" && p?.tool === "task"),
        )
        if (hasTaskPart) return { supported: true, reason: "task tool-part observed" }
      }
    }
    return { supported: false, reason: "no child session or task tool-part observed (no-op core)" }
  } catch (e) {
    return { supported: false, reason: `probe error: ${e instanceof Error ? e.message : String(e)}` }
  } finally {
    if (probeID) {
      // Delayed cleanup: the probe session received a prompt_async which may
      // still be processing when we reach this point. An immediate DELETE on an
      // active session fails silently on stock 1.2.27, leaving a ghost session
      // titled "__agent_teams_subtask_probe__" in the user's session list.
      // Waiting 5s gives the session time to settle; the DELETE then succeeds.
      const cleanupBase = base
      const cleanupId = probeID
      setTimeout(() => {
        fetch(`${cleanupBase}session/${encodeURIComponent(cleanupId)}`, { method: "DELETE" }).catch(() => undefined)
      }, 5000)
    }
  }
}

function detectInlineSupport(serverUrl: string): Promise<{ supported: boolean; reason: string }> {
  let cached = inlineSupportCache.get(serverUrl)
  if (!cached) {
    cached = probeInlineSupport(serverUrl)
    inlineSupportCache.set(serverUrl, cached)
  }
  return cached
}

// Resolve the classified agent name to a name the core actually has configured.
// The subtask `agent` field feeds the core's Task machinery — an unknown agent
// makes the core error, so if the classified name isn't configured we fall back
// to the relay path (which also carries the same names today, so behavior is
// unchanged for existing users).
const knownAgentsCache = new Map<string, Set<string>>()

async function knownAgentNames(serverUrl: string): Promise<Set<string> | undefined> {
  if (knownAgentsCache.has(serverUrl)) return knownAgentsCache.get(serverUrl)
  const base = parentBase(serverUrl)
  try {
    const res = await fetch(`${base}agent`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return undefined
    const list = (await res.json()) as Array<{ name?: string }>
    const names = new Set(list.map((a) => a?.name).filter((n): n is string => Boolean(n)))
    knownAgentsCache.set(serverUrl, names)
    return names
  } catch {
    return undefined
  }
}

// Fire-and-forget inline subtask post to the PARENT's own server. Never awaits
// the core processing the message — prompt_async returns immediately (204) and
// the message is queued behind the current turn (constraint 1).
async function postInlineSubtask(
  serverUrl: string,
  sessionID: string,
  messageAgent: string,
  task: { agent: string; prompt: string; description: string },
): Promise<{ ok: boolean; status?: number; body?: string; error?: string }> {
  const base = parentBase(serverUrl)
  const url = `${base}session/${encodeURIComponent(sessionID)}/prompt_async`
  const parts = [{ type: "subtask", prompt: task.prompt, description: task.description, agent: task.agent }]
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: messageAgent, parts }),
      // Generous-but-bounded: prompt_async returns 204 immediately on a healthy
      // core; this guards against a wedged server hanging the tool call.
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) return { ok: true, status: res.status }
    const body = await res.text().catch(() => "")
    return { ok: false, status: res.status, body: body.slice(0, 300) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Short human-visible summary of a task (mirrors the relay's title logic).
function subtaskDescription(agent: string, prompt: string): string {
  const clean = prompt.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/[\r\n]+/g, " ").trim()
  const snippet = clean.slice(0, 45)
  return snippet ? `🤖 [${agent}] ${snippet}` : `🤖 [${agent}]`
}

// Shared relay fallback used by inline mode when the core doesn't support
// subtask parts (or the inline POST fails). Keeps existing relay behavior 100%
// intact and reports why the fallback engaged.
async function fallbackToRelay(
  directory: string,
  server: string,
  port: number,
  context: { sessionID: string; agent: string },
  tasks: Array<{ agent: string; prompt: string; notify: boolean }>,
  extra: Record<string, unknown>,
): Promise<unknown> {
  if (!(await ensureRelay(directory, server))) {
    return { error: "Agent-Teams relay failed to start", ...extra }
  }
  const spawned = await request(port, "POST", "/spawn", readToken(port), {
    parentID: context.sessionID,
    callerAgent: context.agent,
    tasks,
  })
  return { ...spawned, ...extra }
}

interface SwarmTreeNode {
  sessionID: string
  parentID?: string
  agent?: string
  title?: string
  status?: string
  createdAt?: number
  updatedAt?: number
  completedAt?: number
  result?: string
  error?: string
  drained?: boolean
  children: SwarmTreeNode[]
}

function elapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function previewText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat
}

function countSwarmTreeNodes(nodes: SwarmTreeNode[]): number {
  return nodes.reduce((acc, node) => acc + 1 + countSwarmTreeNodes(node.children), 0)
}

function buildSwarmHierarchy(nodes: any[], rootParentID: string): SwarmTreeNode[] {
  const byId = new Map<string, SwarmTreeNode>()
  for (const n of nodes) {
    const id = n?.sessionID || n?.id
    if (!id) continue
    byId.set(id, {
      sessionID: id,
      parentID: n.parentID,
      agent: n.agent,
      title: n.title,
      status: n.status || "running",
      createdAt: typeof n.createdAt === "number" ? n.createdAt : undefined,
      updatedAt: typeof n.updatedAt === "number" ? n.updatedAt : undefined,
      completedAt: typeof n.completedAt === "number" ? n.completedAt : undefined,
      result: typeof n.result === "string" ? n.result : undefined,
      error: typeof n.error === "string" ? n.error : undefined,
      drained: n.drained === true,
      children: [],
    })
  }

  const roots: SwarmTreeNode[] = []
  for (const node of byId.values()) {
    if (node.parentID && byId.has(node.parentID) && node.parentID !== node.sessionID) {
      byId.get(node.parentID)!.children.push(node)
    } else if (!node.parentID || node.parentID === rootParentID) {
      roots.push(node)
    }
  }

  // If no root matched rootParentID directly, but there are nodes, treat top-level nodes as roots
  if (roots.length === 0 && byId.size > 0) {
    for (const node of byId.values()) {
      if (!node.parentID || !byId.has(node.parentID)) {
        roots.push(node)
      }
    }
  }

  const sortNodes = (list: SwarmTreeNode[]) => {
    list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    for (const item of list) {
      if (item.children.length > 0) sortNodes(item.children)
    }
  }
  sortNodes(roots)
  return roots
}

function renderSwarmTreeLines(
  nodes: SwarmTreeNode[],
  now: number,
  prefix = "",
): string[] {
  const lines: string[] = []
  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1
    const branch = isLast ? "└─ " : "├─ "
    const childPrefix = prefix + (isLast ? "   " : "│  ")

    const status = node.status || "running"
    const isDrained = node.drained === true
    const consumed = isDrained ? " (drained)" : ""

    const lastActiveAt = node.updatedAt || node.createdAt || now
    const isStalled = status === "running" && (now - lastActiveAt > 180_000)
    const stalledTag = isStalled ? " [stalled]" : ""

    const startedAt = node.createdAt || now
    const timeStr = elapsed(now - startedAt)
    const titleOrAgent = node.title || node.agent || ""
    const titleStr = titleOrAgent ? ` ${titleOrAgent}` : ""

    const head = `${prefix}${branch}${node.sessionID} [${status}]${stalledTag}${consumed}${titleStr} ${timeStr}`
    lines.push(head)

    if (status !== "running") {
      const text = status === "error" ? (node.error || "") : (node.result || "")
      if (text) {
        lines.push(`${childPrefix}${previewText(text)}`)
      }
    }

    if (node.children.length > 0) {
      lines.push(...renderSwarmTreeLines(node.children, now, childPrefix))
    }
  })
  return lines
}

export const AgentTeams = async ({ directory, serverUrl }: any) => {
  if (!isValidServerUrl(serverUrl)) {
    return {
      tool: {
        running_agents: tool({
          description: "Spawn child agents asynchronously.",
          args: { tasks: tool.schema.array(tool.schema.object({ prompt: tool.schema.string() })) },
          async execute() { return JSON.stringify({ error: "Agent-Teams unavailable: serverUrl is invalid or not yet ready." }) },
        }),
        next_agent: tool({
          description: "Wait for the next completed child agent.",
          args: {},
          async execute() { return JSON.stringify({ error: "Agent-Teams unavailable: serverUrl is invalid or not yet ready." }) },
        }),
        agents_status: tool({
          description: "Snapshot of child agent statuses.",
          args: {},
          async execute() { return JSON.stringify({ error: "Agent-Teams unavailable: serverUrl is invalid or not yet ready." }) },
        }),
        resume_agent: tool({
          description: "Resume an existing child agent session.",
          args: {
            target_id: tool.schema.string().optional().describe("Target agent session ID or natural agent name/role (e.g. 'Backend Lead', 'Frontend')."),
            sessionID: tool.schema.string().optional().describe("Legacy session ID."),
            prompt: tool.schema.string().optional().describe("Optional operator guidance or instructions for resuming the agent."),
          },
          async execute() { return JSON.stringify({ error: "Agent-Teams unavailable: serverUrl is invalid or not yet ready." }) },
        }),
        manage_agents: tool({
          description: "Manage subagent swarm lifecycle: kill, kill_all, inspect, or restart background workers.",
          args: {
            action: tool.schema.enum(["kill", "kill_all", "inspect", "restart"]).describe("Action to perform: 'kill', 'kill_all', 'inspect', or 'restart'."),
            target_id: tool.schema.string().optional().describe("Target agent session ID, natural agent name, or role (e.g. 'Backend', 'Frontend Lead')."),
            prompt: tool.schema.string().optional().describe("Optional guidance or instructions for restart."),
          },
          async execute() { return JSON.stringify({ error: "Agent-Teams unavailable: serverUrl is invalid or not yet ready." }) },
        }),
        ask_agent: tool({
          description: "Query an agent out-of-band without interrupting its running task or causing concurrency collisions.",
          args: {
            target_id: tool.schema.string().describe("Target agent name, role, or session ID to query."),
            prompt: tool.schema.string().describe("Question or prompt for the worker."),
          },
          async execute() { return JSON.stringify({ error: "Agent-Teams unavailable: serverUrl is invalid or not yet ready." }) },
        }),
      },
    }
  }

  const rawServer = serverUrl instanceof URL ? serverUrl.toString() : String(serverUrl)
  const server = process.env.AGENT_TEAMS_PRIMARY_URL || rawServer
  const port = relayPort(server)

  // Supervisor (spec §5/§6): starts the moment the plugin loads for this
  // server — NOT deferred to the first tool call — and from then on owns
  // relay health/respawn + the scheduled /reconcile push. Tool handlers keep
  // their own per-call ensureRelay as belt-and-suspenders.
  startSupervisor(directory, server, port)

  return {
    tool: {
      running_agents: tool({
        description:
          "Spawn unlimited child agents asynchronously. Results return only to the calling Agent-Teams session. " +
          "Set inline=true to render a single child as a native `│ Task` widget inside THIS session instead of the relay drawer. " +
          "INLINE IS SEQUENTIAL: the core processes inline subtask parts one at a time, each blocking until the child finishes — " +
          "do NOT request multiple inline tasks expecting parallel execution; parallel fan-out requires inline=false (relay mode). " +
          "Inline requires a subtask-aware core; on older cores (e.g. stable 1.2.27) it auto-falls back to the relay.",
        args: {
          tasks: tool.schema.array(tool.schema.object({
            agent: tool.schema.string().optional(),
            prompt: tool.schema.string(),
            notify: tool.schema.boolean().optional(),
            scope: tool.schema.string().optional(),
          })),
          inline: tool.schema.boolean().optional(),
        },
        async execute(args, context) {
          if (!ALLOWED_AGENTS.has(context.agent)) return denied(context.agent)

          const rawTasks = (args as any).tasks || []
          const inline = (args as any).inline === true
          const mappedTasks = rawTasks.map((t: any) => ({
            agent: classifyAgent(t.prompt || "", t.agent),
            prompt: t.scope ? `[Scope Boundary Guideline: ${t.scope}]\n${t.prompt}` : t.prompt,
            notify: Boolean(t.notify),
          }))

          // ── INLINE MODE ─────────────────────────────────────────────
          if (inline) {
            if (mappedTasks.length !== 1) {
              // Inline is inherently sequential (constraint 2) — refuse parallel
              // inline rather than silently serializing or confusing the core.
              return JSON.stringify({
                error: "inline mode supports exactly ONE task. Inline subtask parts are processed sequentially by the core (each blocks until the child finishes). For parallel fan-out set inline=false to use the relay path.",
                inline: true,
                queued: false,
              })
            }
            const task = mappedTasks[0]

            // 1. Feature-detect subtask support (cached per server).
            const support = await detectInlineSupport(server)

            // 2. Resolve the classified agent to a configured core agent name.
            //    Unknown agent names make the core's Task machinery error.
            let resolvedAgent = task.agent
            const known = await knownAgentNames(server)
            if (known && !known.has(resolvedAgent)) {
              // Try to map department-lead names to a built-in core agent so
              // inline still works without the department config installed.
              const builtins = ["build", "plan", "general", "explore"].filter((a) => known.has(a))
              if (builtins.length > 0) {
                resolvedAgent = builtins[0]
              } else {
                return JSON.stringify(await fallbackToRelay(directory, server, port, context, mappedTasks, {
                  inlineRequested: true,
                  inlineSupported: false,
                  reason: `agent "${task.agent}" is not configured on this core; no usable fallback agent found`,
                }))
              }
            }

            // 3. Fire-and-forget the subtask to the PARENT's own session.
            if (support.supported) {
              const posted = await postInlineSubtask(server, context.sessionID, context.agent, {
                agent: resolvedAgent,
                prompt: task.prompt,
                description: subtaskDescription(resolvedAgent, task.prompt),
              })
              if (posted.ok) {
                return JSON.stringify({
                  inline: true,
                  queued: true,
                  agent: resolvedAgent,
                  note:
                    "Subtask queued inline. It will render as a `│ Task` widget in this session and its result " +
                    "arrives when the core processes the queued message (after the current turn completes). " +
                    "Inline subtasks are processed SEQUENTIALLY by the core. For parallel fan-out use " +
                    "inline=false (relay) and next_agent/agents_status.",
                })
              }
              return JSON.stringify(await fallbackToRelay(directory, server, port, context, mappedTasks, {
                inlineRequested: true,
                inlineSupported: true,
                reason: `inline subtask POST failed (HTTP ${posted.status ?? "?"}${posted.body ? `: ${posted.body}` : ""}${posted.error ? ` ${posted.error}` : ""}); falling back to relay`,
              }))
            }

            // Not supported — fall back to the relay path so existing users
            // are completely unaffected.
            return JSON.stringify(await fallbackToRelay(directory, server, port, context, mappedTasks, {
              inlineRequested: true,
              inlineSupported: false,
              reason: support.reason,
            }))
          }

          // ── RELAY MODE (existing behavior) ──────────────────────────
          if (!(await ensureRelay(directory, server))) return JSON.stringify({ error: "Agent-Teams relay failed to start" })

          return JSON.stringify(await request(port, "POST", "/spawn", readToken(port), {
            parentID: context.sessionID,
            callerAgent: context.agent,
            tasks: mappedTasks,
          }))
        },
      }),

      next_agent: tool({
        description:
          "Wait for the next completed child of this Agent-Teams session. Other children continue running. " +
          "Only tracks relay-spawned children; inline subtasks (inline=true) are drained by the core itself, " +
          "so after inline use this returns noPending. " +
          "If the relay restarted mid-wait, returns relay_restarted=true with a list of still-running " +
          "sessionIDs — DO NOT re-spawn them; call agents_status to check their state then resume_agent for any that finished.",
        args: { timeoutSeconds: tool.schema.number().optional() },
        async execute(args, context) {
          if (!ALLOWED_AGENTS.has(context.agent)) return denied(context.agent)
          if (!(await ensureRelay(directory, server))) return JSON.stringify({ error: "Agent-Teams relay failed to start" })
          const timeoutSec = Number((args as any).timeoutSeconds ?? 120)
          const requestTimeoutMs = Math.max(130_000, (timeoutSec + 30) * 1000)
          // Retry loop: /await-any is a long-poll that breaks when the relay
          // restarts (connection refused / reset). On failure we wait 2s, re-check
          // relay liveness via ensureRelay, then retry — up to 5 attempts. This
          // handles the aux-server cascade scenario where the relay is respawned
          // mid-poll and the next relay instance has recovered the persisted state.
          const MAX_AWAIT_RETRIES = 5
          let lastErr: unknown
          for (let attempt = 0; attempt < MAX_AWAIT_RETRIES; attempt++) {
            if (attempt > 0) {
              await new Promise<void>((r) => setTimeout(r, 2000))
              const ok = await ensureRelay(directory, server)
              if (!ok) return JSON.stringify({ error: "Agent-Teams relay failed to restart" })
            }
            try {
              return JSON.stringify(await request(port, "POST", "/await-any", readToken(port), {
                parentID: context.sessionID,
                callerAgent: context.agent,
                timeoutSeconds: timeoutSec,
              }, requestTimeoutMs))
            } catch (e) {
              lastErr = e
              logPlugin(port, `[agent-teams] next_agent /await-any attempt ${attempt + 1}/${MAX_AWAIT_RETRIES} failed: ${e instanceof Error ? e.message : String(e)} — retrying`)
            }
          }
          // All retries exhausted — the relay restarted while we were waiting.
          // DO NOT tell the LLM the sessions are gone. Instead, return a
          // relay_restarted snapshot: the relay has recovered state from SQLite,
          // so all sessions are still alive. The LLM must call agents_status
          // to inspect current state and resume_agent for any that finished,
          // rather than re-spawning sessions that are already running.
          logPlugin(port, `[agent-teams] next_agent: relay restarted mid-wait — returning relay_restarted snapshot to prevent re-spawn`)
          return JSON.stringify({
            relay_restarted: true,
            message: "The relay restarted while waiting. Your sub-agent sessions are safe in relay.db — DO NOT re-spawn them. Call agents_status to see their current state, then call next_agent again to continue waiting, or resume_agent for any that finished.",
          })
        },
      }),

      agents_status: tool({
        description:
          "Inspect all current children of this Agent-Teams session without blocking. " +
          "Renders live hierarchical ASCII swarm status tree with elapsed runtimes and stall detection. " +
          "Reports relay-spawned children only; inline subtasks (inline=true) render as `│ Task` widgets " +
          "managed by the core and will not appear here.",
        args: {},
        async execute(_args, context) {
          if (!ALLOWED_AGENTS.has(context.agent)) return denied(context.agent)
          if (!(await ensureRelay(directory, server))) return JSON.stringify({ error: "Agent-Teams relay failed to start" })

          let allNodes: Array<any> = []
          try {
            const treeRes = await request(port, "GET", "/tree", readToken(port))
            if (Array.isArray(treeRes?.nodes) && treeRes.nodes.length > 0) {
              allNodes = treeRes.nodes
            }
          } catch {
            /* fallback to /collect */
          }

          let collectSpawned: Array<any> = []
          try {
            const collectRes = await request(port, "GET", `/collect?parentID=${encodeURIComponent(context.sessionID)}`, readToken(port))
            if (Array.isArray(collectRes?.spawned)) {
              collectSpawned = collectRes.spawned
            }
          } catch {
            /* silent */
          }

          const nodeMap = new Map<string, any>()
          for (const n of allNodes) {
            const id = n?.sessionID || n?.id
            if (id) nodeMap.set(id, { ...n, sessionID: id })
          }
          for (const s of collectSpawned) {
            const id = s?.sessionID || s?.id
            if (id) {
              const existing = nodeMap.get(id) || {}
              nodeMap.set(id, { ...existing, ...s, sessionID: id })
            }
          }

          const combinedNodes = Array.from(nodeMap.values())
          const roots = buildSwarmHierarchy(combinedNodes, context.sessionID)
          const now = Date.now()

          if (roots.length === 0) {
            const emptyMsg = "No background tasks running for this session."
            return JSON.stringify({
              tree: emptyMsg,
              output: emptyMsg,
              spawned: [],
              count: 0,
            })
          }

          const lines = renderSwarmTreeLines(roots, now)
          const treeOutput = lines.join("\n")
          const count = countSwarmTreeNodes(roots)

          return JSON.stringify({
            tree: treeOutput,
            output: treeOutput,
            spawned: collectSpawned.length > 0 ? collectSpawned : combinedNodes,
            count,
          })
        },
      }),

      resume_agent: tool({
        description:
          "Resume / follow up on an EXISTING agent session, reusing its accumulated context. " +
          "target_id supports natural agent names/roles (e.g. 'Backend Lead', 'Frontend') in addition to session IDs. " +
          "Optionally accept prompt for operator guidance. " +
          "The session must still be alive: an unknown or dead session returns the relay's error message.",
        args: {
          target_id: tool.schema.string().optional().describe("Target agent session ID or natural agent name/role (e.g. 'Backend Lead', 'Frontend')."),
          sessionID: tool.schema.string().optional().describe("Legacy session ID for backward compatibility."),
          prompt: tool.schema.string().optional().describe("Optional operator guidance or instructions for resuming the agent."),
        },
        async execute(args, context) {
          if (!ALLOWED_AGENTS.has(context.agent)) return denied(context.agent)
          const target = (args as any).target_id || (args as any).sessionID
          const prompt = (args as any).prompt || ""
          if (!target) {
            return JSON.stringify({ error: "resume_agent requires target_id (agent name or session ID)" })
          }
          if (!(await ensureRelay(directory, server))) return JSON.stringify({ error: "Agent-Teams relay failed to start" })
          try {
            const resumed = await request(port, "POST", "/resume", readToken(port), {
              target_id: target,
              sessionID: target,
              prompt,
            })
            return JSON.stringify(resumed)
          } catch (e) {
            return JSON.stringify({
              error: `resume_agent: ${e instanceof Error ? e.message : String(e)}`,
              target_id: target,
            })
          }
        },
      }),

      manage_agents: tool({
        description:
          "Manage subagent swarm lifecycle: kill, kill_all, inspect, or restart background workers. " +
          "target_id accepts natural agent name/role (e.g. 'Backend', 'Frontend Lead') or session ID.",
        args: {
          action: tool.schema.enum(["kill", "kill_all", "inspect", "restart"]).describe("Action to perform: 'kill', 'kill_all', 'inspect', or 'restart'."),
          target_id: tool.schema.string().optional().describe("Target agent session ID, natural agent name, or role (e.g. 'Backend', 'Frontend Lead')."),
          prompt: tool.schema.string().optional().describe("Optional guidance or instructions for restart."),
        },
        async execute(args, context) {
          if (!ALLOWED_AGENTS.has(context.agent)) return denied(context.agent)
          if (!(await ensureRelay(directory, server))) return JSON.stringify({ error: "Agent-Teams relay failed to start" })

          const action = (args as any).action
          const target = (args as any).target_id?.trim()
          const prompt = (args as any).prompt || ""

          if (action === "kill") {
            if (!target) return JSON.stringify({ error: "manage_agents 'kill' requires target_id" })
            try {
              const res = await request(port, "POST", "/kill", readToken(port), {
                target_id: target,
                sessionID: target,
              })
              return JSON.stringify(res)
            } catch (e) {
              return JSON.stringify({
                error: `manage_agents kill failed: ${e instanceof Error ? e.message : String(e)}`,
                target_id: target,
              })
            }
          }

          if (action === "kill_all") {
            try {
              const res = await request(port, "POST", "/kill-all", readToken(port), {
                parent_id: context.sessionID,
                parentID: context.sessionID,
                target_id: target,
              })
              return JSON.stringify(res)
            } catch (e) {
              return JSON.stringify({
                error: `manage_agents kill_all failed: ${e instanceof Error ? e.message : String(e)}`,
              })
            }
          }

          if (action === "restart") {
            if (!target) return JSON.stringify({ error: "manage_agents 'restart' requires target_id" })
            try {
              const res = await request(port, "POST", "/resume", readToken(port), {
                target_id: target,
                sessionID: target,
                prompt,
              })
              return JSON.stringify(res)
            } catch (e) {
              return JSON.stringify({
                error: `manage_agents restart failed: ${e instanceof Error ? e.message : String(e)}`,
                target_id: target,
              })
            }
          }

          if (action === "inspect") {
            try {
              const collectRes = await request(port, "GET", `/collect?parentID=${encodeURIComponent(context.sessionID)}`, readToken(port))
              const allSpawned: any[] = collectRes?.spawned || []
              const now = Date.now()

              let targetWorkers = allSpawned
              if (target) {
                const query = target.toLowerCase()
                targetWorkers = allSpawned.filter((w: any) =>
                  (w.sessionID && w.sessionID.toLowerCase() === query) ||
                  (w.agent && w.agent.toLowerCase().includes(query)) ||
                  (w.title && w.title.toLowerCase().includes(query))
                )
                if (targetWorkers.length === 0) {
                  return JSON.stringify({
                    error: `Agent or worker '${target}' not found in current session`,
                    target_id: target,
                  })
                }
              }

              const stalledOrFailed = targetWorkers.filter((w: any) => {
                const lastActive = w.updatedAt || w.createdAt || now
                const isStalled = w.status === "running" && (now - lastActive > 180_000)
                return w.status === "error" || w.status === "killed" || isStalled
              })

              const workersToReport = stalledOrFailed.length > 0 ? stalledOrFailed : targetWorkers
              const diagnostics: string[] = []

              for (const w of workersToReport) {
                const lastActive = w.updatedAt || w.createdAt || now
                const isStalled = w.status === "running" && (now - lastActive > 180_000)
                const statusLabel = isStalled ? `${w.status} [stalled]` : (w.status || "unknown")
                const elapsedStr = w.createdAt ? elapsed(now - w.createdAt) : "unknown"

                diagnostics.push(
                  `### Worker Diagnostics: ${w.agent || "Worker"} (${w.sessionID})\n` +
                  `- **Status**: ${statusLabel}\n` +
                  `- **Elapsed**: ${elapsedStr}\n` +
                  `- **Parent**: ${w.parentID || context.sessionID}\n` +
                  (w.error ? `- **Error**: ${w.error}\n` : "") +
                  (w.result ? `- **Last Output**: ${previewText(w.result)}\n` : "") +
                  (isStalled ? `- **Notice**: Worker has been inactive for >3 minutes. Recommend: manage_agents(action="restart", target_id="${w.sessionID}")\n` : "") +
                  (w.status === "error" ? `- **Notice**: Worker terminated with error. Recommend: manage_agents(action="restart", target_id="${w.sessionID}")\n` : "")
                )
              }

              const outputSummary = diagnostics.length > 0
                ? diagnostics.join("\n\n")
                : "All workers are healthy and running within normal time bounds."

              return JSON.stringify({
                ok: true,
                diagnostics: outputSummary,
                output: outputSummary,
                stalled_or_failed_count: stalledOrFailed.length,
                workers: workersToReport,
              })
            } catch (e) {
              return JSON.stringify({
                error: `manage_agents inspect failed: ${e instanceof Error ? e.message : String(e)}`,
              })
            }
          }

          return JSON.stringify({ error: `Unknown action '${action}'` })
        },
      }),

      ask_agent: tool({
        description:
          "Query an agent out-of-band without interrupting its running task or causing concurrency collisions. " +
          "target_id accepts natural agent name/role (e.g. 'Backend', 'Frontend Lead') or session ID.",
        args: {
          target_id: tool.schema.string().describe("Target agent name, role, or session ID to query."),
          prompt: tool.schema.string().describe("Question or prompt for the worker."),
        },
        async execute(args, context) {
          if (!ALLOWED_AGENTS.has(context.agent)) return denied(context.agent)
          const { target_id, prompt } = args as { target_id: string; prompt: string }
          if (!target_id || !prompt) {
            return JSON.stringify({ error: "ask_agent requires both target_id and prompt" })
          }
          if (!(await ensureRelay(directory, server))) return JSON.stringify({ error: "Agent-Teams relay failed to start" })
          try {
            const result = await request(port, "POST", "/ask", readToken(port), {
              target_id,
              sessionID: target_id,
              prompt,
            })
            return JSON.stringify(result)
          } catch (e) {
            return JSON.stringify({
              error: `ask_agent failed: ${e instanceof Error ? e.message : String(e)}`,
              target_id,
            })
          }
        },
      }),
    },
  }
}
