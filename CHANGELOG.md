# Changelog

All notable changes to **`opencode-agent-teams-relay`** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v1.0.0.html).

---

## [1.0.7] - 2026-09-05

### Fixed
- **Subagent Completion Stall Resolution:** Added a synthetic tool-action summary fallback in `readSessionOutput()` (`relay/agent-teams-relay.mjs`) when turns conclude with tool executions (`edit`, `write`, `bash`) rather than conversational text. Unblocks the `session.idle` handler and routes the session to `done` immediately.
- **Resilient 404 Notification Queue Handling:** Implemented a 3-attempt retry loop with 4-second backoff in `drainParentNotifications()` (`relay/agent-teams-relay.mjs`). Prevents transient 404 responses during parent status checks or `promptAsync` delivery from permanently deleting the orchestrator's notification queue.
- **Cross-Session Target Scoping in Resume & Restart:** Passed `parentID: context.sessionID` in `resume_agent` and `manage_agents restart` (`plugins/agent-teams.ts`) and configured default resume prompts (`"Resume and continue from where you left off."`). Resolves targets strictly to the current active session, preventing accidental resumption of stale historical ghost agents.
- **Session Preservation on Operator Kill:** Replaced `deleteServerSession` with `abortServerSession` across `manage_agents kill` and `kill_all` (`relay/agent-teams-relay.mjs`). Aborts in-flight execution upstream while preserving SQLite session records and WAL history intact for subsequent resumption.
- **Enriched Out-of-Band `/ask` Snapshots:** Formatted tool calls, arguments, outputs, and thinking snippets into the ephemeral transcript snapshot in `agent-teams-relay.mjs`, ensuring operator inquiries reflect active background work and tool execution rather than appearing idle.

## [1.0.6] - 2026-09-04

### Added
- **Reactive Orchestrator Protocol (`orchestrator-agent-teams.md`):** Mandated non-blocking fanout where the Main Orchestrator dispatches department leads asynchronously via `Task(background=true)` and immediately yields the turn to the user (permanently preserving terminal interactivity). Forbids calling `next_agent` in foreground turns.
- **File Touch Scope Protocol:** Adds explicit decision rules for worktree isolation: `worktree: true` when subagents touch shared files (`package.json`, shared schemas); `worktree: false` for disjoint directories or read-only tasks to eliminate disk I/O and temporary git branch overhead.
- **Swarm Management & Side Query Directives:** Equipped the Orchestrator with `agents_status` (hierarchical tree snapshots and stall detection), `manage_agents` (`kill`, `kill_all`, `inspect`, `restart`), and `ask_agent` for out-of-band side queries.
- **Autonomous Department Leads (Level 1 Depth):** Upgraded all 6 Department Leads (`Backend`, `Frontend`, `DevOps`, `QA`, `AI & Data`, `Security`) to autonomous middle managers that supervise specialists in background worktrees, run compile/typecheck/test verification gates inside department sandboxes, and report consolidated outcomes upward.

### Fixed
- **Root `subagent_depth` Schema Alignment:** Configured `subagent_depth = 2` directly at the root level of `opencode.json` in `bin/lib/merge-subagent-depth.mjs` and `install.ps1` to align with the official OpenCode V2 schema (`https://opencode.ai/config.json`) and SDK types. Eliminates editor schema validation warnings (`Property subagent_depth is not allowed`) while auto-migrating any misplaced `experimental.subagent_depth` back to root and pruning empty `experimental` blocks.

## [1.0.5] - 2026-09-03

### Fixed
- **OpenCode V2 Subagent Depth Alignment:** Updated installer logic (`bin/lib/merge-subagent-depth.mjs` and `install.ps1`) to configure `experimental.subagent_depth = 2` matching the official OpenCode V2 (`v1.18.x+`) schema (`https://opencode.ai/config.json`).
- **Legacy Config Auto-Migration:** Automatically detects legacy root `subagent_depth` in existing user configs, migrates it into `experimental.subagent_depth`, and removes the root key to eliminate schema validation errors while preserving custom user values and existing experimental keys.

## [1.0.4] - 2026-08-20

