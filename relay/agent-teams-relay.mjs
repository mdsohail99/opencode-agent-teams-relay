import { createOpencodeClient } from "@opencode-ai/sdk"
import { createServer } from "node:http"
import { createServer as createNetServer } from "node:net"
import { randomBytes } from "node:crypto"
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { spawn } from "node:child_process"



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
const RELAY_PORT = Number(process.env.RELAY_PORT) || Number(process.env.AGENT_TEAMS_RELAY_PORT) || 25800
const STATE_DIR = process.env.RELAY_STATE_DIR || join(homedir(), "AppData", "Local", "opencode", "agent-teams", "shared")
const TOKEN_FILE = join(STATE_DIR, "token")
const WAL_FILE = join(STATE_DIR, "agent-teams-relay.wal")
const STATE_FILE = join(STATE_DIR, "agent-teams-relay-state.json")

if (!OPENCODE_URL) throw new Error("OPENCODE_URL is required")
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

    // Windows: the 0o600 open() mode is a no-op. Enforce a restrictive ACL so
    // the token file is readable only by the current user. Fire-and-forget —
    // the 'error' handler is mandatory (an unhandled 'error' event on a spawned
    // child crashes the relay); a failed icacls is logged, never fatal.
    if (process.platform === "win32") {
      const user = process.env.USERNAME
      if (!user) {
        console.error(`[relay] FIX-ME: cannot lock down ${TOKEN_FILE} ACL — USERNAME env not set`)
      } else {
        const child = spawn("icacls.exe", [TOKEN_FILE, "/inheritance:r", "/grant:r", `${user}:F`], {
          stdio: "ignore",
          windowsHide: true,
        })
        child.on("error", (e) => console.error(`[relay] FIX-ME: icacls failed to lock down ${TOKEN_FILE}:`, e?.message ?? e))
        child.unref()
      }
    } else {
      // POSIX defense-in-depth: the open() mode normally suffices, but this
      // guarantees 0o600 regardless of umask.
      try {
        chmodSync(TOKEN_FILE, 0o600)
      } catch (e) {
        console.error(`[relay] FIX-ME: chmod 0600 failed on ${TOKEN_FILE}:`, e?.message ?? e)
      }
    }
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

// Cap every upstream SDK call so a wedged opencode HTTP server cannot hang the
// relay process forever. The SSE /await-any long-poll is NOT capped here (it is
// bounded end-to-end by its own per-request timeout timer).
const SDK_TIMEOUT_MS = 30_000

// node tree: sessionID -> node
// node = { sessionID, parentID, agent, title, prompt, status, result, error, drained, children, createdAt, completedAt, autoContinueCount }
const nodes = new Map()

// Teams grouped by parent: parentID -> { spawned: node[], teamCreatedAt }
const teams = new Map()

// Tiny route table for wrong-method dispatch → 405 + Allow header.
const ROUTE_ALLOW = {
  "/health": ["GET"],
  "/reset-circuit": ["POST"],
  "/spawn": ["POST"],
  "/await-any": ["POST"],
  "/reconcile": ["POST"],
  "/resume": ["POST"],
  "/kill": ["POST"],
  "/kill-all": ["POST"],
  "/ask": ["POST"],
  "/drain-completed": ["POST"],
  "/collect": ["GET"],
  "/tree": ["GET"],
}

// Per-session completion promises — eliminates the TOCTOU race entirely.
// When a session completes, its promise resolves; team_await_any races them.
const completionPromises = new Map() // sessionID -> { promise, resolve, reject, settled }
let eventsReady = false

// Pending auto-drain notifications for parent sessions:
// parentID -> { queue: Node[], timer: Timeout|null, retrying: boolean }
const parentNotificationQueues = new Map()

// --- Concurrency Ceiling & FIFO Queueing ---
function readOpencodeConfig() {
  const configDir = process.env.OPENCODE_CONFIG_DIR
  const candidates = [
    join(DIRECTORY, "opencode.json"),
    join(DIRECTORY, ".config", "opencode", "opencode.json"),
    configDir ? join(configDir, "opencode.json") : null,
    join(homedir(), ".config", "opencode", "opencode.json"),
    join(homedir(), ".config", "ocd", "opencode.json"),
  ].filter(Boolean)

  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const raw = readFileSync(p, "utf-8").replace(/^\uFEFF/, "")
        return JSON.parse(raw)
      }
    } catch {}
  }
  return {}
}

function getMaxConcurrentAgents() {
  try {
    const config = readOpencodeConfig()
    const val = config.max_concurrent_agents ?? config.experimental?.max_concurrent_agents ?? process.env.MAX_CONCURRENT_AGENTS
    const parsed = Number(val)
    if (!Number.isNaN(parsed) && parsed > 0) return parsed
  } catch {}
  return 20
}

const taskQueue = []

function getRunningCount() {
  return Array.from(nodes.values()).filter((n) => n.status === "running" && n.sessionID).length
}

let isDispatching = false
async function dispatchNextQueued() {
  if (isDispatching) return
  isDispatching = true
  try {
    const maxConcurrent = getMaxConcurrentAgents()
    while (taskQueue.length > 0 && getRunningCount() < maxConcurrent) {
      const next = taskQueue.shift()
      const node = nodes.get(next.sessionID)
      if (!node || node.status !== "queued") continue

      node.status = "running"
      node.updatedAt = Date.now()
      logNode(node)
      appendEvent(node.sessionID, EVENT_RESUMED)
      flushNowSync()

      try {
        await client.session.promptAsync({
          path: { id: node.sessionID },
          body: { agent: node.agent, parts: [{ type: "text", text: next.prompt }] },
          query: { directory: DIRECTORY },
          signal: AbortSignal.timeout(SDK_TIMEOUT_MS),
        })
        console.error(`[relay] promoted queued task ${node.sessionID} (${node.agent}) to running`)
      } catch (e) {
        console.error(`[relay] failed to dispatch queued task ${node.sessionID}:`, e?.message ?? e)
        routeCompletion(node.sessionID, "error", undefined, e?.message ?? String(e))
      }
    }
  } finally {
    isDispatching = false
  }
}

// --- 2-Tier Natural Agent Target Resolution ---
function resolveTarget(target, parentID) {
  if (!target || typeof target !== "string") return null
  const clean = target.trim()
  if (!clean) return null

  const allNodes = Array.from(nodes.values())
  const scopedNodes = parentID ? allNodes.filter((n) => n.parentID === parentID) : []
  const pools = scopedNodes.length > 0 ? [scopedNodes, allNodes] : [allNodes]

  const isActive = (n) => n.status === "running" || n.status === "pending" || n.status === "queued"

  const sortByRecency = (list) =>
    list.slice().sort((a, b) => (b.updatedAt ?? b.completedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.completedAt ?? a.createdAt ?? 0))

  for (const pool of pools) {
    const activeNodes = pool.filter(isActive)
    const deadNodes = pool.filter((n) => !isActive(n))

    // Tier 1: Search active nodes
    // 1. exact sessionID
    const exactIdActive = activeNodes.filter((n) => n.sessionID === clean)
    if (exactIdActive.length > 0) return sortByRecency(exactIdActive)[0]

    // 2. exact agent name (case-insensitive)
    const exactAgentActive = activeNodes.filter((n) => typeof n.agent === "string" && n.agent.toLowerCase() === clean.toLowerCase())
    if (exactAgentActive.length > 0) return sortByRecency(exactAgentActive)[0]

    // 3. title substring (case-insensitive)
    const titleActive = activeNodes.filter((n) => {
      const t = (n.title || n.agent || "").toLowerCase()
      return t.includes(clean.toLowerCase())
    })
    if (titleActive.length > 0) return sortByRecency(titleActive)[0]

    // Only check completed/dead nodes if zero active matches exist
    // 1. exact sessionID
    const exactIdDead = deadNodes.filter((n) => n.sessionID === clean)
    if (exactIdDead.length > 0) return sortByRecency(exactIdDead)[0]

    // 2. exact agent name (case-insensitive)
    const exactAgentDead = deadNodes.filter((n) => typeof n.agent === "string" && n.agent.toLowerCase() === clean.toLowerCase())
    if (exactAgentDead.length > 0) return sortByRecency(exactAgentDead)[0]

    // 3. title substring (case-insensitive)
    const titleDead = deadNodes.filter((n) => {
      const t = (n.title || n.agent || "").toLowerCase()
      return t.includes(clean.toLowerCase())
    })
    if (titleDead.length > 0) return sortByRecency(titleDead)[0]
  }

  return null
}

function getDescendantNodeIds(rootID) {
  const result = []
  const queue = [rootID]
  const visited = new Set([rootID])

  while (queue.length > 0) {
    const currentId = queue.shift()
    const node = nodes.get(currentId)
    const team = teams.get(currentId)
    const directChildren = new Set()

    if (node?.children) {
      for (const cid of node.children) directChildren.add(cid)
    }
    if (team?.spawned) {
      for (const s of team.spawned) {
        if (s?.sessionID) directChildren.add(s.sessionID)
      }
    }

    for (const cid of directChildren) {
      if (!visited.has(cid)) {
        visited.add(cid)
        result.push(cid)
        queue.push(cid)
      }
    }
  }
  return result
}

// --- Hierarchical Swarm Tree & Stall Formatting ---
function formatNodeSummary(node) {
  if (!node) return "Unknown"
  const now = Date.now()
  const isStalled = node.status === "running" && (now - (node.updatedAt || node.createdAt || now) > 180000)
  const elapsed = Math.floor(((node.completedAt || now) - (node.createdAt || now)) / 1000)
  const statusStr = isStalled ? `${node.status} [stalled]` : node.status
  return `${node.agent || "Agent"} (${node.sessionID || "no-id"}) [${statusStr}, ${elapsed}s]`
}

function renderTreeAscii(rootIds) {
  const lines = []
  function walk(id, prefix, isLast) {
    const node = nodes.get(id)
    if (!node) return
    const connector = isLast ? "└─ " : "├─ "
    lines.push(`${prefix}${connector}${formatNodeSummary(node)}`)
    const childIds = (node.children || []).filter((cid) => nodes.has(cid))
    const childPrefix = prefix + (isLast ? "   " : "│  ")
    for (let i = 0; i < childIds.length; i++) {
      walk(childIds[i], childPrefix, i === childIds.length - 1)
    }
  }
  for (let i = 0; i < rootIds.length; i++) {
    walk(rootIds[i], "", i === rootIds.length - 1)
  }
  return lines.join("\n")
}

