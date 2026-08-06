import { tool } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs"
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

function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  return hash
}

function relayPort(serverUrl: string): number {
  return PORT_BASE + (hashString(serverUrl) % PORT_RANGE)
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
  if (process.platform === "win32") return "C:/Program Files/nodejs/node.exe"
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

const relays = new Map<string, { port: number; ready: Promise<boolean> }>()

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
    return data.ok === true && data.eventsReady === true
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

function opencodeExecutable(): string {
  if (process.env.AGENT_TEAMS_OPENCODE) return process.env.AGENT_TEAMS_OPENCODE
  if (process.platform !== "win32") return "opencode"

  // Prefer the real executable. Spawning opencode.cmd through a shell can create
  // a visible console window even when windowsHide is true.
  const appData = process.env.APPDATA || ""
  const candidates = [
    join(appData, "npm", "node_modules", "opencode-ai", "node_modules", "opencode-windows-x64", "bin", "opencode.exe"),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  try {
    const found = execFileSync("where.exe", ["opencode"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((value: string) => value.trim())
      .find(Boolean)
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

async function startAuxiliaryServer(directory: string, originalUrl: string, _port: number, state: string): Promise<string | undefined> {
  // Let the OS pick a free port — no hardcoded range, no platform collisions.
  const auxiliaryPort = await findFreePort()
  const base = `http://127.0.0.1:${auxiliaryPort}/`
  if (await upstreamAvailable(base)) return base

  const log = openSync(join(state, "server.log"), "a")
  const executable = opencodeExecutable()
  const child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(auxiliaryPort)], {
    cwd: directory,
    detached: true,
    windowsHide: true,
    shell: process.platform === "win32" && executable.toLowerCase().endsWith(".cmd"),
    env: { ...process.env },
    stdio: ["ignore", log, log],
  })
  child.unref()

  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (await upstreamAvailable(base)) return base
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return undefined
}

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
        return ensureRelayInternal(directory, serverUrl)
      }
      // Original spawn succeeded — but re-probe liveness on EVERY call so a
      // relay that died since (heartbeat exit, crash, install/uninstall) gets
      // respawned instead of making every tool call fail until opencode restart.
      if (await health(existing.port)) return true
      relays.delete(serverUrl)
      console.error(`[agent-teams] relay on port ${existing.port} is not healthy — respawning`)
      return ensureRelayInternal(directory, serverUrl)
    })()
  }
  return ensureRelayInternal(directory, serverUrl)
}

async function ensureRelayInternal(directory: string, serverUrl: string): Promise<boolean> {
  const port = relayPort(serverUrl)
  const ready = (async () => {
    // Fast path: if a relay is already running and healthy on this port, reuse it.
    // This avoids the auxiliary server cascade entirely.
    if (await health(port)) return true

    const state = stateDir(port)
    let backendUrl = serverUrl
    if (!(await upstreamAvailable(backendUrl))) {
      const auxiliary = await startAuxiliaryServer(directory, serverUrl, port, state)
      if (!auxiliary) return false
      backendUrl = auxiliary
    }
    // Re-check after auxiliary — another process may have started the relay
    if (await health(port)) return true

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
      },
      stdio: ["ignore", log, log],
    })
    child.unref()
    return waitForRelay(port, backendUrl)
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

async function request(port: number, method: string, path: string, token: string | undefined, body?: unknown): Promise<any> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(`http://${RELAY_HOST}:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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
    if (!res.ok) return { tooOld: false }
    const data = (await res.json()) as { version?: string }
    const version = typeof data?.version === "string" ? data.version : undefined
    if (!version) return { tooOld: false }
    const m = version.match(/^(\d+)\.(\d+)/)
    if (!m) return { tooOld: false }
    const major = Number(m[1])
    const minor = Number(m[2])
    const tooOld = major < INLINE_CORES_MIN_VERSION[0] ||
      (major === INLINE_CORES_MIN_VERSION[0] && minor < INLINE_CORES_MIN_VERSION[1])
    return { version, tooOld }
  } catch {
    return { tooOld: false }
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
      // Best-effort cleanup of the throwaway session.
      fetch(`${base}session/${probeID}`, { method: "DELETE" }).catch(() => undefined)
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

export const AgentTeams = async ({ directory, serverUrl }: any) => {
  const server = serverUrl instanceof URL ? serverUrl.toString() : String(serverUrl)
  const port = relayPort(server)

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
          "so after inline use this returns noPending.",
        args: { timeoutSeconds: tool.schema.number().optional() },
        async execute(args, context) {
          if (!ALLOWED_AGENTS.has(context.agent)) return denied(context.agent)
          if (!(await ensureRelay(directory, server))) return JSON.stringify({ error: "Agent-Teams relay failed to start" })
          return JSON.stringify(await request(port, "POST", "/await-any", readToken(port), {
            parentID: context.sessionID,
            callerAgent: context.agent,
            timeoutSeconds: (args as any).timeoutSeconds ?? 120,
          }))
        },
      }),

      agents_status: tool({
        description:
          "Inspect all current children of this Agent-Teams session without blocking. " +
          "Reports relay-spawned children only; inline subtasks (inline=true) render as `│ Task` widgets " +
          "managed by the core and will not appear here.",
        args: {},
        async execute(_args, context) {
          if (!ALLOWED_AGENTS.has(context.agent)) return denied(context.agent)
          if (!(await ensureRelay(directory, server))) return JSON.stringify({ error: "Agent-Teams relay failed to start" })
          return JSON.stringify(await request(port, "GET", `/collect?parentID=${encodeURIComponent(context.sessionID)}`, readToken(port)))
        },
      }),
    },
  }
}