### Added
- **Durable WAL + checkpoint state store.** The relay persists its entire picture of the world (`nodes`, `teams`, plus an append-only `events` diary) to `<state-dir>/agent-teams-relay.wal` (append-only write-ahead log) with periodic atomic checkpoints to `<state-dir>/agent-teams-relay-state.json` — every state transition is mirrored transactionally, and a relay that is killed and restarted replays its full state, including completed results, drained flags, and retry budgets. The in-memory Maps remain the runtime source of truth for logic; the store survives restarts. (`relay/agent-teams-relay.mjs`)
- **Full-instance visibility (`/reconcile`).** A new plugin-side **supervisor loop** (started at plugin load, not on tool calls) checks relay health every 10s, respawns a dead relay, and pushes the opencode server's *entire* live session list to the relay's new `/reconcile` endpoint — so the relay tracks every session on the instance (including human-started ones), not just children it spawned itself, and corrects drifted statuses. (`plugins/agent-teams.ts`, `relay/agent-teams-relay.mjs`)
- **Confirmed-deletion cascade.** Deletion is now triggered **only** by a confirmed parent deletion — either the SSE `session.deleted` event or a parent missing from two consecutive reconciliation passes *and* an explicit `session.get` returning 404. Unreachability is never treated as deletion. Pending `/await-any` waiters are resolved with `disposed` status; child sessions are deleted with an audit trail in the `events` diary.
- **30-day confirmed-orphan sweep.** A low-frequency safety net (`ORPHAN_SWEEP_INTERVAL_MS`, default 24h cadence) revisits stale nodes but only cascades them through the same confirmed-deletion gate — never on age alone.
- **Event-diary retention.** The append-only `events` table is pruned on boot and on the maintenance tick (default 24h): rows older than 90 days are removed (`EVENT_RETENTION_DAYS` to override, e.g. for tests).
- **`/resume` + `resume_agent` tool.** Any existing, still-alive session can receive a follow-up instruction and continue with its accumulated context; status/drained/result reset and a fresh completion promise is registered so `next_agent`/`agents_status` pick it back up. Network failure to the upstream server returns `502 upstream_unreachable` (never treated as "not found").
- **Per-agent failure isolation.** Retry budgets are now **per-node** (`retry_count`, capped at 3): one agent exhausting its budget goes `error` with a `needs_attention` event while every sibling keeps working. The global circuit breaker is reserved solely for SSE-transport failures; `/reset-circuit {sessionID}` revives a single node's budget. (`relay/agent-teams-relay.mjs`)
- **Test suite growth:** 28 automated tests (relay lifecycle, reconcile, cascade, orphan sweep, resume, failure isolation, installer scenarios 1–6) via `node --test`.

### Changed
- **Architectural Upgrade: Replaced HTTP Heartbeat Polling with OS Kernel Process Supervision.** Relays no longer issue `GET /global/health` probes over local HTTP connections to check parent liveness. Instead, the plugin passes `PARENT_PID` to the relay, which monitors the parent OpenCode Process ID directly via OS Kernel liveness checks (`process.kill(parentPid, 0)`). Zero false-positive relay exits during CPU or AI spikes. As long as the parent OpenCode process exists in the OS process table, the relay stays 100% alive indefinitely (even if idle for days). The moment the user closes the parent OpenCode application or terminal, the kernel monitor detects process termination (`ESRCH`) and shuts down the relay immediately. (`relay/agent-teams-relay.mjs`, `plugins/agent-teams.ts`)
- **Single config root + disabled-plugin parking.** Both install modes now target `~/.config/opencode` — one config world, no more separate `.config/ocd` for agents-only. In `agents` (native-fork) mode the plugin is **parked** into `plugins-disabled/agent-teams.ts`, outside the core's `{plugin,plugins}/*.{ts,js}` autodiscovery, so the fork's compiled-in `Task`/`next_agent`/`agents_status` run collision-free (no tool collision between the plugin and the native fork). `full` mode restores it into `plugins/`, removes any parked copy, and strips stale `subagent_depth`. Legacy `.config/ocd` installs are still auto-detected for reinstall/uninstall. (`bin/install.mjs`, `bin/menu.mjs`, `bin/uninstall.mjs`, `install.ps1`, `bin/lib/config-root.mjs`, new `bin/lib/plugin-park.mjs`)
- **Runtime floor raised to `node >= 20.19`** (for the WAL + checkpoint durable store). (`package.json`)
- **State & Runtime Cleanup Alignment:** Synchronized runtime state allowlists across `bin/lib/runtime-state.mjs` and `install.ps1` to cover the WAL + checkpoint state files (`agent-teams-relay.wal`, `agent-teams-relay-state.json` and transient `.tmp` variants) and temporary tokens (`token.tmp`).
- `scripts/test-relay-cascade.mjs` replaces the obsolete `test-relay-dispose.mjs` integration script.