// --- Pure-Text Context Compression ---
function extractAbstract(text) {
  const trimmed = (text || "").trim()
  const headingMatches = [...trimmed.matchAll(/(?:^|\n)(#{1,6}\s+[^\n]+[\s\S]*)$/g)]
  let candidate = ""
  if (headingMatches.length > 0) {
    candidate = headingMatches[headingMatches.length - 1][1].trim()
  }
  if (!candidate) {
    candidate = trimmed.slice(-200).trim()
  }
  if (candidate.length > 200) {
    candidate = candidate.slice(0, 197) + "..."
  }
  return candidate
}

// --- Durable store (WAL + periodic atomic checkpoint) ---
// The redesign's persistence engine. Every in-memory node/team write is
// appended to ${STATE_DIR}/agent-teams-relay.wal (NDJSON, one line per
// mutation, O(1) per write) and periodically compacted into
// ${STATE_DIR}/agent-teams-relay-state.json (atomic rename). The Maps above
// stay the runtime source of truth — disk is read only at boot.
//   * Critical ops (spawn / completion / drain / resume / cascade / event)
//     flush synchronously (append + fsync) so the restart contract holds.
//   * Non-critical ops (touches, boundary events) coalesce into the next
//     30ms flush — the on-disk state never lags memory by more than that.
//   * State on disk is NEVER newer than memory; replay is by seq > savedSeq,
//     so a crash at any point replays exactly the un-checkpointed delta.
// A corrupt checkpoint is fatal at boot (process.exit(1)) — matching the old
// openDatabase() posture; the plugin respawns the relay and the failure stays
// visible in the relay log. A torn trailing WAL line is tolerated and skipped.
const EVENT_CREATED = "created"
const EVENT_IDLE = "idle"
const EVENT_ERROR = "error"
const EVENT_COMPACTED = "compacted"
const EVENT_RESUMED = "resumed"
const EVENT_DELETED = "deleted"
const EVENT_NEEDS_ATTENTION = "needs_attention"

// Windows fs discipline: NTFS renames/appends can transiently throw
// EPERM/EBUSY/EACCES while an AV scanner or Indexer holds a handle. Bounded
// retry with backoff — never an unbounded spin loop.
const RETRY_BACKOFF_MS = [10, 20, 40, 80]
const RETRY_MAX_ATTEMPTS = 5

const FLUSH_DELAY_MS = Number(process.env.FLUSH_DELAY_MS) || 30
const CHECKPOINT_INTERVAL_MS = Number(process.env.CHECKPOINT_INTERVAL_MS) || 60_000
const WAL_BYTES_MAX = Number(process.env.WAL_BYTES_MAX) || 8 * 1024 * 1024

// Single-writer discipline: the pending buffer is the ONLY write path. All
// appends and compactions are synchronous on the single-threaded loop (no
// persistent append handle to race), and `sequential` guards re-entry.
let seqCtr = 0 // monotonic sequence; WAL order == memory order
let pendingLogs = [] // NDJSON lines not yet on disk
let flushedSeq = 0 // highest seq known-durable in the WAL
let savedSeq = 0 // highest seq folded into the checkpoint
let sequential = false // a critical flush is in progress
let flushTimer = null

function logLine(obj) {
  obj.seq = ++seqCtr
  pendingLogs.push(JSON.stringify(obj))
}

// Serialization contract (§2.2): the projection is a full current-state
// snapshot of one node. WAL node lines and the checkpoint share it. Fields
// never persisted: prompt, notify, children (rebuilt), autoContinuePending
// (re-derived), stuckToolAutoResumeCount, error-stub sessionIDs.
function nodeProjection(node) {
  const p = {
    sessionID: node.sessionID,
    parentID: node.parentID,
    agent: node.agent,
    title: node.title,
    status: node.status,
    notify: Boolean(node.notify),
    drained: Boolean(node.drained),
    retryCount: node.autoContinueCount ?? 0,
    stuckToolAutoResumeCount: node.stuckToolAutoResumeCount ?? node.autoContinueCount ?? 0,
    createdAt: node.createdAt,
  }
  if (node.status === "error" || node.status === "killed") {
    if (node.error !== undefined) p.error = node.error
  } else if (node.result !== undefined) {
    p.result = node.result
  }
  // updated_at historically carried the completion timestamp (and, after
  // reconcile touches, the last activity) — the 30-day orphan sweep keys off
  // it. Preserve that dual role exactly.
  p.updatedAt = node.completedAt ?? node.updatedAt ?? node.createdAt ?? Date.now()
  return p
}

function logNode(node) {
  logLine({ op: "node", ts: Date.now(), data: nodeProjection(node) })
}

function logNodeDeleted(sessionID) {
  logLine({ op: "nodeDel", ts: Date.now(), sessionID })
}

// Append a chunk to the WAL with bounded retry. Returns true on success; on
// final failure logs and returns false (caller rolls the chunk back).
function appendWalSync(chunk) {
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const fd = openSync(WAL_FILE, "a")
      try {
        writeSync(fd, chunk, null, "utf-8")
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      return true
    } catch (e) {
      if (attempt === RETRY_MAX_ATTEMPTS - 1) {
        console.error("[relay] WAL append failed:", e?.message ?? e)
        return false
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_BACKOFF_MS[attempt])
    }
  }
  return false
}

// Atomic write (tmp + fsync + rename) with bounded retry. Used for the
// checkpoint and for WAL compaction rewrites.
function writeFileAtomic(targetPath, payload) {
  const tmp = targetPath + ".tmp"
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const fd = openSync(tmp, "w", 0o600)
      try {
        writeSync(fd, payload, null, "utf-8")
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, targetPath)
      return true
    } catch (e) {
      if (attempt === RETRY_MAX_ATTEMPTS - 1) {
        console.error(`[relay] atomic write failed for ${targetPath}:`, e?.message ?? e)
        return false
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_BACKOFF_MS[attempt])
    }
  }
  return false
}

// Critical flush: write the pending buffer to the WAL now, synchronously.
// On append failure the chunk is rolled back into pendingLogs — never dropped.
function flushNowSync() {
  if (sequential || pendingLogs.length === 0) return
  sequential = true
  const chunk = pendingLogs.join("\n") + "\n"
  pendingLogs = []
  try {
    if (appendWalSync(chunk)) {
      flushedSeq = seqCtr
    } else {
      pendingLogs = chunk.split("\n").filter((l) => l) .concat(pendingLogs)
    }
  } finally {
    sequential = false
  }
  maybeCheckpoint() // WAL_BYTES_MAX threshold — bounds log growth under heavy fan-out
}

// Non-critical flush: coalesce into a single 30ms-later write.
function markFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    try {
      flushNowSync()
    } catch (e) {
      console.error("[relay] deferred flush failed:", e?.message ?? e)
    }
  }, FLUSH_DELAY_MS)
  flushTimer.unref?.()
}

// Bump a running node's recency marker (replaces the old SQL touchNode). Keeps
// the 30-day orphan sweep from mistaking an actively-reconciled tree for stale.
function touchNode(sessionID) {
  const node = nodes.get(sessionID)
  if (!node) return
  node.updatedAt = Date.now()
  logNode(node)
  markFlush() // non-critical — recency is best-effort
}

// events is append-only — the audit trail that lets a freshly-restarted relay
// explain what happened while it was down. Never read at runtime; retained in
// the WAL until compaction prunes it.
function appendEvent(sessionID, eventType) {
  logLine({ op: "event", sessionID, eventType, ts: Date.now() })
}

// Compaction: rewrite the WAL keeping only recent event lines plus node lines
// not yet folded into a checkpoint (seq > savedSeq). Runs on the checkpoint
// cadence and when the WAL exceeds WAL_BYTES_MAX. A crash between the atomic
// checkpoint write and this rewrite is safe — replay skips seq <= savedSeq.
function compactWal() {
  let raw
  try {
    raw = readFileSync(WAL_FILE, "utf-8")
  } catch (e) {
    if (e?.code !== "ENOENT") console.error("[relay] WAL compaction read failed:", e?.message ?? e)
    return
  }
  const cutoff = Date.now() - EVENT_RETENTION_MS
  const keep = []
  let pruned = 0
  for (const line of raw.split("\n")) {
    if (!line) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue // torn trailing line — drop
    }
    if (obj.op === "event") {
      if (obj.ts >= cutoff) keep.push(line)
      else pruned++
    } else if ((obj.seq ?? 0) > savedSeq) {
      keep.push(line)
    }
  }
  if (pruned === 0) return
  const payload = keep.join("\n") + "\n"
  if (writeFileAtomic(WAL_FILE, payload)) {
    console.error(`[relay] pruned ${pruned} event(s) older than retention; WAL compacted (${keep.length} line(s) kept)`)
  }
}

// Best-effort like the old mirror(): a failing compact logs to stderr and
// never crashes the relay or bounces the SSE stream.
function pruneEvents() {
  try {
    compactWal()
  } catch (e) {
    console.error("[relay] event prune failed:", e?.message ?? e)
  }
}

// Serialize the in-memory maps into the checkpoint payload. teams[].spawned is
// an explicit ordered id array — the delivery-order contract for /await-any's
// first-undrained-done scan. parentConfirmedDeleted/parentDeletedAt are
// dropped (write-only in the old schema; deleted in the same txn as the flag).
function serializeState() {
  return JSON.stringify({
    version: 3,
    savedSeq: flushedSeq,
    savedAt: Date.now(),
    teams: Array.from(teams.entries()).map(([parentID, t]) => ({
      parentID,
      spawned: t.spawned.filter((n) => n?.sessionID).map((n) => n.sessionID),
      teamCreatedAt: t.teamCreatedAt,
    })),
    nodes: Array.from(nodes.values()).map(nodeProjection),
  })
}

function writeCheckpoint() {
  const payload = serializeState()
  if (!writeFileAtomic(STATE_FILE, payload)) return
  savedSeq = flushedSeq
  compactWal()
}

// Run every CHECKPOINT_INTERVAL_MS, plus whenever the WAL outgrows
// WAL_BYTES_MAX (checked after each critical flush).
function maybeCheckpoint() {
  try {
    if (existsSync(WAL_FILE) && statSync(WAL_FILE).size > WAL_BYTES_MAX) {
      console.error(`[relay] WAL exceeded ${WAL_BYTES_MAX} bytes — checkpointing`)
      writeCheckpoint()
    }
  } catch (e) {
    console.error("[relay] checkpoint size check failed:", e?.message ?? e)
  }
}

const checkpointTimer = setInterval(() => {
  writeCheckpoint()
}, CHECKPOINT_INTERVAL_MS)
checkpointTimer.unref()

// --- Boot: load checkpoint, then replay the WAL delta ---
// Teams/nodes are rebuilt from the checkpoint; completionPromises are NOT
// restored (/await-any re-registers them on demand for still-pending nodes,
// and done nodes are served by its synchronous done-check). Then the WAL delta
// (seq > savedSeq) is applied in order.
function restoreNodeRecord(n) {
  const rec = {
    sessionID: n.sessionID,
    parentID: n.parentID,
    agent: n.agent,
    title: n.title ?? (n.agent ? `🤖 [${n.agent}]` : ""),
    status: n.status,
    notify: Boolean(n.notify),
    drained: Boolean(n.drained),
    createdAt: n.createdAt,
    updatedAt: n.updatedAt ?? n.createdAt,
    autoContinueCount: n.retryCount ?? 0,
    stuckToolAutoResumeCount: n.stuckToolAutoResumeCount ?? n.retryCount ?? 0,
    children: [],
  }
  if (n.status === "error" || n.status === "killed") rec.error = n.error ?? undefined
  else rec.result = n.result ?? undefined
  if (n.status === "done" || n.status === "error" || n.status === "killed") rec.completedAt = n.updatedAt ?? n.createdAt
  return rec
}

function linkNode(rec) {
  nodes.set(rec.sessionID, rec)
  const team = getTeam(rec.parentID)
  team.spawned.push(rec)
  const parentNode = nodes.get(rec.parentID)
  if (parentNode) parentNode.children.push(rec.sessionID)
}

function applyWalLine(obj) {
  const seq = obj?.seq ?? 0
  if (seq <= savedSeq) return // already folded into the checkpoint — idempotent
  seqCtr = Math.max(seqCtr, seq)
  if (obj.op === "node") {
    const n = obj.data ?? obj
    if (!n?.sessionID) return
    // Re-link into the same team (getTeam may not exist yet if the team line
    // was compacted; spawned order follows WAL order).
    linkNode(restoreNodeRecord(n))
  } else if (obj.op === "nodeDel") {
    const rec = nodes.get(obj.sessionID)
    if (!rec) return
    const team = teams.get(rec.parentID)
    if (team) team.spawned = team.spawned.filter((s) => s.sessionID !== rec.sessionID)
    nodes.delete(obj.sessionID)
  }
  // event lines: replay does not need them at runtime (append-only diary)
}

