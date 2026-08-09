import { createOpencodeClient } from "@opencode-ai/sdk"
import { createServer } from "node:http"
import { createServer as createNetServer } from "node:net"
import { randomBytes } from "node:crypto"
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync } from "node:fs"
import { join } from "node:path"
import { execSync } from "node:child_process"

if (process.platform === "win32") {
  try {
    const psFile = `${process.env.USERPROFILE || 'C:\\Users\\moham'}\\.gemini\\antigravity\\bin\\hide_console.ps1`
    execSync(`powershell -windowstyle hidden -file "${psFile}"`, { stdio: "ignore" })
  } catch {}
}

// agent-teams relay — runs as an EXTERNAL opencode SDK client.
// One relay per opencode server instance (port derived from serverUrl by the plugin).
//
// SECURITY: every request (except /health) must include a shared-secret token.
// The relay generates a random token on startup and writes it to a file that
// the plugin reads. This prevents local privilege escalation via unauthenticated
// access to the relay HTTP server.
//
// OUTPUT: all console.log is suppressed so relay messages don't leak into the
// opencode TUI. Errors go to stderr only.

const OPENCODE_URL = process.env.OPENCODE_URL
const DIRECTORY = process.env.OPENCODE_DIR || process.cwd()
const RELAY_HOST = process.env.RELAY_HOST || "127.0.0.1"
const RELAY_PORT = Number(process.env.RELAY_PORT)
const STATE_DIR = process.env.RELAY_STATE_DIR || join(process.cwd(), ".agent-teams")
const TOKEN_FILE = join(STATE_DIR, "token")

if (!OPENCODE_URL || !RELAY_PORT) throw new Error("OPENCODE_URL and RELAY_PORT are required")
mkdirSync(STATE_DIR, { recursive: true })

// --- Port-guard: exit BEFORE writing token if port is already bound ---
// This prevents token corruption: a duplicate process must NEVER overwrite the
// token file that the currently-running relay wrote.
await new Promise((resolve, reject) => {
  const probe = createNetServer()
  probe.once("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[relay] Port ${RELAY_PORT} is already bound by an active relay process. Exiting duplicate process.`)
      process.exit(0)
    }
    reject(err)
  })
  probe.listen(RELAY_PORT, RELAY_HOST, () => {
    probe.close(() => resolve())
  })
})

// --- Token generation ---
// The token is generated here but NOT persisted until the server has bound the
// port successfully (see persistToken, called from server.listen callback).
// Rationale: writing the token before listen means a process that LOSES the
// bind race (EADDRINUSE) would already have clobbered the live relay's token
// file before it exits — bricking the running relay's auth. The port-guard
// above covers the probe window, and deferring the write to the listen callback
// closes the residual gap between probe.close and server.listen entirely.
const AUTH_TOKEN = randomBytes(32).toString("hex")

// Atomically persist the shared-secret token so the plugin can read it.
// Temp-file + rename (atomic on same filesystem) + fsync + 0o600 (POSIX).
function persistToken() {
  const tmp = `${TOKEN_FILE}.tmp`
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    const fd = openSync(tmp, "w", 0o600)
    try {
      writeSync(fd, AUTH_TOKEN, null, "utf-8")
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, TOKEN_FILE)
  } catch (e) {
    // Clean up a partial temp file before exiting
    try { renameSync(tmp, TOKEN_FILE) } catch { /* ignore */ }
    console.error(`[relay] failed to write token file:`, e?.message ?? e)
    process.exit(1)
  }
}

function verifyToken(req) {
  const auth = req.headers["authorization"] || ""
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : ""
  return token === AUTH_TOKEN
}

const client = createOpencodeClient({ baseUrl: OPENCODE_URL })

// node tree: sessionID -> node
// node = { sessionID, parentID, agent, prompt, status, result, error, drained, children, createdAt, completedAt, autoContinueCount }
const nodes = new Map()

