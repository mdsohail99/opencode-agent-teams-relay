# Changelog

All notable changes to **`opencode-agent-teams-relay`** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v1.0.0.html).

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