function loadDurableState() {
  // 1. Checkpoint (fast path).
  let state = null
  if (existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(readFileSync(STATE_FILE, "utf-8"))
    } catch (e) {
      throw new Error(`corrupt checkpoint ${STATE_FILE}: ${e?.message ?? e}`)
    }
    if (state?.version !== 3) throw new Error(`unsupported checkpoint version in ${STATE_FILE}: ${state?.version}`)
    savedSeq = Number(state.savedSeq) || 0
    seqCtr = savedSeq
    for (const t of state.teams ?? []) {
      if (t?.parentID != null) teams.set(t.parentID, { spawned: [], teamCreatedAt: t.teamCreatedAt ?? Date.now() })
    }
    for (const n of state.nodes ?? []) {
      if (n?.sessionID) linkNode(restoreNodeRecord(n))
    }
  }

  // 2. WAL replay (delta since the checkpoint).
  if (existsSync(WAL_FILE)) {
    const raw = readFileSync(WAL_FILE, "utf-8")
    for (const line of raw.split("\n")) {
      if (!line) continue
      let obj
      try {
        obj = JSON.parse(line)
      } catch {
        continue // torn trailing line — skip
      }
      applyWalLine(obj)
    }
  }

  // 3. Normalize teamCreatedAt to the earliest child (as the old SQL restore did).
  for (const team of teams.values()) {
    if (team.spawned.length > 0) {
      team.teamCreatedAt = Math.min(...team.spawned.map((n) => n.createdAt))
    }
  }

  // 4. Re-queue any restored nodes that were queued when relay stopped
  for (const node of nodes.values()) {
    if (node.status === "queued" && node.sessionID) {
      taskQueue.push({
        sessionID: node.sessionID,
        parentID: node.parentID,
        agent: node.agent,
        prompt: node.prompt || "",
      })
    }
  }

  pruneEvents()
}

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
  rec.updatedAt = rec.createdAt // orphan-sweep recency starts at creation
  rec.autoContinueCount = 0 // how many auto-"continue" resumes this session has consumed
  nodes.set(rec.sessionID, rec)
  const team = getTeam(parentID)
  team.spawned.push(rec)
  // Link parent's children list
  const parentNode = nodes.get(parentID)
  if (parentNode) parentNode.children.push(rec.sessionID)
  // Fresh nodes are always running/undrained with no result yet.
  logNode(rec)
  appendEvent(rec.sessionID, EVENT_CREATED)
  flushNowSync() // spawn is critical — the session must survive a hard kill
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
      signal: AbortSignal.timeout(SDK_TIMEOUT_MS),
    })
    const data = res?.data ?? res
    const msgs = Array.isArray(data) ? data : data?.messages ?? []
    const node = nodes.get(sessionID)

    const getRole = (m) => m?.role || m?.info?.role || ""

    if (node?.autoContinuePending) {
      const lastContinueIdx = msgs.findLastIndex((m) =>
        (m?.parts ?? []).some((p) => p?.type === "text" && typeof p?.text === "string" && p.text.trim().toLowerCase() === "continue")
      )
      if (lastContinueIdx === -1) {
        // Continue prompt not in transcript yet (e.g. early idle before continue turn output)
        return ""
      }
      const hasPostContinueText = msgs.slice(lastContinueIdx + 1).some((m) =>
        getRole(m) !== "user" && getRole(m) !== "system" && (m?.parts ?? []).some((p) => p?.type === "text" && p.text.trim().toLowerCase() !== "continue")
      )
      if (hasPostContinueText) {
        node.autoContinuePending = false
      } else {
        // Check if there is pre-continue text. In test 1, prompt_async didn't append text after continue, but pre-continue had the report.
        const preContinueText = msgs.slice(0, lastContinueIdx).findLast((m) =>
          getRole(m) !== "user" && getRole(m) !== "system" && (m?.parts ?? []).some((p) => p?.type === "text" && p.text.trim().toLowerCase() !== "continue")
        )
        if (preContinueText) {
          node.autoContinuePending = false
        } else {
          return ""
        }
      }
    }

    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      const role = getRole(m)
      if (role === "user" || role === "system") continue
      const parts = m?.parts ?? []

      const texts = parts
        .filter((p) => p?.type === "text" && typeof p?.text === "string")
        .map((p) => p.text)
        .filter((t) => t.trim().toLowerCase() !== "continue")

      if (texts.length > 0) {
        const fullOutput = texts.join("\n")
        if (fullOutput.length > 1500) {
          try {
            const logsDir = join(STATE_DIR, "logs")
            mkdirSync(logsDir, { recursive: true })
            const logFile = join(logsDir, `${sessionID}.log`)
            writeFileSync(logFile, fullOutput, "utf-8")

            const abstract = extractAbstract(fullOutput)
            return `${abstract}\n\n[Full output (${fullOutput.length} chars) archived to: ${logFile}]`
          } catch (e) {
            console.error(`[relay] failed to archive log for ${sessionID}:`, e?.message ?? e)
          }
        }
        return fullOutput
      }
    }

    // Second pass: if no text turn was found (e.g. agent completed with tool actions
    // like file write or bash command), synthesize a summary from the last tool actions
    // so the agent completes cleanly instead of stalling in 'running' state indefinitely.
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      const role = getRole(m)
      if (role === "user" || role === "system") continue
      const parts = m?.parts ?? []
      const toolCalls = parts.filter((p) => p?.type === "tool_use" || p?.type === "tool" || p?.callID)
      const toolResults = parts.filter((p) => p?.type === "tool_result")
      if (toolCalls.length > 0 || toolResults.length > 0) {
        const toolNames = toolCalls.map((p) => p?.name || p?.tool || "tool").filter(Boolean).join(", ")
        const snippets = toolResults
          .map((p) => {
            if (typeof p?.content === "string") return p.content
            if (Array.isArray(p?.content)) {
              return p.content.filter((c) => c?.type === "text").map((c) => c.text).join("\n")
            }
            if (typeof p?.output === "string") return p.output
            return ""
          })
          .filter(Boolean)
          .join("\n")
          .trim()
          .slice(0, 500)
        return `[Agent completed with tool(s): ${toolNames || "executed actions"}]\n${snippets}`.trim()
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

    // Deduplication check: Avoid spawning duplicate concurrent leads for the exact same agent under this parent
    const team = getTeam(parentID)
    const existingActive = team.spawned.find(
      (s) => s.agent === task.agent && (s.status === "running" || s.status === "queued") && s.sessionID
    )
    if (existingActive && !task.force) {
      console.error(`[relay] duplicate lead avoided: '${task.agent}' is already active (${existingActive.sessionID}, status: ${existingActive.status}) for parent ${parentID}`)
      return existingActive
    }

    const created = await client.session.create({
      body: { parentID, title },
      query: { directory: DIRECTORY },
      signal: AbortSignal.timeout(SDK_TIMEOUT_MS),
    })
    const sessionID = created?.data?.id ?? created?.id
    if (!sessionID) throw new Error("no session id")

    const maxConcurrent = getMaxConcurrentAgents()
    const runningCount = getRunningCount()

    if (runningCount >= maxConcurrent) {
      const rec = { sessionID, parentID, agent: task.agent, title, prompt: rawPrompt, notify: Boolean(task.notify), status: "queued", drained: false }
      registerNode(parentID, rec)
      taskQueue.push({ sessionID, parentID, agent: task.agent, prompt: rawPrompt })
      console.error(`[relay] concurrency ceiling reached (${runningCount}/${maxConcurrent}) — queued task for ${sessionID} (${task.agent})`)
      return rec
    }

    const rec = { sessionID, parentID, agent: task.agent, title, prompt: rawPrompt, notify: Boolean(task.notify), status: "running", drained: false }
    registerNode(parentID, rec)

    await client.session.promptAsync({
      path: { id: sessionID },
      body: { agent: task.agent, parts: [{ type: "text", text: rawPrompt }] },
      query: { directory: DIRECTORY },
      signal: AbortSignal.timeout(SDK_TIMEOUT_MS),
    })
    return rec
  } catch (e) {
    const rec = { sessionID: "", parentID, agent: task.agent, title: `🤖 [${task.agent}]`, prompt: task.prompt, status: "error", error: e?.message ?? String(e), drained: false }
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
  if (status === "error" || status === "killed") node.error = error
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
  // Persist completion state: node line carries updatedAt = completion time
  // (restored as completedAt at boot so TTL eviction survives restarts).
  logNode(node)
  appendEvent(sessionID, status === "error" ? EVENT_ERROR : (status === "killed" ? "killed" : EVENT_IDLE))
  flushNowSync() // completion is critical — the restart contract depends on it

  void dispatchNextQueued()

  scheduleParentNotification(node.parentID, node)
}

// --- Auto-drain notification queue for parent sessions ---

function scheduleParentNotification(parentID, node) {
  if (!parentID || parentID === node?.sessionID) return

  const team = teams.get(parentID)
  const spawned = team?.spawned || []
  const allCompleted = spawned.length > 0 && spawned.every((t) => t.status === "done" || t.status === "error" || t.status === "killed")

  if (!node?.notify && !allCompleted) return

  let entry = parentNotificationQueues.get(parentID)
  if (!entry) {
    entry = { queue: [], timer: null, retrying: false }
    parentNotificationQueues.set(parentID, entry)
  }

  // Avoid duplicate session IDs in the queue
  if (!entry.queue.some((n) => n.sessionID && n.sessionID === node.sessionID)) {
    entry.queue.push(node)
  }

  // If all completed, also ensure any other completed undrained nodes from this team are queued
  if (allCompleted) {
    for (const t of spawned) {
      if (!t.drained && (t.status === "done" || t.status === "error" || t.status === "killed")) {
        if (!entry.queue.some((n) => n.sessionID && n.sessionID === t.sessionID)) {
          entry.queue.push(t)
        }
      }
    }
  }

  // Bounded timer: do not reset an existing timer to avoid debounce starvation
  if (!entry.timer) {
    entry.timer = setTimeout(() => {
      entry.timer = null
      void drainParentNotifications(parentID)
    }, 1500)
  }
}