// Teams grouped by parent: parentID -> { spawned: node[], teamCreatedAt }
const teams = new Map()

// Per-session completion promises — eliminates the TOCTOU race entirely.
// When a session completes, its promise resolves; team_await_any races them.
const completionPromises = new Map() // sessionID -> { promise, resolve, reject }
let eventsReady = false

function getTeam(parentID) {
  let t = teams.get(parentID)
  if (!t) {
    t = { spawned: [], teamCreatedAt: Date.now() }
    teams.set(parentID, t)
  }
  return t
}

function registerNode(parentID, rec) {
  rec.children = []
  rec.createdAt = Date.now()
  rec.autoContinueCount = 0 // how many auto-"continue" resumes this session has consumed
  nodes.set(rec.sessionID, rec)
  const team = getTeam(parentID)
  team.spawned.push(rec)
  // Link parent's children list
  const parentNode = nodes.get(parentID)
  if (parentNode) parentNode.children.push(rec.sessionID)
  return team
}

// Create a completion promise for a session (idempotent — returns existing if present).
function ensureCompletionPromise(sessionID) {
  if (completionPromises.has(sessionID)) {
    return completionPromises.get(sessionID)
  }
  let resolve, reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  const entry = { promise, resolve, reject, settled: false }
  completionPromises.set(sessionID, entry)
  return entry
}

async function readSessionOutput(sessionID) {
  try {
    const res = await client.session.messages({
      path: { id: sessionID },
      query: { directory: DIRECTORY, limit: 50 },
    })
    const data = res?.data ?? res
    const msgs = Array.isArray(data) ? data : data?.messages ?? []
    // Return ONLY the last assistant text message (the final answer), not the
    // whole transcript — keeps the caller's context small.
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      const parts = m?.parts ?? []
      const texts = parts.filter((p) => p?.type === "text").map((p) => p?.text ?? "")
      if (texts.length > 0) {
        return texts.join("\n")
      }
    }
    return ""
  } catch (e) {
    console.error(`[relay] error reading session ${sessionID}:`, e?.message ?? e)
    return `[error reading session output]`
  }
}