### Removed
- `/dispose` endpoint and `evictStale()` (the 30-minute TTL eviction) — both replaced by the confirmed-deletion cascade above. Nothing is ever deleted automatically without a confirmed parent deletion.

### Fixed
- **Auxiliary-server split-brain on startup.** When the real opencode server wasn't answering yet at plugin load (boot race), the plugin immediately spawned a second `opencode serve` and pointed the relay at it — the relay silently watched the wrong server while `/reconcile` pushes to the real one failed. The upstream probe now retries (~5s window) before any auxiliary fallback, the fallback is logged when it does happen, and the supervisor **self-heals**: once pushes reach the real server again, an aux-backed relay is killed and respawned on the real URL (lossless — the WAL + checkpoint store replays state). (`plugins/agent-teams.ts`)
- **Relay heartbeat exit threshold raised from 12 → 36 (3 minutes) and made env-tunable.** Previously, aux-backed relays (spawned when the real opencode upstream was down) exited after only 12 × 5 s = 60 seconds of upstream unreachability. Under heavy parallel AI workloads, the aux `opencode serve` process becomes transiently unreachable for longer than 60 s, causing the relay to self-terminate. The plugin then re-ran `ensureRelay`, found the upstream still down, and spawned a *new* aux server on a new random port — triggering a new relay on a new port. Every cycle broke `next_agent`'s long-poll connection. 8+ relay/aux pairs were created in a single session. Default is now 36 failures (3 minutes). `HEARTBEAT_MAX_FAILURES` env var allows custom tuning without code changes. (`relay/agent-teams-relay.mjs`)
- **`next_agent` now retries `/await-any` up to 5 times across relay restarts.** When the relay is respawned mid-poll the HTTP connection drops. The execute handler now retries with a 2 s pause + `ensureRelay` health re-check between attempts, so a relay that restarted and recovered its persisted state is found on the next attempt. (`plugins/agent-teams.ts`)
- **`reconcileMissedCompletions` called immediately at relay boot.** Previously this ran only after the SSE event stream connected (which can take several seconds). An `/await-any` call arriving in that window could block to timeout even if sub-agents already finished while the relay was down. Now the recovery runs right after `openDatabase()` / `loadDurableState()` so persisted completions are resolved before the first tool call is served. (`relay/agent-teams-relay.mjs`)
- **Relay health check no longer gates on `eventsReady`.** `/health` now always returns `ok: true` when the relay process is alive (i.e. it responded). `eventsReady` remains in the payload as an informational field about the SSE stream. Previously, any transient SSE reconnect caused the plugin's `health()` check to return `false`, which deleted the relay cache entry and tried to respawn a relay that was already running — a duplicate that then immediately exited on `EADDRINUSE`. (`relay/agent-teams-relay.mjs`, `plugins/agent-teams.ts`)
- **Ghost `__agent_teams_subtask_probe__` sessions no longer appear in the session list.** `probeVersionFastPath()` now conservatively returns `tooOld: true` whenever the core version cannot be determined (endpoint unhealthy, no `version` field, unparseable string, or network error). On stock opencode 1.2.27 the version is not published on `/global/health`, so the fast-path now short-circuits before creating any throwaway session — the probe session creation is skipped entirely. (`plugins/agent-teams.ts`)
- **Probe session DELETE is delayed 5 s.** When the full probe path does run (native fork ≥ 1.18.x), the `finally` cleanup now waits 5 seconds before issuing the DELETE. An immediate DELETE on a session that just received `prompt_async` fails silently on some cores, leaving a ghost session in the list. The delay gives the session time to reach idle. (`plugins/agent-teams.ts`)
- **Relay reconcile skips probe sessions.** `handleReconcileSessions()` now filters out any session whose title is `__agent_teams_subtask_probe__` before folding it into the node tree. Previously these sessions accumulated in the relay's durable store across restarts and triggered unnecessary status-API polling on every reconcile pass. (`relay/agent-teams-relay.mjs`)
- **Fixed `serverUrl` undefined hashing to port 25821 on startup.** Added `isValidServerUrl()` validation to prevent attempting relay startup or spawning auxiliary servers on undefined server URLs. (`plugins/agent-teams.ts`)

---

## [1.0.3] - 2026-08-09

### Changed
- **Mode-aware config directory:** the installer now targets `.config/ocd` in `agents` mode (native fork) and `.config/opencode` in `full` mode (stock opencode), so both modes can coexist on the same machine without clobbering each other's state. (`bin/install.mjs`, `install.ps1`)
- `install.ps1` uses `$PSScriptRoot` for the package root and `$USERPROFILE` first for the home dir (more robust under non-standard shells).