async function drainParentNotifications(parentID) {
  const entry = parentNotificationQueues.get(parentID)
  if (!entry) return

  // Filter queue for undrained nodes (!n.drained). If empty, clear queue and return.
  entry.queue = (entry.queue || []).filter((n) => !n.drained)
  if (entry.queue.length === 0) {
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    entry.retrying = false
    return
  }

  // Check upstream parent session status via client.session.status.
  // If parent is currently running or generating, keep queue safe and defer until free.
  let isBusy = false
  try {
    const res = await client.session.status({ query: { directory: DIRECTORY }, signal: AbortSignal.timeout(SDK_TIMEOUT_MS) })
    if (res && isConfirmedNotFound(res)) {
      entry.notFoundCount = (entry.notFoundCount || 0) + 1
      if (entry.notFoundCount >= 3) {
        console.error(`[relay] auto-drain: parent ${parentID} confirmed not found after ${entry.notFoundCount} attempts — discarding notification queue`)
        if (entry.timer) clearTimeout(entry.timer)
        parentNotificationQueues.delete(parentID)
        return
      }
      console.error(`[relay] auto-drain: parent ${parentID} status check returned 404 (attempt ${entry.notFoundCount}/3) — retrying in 4000ms`)
      if (!entry.timer) {
        entry.retrying = true
        entry.timer = setTimeout(() => {
          entry.timer = null
          void drainParentNotifications(parentID)
        }, 4000)
      }
      return
    }
    const statusMap = (res?.data ?? res) || {}
    const st = statusMap[parentID]
    if (st) {
      const sType = typeof st === "string" ? st : (st.type ?? st.status ?? "")
      if (sType === "busy" || sType === "running" || sType === "generating") {
        isBusy = true
      }
    }
  } catch (e) {
    const is404 = e?.status === 404 || e?.response?.status === 404 || /404|not found/i.test(e?.message ?? String(e))
    if (is404) {
      entry.notFoundCount = (entry.notFoundCount || 0) + 1
      if (entry.notFoundCount >= 3) {
        console.error(`[relay] auto-drain: parent ${parentID} status check returned 404 after ${entry.notFoundCount} attempts — discarding notification queue`)
        if (entry.timer) clearTimeout(entry.timer)
        parentNotificationQueues.delete(parentID)
        return
      }
      console.error(`[relay] auto-drain: parent ${parentID} status check threw 404 (attempt ${entry.notFoundCount}/3) — retrying in 4000ms`)
      if (!entry.timer) {
        entry.retrying = true
        entry.timer = setTimeout(() => {
          entry.timer = null
          void drainParentNotifications(parentID)
        }, 4000)
      }
      return
    }
    console.error(`[relay] auto-drain: status check failed for parent ${parentID} (${e?.message ?? e}) — rescheduling retry after 2500ms`)
    if (!entry.timer) {
      entry.retrying = true
      entry.timer = setTimeout(() => {
        entry.timer = null
        void drainParentNotifications(parentID)
      }, 2500)
    }
    return
  }

  if (isBusy) {
    // Parent is currently busy: leave notifications queued and arm a retry timer.
    // SSE session.idle event will also trigger immediate drain the instant the parent becomes free.
    if (!entry.timer) {
      entry.retrying = true
      entry.timer = setTimeout(() => {
        entry.timer = null
        void drainParentNotifications(parentID)
      }, 2500)
    }
    return
  }

  const undrained = entry.queue.filter((n) => !n.drained)
  if (undrained.length === 0) {
    entry.queue = []
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    entry.retrying = false
    return
  }

  const team = teams.get(parentID)
  const spawned = team?.spawned || []
  const runningLeads = spawned.filter((s) => s.status === "running" || s.status === "queued" || s.status === "pending")
  const allCompleted = spawned.length > 0 && runningLeads.length === 0

  let promptText = `[Relay Swarm Notification] Child agent deliverable auto-drain:\n\n`
  for (const n of undrained) {
    const title = n.title || `🤖 [${n.agent || "Agent"}]`
    promptText += `### ${title} (\`${n.sessionID}\`)\n`
    promptText += `- **Agent**: ${n.agent || "Unknown"}\n`
    promptText += `- **Status**: ${n.status}\n`
    if (n.status === "error" || n.status === "killed" || n.error) {
      promptText += `- **Error**: ${n.error || "Unknown error"}\n\n`
    } else {
      promptText += `- **Output**:\n${n.result || "(No output recorded)"}\n\n`
    }
  }

  if (allCompleted) {
    promptText += `🏁 **All department leads have finished their work.**\nPlease verify deliverables on disk, route any outstanding escalations, and synthesize your final executive report for the operator.`
  } else {
    const leadsList = runningLeads.length > 0
      ? runningLeads.map((s) => `- ${s.agent || "Agent"} (\`${s.sessionID}\`) [${s.status}]`).join("\n")
      : "- (None)"
    promptText += `⏳ **Remaining running leads:**\n${leadsList}\n\nPlease review the deliverables above and route any outstanding escalations.`
  }

  try {
    const res = await client.session.promptAsync({
      path: { id: parentID },
      body: { agent: "Agent-Teams", parts: [{ type: "text", text: promptText }] },
      query: { directory: DIRECTORY },
      signal: AbortSignal.timeout(SDK_TIMEOUT_MS),
    })

    if (res && isConfirmedNotFound(res)) {
      entry.notFoundCount = (entry.notFoundCount || 0) + 1
      if (entry.notFoundCount >= 3) {
        console.error(`[relay] auto-drain: parent ${parentID} confirmed not found after ${entry.notFoundCount} attempts — discarding notification queue`)
        if (entry.timer) clearTimeout(entry.timer)
        parentNotificationQueues.delete(parentID)
        return
      }
      console.error(`[relay] auto-drain: parent ${parentID} promptAsync returned 404 (attempt ${entry.notFoundCount}/3) — retrying in 4000ms`)
      entry.retrying = true
      entry.timer = setTimeout(() => {
        entry.timer = null
        void drainParentNotifications(parentID)
      }, 4000)
      return
    }

    if (res?.error) {
      throw new Error(res.error?.message ?? String(res.error))
    }

    for (const n of undrained) {
      n.drained = true
      logNode(n)
    }
    flushNowSync()
    entry.queue = entry.queue.filter((n) => !n.drained)
    entry.retrying = false
    entry.notFoundCount = 0
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    lastParentContactAt.set(parentID, Date.now())
    console.error(`[relay] auto-drain: successfully drained ${undrained.length} notification(s) to parent ${parentID}`)
  } catch (e) {
    const is404 = e?.status === 404 || e?.response?.status === 404 || /404|not found/i.test(e?.message ?? String(e))
    if (is404) {
      entry.notFoundCount = (entry.notFoundCount || 0) + 1
      if (entry.notFoundCount >= 3) {
        console.error(`[relay] auto-drain: parent ${parentID} not found (404) after ${entry.notFoundCount} attempts — discarding notification queue`)
        if (entry.timer) clearTimeout(entry.timer)
        parentNotificationQueues.delete(parentID)
        lastParentContactAt.delete(parentID)
        return
      }
      console.error(`[relay] auto-drain: parent ${parentID} promptAsync threw 404 (attempt ${entry.notFoundCount}/3) — retrying in 4000ms`)
      entry.retrying = true
      entry.timer = setTimeout(() => {
        entry.timer = null
        void drainParentNotifications(parentID)
      }, 4000)
      return
    }

    console.error(`[relay] auto-drain: promptAsync failed for parent ${parentID} (${e?.message ?? e}) — rescheduling retry after 3000ms`)
    if (entry.timer) clearTimeout(entry.timer)
    entry.retrying = true
    entry.timer = setTimeout(() => {
      entry.timer = null
      void drainParentNotifications(parentID)
    }, 3000)
  }
}

const PROGRESS_HEARTBEAT_INTERVAL_MS = 35_000
const lastParentContactAt = new Map()

// Sends an in-flight progress heartbeat to parent session if subagents are still running.
// Only sends when parent is idle to respect the foreground operator.
async function sendProgressHeartbeat(parentID, running) {
  if (!parentID || !Array.isArray(running) || running.length === 0) return

  // If there are undrained completed deliverables queued, drain those first
  const entry = parentNotificationQueues.get(parentID)
  if (entry && entry.queue && entry.queue.length > 0) {
    void drainParentNotifications(parentID)
    return
  }

  // Check parent busy status first to avoid interrupting foreground turns
  let isBusy = false
  try {
    const res = await client.session.status({ query: { directory: DIRECTORY }, signal: AbortSignal.timeout(SDK_TIMEOUT_MS) })
    if (res && isConfirmedNotFound(res)) return
    const statusMap = (res?.data ?? res) || {}
    const st = statusMap[parentID]
    if (st) {
      const sType = typeof st === "string" ? st : (st.type ?? st.status ?? "")
      if (sType === "busy" || sType === "running" || sType === "generating") {
        isBusy = true
      }
    }
  } catch {
    return
  }

  if (isBusy) {
    // Parent is busy; leave contact time as-is so next check will attempt heartbeat once idle
    return
  }

  const now = Date.now()
  const summaryList = running.map((s) => {
    const elapsed = Math.round((now - (s.createdAt || now)) / 1000)
    const lastActiveAgo = s.updatedAt ? Math.round((now - s.updatedAt) / 1000) : elapsed
    return `- **${s.agent}** (\`${s.sessionID}\`): active ⏱ ${elapsed}s (last active ${lastActiveAgo}s ago)`
  }).join("\n")

  const heartbeatPrompt = [
    `[Relay Swarm Progress Heartbeat] In-flight status update for your active team:`,
    `${running.length} sub-agent lead(s) running in the background:`,
    summaryList,
    `\n*This is an automated periodic heartbeat. You may check details via \`agents_status\` or continue waiting for deliverables.*`
  ].join("\n\n")

  try {
    const res = await client.session.promptAsync({
      path: { id: parentID },
      body: { agent: "Agent-Teams", parts: [{ type: "text", text: heartbeatPrompt }] },
      query: { directory: DIRECTORY },
      signal: AbortSignal.timeout(SDK_TIMEOUT_MS),
    })
    if (!res?.error) {
      lastParentContactAt.set(parentID, now)
      console.error(`[relay] progress heartbeat delivered to parent ${parentID} (${running.length} active)`)
    }
  } catch (e) {
    console.error(`[relay] progress heartbeat failed for parent ${parentID}:`, e?.message ?? e)
  }
}

async function checkProgressHeartbeats() {
  const now = Date.now()
  for (const [parentID, team] of teams.entries()) {
    const spawned = team?.spawned || []
    const running = spawned.filter((s) => s.status === "running" || s.status === "queued" || s.status === "pending")
    if (running.length === 0) continue

    const lastContact = lastParentContactAt.get(parentID) || team.teamCreatedAt || 0
    if (now - lastContact >= PROGRESS_HEARTBEAT_INTERVAL_MS) {
      await sendProgressHeartbeat(parentID, running)
    }
  }
}

const heartbeatTimer = setInterval(() => {
  void checkProgressHeartbeats()
}, 15000)
heartbeatTimer.unref()

// Abort a running child session on the server to halt execution without deleting the session.
// Preserves session history for later resumption and prevents SQLite foreign-key crashes.
async function abortServerSession(sessionID, reason) {
  if (!sessionID) return
  try {
    if (typeof client.session?.abort === "function") {
      await client.session.abort({
        path: { id: sessionID },
        query: { directory: DIRECTORY },
        signal: AbortSignal.timeout(SDK_TIMEOUT_MS),
      })
    }
  } catch (e) {
    console.error(`[relay] failed to abort session ${sessionID} (${reason}):`, e?.message ?? e)
  }
}

// Delete a folded child session on the server (best-effort).
async function deleteServerSession(sessionID, reason) {
  if (!sessionID) return
  try {
    await client.session.delete({
      path: { id: sessionID },
      query: { directory: DIRECTORY },
      signal: AbortSignal.timeout(SDK_TIMEOUT_MS),
    })
  } catch (e) {
    console.error(`[relay] failed to delete session ${sessionID} (${reason}):`, e?.message ?? e)
  }
}

// ── Confirmed-deletion detection (spec §7) ────────────────────────────────
// A parent session the relay tracks that is absent from the live session list
// for two consecutive /reconcile passes gets an explicit single-session
// lookup against the opencode server. ONLY a positive "not found" response
// confirms deletion — a timeout, network error, or 5xx is explicitly NOT
// confirmation (unreachability is never treated as deletion). Miss counts are
// in-memory by design: a relay restart needs two fresh misses again, which is
// exactly the safety margin the spec wants.
const parentMissCounts = new Map() // parentID -> consecutive /reconcile passes without the parent