async function spawnTask(parentID, task) {
  try {
    const rawPrompt = (task.prompt || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim()
    const cleanSnippet = rawPrompt.replace(/[\r\n]+/g, " ").trim().slice(0, 45)
    const title = `🤖 [${task.agent}] ${cleanSnippet}`
    const created = await client.session.create({
      body: { parentID, title },
      query: { directory: DIRECTORY },
    })
    const sessionID = created?.data?.id ?? created?.id
    if (!sessionID) throw new Error("no session id")

    const rec = { sessionID, parentID, agent: task.agent, prompt: rawPrompt, notify: Boolean(task.notify), status: "running", drained: false }
    registerNode(parentID, rec)

    await client.session.promptAsync({
      path: { id: sessionID },
      body: { agent: task.agent, parts: [{ type: "text", text: rawPrompt }] },
      query: { directory: DIRECTORY },
    })
    return rec
  } catch (e) {
    const rec = { sessionID: "", parentID, agent: task.agent, prompt: task.prompt, status: "error", error: e?.message ?? String(e), drained: false }
    getTeam(parentID).spawned.push(rec)
    return rec
  }
}

// Route a completed session's result — resolves its completion promise.
// This is the single synchronization point: team_await_any creates promises,
// routeCompletion resolves them. No TOCTOU because the promise is created
// BEFORE it's passed to Promise.race, and resolve() is idempotent.
function routeCompletion(sessionID, status, result, error) {
  const node = nodes.get(sessionID)
  if (!node) return
  node.status = status
  node.completedAt = Date.now()
  if (status === "error") node.error = error
  else node.result = result

  // The session completed successfully — a future reasoning_content hiccup on a
  // NEW run should get a fresh auto-continue budget, so reset the counter.
  if (status === "done") node.autoContinueCount = 0

  // Resolve the completion promise if one exists (created by ensureCompletionPromise)
  const entry = completionPromises.get(sessionID)
  if (entry && !entry.settled) {
    entry.settled = true
    entry.resolve(node)
  }
}

// --- Memory management constants ---
const NODE_TTL_MS = 30 * 60 * 1000         // 30 minutes — evict completed nodes after this
const CLEANUP_INTERVAL_MS = 60 * 1000       // Run cleanup every 60 seconds

function evictStale() {
  const now = Date.now()

  // Evict only drained completed/errored nodes past TTL. There is no spawn cap;
  // unfinished or undrained results must never be discarded.
  const completedNodes = []
  for (const [id, node] of nodes) {
    if ((node.status === "done" || node.status === "error") && node.drained) {
      completedNodes.push({ id, node })
    }
  }
  // Sort by completion time ascending (oldest first)
  completedNodes.sort((a, b) => (a.node.completedAt ?? 0) - (b.node.completedAt ?? 0))

  for (const { id, node } of completedNodes) {
    const pastTTL = node.completedAt && (now - node.completedAt > NODE_TTL_MS)
    if (pastTTL) {
      nodes.delete(id)
      completionPromises.delete(id) // Clean up orphaned promises
    }
  }

  // 2. Evict teams ONLY when they are truly finished. A team is finished when:
  //    - it has no spawned entries referencing live nodes (truly empty), OR
  //    - EVERY child node is completed (done/error), drained, and past the node TTL.
  //    A team with running or undrained children is NEVER evicted — otherwise a
  //    long-running sub-agent's result becomes unreachable via /await-any and
  //    /collect (the bug that silently orphaned >1h teams).
  for (const [parentID, team] of teams) {
    // Filter out spawned entries whose nodes no longer exist (evicted above)
    team.spawned = team.spawned.filter((s) => nodes.has(s.sessionID))

    if (team.spawned.length === 0) {
      // Truly empty team — safe to evict immediately
      teams.delete(parentID)
      continue
    }

    // All children finished AND drained AND individually past node TTL
    const allFinished = team.spawned.every((s) => {
      const node = nodes.get(s.sessionID)
      return node && (node.status === "done" || node.status === "error")
    })
    const allDrained = team.spawned.every((s) => nodes.get(s.sessionID)?.drained === true)
    const allPastTtl = team.spawned.every((s) => {
      const node = nodes.get(s.sessionID)
      return node && node.completedAt && now - node.completedAt > NODE_TTL_MS
    })
    if (allFinished && allDrained && allPastTtl) {
      teams.delete(parentID)
    }
  }
}

// Start periodic cleanup on server startup
const cleanupTimer = setInterval(evictStale, CLEANUP_INTERVAL_MS)
// Allow the process to exit even if the timer is active
cleanupTimer.unref()

const HEARTBEAT_INTERVAL_MS = 3000
const HEARTBEAT_MAX_FAILURES = 5 // tolerate transient blips; exit only after this many consecutive failures (~15s)

let heartbeatFailures = 0

async function checkUpstreamHeartbeat() {
  try {
    const res = await fetch(`${OPENCODE_URL}/global/health`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) {
      heartbeatFailures++
      console.error(`[relay] upstream opencode server reported non-${res.status} (heartbeat failure ${heartbeatFailures}/${HEARTBEAT_MAX_FAILURES})`)
    } else {
      // Recovered — reset the failure counter
      if (heartbeatFailures > 0) {
        console.error(`[relay] upstream opencode server healthy again (recovered after ${heartbeatFailures} failure(s))`)
      }
      heartbeatFailures = 0
    }
  } catch {
    heartbeatFailures++
    console.error(`[relay] upstream opencode server unreachable (heartbeat failure ${heartbeatFailures}/${HEARTBEAT_MAX_FAILURES})`)
  }

  if (heartbeatFailures >= HEARTBEAT_MAX_FAILURES) {
    console.error(`[relay] upstream opencode server unreachable for ${HEARTBEAT_MAX_FAILURES} consecutive heartbeats. Exiting relay.`)
    process.exit(0)
  }
}

const heartbeatTimer = setInterval(checkUpstreamHeartbeat, HEARTBEAT_INTERVAL_MS)
heartbeatTimer.unref()
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000
const RECONNECT_MAX_ATTEMPTS = 20

// Circuit breaker: if we fail RECONNECT_MAX_ATTEMPTS times in a row, stop trying
// and log a critical alert. A manual restart is required.
let consecutiveFailures = 0
let circuitOpen = false

// Clean-stream reconnect backoff: a stream that ends cleanly (upstream restart,
// idle timeout) must not trigger an immediate reconnect storm. Capped exponential
// backoff, reset once a stream has stayed connected for a meaningful duration.
const CLEAN_RECONNECT_MIN_STAY_MS = 30 * 1000 // reset backoff if the stream lasted this long
let cleanEndCount = 0
let lastConnectedAt = 0

// Reconcile sessions that completed while the event stream was down. The SSE
// subscription has no replay: a session that went idle during a reconnect
// window or while the circuit was open never delivered its session.idle event,
// so its result would otherwise be lost forever (parent /await-any stalls to
// timeout). After every successful (re)connect we re-check upstream status for
// tracked running sessions and route any that are now idle as completions.

// ── Retryable provider-error handling (transient model/provider quirks) ─────
// Certain provider/model errors are TRANSIENT: the session itself is not
// actually failed, and re-sending a minimal "continue" prompt to the SAME
// session resumes it and it completes normally (confirmed live). Three families
// are known to behave this way:
//   1. DeepSeek thinking-mode quirk:
//      "The `reasoning_content` in the thinking mode must be passed back to the API"
//   2. Model output JSON parse quirk:
//      "AI_JSONParseError: JSON parsing failed: Text: ..."
//   3. Provider-overload 503 (request queue full):
//      "Streaming response failed: [503] The request queue is full."
// We treat these as retryable instead of routing the task to status:"error".
// Auto-continue is bounded per session so a genuinely stuck session still
// surfaces its error to the parent. Deliberately conservative: only these
// well-known patterns match — arbitrary errors are never auto-continued.
const AUTO_CONTINUE_MAX = 3 // max auto-"continue" resumes per session

// Extract a searchable string from an error value that may be a string, an
// Error, or any other object (incl. the relay's nested
// {name, data:{message:...}} shape from ev.properties?.error).
function errorText(err) {
  if (typeof err === "string") return err
  if (err && typeof err.message === "string") return err.message
  try {
    return JSON.stringify(err ?? "")
  } catch {
    return String(err ?? "")
  }
}

// True for the known transient provider-error families above. The JSON
// stringify path in errorText() ensures nested shapes such as
// {name:"UnknownError", data:{message:"AI_JSONParseError: JSON parsing failed: ..."}}
// are searched through their serialized form.
function isAutoContinueError(err) {
  const text = errorText(err)
  if (/reasoning_content/i.test(text) && /must be passed back/i.test(text)) return true
  if (/AI_JSONParseError/i.test(text) || /JSON parsing failed/i.test(text)) return true
  // Family 3 — provider overload. Match ONLY the distinctive "request queue is
  // full" phrase (not "streaming response failed" or bare "503"), because other
  // 503s (Service Unavailable, rate limiting, etc.) may reflect genuine server
  // problems we should NOT auto-continue. This phrase is specific enough that a
  // session hitting it is resuming a queue-full transient overload.
  if (/request queue is full/i.test(text)) return true
  return false
}

// Send a minimal "continue" prompt to resume a session that hit a transient
// provider error. Fire-and-forget: the session's subsequent completion
// (session.idle) or another error arrives via the normal event stream.
function autoContinueSession(sid, node) {
  node.autoContinueCount = (node.autoContinueCount ?? 0) + 1
  console.error(`[relay] transient provider error for ${sid} (${node.agent}) — sent "continue" to resume (attempt ${node.autoContinueCount}/${AUTO_CONTINUE_MAX})`)
  client.session.promptAsync({
    path: { id: sid },
    body: { agent: node.agent, parts: [{ type: "text", text: "continue" }] },
    query: { directory: DIRECTORY },
  }).catch((e) => console.error(`[relay] auto-continue failed for ${sid}:`, e?.message ?? e))
}

async function reconcileMissedCompletions() {
  const running = [...nodes.values()].filter((n) => n.status === "running" && n.sessionID)
  if (running.length === 0) return
  try {
    const res = await client.session.status({ query: { directory: DIRECTORY } })
    const statusMap = (res?.data ?? res) || {}
    for (const node of running) {
      const st = statusMap[node.sessionID]
      if (!st) continue
      if (st.type === "idle") {
        console.error(`[relay] reconcile: recovered missed completion for ${node.sessionID} (${node.agent})`)
        const out = await readSessionOutput(node.sessionID)
        routeCompletion(node.sessionID, "done", out, undefined)
      } else if (st.type === "retry" && isAutoContinueError(st.message)) {
        // The session is stuck retrying a transient provider error that happened
        // while the event stream was down. Same treatment as the live
        // session.error path: resume it with a bounded auto-"continue".
        if ((node.autoContinueCount ?? 0) < AUTO_CONTINUE_MAX) {
          console.error(`[relay] reconcile: session ${node.sessionID} (${node.agent}) in retry with transient provider error — resuming`)
          autoContinueSession(node.sessionID, node)
        }
      }
    }
  } catch (e) {
    console.error("[relay] reconcile missed completions failed:", e?.message ?? e)
  }
}

async function startEventListener() {
  if (circuitOpen) {
    console.error("[relay] circuit breaker OPEN — event listener disabled. Restart relay to recover.")
    return
  }

  while (consecutiveFailures < RECONNECT_MAX_ATTEMPTS) {
    try {
      const sub = await client.event.subscribe()
      const stream = (sub?.data ?? sub)?.stream
      if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
        console.error("[relay] no event stream available, retrying...")
        consecutiveFailures++
        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, consecutiveFailures), RECONNECT_MAX_MS)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }

      // Connected successfully — reset failure counter
      consecutiveFailures = 0
      lastConnectedAt = Date.now()
      eventsReady = true
      console.error("[relay] event listener connected, streaming events...")

      // Recover any completions that were missed while the stream was down
      // (reconnect window / circuit-open). No-op when nothing is running.
      await reconcileMissedCompletions()

      for await (const raw of stream) {
        const ev = raw && typeof raw === "object" ? raw : null
        if (!ev) continue
        const type = ev.type
        if (type === "session.idle") {
          const sid = ev.properties?.sessionID
          if (!sid || !nodes.has(sid)) continue
          const node = nodes.get(sid)
          const out = await readSessionOutput(sid)
          if (node?.notify) {
            console.error(`[relay] NOTIFY: Task completed for agent '${node.agent}' (${sid})`)
          }
          routeCompletion(sid, "done", out, undefined)
        } else if (type === "session.error") {
          const sid = ev.properties?.sessionID
          if (!sid || !nodes.has(sid)) continue
          const node = nodes.get(sid)
          const err = ev.properties?.error ?? "session error"
          // Transient provider quirk (DeepSeek reasoning_content thinking-mode
          // or AI_JSONParseError) — resume the session with a minimal "continue"
          // prompt instead of failing the task. Bounded per session; fall
          // through to error when the session is genuinely stuck.
          if (isAutoContinueError(err)) {
            if ((node.autoContinueCount ?? 0) < AUTO_CONTINUE_MAX) {
              autoContinueSession(sid, node)
              continue // do NOT route to error — the task may still complete
            }
            console.error(`[relay] transient provider auto-continue retries exhausted for ${sid} (${node.agent}) — routing to error`)
          }
          if (node?.notify) {
            console.error(`[relay] NOTIFY: Task failed for agent '${node.agent}' (${sid}): ${err}`)
          }
          routeCompletion(sid, "error", undefined, err)
        } else if (type === "session.compacted") {
          const sid = ev.properties?.sessionID
          if (sid && nodes.has(sid)) {
            const node = nodes.get(sid)
            if (node && node.prompt && node.status === "running") {
              console.error(`[relay] Memory compacted for ${sid} (${node.agent}) — auto re-briefing task context`)
              client.session.promptAsync({
                path: { id: sid },
                body: { agent: node.agent, parts: [{ type: "text", text: `[System Memory Re-Brief]: Context was compacted. Reminder of your original task prompt:\n${node.prompt}` }] },
                query: { directory: DIRECTORY },
              }).catch((e) => console.error(`[relay] re-brief failed for ${sid}:`, e?.message ?? e))
            }
          }
        }
      }
      // Stream ended without error (upstream restart, idle timeout) — reconnect.
      // Apply capped exponential backoff so a server that keeps closing the
      // connection on accept (or a restart loop) doesn't create a reconnect storm.
      const cleanStayMs = lastConnectedAt ? Date.now() - lastConnectedAt : 0
      if (cleanStayMs < CLEAN_RECONNECT_MIN_STAY_MS) {
        cleanEndCount++
      } else {
        cleanEndCount = 0 // stream was healthy for a while — restart backoff
      }
      const cleanDelay = Math.min(RECONNECT_BASE_MS * Math.pow(2, cleanEndCount - 1), RECONNECT_MAX_MS)
      console.error(`[relay] event stream ended cleanly, reconnecting in ${cleanDelay}ms (clean-end #${cleanEndCount})...`)
      await new Promise((r) => setTimeout(r, cleanDelay))
    } catch (e) {
      eventsReady = false
      consecutiveFailures++
      console.error(`[relay] event listener error (attempt ${consecutiveFailures}/${RECONNECT_MAX_ATTEMPTS}):`, e?.message ?? e)
      const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, consecutiveFailures), RECONNECT_MAX_MS)
      await new Promise((r) => setTimeout(r, delay))
    }
  }

  // Exhausted retries — open circuit breaker
  circuitOpen = true
  eventsReady = false
  console.error(`[relay] CRITICAL: event listener failed ${RECONNECT_MAX_ATTEMPTS} times in a row. Circuit breaker OPEN. Completions will be LOST until relay restart.`)
}