### Fixed
- **Mode-aware `subagent_depth` merge in `install.ps1`:** `full` mode now strips a stale `subagent_depth` key instead of writing it (the stock core rejects the unrecognized key and refuses to start); `agents` mode creates `opencode.json` with `subagent_depth=2` when missing.
- **Hidden console on Windows:** the relay process now spawns a hidden console at startup (`hide_console.ps1`), so the background relay no longer pops a terminal window.

---

## [1.0.2] - 2026-08-07

### Added
- README: **"Performance & Measured Impact"** section — real measured numbers from an in-repo orchestration run (18 concurrent sessions, ~15 min wall-clock to synthesis, 8 concurrent escalations), with explicit **measured vs modeled** labeling and the honest tokens-for-throughput trade-off.

---

## [1.0.1] - 2026-08-07

### Fixed
- `subagent_depth` merge is now **mode-aware**: the key is only applied in `agents` mode (native fork core, which understands it). `full` mode (stock opencode core) no longer writes it — the stable core rejects `subagent_depth` as an unrecognized key and refuses to start. Full-mode installs/reverts also **strip** a stale `subagent_depth` to self-heal configs broken by an earlier agents-mode install.

---

## [1.0.0] - 2026-08-07

Initial public release — async department-lead orchestration and parallel sub-agent relay for OpenCode.

### Added
- 🚀 **Async Parallel Fan-Out:** `running_agents` tool launches unlimited child sessions in parallel without freezing the OpenCode TUI; results collected with `next_agent` (drain) / `agents_status` (snapshot).
- 📡 **Detached SDK Relay Engine:** External Node.js background process (relay/agent-teams-relay.mjs) connecting via `@opencode-ai/sdk`, tracking `session.idle` / `session.error` events via SSE.
- 🏢 **7 Department Leads & 67 Specialists:** Pre-configured orchestrators (`Agent-Teams`, `Frontend`, `Backend`, `Security`, `DevOps`, `AI & Data`, `QA`) routing tasks to specialized domain agents.
- ⚡ **Management by Exception:** Unblocked work digests silently; blockers trigger immediate escalations so fixer leads dispatch in parallel.
- 🛡️ **Relay Resilience & Self-Healing:**
  - Heartbeat tolerates transient upstream blips (5 consecutive failures before exit) instead of dying on a single one.
  - Stale-team eviction never deletes teams with running/undrained children.
  - Plugin re-probes relay health on every tool call and respawns a dead relay.
  - Token persisted atomically (tmp+rename+fsync, `0o600`) after a successful listen; capped exponential reconnect backoff; missed completions reconciled on resubscribe.
- 🔄 **Auto-Continue on Transient Provider Errors:** `reasoning_content ... must be passed back` (DeepSeek thinking mode), `AI_JSONParseError` / `JSON parsing failed`, and `[503] request queue is full` are automatically resumed with a minimal "continue" prompt instead of failing the task (bounded retries, genuine failures still surface).
- 🧵 **Inline Sub-Agent Mode:** `running_agents({ inline: true })` renders a child as a native `│ Task` widget with automatic fallback to the relay path on cores that don't support subtask parts.
- ⚙️ **Two-Mode Installer:** `full` (agents + AGENTS.md + plugin + relay + npm dep) and `agents` / `--agents-only` (agents + AGENTS.md only, for native-fork users). Writes a `.installed-mode` marker.
- 🗑️ **Mode-Aware Uninstall:** removes only the artifacts the installed mode manages; preserves other user plugins, `opencode.json`, `package.json`, and `node_modules`. `status` reports the installed mode.
- 📦 **Safe Installer:** non-destructive with full timestamped backups, rollback, and marked-block `AGENTS.md` merging; keeps the last 5 backups.
- 🔒 **Shared-Secret Security:** 32-byte token authentication; unique hash-derived relay ports per server URL (20000–50000) for multi-session isolation.

### Changed
- `install.ps1` is mode-aware (`-AgentsOnly`).
- README documents installation modes; `MANIFEST.txt` lists both.

### Removed
- (n/a — initial release)

### Fixed
- Relay no longer exits on a single transient upstream heartbeat failure.
- Token file no longer world-readable, and is written only after the relay is listening (no clobber on port collisions).
- Sub-agent sessions hitting transient provider errors resume automatically instead of dying.