// True ONLY when the upstream server positively said "not found" (HTTP 404 or
// an error body matching 404/not found) AND we actually got an HTTP response.
// Anything else — no response (network), 5xx, 200 — is NOT confirmation.
function isConfirmedNotFound(result) {
  if (!result || result.response === undefined) return false
  if (result.response.status === 404) return true
  const err = result.error ?? result.data?.error
  const msg = typeof err === "string" ? err : (err?.message ?? "")
  return /404|not found/i.test(msg)
}

// Cascade teardown of a whole team after its parent is CONFIRMED deleted
// upstream. Resolves pending completion promises cleanly first (an /await-any
// race drains the node as "disposed"), deletes every child session on the
// server (fire-and-forget), then drops all rows in ONE transaction after
// marking the parent confirmed-deleted.
function cascadeConfirmed(parentID, reason) {
  const team = teams.get(parentID)
  parentMissCounts.delete(parentID)
  const pendingNotif = parentNotificationQueues.get(parentID)
  if (pendingNotif) {
    if (pendingNotif.timer) clearTimeout(pendingNotif.timer)
    parentNotificationQueues.delete(parentID)
  }
  lastParentContactAt.delete(parentID)
  if (!team) {
    // Nothing in memory — there is no durable row to clear in the WAL model
    // (teams exist on disk only via their node lines, which are already gone).
    return
  }
  const disposedIds = []
  for (const s of team.spawned) {
    if (!s.sessionID) continue
    const entry = completionPromises.get(s.sessionID)
    if (entry && !entry.settled) {
      entry.settled = true
      entry.resolve({ ...s, status: "disposed", result: undefined })
    }
    completionPromises.delete(s.sessionID)
    nodes.delete(s.sessionID)
    disposedIds.push(s.sessionID)
    void deleteServerSession(s.sessionID, reason)
  }
  teams.delete(parentID)
  // Remove every child node line and log the audit trail, atomically in one
  // WAL flush. parentConfirmedDeleted is write-only in the old schema (the
  // /resume guard reads it from memory, where cascade deletes the team before
  // the guard could ever see the flag) — deliberately dropped (§2.2).
  for (const id of disposedIds) {
    logNodeDeleted(id)
    appendEvent(id, EVENT_DELETED)
  }
  appendEvent(parentID, EVENT_DELETED)
  flushNowSync() // cascade is critical — confirm the deletion before returning
  console.error(`[relay] cascade: parent ${parentID} confirmed deleted (${reason}) — disposed ${disposedIds.length} node(s)`)

  void dispatchNextQueued()
}

// Called after every /reconcile payload. Teams whose parent is present in the
// live list are healthy; absent parents accumulate misses and get the
// explicit lookup on the second miss.
const ENABLE_AUTO_CASCADE = process.env.ENABLE_AUTO_CASCADE === "true" // Disabled by default so database session history is permanent and never wiped

async function checkParentDeletions(liveIds) {
  // Never automatically delete session history from SQLite on background reconciliation passes.
  // Session data in SQLite is durable and permanent — only explicit user deletion (session.deleted event)
  // or full uninstall scrubs database rows.
  if (!ENABLE_AUTO_CASCADE) {
    return
  }

  for (const parentID of teams.keys()) {
    if (!parentID || parentID === "") continue // root-less teams are never cascade targets
    if (liveIds.has(parentID)) {
      parentMissCounts.delete(parentID)
      continue
    }
    const misses = (parentMissCounts.get(parentID) ?? 0) + 1
    parentMissCounts.set(parentID, misses)
    if (misses < 2) continue

    // Two consecutive misses — ask the server directly. The SDK returns a
    // result object with response === undefined on network failure, so the
    // confirmed-vs-unknown distinction stays reliable.
    let result
    try {
      result = await client.session.get({
        path: { id: parentID },
        query: { directory: DIRECTORY },
        signal: AbortSignal.timeout(SDK_TIMEOUT_MS),
      })
    } catch {
      result = null
    }
    if (isConfirmedNotFound(result)) {
      cascadeConfirmed(parentID, "reconcile-confirmed")
    } else if (result && result.response && result.response.ok) {
      // The parent answered with a live 2xx — it is alive; disarm the miss
      // count. (5xx / unknown fall through: per spec, a lookup that errors is
      // "unknown, not confirmed" and is retried on the next pass.)
      parentMissCounts.delete(parentID)
    }
    // Unknown (no HTTP response): do nothing; the count stays armed and the
    // next pass retries the lookup (spec: "try again on the next pass").
  }
}

// ── 30-day confirmed-orphan sweep (spec §7, phase 5) ──────────────────────
// Low-frequency backstop: node rows untouched for 30 days are candidates, but
// NOTHING is deleted on age alone — each candidate's PARENT gets the same
// confirmed-deletion check as the reconcile path, and only a positive
// "not found" invokes the cascade. A live parent, a 5xx, or an unreachable
// server leaves every row alone no matter how old it is (the one rule that
// never gets relaxed). Interval is env-tunable for tests.
const ORPHAN_AGE_MS = Number(process.env.ORPHAN_AGE_MS) || 30 * 24 * 60 * 60 * 1000
const ORPHAN_SWEEP_INTERVAL_MS = Number(process.env.ORPHAN_SWEEP_INTERVAL_MS) || 24 * 60 * 60 * 1000

async function sweepOrphans() {
  const cutoff = Date.now() - ORPHAN_AGE_MS
  // Candidate parents are computed from the in-memory node map (the runtime
  // source of truth) — a parent whose newest node has been untouched since
  // before the cutoff. The in-memory updatedAt is bumped by touchNode / the
  // stuck-tool watchdog exactly where the old SQL updated_at was.
  const candidates = new Set()
  for (const node of nodes.values()) {
    if (!node.parentID || node.parentID === "") continue
    const last = node.completedAt ?? node.updatedAt ?? node.createdAt ?? 0
    if (last < cutoff) candidates.add(node.parentID)
  }
  if (candidates.size === 0) return
  for (const parentID of candidates) {
    let result
    try {
      result = await client.session.get({
        path: { id: parentID },
        query: { directory: DIRECTORY },
        signal: AbortSignal.timeout(SDK_TIMEOUT_MS),
      })
    } catch {
      result = null
    }
    if (isConfirmedNotFound(result)) {
      console.error(`[relay] orphan sweep: parent ${parentID} confirmed deleted — cascading (${candidates.size} candidate(s))`)
      cascadeConfirmed(parentID, "orphan-sweep")
    }
    // Anything else — alive, errored, unreachable — leaves the rows alone.
  }
}

// Events retention (spec §4 audit diary): the WAL event lines are append-only
// and grow unbounded, so compaction drops anything older than the retention
// window. Runs on the SAME maintenance cadence as the orphan sweep plus once
// at boot. Direct EVENT_RETENTION_MS overrides the day-based default (tests
// use this).
const EVENT_RETENTION_DAYS = Number(process.env.EVENT_RETENTION_DAYS) || 90
const EVENT_RETENTION_MS =
  Number(process.env.EVENT_RETENTION_MS) || EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000

const maintenanceTimer = setInterval(() => {
  void sweepOrphans()
  pruneEvents()
}, ORPHAN_SWEEP_INTERVAL_MS)
maintenanceTimer.unref()

// ── OS Kernel Process Supervision (v1.0.4) ──────────────────────────────────
// Replaces fragile HTTP polling with OS Kernel liveness probes.
// Checks if the parent OpenCode process ID exists in the OS process table.
// As long as the user's OpenCode app/terminal stays open (even if idle for days
// or frozen during heavy AI workloads), isPidAlive returns true.
// The moment the parent process is closed by the user, the kernel removes the PID
// and isPidAlive returns false, terminating the relay process immediately.
const PARENT_PID = Number(process.env.PARENT_PID) || undefined
const PID_CHECK_INTERVAL_MS = Number(process.env.PID_CHECK_INTERVAL_MS) || 10000

const registeredTerminalPids = new Set()
if (PARENT_PID && PARENT_PID > 1) registeredTerminalPids.add(PARENT_PID)

function isPidAlive(pid) {
  if (!pid || pid <= 1) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === "EPERM"
  }
}

function checkParentLiveness() {
  if (registeredTerminalPids.size === 0) return
  for (const pid of Array.from(registeredTerminalPids)) {
    if (!isPidAlive(pid)) {
      registeredTerminalPids.delete(pid)
    }
  }
  if (registeredTerminalPids.size === 0) {
    console.error(`[relay] all registered parent process PIDs are gone from OS process table — exiting relay`)
    process.exit(0)
  }
}

const pidWatchdog = setInterval(checkParentLiveness, PID_CHECK_INTERVAL_MS)
pidWatchdog.unref()
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
  node.autoContinuePending = true
  console.error(`[relay] transient provider error for ${sid} (${node.agent}) — sent "continue" to resume (attempt ${node.autoContinueCount}/${AUTO_CONTINUE_MAX})`)
  logNode(node) // retryCount (= autoContinueCount) persisted via projection
  appendEvent(sid, EVENT_RESUMED)
  markFlush() // non-critical: the completion flush will carry it if it lands first
  client.session.promptAsync({
    path: { id: sid },
    body: { agent: node.agent, parts: [{ type: "text", text: "continue" }] },
    query: { directory: DIRECTORY },
    signal: AbortSignal.timeout(SDK_TIMEOUT_MS),
  }).catch((e) => console.error(`[relay] auto-continue failed for ${sid}:`, e?.message ?? e))
}

const STUCK_TOOL_TIMEOUT_MS = Number(process.env.STUCK_TOOL_TIMEOUT_MS) || 120000 // 2 minutes

async function reconcileMissedCompletions() {
  const running = [...nodes.values()].filter((n) => n.status === "running" && n.sessionID)
  if (running.length === 0) return
  try {
    const res = await client.session.status({ query: { directory: DIRECTORY }, signal: AbortSignal.timeout(SDK_TIMEOUT_MS) })
    const statusMap = (res?.data ?? res) || {}
    const now = Date.now()
    for (const node of running) {
      const st = statusMap[node.sessionID]
      
      // Watchdog: detect stuck tool calls or frozen session execution (>120s with no update)
      const lastTime = node.updatedAt || node.createdAt || now
      if (now - lastTime > STUCK_TOOL_TIMEOUT_MS) {
        if ((node.stuckToolAutoResumeCount ?? 0) < AUTO_CONTINUE_MAX) {
          node.stuckToolAutoResumeCount = (node.stuckToolAutoResumeCount ?? 0) + 1
          node.updatedAt = now
          console.error(`[relay] stuck tool watchdog: session ${node.sessionID} (${node.agent}) frozen for >${Math.round(STUCK_TOOL_TIMEOUT_MS/1000)}s — issuing auto-resume prompt`)
          logNode(node) // retryCount (= stuckToolAutoResumeCount) persisted
          appendEvent(node.sessionID, EVENT_RESUMED)
          markFlush() // non-critical: watchdog is not the restart contract
          client.session.promptAsync({
            path: { id: node.sessionID },
            body: { agent: node.agent, parts: [{ type: "text", text: "Tool execution timed out or skipped. Finalize and summarize your audit findings now." }] },
            query: { directory: DIRECTORY },
            signal: AbortSignal.timeout(SDK_TIMEOUT_MS),
          }).catch((e) => console.error(`[relay] stuck-tool auto-resume failed for ${node.sessionID}:`, e?.message ?? e))
          continue
        }
      }

      if (!st) continue
      if (st.type === "idle") {
        const out = await readSessionOutput(node.sessionID)
        if (out && out.trim() !== "") {
          console.error(`[relay] reconcile: recovered missed completion for ${node.sessionID} (${node.agent})`)
          routeCompletion(node.sessionID, "done", out, undefined)
        }
      } else if (st.type === "retry" && isAutoContinueError(st.message)) {
        // The session is stuck retrying a transient provider error that happened
        // while the event stream was down. Same treatment as the live
        // session.error path: resume it with a bounded auto-"continue".
        if ((node.autoContinueCount ?? 0) < AUTO_CONTINUE_MAX) {
          console.error(`[relay] reconcile: session ${node.sessionID} (${node.agent}) in retry with transient provider error — resuming`)
          autoContinueSession(node.sessionID, node)
        } else {
          // The cap was already exhausted (live path likely flagged it too) —
          // surface the stuck node instead of silently doing nothing.
          console.error(`[relay] reconcile: retries exhausted for ${node.sessionID} (${node.agent}) — routing to error`)
          appendEvent(node.sessionID, EVENT_NEEDS_ATTENTION)
          routeCompletion(node.sessionID, "error", undefined, "transient provider error retries exhausted")
        }
      }
    }
  } catch (e) {
    console.error("[relay] reconcile missed completions failed:", e?.message ?? e)
  }
}

