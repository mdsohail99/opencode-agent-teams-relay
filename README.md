<div align="center">
  <h1>🤖 OpenCode Agent Teams Relay</h1>
  <p><strong>Async Department-Lead Orchestration & Parallel Sub-Agent Relay Engine for OpenCode</strong></p>

  <p>
    <img src="https://img.shields.io/npm/v/opencode-agent-teams-relay?style=flat-square&color=blue" alt="NPM Version"/>
    <img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="License"/>
    <img src="https://img.shields.io/github/stars/mdsohail99/opencode-agent-teams-relay?style=flat-square" alt="GitHub"/>
    <img src="https://img.shields.io/badge/OpenCode-Plugin-FF6B6B?style=flat-square&logo=opencode&logoColor=white" alt="OpenCode"/>
    <img src="https://img.shields.io/badge/Node.js-%3E%3D20.19-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js"/>
    <img src="https://img.shields.io/badge/TypeScript-5.0-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"/>
  </p>
</div>

---

## 📌 Project Overview

**`opencode-agent-teams-relay`** is a portable, production-grade orchestration package and background relay engine for [OpenCode](https://github.com/sst/opencode). 

It introduces **true asynchronous sub-agent fan-out** and a multi-agent **Department Lead architecture** into OpenCode. Instead of running single sequential sub-tasks that block your session, `opencode-agent-teams-relay` allows an orchestrator agent (`Agent-Teams`) to launch unlimited child agents in parallel, keep working independently, and react to results as they complete.

Built on the principle of **Management by Exception**, successful sub-agent work digests silently into final reports, while **blockers or failures trigger immediate escalations** to spawn targeted fixer leads concurrently.

---

## ⚡ Features (v1.0.8)

- 🚀 **Stock OpenCode 1.18.34+ Native Compatibility**: Full native support for upstream OpenCode! Supports `subagent_depth = 2` (Root Orchestrator → Department Lead → Specialist) and native `Ctrl+B` background subagent detaching.
- 👁️ **Visible Parallel Batch Task Mode**: Concurrent `Task` dispatch rendered natively in the terminal as live interactive `│ Task` widgets with animated spinners and toolcall logs (`↳ Edit src/...`).
- 📡 **Detached SDK Relay Engine**: External Node.js background process connects via `@opencode-ai/sdk`, tracking `session.idle` and `session.error` events in real-time via SSE.
- 🎮 **Swarm Slash Command Palette**: Pre-configured `/tree`, `/report`, `/ask`, `/resume`, `/stop`, and `/errors` commands for real-time swarm observability and mid-flight steering.
- 🏢 **7 Department Leads & 67 Specialists**: Pre-configured orchestrators (`Frontend`, `Backend`, `Security`, `DevOps`, `AI & Data`, `QA`, `Agent-Teams`) routing tasks to specialized domain agents.
- 🛡️ **Automated Git Worktree Sandboxing**: Integrates with core worktree endpoints to allocate isolated git sandboxes per task, preventing write conflicts and git branch collisions.
- 🔁 **Deterministic Error Resumption**: Seamlessly revives failed or paused agents via `Task(task_id="<id>", prompt="...")`, retaining accumulated memory, tool state, and file diffs.
- ⚡ **Management by Exception**: Unblocked work digests silently; blockers trigger immediate escalations so fixers dispatch in parallel without waiting for unblocked streams.
- ⚡ **Fast Capability Probing**: Instant API-based feature detection eliminates the 5-second startup freeze and ghost probe sessions on SQLite.
- 🔒 **Shared-Secret Security**: Authenticated HTTP communications using 32-byte tokens stored in XDG-compliant state directories (`AppData/Local/opencode/...`).
- 📦 **1-Command Safe Installer**: Non-destructive installer featuring automated full-config backups, rollback capability, and smart marked-block `AGENTS.md` merging.

---

## 🧠 Resilience & Durability (v1.0.8)

- 💾 **Durable WAL + checkpoint state store**: The relay persists its full session tree (`nodes`, `teams`, and an append-only `events` diary) to an append-only write-ahead log (`<state-dir>/agent-teams-relay.wal`) with periodic atomic checkpoints (`<state-dir>/agent-teams-relay-state.json`) — a restarted relay recovers every result, drained flag, and retry budget intact.
- 👁️ **Full-instance visibility**: A plugin supervisor loop (10s tick, started at plugin load) health-checks and respawns the relay, and pushes the opencode server's *entire* live session list to the relay's `/reconcile` endpoint — every session on the instance is monitored, not just relay-spawned children.
- 🌳 **Fast-path capability probe**: Modernized API checks query core capabilities directly without creating throwaway probe sessions, eliminating startup delays and ghost SQLite records.
- 🌲 **Native worktree sandbox lifecycle**: Allocates isolated worktree folders for mutating parallel tasks and cleans them up automatically upon task settlement.
- 🗑️ **Non-destructive by design**: Nothing is ever deleted automatically. Teams are cleaned up **only** after their parent session is *confirmed* deleted. Unreachability is never mistaken for deletion.
- 🔁 **`resume_agent` & `task_id` resumption**: Send follow-up instructions to any alive agent session or recover failed tasks via deterministic `task_id` resumption; context and sandboxes remain preserved.
- 🧊 **Per-agent failure isolation**: Transient provider errors retry per-node (cap 3) — one stuck agent goes `error` with a `needs_attention` event while sibling workers keep running uninterrupted.

---

## 📊 Performance & Measured Impact

*Real numbers from an in-repo orchestration run (Aug 2026). Items labeled **measured** are evidenced facts from that run; everything else is a **modeled estimate** with labeled confidence — never presented as fact.*

### What actually happened (measured ✅)

| Fact | Value |
|---|---|
| Fan-out shape | 1 main orchestrator → **4 department leads** in one parallel batch → each spun **13 specialists** of their own |
| Total concurrent sessions | **18** (1 main + 4 leads + 13 specialists) |
| Wall-clock to final synthesis | **≈15 minutes** (measured floor) |
| Cross-team escalations | **8** raised & routed while other tracks kept running — none forced the run to stop |

> Methodology: the first drain call returned with zero completions (no lead had finished); the four leads then drained sequentially, with the slowest lead bounding the headline runtime. **15 minutes is the measured floor**, not a ceiling — larger tasks amortize the coordination tax further.

### Counterfactual: the same task as a single agent (modeled estimate)

A single agent doing all four departments must work serially and hold one monolithic context:

1. **Wall-clock ≈ 4× slower.** Four department passes in sequence (~11–15 min each) → **45–60 min total**. No LLM parallelism — one brain, one token stream at a time; nothing is "background-computed."
2. **Context exhaustion risk.** One agent accumulates the entire task across all four domains. Past a point, truncation/eviction risk → incomplete deliverables → re-runs, which multiply effective time *and* tokens.
3. **Worse token profile per useful unit.** A single agent re-reads shared files, holds cross-domain working notes, and emits extra tokens just to keep state coherent in one window — the "same budget, worse signal-to-noise" failure mode.

### Side-by-side

| Metric | Team (measured) | Single agent (modeled) |
|---|---|---|
| Wall-clock to complete run | **≈15 min** | ≈45–60 min |
| Concurrent work-streams | **18** | 1 |
| Context per unit of work | Small, focused per agent | Monolithic, grows to overflow |
| Blocker breakdown | Escalated & fixed in parallel | Run stalls |
| Risk of context overflow / truncation | **~0 sessions lost** | High (everything at risk near the end) |
| Total raw LLM tokens | Higher (more sessions, duplicated groundwork) | Baseline (fewer, but less reliable) |

### The honest trade-off

Team orchestration is **not** "faster *and* cheaper on tokens" — that's the part elevator pitches get wrong. The real exchange is:

> **You trade total tokens produced for elapsed wall-clock time, fault isolation, and a focused context per responsibility.**

- **More total tokens** — 18 sessions each reason independently (duplicated groundwork, shared-file reads) vs. one session.
- **Far less wall-clock (~4×)** and **far lower truncation risk** — work advances in parallel and each context stays small.

The coordination "tax" is real: orchestrator handoff, re-briefing each agent, collecting results — non-trivial per-turn overhead. **It pays off only when a task is big enough to amortize that tax** — i.e., decomposable into independent tracks.

### Bottom line

> ⏱ **~15 min vs ~1 hr** (measured vs modeled) · 🔀 **18 parallel sessions vs 1** · 📉 **~4× wall-clock reduction** via parallel fan-out · 🛡 **escalations recover concurrently, not serially**. The team made the run **~4× faster and dramatically safer at the tail end**, at the explicit cost of **higher total LLM tokens** — the classic tokens-for-throughput swap.

---

## 🏗️ Architecture

```mermaid
flowchart TD
    User(["👤 User"]) --> Main1["🤖 Main Agent"] --> Relay["📡 Relay Server"]
    
    subgraph "⚡ Parallel Execution"
        Relay --> L_A["🏢 Lead A"] & L_B["🏢 Lead B"] & L_C["🏢 Lead C"]
        
        L_A --> S_A1["🛠️ Spec A1"] & S_A2["🛠️ Spec A2"]
        L_B --> S_B1["🛠️ Spec B1"] & S_B2["⚠️ Spec B2 (Block)"]
        L_C --> S_C1["🛠️ Spec C1"] & S_C2["🛠️ Spec C2"]
    end

    Main2["🤖 Main (Escalate)"]
    Fixer["🔧 Fixer"]
    S_B2_F["🛠️ Spec B2 (Fixed)"]
    Report["📊 Consolidated Report"]
    
    %% Error Flow
    S_B2 -->|Escalates| Main2 -.->|Fixes| Fixer -.-> S_B2_F
    
    %% Success Flow
    S_A1 & S_A2 & S_B1 & S_C1 & S_C2 --> Report
    S_B2_F --> Report
    
    %% Final Return
    Report --> Main3["🤖 Main Agent"] --> User2(["👤 User"])

    %% Styling
    classDef user fill:#34495e,color:#fff,stroke:#2c3e50,stroke-width:1px
    classDef main fill:#e74c3c,color:#fff,stroke:#c0392b,stroke-width:1px
    classDef relay fill:#9b59b6,color:#fff,stroke:#8e44ad,stroke-width:1px
    classDef team fill:#8e44ad,color:#fff,stroke:#8e44ad,stroke-width:1px
    classDef spec fill:#3498db,color:#fff,stroke:#2980b9,stroke-width:1px
    classDef blocked fill:#e67e22,color:#fff,stroke:#d35400,stroke-width:1px
    classDef fixer fill:#27ae60,color:#fff,stroke:#2ecc71,stroke-width:1px
    classDef report fill:#16a085,color:#fff,stroke:#1abc9c,stroke-width:1px

    class User,User2 user
    class Main1,Main2,Main3 main
    class Relay relay
    class L_A,L_B,L_C team
    class S_A1,S_A2,S_B1,S_C1,S_C2,S_B2_F spec
    class S_B2 blocked
    class Fixer fixer
    class Report report
```

---

## 📋 Prerequisites First

> ⚠️ **Important:** Ensure you have the following installed before running the quick start installer:
> 1. **OpenCode** installed and configured on your machine.
> 2. **Node.js >= 20.19** available in your `PATH` (the relay's durable store is an append-only WAL + periodic atomic checkpoint).
> 3. Active terminal session with access to `npx`.

---

## ⚡ Quick Start

Deploy `opencode-agent-teams-relay` directly to your local OpenCode environment with one command:

```powershell
npx opencode-agent-teams-relay
```

This launches an interactive TUI installer menu:

```text
  Agent-Teams Relay Manager
  =========================

  > 1. Install / Upgrade Agent-Teams
    2. Revert to Backup
    3. Check Status
    4. Uninstall
    5. Exit
```

---

## 🎮 Swarm Slash Command Palette

Agent-Teams registers 6 native slash commands directly into your OpenCode configuration (`opencode.json`), giving you real-time command-and-control over the swarm:

| Slash Command | Question It Answers | What It Does |
| :--- | :--- | :--- |
| **`/tree [filter]`** | *"Who is working right now?"* | Renders a live hierarchical ASCII parent-child tree showing running/completed agents, elapsed execution time, and `[stalled]` tags. |
| **`/report [filter]`** | *"What is the status of the work?"* | Harvests all completed deliverables, code changes, and active tasks across leads to synthesize an executive summary. |
| **`/ask <agent> <query>`** | *"Can I steer a worker mid-flight?"* | Sends an out-of-band side query directly to an active subagent without interrupting its execution or losing turn state. |
| **`/resume <agent> [notes]`**| *"How do I un-stick a paused task?"* | Resumes a stalled, paused, or failed worker, keeping its accumulated memory, tool context, and git worktree sandbox intact. |
| **`/stop [agent|all]`** | *"How do I halt runaway workers?"* | Surgically halts a specific worker or triggers an immediate full-swarm emergency stop. |
| **`/errors`** | *"Did anything break?"* | Scans the swarm for failed, errored, or stalled workers and outputs actionable diagnostic traces. |

---

## ⚙️ Installation Modes

The package ships **two installation modes** to support both upstream stock OpenCode and custom native forks:

### 1. `full` — Default (Stock OpenCode + Swarm Control Plane)

```powershell
npx opencode-agent-teams-relay-install
# or, from this repo:
.\install.ps1
```

Installs the complete orchestration suite:
1. **74 Curated Agents**: `agents/orchestrators/*.md` + `agents/specialists/*.md`.
2. **`AGENTS.md` Rules**: Injects Department Lead orchestration and hub-and-spoke rules (non-destructive marker-based merge).
3. **Native `subagent_depth = 2` & `max_concurrent_agents = 20`**: Configured directly in `opencode.json` for deep hierarchy support.
4. **Slash Commands**: Registers `/tree`, `/report`, `/ask`, `/resume`, `/stop`, and `/errors` in `opencode.json`.
5. **Agent-Teams Plugin**: `plugins/agent-teams.ts` providing fast-path capability probing and bridge tools.
6. **Background Relay Daemon**: `relay/agent-teams-relay.mjs` providing out-of-band monitoring, SQLite WAL state persistence, and native git worktree sandboxing.
7. **NPM Dependency**: Adds `@opencode-ai/plugin` to `~/.config/opencode/package.json`.

*Use this mode if you are running official stock OpenCode (`v1.18.34+`) from npm.*

### 2. `agents` — Agents-Only (Native Fork / Ultra-Lean Mode)

```powershell
npx opencode-agent-teams-relay-install --agents-only
# or, from this repo:
.\install.ps1 -AgentsOnly
```

Installs **only**:
1. **74 Curated Agents**: Uses the fork-native orchestrator configured for in-engine `Task(background=true, daemon=true, worktree=true)`.
2. **`AGENTS.md` Rules**: Full department orchestration contracts.
3. **Native `subagent_depth = 2`**: Configured directly in `opencode.json`.

*Does **NOT** install the plugin, the relay daemon, or extra npm dependencies. Zero background processes, zero open ports, zero overhead. Ideal for native forks (e.g. `anomalyco/opencode`) where background primitives are compiled directly into the binary.*

### Mode Marker & Uninstall Discipline

Every installation writes `.installed-mode` (`"full"` or `"agents"`) into your OpenCode configuration directory. The uninstaller inspects this marker so it only removes what that specific mode manages:
- In `agents` mode, uninstalling never touches user plugins, `node_modules`, or `package.json`.
- In `full` mode, uninstaller cleans up the relay and parked plugins while preserving user settings.
- Re-running the installer seamlessly switches between modes (`full` ↔ `agents`).
- Check current status anytime with `npx opencode-agent-teams-relay-uninstall status`.

---

## 🛠️ Commands & Automation

For CI/CD scripts or automated deployment, use non-interactive binary commands:

| Command | Description |
|---|---|
| `npx opencode-agent-teams-relay` | Interactive TUI menu (install, upgrade, revert, status) |
| `npx opencode-agent-teams-relay-install` | Direct, non-interactive installation script (full mode) |
| `npx opencode-agent-teams-relay-install --agents-only` | Agents-only install (no plugin/relay/npm — native fork) |
| `npx opencode-agent-teams-relay-uninstall` | Non-interactive uninstaller & revert utility |

### Non-Interactive Flag Examples

```powershell
# Direct silent installation (full mode)
npx opencode-agent-teams-relay-install

# Agents-only installation (native fork — no plugin/relay/npm)
npx opencode-agent-teams-relay-install --agents-only

# Check current installation, installed mode & available backups
npx opencode-agent-teams-relay-uninstall status

# Revert to most recent automatic backup
npx opencode-agent-teams-relay-uninstall revert

# Revert to a specific backup version
npx opencode-agent-teams-relay-uninstall revert v0.1.0

# Complete clean uninstall (preserves custom AGENTS.md rules; agents-only mode
# also preserves any other user plugins)
npx opencode-agent-teams-relay-uninstall uninstall
```

### Local PowerShell Installation

```powershell
cd c:\Dev\opencode\orchestration
.\install.ps1                       # full mode (default)
.\install.ps1 -AgentsOnly           # agents-only mode (native fork)
```

---

## 📑 Department Leads & Agents

This package provisions **7 Orchestrators** and **67 Specialist Agents** into your `~/.config/opencode/agents/` directory:

| Department | Orchestrator Agent | Specialized Domain Agents |
|---|---|---|
| ⚡ **Async Fan-Out** | **`Agent-Teams`** | Multi-agent parallel routing (`running_agents`, `next_agent`, `agents_status`) |
| 🎨 **Frontend** | `Frontend` | `Frontend Developer`, `UI Designer`, `UX Architect`, `Accessibility Auditor`, `USWDS Developer` |
| ⚙️ **Backend** | `Backend` | `Backend Architect`, `Database Optimizer`, `API Platform Engineer`, `Payments Billing Engineer`, `Rust Refactoring Specialist` |
| 🛡️ **Security** | `Security` | `Security Architect`, `Penetration Tester`, `Cloud Security Architect`, `Secrets Credential Hygiene Engineer`, `Privacy Engineer` |
| 🚀 **DevOps** | `DevOps` | `DevOps Automator`, `SRE (Site Reliability Engineer)`, `FinOps Engineer`, `IoT Fleet Engineer`, `Incident Response Commander` |
| 🧠 **AI & Data** | `AI & Data` | `AI Engineer`, `RAG Pipeline Engineer`, `Prompt Engineer`, `Data Engineer`, `Search Relevance Engineer` |
| 🧪 **QA** | `QA` | `Test Automation Engineer`, `API Tester`, `Performance Benchmarker`, `Reality Checker`, `Test Results Analyzer` |

---

## 🔄 Upgrade & Automatic Backup System

Every installation automatically creates a full, timestamped backup before modifying your configuration:

1. **Detection:** Reads `.installed-version` in your OpenCode config folder.
2. **Full Backup:** Copies entire config state to `~/.config/opencode/.backups/<version>-<timestamp>/`.
3. **Smart Merge:** Injects or updates the `AGENTS.md` orchestration block using start/end markers (`<!-- agent-teams-orchestration:start -->`), **preserving all existing user rules**.
4. **Pruning:** Automatically keeps the last 5 backups and prunes older entries to conserve space.

### Backup Storage Directory

```text
~/.config/opencode/.backups/
├── v0.1.0-2026-08-05T20-45-00/
│   ├── agents/
│   ├── plugins/
│   ├── relay/
│   └── .installed-version
└── .backup-version
```

---

## 🔒 Security & Context Isolation

- **Token Protection:** The background relay generates a cryptographically secure 32-byte hex token on startup. All IPC requests require a matching `Authorization: Bearer <token>` header.
- **Port Isolation:** Every OpenCode server URL gets a unique, hash-derived relay port (20000–50000). Multiple terminal windows and projects remain completely isolated.
- **Context Preservation:** Sub-agent completions return **only final assistant text summaries** to parent sessions, preventing transcript inflation.

---

## 🤝 Contributing

Contributions of new specialized agents, workflow patterns, and relay optimizations are welcome! Please feel free to open an issue or submit a pull request.

---

## 📄 License

Distributed under the **MIT License**. See [`LICENSE`](LICENSE) for details.