const server = createServer(async (req, res) => {
  const respond = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" })
    res.end(JSON.stringify(obj))
  }
  const readBody = async (maxBytes = 1024 * 1024) => {
    const chunks = []
    let bytesRead = 0
    for await (const c of req) {
      bytesRead += c.length
      if (bytesRead > maxBytes) throw new Error("Payload body exceeds 1MB limit")
      chunks.push(c)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}")
  }
  const url = new URL(req.url || "/", `http://${req.headers.host}`)
  const path = url.pathname

  try {
    // /health is unauthenticated — needed for the plugin's startup check
    if (req.method === "GET" && path === "/health") {
      return respond(200, {
        ok: eventsReady,
        eventsReady,
        serverUrl: OPENCODE_URL,
        teams: teams.size,
        nodes: nodes.size,
        completionPromises: completionPromises.size,
        circuitOpen,
        consecutiveFailures,
      })
    }

    // All other endpoints require the shared-secret token
    if (!verifyToken(req)) {
      return respond(401, { error: "unauthorized — missing or invalid relay token" })
    }

    if (req.method === "POST" && path === "/reset-circuit") {
      if (circuitOpen) {
        circuitOpen = false
        consecutiveFailures = 0
        startEventListener()
      }
      return respond(200, { ok: true, circuitOpen })
    }

    if (req.method === "POST" && path === "/spawn") {
      const body = await readBody()
      const parentID = body.parentID
      const tasks = body.tasks ?? []
      const records = await Promise.all(tasks.map((task) => spawnTask(parentID, task)))
      const results = records.map((rec) => ({ agent: rec.agent, sessionID: rec.sessionID, parentID, status: rec.status, error: rec.error }))
      return respond(200, { spawned: results })
    }
    if (req.method === "POST" && path === "/await-any") {
      const body = await readBody()
      const parentID = body.parentID
      const timeoutMs = Number(body.timeoutSeconds ?? 120) * 1000
      const team = getTeam(parentID)

      // Phase 1: Check for already-completed, undrained children (synchronous snapshot).
      const doneNode = team.spawned.find((s) => !s.drained && (s.status === "done" || s.status === "error"))
      if (doneNode) {
        doneNode.drained = true
        return respond(200, { agent: doneNode.agent, sessionID: doneNode.sessionID, parentID, status: doneNode.status, result: doneNode.status === "error" ? doneNode.error : doneNode.result })
      }
      if (!team.spawned.length) {
        return respond(200, { noPending: true, reason: "no_tasks_spawned" })
      }

      // Phase 2: Race completion promises for all pending (not yet done/error) children.
      // This eliminates the TOCTOU: we create promises BEFORE awaiting, and
      // routeCompletion resolves them synchronously when events arrive.
      const pendingNodes = team.spawned.filter((s) => !s.drained && s.status !== "done" && s.status !== "error")

      if (pendingNodes.length === 0) {
        // All spawned tasks have already been completed and drained
        return respond(200, { noPending: true, reason: "all_tasks_drained" })
      }

      // Create completion promises for all pending nodes, then race them.
      const completionRace = pendingNodes.map((s) => ensureCompletionPromise(s.sessionID).promise)
      const timeout = new Promise((resolve) => setTimeout(() => resolve({ _timeout: true }), timeoutMs))

      const result = await Promise.race([...completionRace, timeout])

      if (result && result._timeout) {
        return respond(200, { timeout: true })
      }

      // result is a node — drain it and return
      result.drained = true
      return respond(200, { agent: result.agent, sessionID: result.sessionID, parentID, status: result.status, result: result.status === "error" ? result.error : result.result })
    }
    if (req.method === "GET" && path === "/collect") {
      const parentID = url.searchParams.get("parentID") || ""
      const team = getTeam(parentID)
      return respond(200, {
        spawned: team.spawned.map((s) => ({ agent: s.agent, sessionID: s.sessionID, parentID: s.parentID, status: s.status, result: s.result, error: s.error })),
      })
    }
    if (req.method === "GET" && path === "/tree") {
      // Full tree dump (debugging / supervisor visibility)
      return respond(200, { nodes: Array.from(nodes.values()).map((n) => ({ sessionID: n.sessionID, parentID: n.parentID, agent: n.agent, status: n.status })) })
    }
    return respond(404, { error: "not found" })
  } catch (e) {
    // Do not leak internal paths or stack traces
    console.error("[relay] request error:", e?.message ?? e)
    respond(500, { error: "internal relay error" })
  }
})

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[relay] Port ${RELAY_PORT} is already bound by an active relay process. Exiting duplicate process.`)
    process.exit(0)
  }
  console.error("[relay] server error:", err?.message ?? err)
  process.exit(1)
})

server.listen(RELAY_PORT, RELAY_HOST, () => {
  // Port bound successfully — NOW it is safe to persist the token. A duplicate
  // process that lost the bind race will have exited in the EADDRINUSE handler
  // below WITHOUT writing anything, so the live relay's token is never clobbered.
  persistToken()
  console.error(`[agent-teams-relay] listening on ${RELAY_HOST}:${RELAY_PORT}`)
  startEventListener()
})