// ── /reconcile — full-visibility session list push (spec §6) ──────────────
// The plugin's supervisor loop pushes the FULL live session list on a
// schedule. This closes the relay's blind spot: sessions the relay did not
// spawn itself (human-started, other-tool, etc.) get folded into monitoring
// automatically, and tracked sessions whose completion event was missed
// (relay unreachable when it fired) have their status drift corrected.

// The plugin annotates every listed session with status "idle". Anything
// unknown (legacy/absent field) is treated as idle — the safest read of a
// session that is not actively running.
function normalizePayloadStatus(status) {
  if (status === "running" || status === "idle" || status === "done" || status === "error" || status === "killed") return status
  return "idle"
}

// Credible-output guard shared by the /reconcile drift path: readSessionOutput
// returns its placeholder on failure — that must never be treated as a result.
function hasRealOutput(out) {
  return typeof out === "string" && out.trim() !== "" && out !== "[error reading session output]"
}

// Process one /reconcile payload. Returns the response-body counters plus the
// set of live session IDs (for the confirmed-deletion check), so the route
// handler stays thin. Idempotent: re-posting the same list inserts nothing
// and corrects nothing already correct.
//
// DRIFT SEMANTICS: the plugin annotates every listed session with status
// "idle" — it is a PLACEHOLDER, not the session's real state. A running
// session's transcript contains its partial output, so trusting payload
// "idle" at face value would complete live sessions mid-flight. Therefore:
//   - payload "done" / "error" (explicit, unambiguous) → correct immediately
//     (output/error recovered from the transcript);
//   - payload "idle" → verify against the session status API first; only a
//     real "idle" upstream completes the node. "running"/unknown → the node
//     is left alone (touched so the orphan sweep ignores it). This mirrors
//     reconcileMissedCompletions' proven semantics.
async function handleReconcileSessions(sessions) {
  let inserted = 0
  let updated = 0
  const liveIds = new Set()

  // One status-API fetch per pass, only when the relay tracks something that
  // might still be running. Failure → null: payload "idle" then degrades to
  // "leave running", which is always the safe side.
  const hasRunning = [...nodes.values()].some((n) => n.status === "running")
  let statusMap = null
  if (hasRunning) {
    try {
      const res = await client.session.status({ query: { directory: DIRECTORY }, signal: AbortSignal.timeout(SDK_TIMEOUT_MS) })
      statusMap = (res?.data ?? res) || {}
    } catch {
      statusMap = null
    }
  }

  for (const s of sessions) {
    const sessionID = typeof s?.sessionID === "string" ? s.sessionID : ""
    if (!sessionID) continue // the plugin maps missing ids to "" — never track blanks
    // Filter the plugin's own throwaway inline-support probe sessions. These are
    // created by probeInlineSupport() and are never real tasks — folding them
    // into the node tree would cause status polling on every reconcile pass and
    // accumulate stale rows in SQLite across relay restarts.
    const rawTitle = typeof s?.title === "string" ? s.title : ""
    if (rawTitle === "__agent_teams_subtask_probe__") continue
    liveIds.add(sessionID)
    const payloadStatus = normalizePayloadStatus(s.status)
    const parentID = typeof s?.parentID === "string" ? s.parentID : ""
    const node = nodes.get(sessionID)

    if (node) {
      // Drift correction — applied ONLY to sessions the relay still believes
      // are running. Terminal states are never flipped back to running: that
      // would re-deliver a result that /await-any already drained (or resolve
      // the same completion promise twice).
      if (node.status === "running") {
        if (payloadStatus === "done") {
          const out = await readSessionOutput(sessionID)
          if (hasRealOutput(out)) {
            console.error(`[relay] reconcile: drift — ${sessionID} (${node.agent}) completed while the relay was unreachable`)
            routeCompletion(sessionID, "done", out, undefined)
            updated++
          } else {
            touchNode(sessionID)
          }
        } else if (payloadStatus === "error") {
          routeCompletion(sessionID, "error", undefined, "session reported error upstream during reconcile")
          updated++
        } else if (payloadStatus === "idle") {
          const st = statusMap?.[sessionID]
          if (st?.type === "idle") {
            const out = await readSessionOutput(sessionID)
            if (hasRealOutput(out)) {
              console.error(`[relay] reconcile: drift — ${sessionID} (${node.agent}) completed while the relay was unreachable`)
              routeCompletion(sessionID, "done", out, undefined)
              updated++
            } else {
              // Idle but no assistant text yet — keep running state, bump
              // updatedAt so the 30-day orphan sweep never mistakes an
              // actively-reconciled tree for stale.
              touchNode(sessionID)
            }
          } else if (st?.type === "error") {
            routeCompletion(sessionID, "error", undefined, st.message ?? "session errored upstream during reconcile")
            updated++
          } else if (st?.type === "retry" && isAutoContinueError(st.message)) {
            // Session is stuck retrying a transient provider error that
            // happened while the stream was down — same bounded-resume
            // treatment as the live session.error path.
            if ((node.autoContinueCount ?? 0) < AUTO_CONTINUE_MAX) {
              console.error(`[relay] reconcile: session ${sessionID} (${node.agent}) in retry with transient provider error — resuming`)
              autoContinueSession(node.sessionID, node)
            }
          } else {
            // Still running (or upstream status unknown) — never complete on
            // ambiguity. Keep the row young.
            touchNode(sessionID)
          }
        }
      }
    } else {
      // Unknown to the relay → fold into monitoring (spec §6). No completion
      // promise yet — /await-any creates those on demand and its synchronous
      // done-check serves inserted terminal nodes directly. notify stays
      // false: only relay-spawned children carry the notify flag.
      const agent = typeof s?.title === "string" && s.title.trim() !== "" ? s.title : "monitored"
      const rec = {
        sessionID,
        parentID,
        agent,
        title: typeof s?.title === "string" ? s.title : `🤖 [${agent}]`,
        prompt: undefined,
        notify: false,
        status: payloadStatus,
        drained: false,
      }
      if (payloadStatus === "done" || payloadStatus === "error" || payloadStatus === "killed") {
        rec.completedAt = Date.now()
        if (payloadStatus === "error") rec.error = "session was already errored when first monitored"
      }
      registerNode(parentID, rec)
      inserted++
    }
  }
  return { inserted, updated, liveIds }
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
          if (!sid) continue

          // If this session is a parent with queued notifications waiting for it to become idle, drain immediately!
          if (parentNotificationQueues.has(sid)) {
            const qEntry = parentNotificationQueues.get(sid)
            if (qEntry && qEntry.queue.length > 0) {
              if (qEntry.timer) clearTimeout(qEntry.timer)
              qEntry.timer = null
              void drainParentNotifications(sid)
            }
          }

          if (!nodes.has(sid)) continue
          const node = nodes.get(sid)
          const out = await readSessionOutput(sid)
          if (!out || out.trim() === "" || out === "[error reading session output]") {
            console.error(`[relay] session.idle for ${sid} (${node.agent}) has no assistant output yet — keeping running state`)
            continue
          }
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
            // Per-agent isolation (spec §9): flag THIS node for attention in
            // the audit trail; every other node keeps its own budget.
            appendEvent(sid, EVENT_NEEDS_ATTENTION)
          }
          if (node?.notify) {
            console.error(`[relay] NOTIFY: Task failed for agent '${node.agent}' (${sid}): ${err}`)
          }
          routeCompletion(sid, "error", undefined, err)
        } else if (type === "session.compacted") {
          const sid = ev.properties?.sessionID
          if (sid && nodes.has(sid)) {
            appendEvent(sid, EVENT_COMPACTED)
            markFlush() // boundary event — non-critical
            const node = nodes.get(sid)
            if (node && node.prompt && node.status === "running") {
              console.error(`[relay] Memory compacted for ${sid} (${node.agent}) — auto re-briefing task context`)
              client.session.promptAsync({
                path: { id: sid },
                body: { agent: node.agent, parts: [{ type: "text", text: `[System Memory Re-Brief]: Context was compacted. Reminder of your original task prompt:\n${node.prompt}` }] },
                query: { directory: DIRECTORY },
                signal: AbortSignal.timeout(SDK_TIMEOUT_MS),
              }).catch((e) => console.error(`[relay] re-brief failed for ${sid}:`, e?.message ?? e))
            }
          }
        } else if (type === "session.deleted") {
          const sid = ev.properties?.sessionID
          if (!sid) continue
          if (teams.has(sid)) {
            // Parent session deleted upstream: the whole subtree is gone with
            // it. The server's own deletion event is confirmation — cascade
            // immediately. The two-miss reconcile path remains the backstop
            // for deletion events missed while the stream was down.
            console.error(`[relay] session.deleted for parent ${sid} — cascading team`)
            cascadeConfirmed(sid, "server-deleted-event")
          } else if (nodes.has(sid)) {
            // A tracked child died under us: route it to error so a parent
            // /await-any race can never hang on a session that no longer
            // exists on the server.
            const node = nodes.get(sid)
            console.error(`[relay] session.deleted for tracked child ${sid} (${node.agent}) — routing to error`)
            routeCompletion(sid, "error", undefined, "session deleted on server")
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
    // Never write after the socket is gone or a response was already sent
    // (e.g. an error raised mid-request after a partial write) — double
    // responses corrupt the client stream.
    if (res.writableEnded) return
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
    const raw = Buffer.concat(chunks).toString("utf-8") || "{}"
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Distinguish a malformed body (client error) from a server failure.
      const err = new Error("invalid JSON body")
      err.code = "invalid_request_body"
      throw err
    }
    return parsed
  }
  const url = new URL(req.url || "/", `http://${req.headers.host}`)
  const path = url.pathname

  const termPidHeader = req.headers["x-terminal-pid"]
  if (termPidHeader) {
    const termPid = Number(termPidHeader)
    if (!Number.isNaN(termPid) && termPid > 1) {
      registeredTerminalPids.add(termPid)
    }
  }

  try {
    // /health is unauthenticated — needed for the plugin's startup check
    if (req.method === "GET" && path === "/health") {
      return respond(200, {
        // ok: relay process is alive — always true here (we responded).
        // eventsReady tracks the SSE stream separately: a relay that is
        // reconnecting its event stream is NOT dead and must not be respawned
        // by the plugin. The plugin's health() checks ok only.
        ok: true,
        eventsReady,
        serverUrl: OPENCODE_URL,
        teams: teams.size,
        nodes: nodes.size,
        queued: taskQueue.length,
        running: getRunningCount(),
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
      const body = await readBody()
      const sessionID = typeof body?.sessionID === "string" ? body.sessionID : ""
      if (sessionID) {
        // Per-node retry isolation (spec §9): reset THIS node's auto-continue
        // budget only — the global breaker is untouched.
        const node = nodes.get(sessionID)
        if (!node) return respond(404, { error: "session_not_found" })
        node.autoContinueCount = 0
        node.autoContinuePending = false
        logNode(node) // retryCount (= autoContinueCount) reset to 0 in the projection
        markFlush() // non-critical
        return respond(200, { ok: true, sessionID, retriesReset: true })
      }
      if (circuitOpen) {
        circuitOpen = false
        consecutiveFailures = 0
        void startEventListener().catch((e) => console.error("[relay] reset-circuit: event listener failed:", e?.message ?? e))
      }
      return respond(200, { ok: true, circuitOpen })
    }

    if (req.method === "POST" && path === "/spawn") {
      const body = await readBody()
      const parentID = body.parentID
      const tasks = body.tasks ?? []
      if (!Array.isArray(tasks) || tasks.length === 0) {
        return respond(400, { error: "tasks_required" })
      }
      const records = []
      for (const task of tasks) {
        records.push(await spawnTask(parentID, task))
      }
      const results = records.map((rec) => ({
        agent: rec.agent,
        sessionID: rec.sessionID,
        parentID,
        status: rec.status,
        result: rec.result,
        error: rec.error,
      }))
      return respond(200, { spawned: results })
    }

    if (req.method === "POST" && path === "/await-any") {
      const body = await readBody()
      const parentID = body.parentID
      if (parentID == null || parentID === "" || parentID === "undefined") {
        return respond(400, { error: "parentID_required" })
      }
      const timeoutMs = Number(body.timeoutSeconds ?? 120) * 1000
      if (Number.isNaN(timeoutMs) || timeoutMs < 0) return respond(400, { error: "invalid_timeout_seconds" })
      // Read-only lookup — never materialize a phantom team just for probing.
      const team = teams.get(parentID)

      // Phase 1: Check for already-completed, undrained children (synchronous snapshot).
      const doneNode = team?.spawned.find((s) => !s.drained && (s.status === "done" || s.status === "error" || s.status === "killed"))
      if (doneNode) {
        doneNode.drained = true
        logNode(doneNode) // drain must survive a restart — never re-deliver
        flushNowSync()
        void dispatchNextQueued()
        return respond(200, {
          agent: doneNode.agent,
          sessionID: doneNode.sessionID,
          parentID,
          status: doneNode.status,
          result: (doneNode.status === "error" || doneNode.status === "killed") ? doneNode.error : doneNode.result,
          error: (doneNode.status === "error" || doneNode.status === "killed") ? doneNode.error : undefined,
        })
      }
      if (!team || !team.spawned.length) {
        return respond(200, { noPending: true, reason: "no_tasks_spawned" })
      }

      // Phase 2: Race completion promises for all pending (not yet done/error/killed) children.
      // This eliminates the TOCTOU: we create promises BEFORE awaiting, and
      // routeCompletion resolves them synchronously when events arrive.
      const pendingNodes = team.spawned.filter((s) => !s.drained && s.status !== "done" && s.status !== "error" && s.status !== "killed")

      if (pendingNodes.length === 0) {
        // All spawned tasks have already been completed and drained
        return respond(200, { noPending: true, reason: "all_tasks_drained" })
      }

      // Create completion promises for all pending nodes, then race them.
      const completionRace = pendingNodes.map((s) => ensureCompletionPromise(s.sessionID).promise)
      const timeout = new Promise((resolve) => setTimeout(() => resolve({ _timeout: true }), timeoutMs))

      const result = await Promise.race([...completionRace, timeout])

      if (result && result._timeout) {
        const running = pendingNodes.map((s) => ({
          agent: s.agent,
          sessionID: s.sessionID,
          status: s.status,
          elapsedSeconds: Math.round((Date.now() - (s.createdAt || Date.now())) / 1000),
          lastActive: s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString() : undefined,
        }))
        return respond(200, {
          timeout: true,
          event: "progress",
          runningCount: running.length,
          running,
          message: `In-flight progress update: ${running.length} subagents active (${running.map((r) => `${r.agent} ⏱ ${r.elapsedSeconds}s`).join(", ")}).`,
        })
      }

      // result is a node — drain it and return
      result.drained = true
      logNode(result) // drain must survive a restart
      flushNowSync()
      void dispatchNextQueued()
      return respond(200, {
        agent: result.agent,
        sessionID: result.sessionID,
        parentID: result.parentID ?? parentID,
        status: result.status,
        result: (result.status === "error" || result.status === "killed") ? result.error : result.result,
        error: (result.status === "error" || result.status === "killed") ? result.error : undefined,
      })
    }

    if (req.method === "POST" && path === "/drain-completed") {
      const body = await readBody()
      const parentID = body.parentID
      if (!parentID) return respond(400, { error: "parentID_required" })

      const team = teams.get(parentID)
      const spawned = team?.spawned || []
      const completedUndrained = spawned.filter((s) => !s.drained && (s.status === "done" || s.status === "error" || s.status === "killed"))

      for (const n of completedUndrained) {
        n.drained = true
        logNode(n)
      }
      if (completedUndrained.length > 0) flushNowSync()

      return respond(200, {
        ok: true,
        parentID,
        drainedCount: completedUndrained.length,
        deliverables: completedUndrained.map((n) => ({
          sessionID: n.sessionID,
          agent: n.agent,
          title: n.title,
          status: n.status,
          result: (n.status === "error" || n.status === "killed") ? n.error : n.result,
          error: (n.status === "error" || n.status === "killed") ? n.error : undefined,
          completedAt: n.completedAt,
        })),
      })
    }

    if (req.method === "POST" && path === "/reconcile") {
      const body = await readBody()
      const sessions = Array.isArray(body.sessions) ? body.sessions : null
      if (!sessions) {
        return respond(400, { error: "sessions_required" })
      }
      // An empty list is always a no-op, never a wipe signal — the plugin
      // skips its push entirely when upstream is unreachable, so no state is
      // ever deleted just because a fetch failed.
      const { inserted, updated, liveIds } = await handleReconcileSessions(sessions)
      // Confirmed-deletion check against the NEW live list (spec §7).
      await checkParentDeletions(liveIds)
      void dispatchNextQueued()
      return respond(200, { ok: true, inserted, updated })
    }

    if (req.method === "POST" && path === "/resume") {
      const body = await readBody()
      const rawTarget = typeof body.target === "string" ? body.target : (typeof body.sessionID === "string" ? body.sessionID : (typeof body.target_id === "string" ? body.target_id : ""))
      const rawPrompt = typeof body.prompt === "string" ? body.prompt.trim() : ""
      const prompt = rawPrompt || "Resume and continue from where you left off."
      if (!rawTarget) {
        return respond(400, { error: "sessionID_required" })
      }
      const node = resolveTarget(rawTarget, body.parentID)
      // Unknown locally → 404. (The parent-confirmed-deleted flag is not
      // persisted in the WAL model — a confirmed cascade removes the team from
      // memory before any /resume could observe it, §2.2.)
      if (!node) return respond(404, { error: "session_not_found" })
      const sessionID = node.sessionID

      // Belt-and-suspenders: verify the session still exists upstream before
      // resuming it. A network failure must NOT look like a deletion — the
      // two cases get distinct status codes (404 vs 502).
      let result
      try {
        result = await client.session.get({ path: { id: sessionID }, query: { directory: DIRECTORY }, signal: AbortSignal.timeout(SDK_TIMEOUT_MS) })
      } catch {
        result = null
      }
      if (result && isConfirmedNotFound(result)) return respond(404, { error: "session_not_found_on_server" })
      if (!result || result.response === undefined) return respond(502, { error: "upstream_unreachable" })

      try {
        await client.session.promptAsync({
          path: { id: sessionID },
          body: { agent: node.agent, parts: [{ type: "text", text: prompt }] },
          query: { directory: DIRECTORY },
          signal: AbortSignal.timeout(SDK_TIMEOUT_MS),
        })
      } catch (e) {
        console.error(`[relay] /resume promptAsync failed for ${sessionID}:`, e?.message ?? e)
        return respond(502, { error: "upstream_unreachable" })
      }

      node.status = "running"
      node.drained = false
      node.result = undefined
      node.error = undefined
      node.completedAt = undefined
      node.autoContinueCount = 0
      node.autoContinuePending = false
      node.updatedAt = Date.now() // matches the old updateNodeResumed (fresh recency)
      logNode(node)
      appendEvent(sessionID, EVENT_RESUMED)
      flushNowSync() // resume is critical — the parent /await-any depends on it
      // Register a fresh completion promise so /await-any picks the session
      // back up when it finishes again (spec §8 step 5).
      ensureCompletionPromise(sessionID)
      console.error(`[relay] /resume: ${sessionID} (${node.agent}) resumed with new prompt`)
      return respond(200, { sessionID, status: "running" })
    }

    if (req.method === "POST" && path === "/kill") {
      const body = await readBody()
      const rawTarget = typeof body.target === "string" ? body.target : (typeof body.sessionID === "string" ? body.sessionID : (typeof body.target_id === "string" ? body.target_id : ""))
      if (!rawTarget) {
        return respond(400, { error: "target_or_sessionID_required" })
      }
      const node = resolveTarget(rawTarget, body.parentID)
      if (!node) {
        return respond(404, { error: "session_not_found" })
      }
      const targetSessionID = node.sessionID

      const qIdx = taskQueue.findIndex((item) => item.sessionID === targetSessionID)
      if (qIdx !== -1) taskQueue.splice(qIdx, 1)

      node.status = "killed"
      node.completedAt = Date.now()
      node.updatedAt = node.completedAt
      node.error = "Session halted by operator (/stop)"

      // CRITICAL: Settle the internal completion promise immediately so /await-any does NOT hang
      const entry = completionPromises.get(targetSessionID)
      if (entry && !entry.settled) {
        entry.settled = true
        entry.resolve({ sessionID: targetSessionID, status: "killed", error: "Session halted by operator (/stop)", agent: node.agent, parentID: node.parentID })
      }

      logNode(node)
      appendEvent(targetSessionID, "killed")
      flushNowSync()

      void abortServerSession(targetSessionID, "operator-kill")
      void dispatchNextQueued()
      scheduleParentNotification(node.parentID, node)

      return respond(200, { ok: true, sessionID: targetSessionID, status: "killed" })
    }

    if (req.method === "POST" && path === "/kill-all") {
      const body = await readBody()
      const parentID = body.parentID
      let targetIds = []

      if (parentID && parentID !== "all") {
        targetIds = getDescendantNodeIds(parentID)
      } else {
        targetIds = Array.from(nodes.values())
          .filter((n) => n.status === "running" || n.status === "queued" || n.status === "pending")
          .map((n) => n.sessionID)
      }

      for (const id of targetIds) {
        const qIdx = taskQueue.findIndex((item) => item.sessionID === id)
        if (qIdx !== -1) taskQueue.splice(qIdx, 1)

        const node = nodes.get(id)
        if (node) {
          node.status = "killed"
          node.completedAt = Date.now()
          node.updatedAt = node.completedAt
          node.error = "Session halted by operator (/stop)"

          const entry = completionPromises.get(id)
          if (entry && !entry.settled) {
            entry.settled = true
            entry.resolve({ sessionID: id, status: "killed", error: "Session halted by operator (/stop)", agent: node.agent, parentID: node.parentID })
          }

          logNode(node)
          appendEvent(id, "killed")
          void abortServerSession(id, "operator-kill-all")
          scheduleParentNotification(node.parentID, node)
        }
      }

      flushNowSync()
      void dispatchNextQueued()

      return respond(200, { ok: true, killed: targetIds, count: targetIds.length })
    }

    if (req.method === "POST" && path === "/ask") {
      const body = await readBody()
      const rawTarget = typeof body.target_id === "string" ? body.target_id : (typeof body.target === "string" ? body.target : (typeof body.sessionID === "string" ? body.sessionID : ""))
      const prompt = typeof body.prompt === "string" ? body.prompt : ""
      if (!rawTarget || !prompt) {
        return respond(400, { error: "target_id_and_prompt_required" })
      }
      const node = resolveTarget(rawTarget, body.parentID)
      if (!node) {
        return respond(404, { error: "target_not_found" })
      }
      const targetSessionID = node.sessionID

      let msgs = []
      try {
        const res = await client.session.messages({
          path: { id: targetSessionID },
          query: { directory: DIRECTORY, limit: 12 },
          signal: AbortSignal.timeout(SDK_TIMEOUT_MS),
        })
        const data = res?.data ?? res
        msgs = Array.isArray(data) ? data : data?.messages ?? []
      } catch (e) {
        console.error(`[relay] /ask failed to fetch messages for ${targetSessionID}:`, e?.message ?? e)
        return respond(502, { error: "failed_to_fetch_target_messages" })
      }

      const getRole = (m) => m?.role || m?.info?.role || "assistant"

      const formatPartForSnapshot = (p) => {
        if (!p || typeof p !== "object") return ""
        if (p.type === "text" && typeof p.text === "string") {
          const txt = p.text.trim()
          return txt ? txt : ""
        }
        if (p.type === "tool" || p.type === "tool_call" || p.type === "tool-invocation" || p.type === "tool_use") {
          const toolName = p.tool || p.name || p.toolName || p.callID || "tool"
          const status = p.state?.status || p.status || "executed"
          let inputSnippet = ""
          const rawInput = p.state?.input ?? p.input ?? p.args ?? p.arguments
          if (rawInput !== undefined && rawInput !== null) {
            try {
              inputSnippet = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput)
              if (inputSnippet.length > 250) inputSnippet = inputSnippet.slice(0, 250) + "..."
            } catch {}
          }
          let outputSnippet = ""
          const rawOutput = p.state?.output ?? p.output ?? p.result
          if (rawOutput !== undefined && rawOutput !== null) {
            try {
              outputSnippet = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput)
              if (outputSnippet.length > 250) outputSnippet = outputSnippet.slice(0, 250) + "..."
            } catch {}
          }
          let str = `[Tool: ${toolName} (${status})]`
          if (inputSnippet) str += ` Args: ${inputSnippet}`
          if (outputSnippet) str += ` Result: ${outputSnippet}`
          return str
        }
        if (p.type === "patch") {
          const files = Array.isArray(p.files) ? p.files.join(", ") : (p.path || p.file || JSON.stringify(p))
          return `[Code Patch: modified ${files}]`
        }
        if (p.type === "reasoning" || p.type === "thought" || p.type === "thinking") {
          const thought = p.text || p.thought || p.reasoning || ""
          const snippet = thought.length > 200 ? thought.slice(0, 200) + "..." : thought
          return snippet ? `[Thinking: ${snippet}]` : ""
        }
        return ""
      }

      const snapshot = msgs.map((m) => {
        const role = getRole(m)
        const parts = m?.parts ?? []
        const formatted = parts
          .map(formatPartForSnapshot)
          .filter(Boolean)
          .join("\n")
        return formatted ? `[${role.toUpperCase()}]:\n${formatted}` : ""
      }).filter(Boolean).join("\n\n")

      const allParts = msgs.flatMap((m) => m?.parts ?? [])
      const recentTools = allParts
        .filter((p) => p && (p.type === "tool" || p.type === "tool_call" || p.type === "tool-invocation" || p.type === "tool_use"))
        .map((p) => p.tool || p.name || p.toolName || "tool")
      const lastTool = recentTools.length > 0 ? recentTools[recentTools.length - 1] : null
      const elapsed = Math.floor((Date.now() - (node.createdAt || Date.now())) / 1000)
      const lastActiveAgo = node.updatedAt ? Math.floor((Date.now() - node.updatedAt) / 1000) : elapsed

      let fallbackAnswer = `Agent '${node.agent}' is currently ${node.status} (elapsed: ${elapsed}s, last active: ${lastActiveAgo}s ago).`
      if (lastTool) {
        fallbackAnswer += ` Recently executed tool: '${lastTool}'. Total tool actions recorded: ${recentTools.length}.`
      } else if (snapshot) {
        fallbackAnswer += ` Recent activity:\n${snapshot.slice(-400)}`
      }

      const ephemeralTitle = `Ephemeral Query: ${node.agent}`
      let ephemeralSessionID
      try {
        const created = await client.session.create({
          body: { title: ephemeralTitle },
          query: { directory: DIRECTORY },
          signal: AbortSignal.timeout(SDK_TIMEOUT_MS),
        })
        ephemeralSessionID = created?.data?.id ?? created?.id
      } catch (e) {
        console.error(`[relay] /ask failed to create ephemeral session:`, e?.message ?? e)
        return respond(502, { error: "failed_to_create_ephemeral_session" })
      }

      const personaPrompt = [
        `You are answering an out-of-band operator status inquiry regarding sub-agent '${node.agent}'.`,
        `Below is the recent transcript snapshot (last ${msgs.length} messages, including tools and actions) from that agent's session:`,
        `--- TRANSCRIPT SNAPSHOT BEGIN ---`,
        snapshot || `(Agent status: ${node.status}, elapsed: ${elapsed}s, no transcript messages yet)`,
        `--- TRANSCRIPT SNAPSHOT END ---`,
        `Operator Question: ${prompt}`,
        `Instructions: Provide a concise, direct answer based strictly on the agent's recent context. If the agent has run tools or edited files, state exactly what tools were called and what work is being done. Do NOT claim the agent is empty or inactive if tool calls are present in the snapshot.`
      ].join("\n\n")

      let answer = ""
      try {
        // Try synchronous prompt first if supported
        const promptRes = await client.session.prompt({
          path: { id: ephemeralSessionID },
          body: { agent: node.agent, parts: [{ type: "text", text: personaPrompt }] },
          query: { directory: DIRECTORY },
          signal: AbortSignal.timeout(SDK_TIMEOUT_MS),
        }).catch(() => null)

        if (promptRes) {
          const data = promptRes?.data ?? promptRes
          if (typeof data === "string") answer = data
          else if (Array.isArray(data?.parts)) {
            answer = data.parts.filter((p) => p?.type === "text").map((p) => p.text).join("\n")
          }
        }

        if (!answer) {
          await client.session.promptAsync({
            path: { id: ephemeralSessionID },
            body: { agent: node.agent, parts: [{ type: "text", text: personaPrompt }] },
            query: { directory: DIRECTORY },
            signal: AbortSignal.timeout(SDK_TIMEOUT_MS),
          })
          answer = await readSessionOutput(ephemeralSessionID)
        }
      } catch (e) {
        console.error(`[relay] /ask prompt failed:`, e?.message ?? e)
      } finally {
        void deleteServerSession(ephemeralSessionID, "ephemeral-ask-cleanup")
      }

      return respond(200, {
        ok: true,
        sessionID: targetSessionID,
        agent: node.agent,
        status: node.status,
        elapsedSeconds: elapsed,
        lastActiveSecondsAgo: lastActiveAgo,
        lastTool: lastTool || undefined,
        answer: answer || fallbackAnswer,
      })
    }

    if (req.method === "GET" && path === "/collect") {
      const parentID = url.searchParams.get("parentID") ?? ""
      if (parentID === "" || parentID === "undefined") {
        return respond(400, { error: "parentID_required" })
      }
      // Read-only lookup — a missing team legitimately means "nothing spawned".
      const team = teams.get(parentID)
      const spawnedList = team ? team.spawned : []
      const now = Date.now()

      const spawnedData = spawnedList.map((s) => {
        const isStalled = s.status === "running" && (now - (s.updatedAt || s.createdAt || now) > 180000)
        const elapsed = Math.floor(((s.completedAt || now) - (s.createdAt || now)) / 1000)
        return {
          agent: s.agent,
          sessionID: s.sessionID,
          parentID: s.parentID,
          status: isStalled ? `${s.status} [stalled]` : s.status,
          rawStatus: s.status,
          stalled: isStalled,
          elapsed,
          result: s.result,
          error: s.error,
        }
      })

      const treeAscii = renderTreeAscii(spawnedList.map((s) => s.sessionID))

      return respond(200, {
        spawned: spawnedData,
        tree: treeAscii,
      })
    }

    if (req.method === "GET" && path === "/tree") {
      // Full tree dump (debugging / supervisor visibility)
      const allNodes = Array.from(nodes.values())
      const now = Date.now()

      const rootIds = allNodes
        .filter((n) => !n.parentID || !nodes.has(n.parentID))
        .map((n) => n.sessionID)
      const treeAscii = renderTreeAscii(rootIds)

      const formattedNodes = allNodes.map((n) => {
        const isStalled = n.status === "running" && (now - (n.updatedAt || n.createdAt || now) > 180000)
        const elapsed = Math.floor(((n.completedAt || now) - (n.createdAt || now)) / 1000)
        return {
          sessionID: n.sessionID,
          parentID: n.parentID,
          agent: n.agent,
          status: isStalled ? `${n.status} [stalled]` : n.status,
          rawStatus: n.status,
          stalled: isStalled,
          elapsed,
          updatedAt: n.updatedAt,
          children: n.children || [],
        }
      })

      return respond(200, {
        nodes: formattedNodes,
        tree: treeAscii,
      })
    }

    // Wrong-method dispatch on a known route → 405 + Allow header; unknown
    // paths stay 404.
    const allow = ROUTE_ALLOW[path]
    if (allow && !allow.includes(req.method)) {
      res.writeHead(405, { "Content-Type": "application/json", Allow: allow.join(", ") })
      return res.end(JSON.stringify({ error: "method_not_allowed" }))
    }
    return respond(404, { error: "not found" })
  } catch (e) {
    // Do not leak internal paths or stack traces
    if (e?.code === "invalid_request_body") {
      return respond(400, { error: "invalid_request_body" })
    }
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
  // Same ordering for the durable store: load only after the port is bound, so
  // a losing duplicate never creates or touches the store files. A
  // corrupt/unreadable store is fatal at boot — the plugin respawns the relay
  // and the failure stays visible in the relay log.
  try {
    loadDurableState() // checkpoint fast path + WAL delta replay + catch-up pruneEvents
  } catch (e) {
    console.error("[relay] fatal: cannot open durable store:", e?.message ?? e)
    process.exit(1)
  }
  // Immediately recover any completions that happened while this relay instance
  // was down (restart / crash). reconcileMissedCompletions normally runs after
  // the SSE stream connects, but that can take seconds. Running it here means
  // an /await-any call that arrives before the SSE is ready still gets the
  // correct result rather than blocking until timeout.
  void reconcileMissedCompletions().catch((e) => console.error("[relay] boot-time missed-completion recovery failed:", e?.message ?? e))
  void dispatchNextQueued().catch((e) => console.error("[relay] boot-time dispatch failed:", e?.message ?? e))
  console.error(`[agent-teams-relay] listening on ${RELAY_HOST}:${RELAY_PORT}`)
  void startEventListener().catch((e) => console.error("[relay] event listener startup failed:", e?.message ?? e))
})
