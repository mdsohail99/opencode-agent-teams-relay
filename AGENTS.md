<!-- agent-teams-orchestration:start -->
# Department Team-Lead Orchestration (Agent-Teams v2 Pattern)

The agent system is organized into departments, each led by an orchestrator (Department Lead):
`backend`, `frontend`, `security`, `qa`, `devops`, `ai-data`. 
The primary entry point is the root orchestrator: `agent-teams`.

## Two Operational Modes:
1. **Agent-Teams Mode (Primary / Swarm Mode):**
   `agent-teams` IS the root delegating orchestrator and central **Escalation Resolver**. It receives high-level user requests, fans out work to department leads, catches cross-department escalations, routes blockers to fixer leads, and synthesizes the final consolidated result.
2. **Specialized Single-Lead Mode:**
   When a user directly invokes a department lead (e.g. `@backend` or `@frontend`), that lead acts as the primary agent for the session and fans out to its domain specialists directly.

---

## OpenCode v2 Hierarchical Swarms (`subagent_depth = 2`)
OpenCode v2 natively supports nested subagents up to `subagent_depth = 2` (configured in `opencode.json` via `"subagent_depth": 2`):
- **Depth 0 (Root Orchestrator):** `agent-teams` orchestrates high-level departmental workflows, monitors progress, and resolves cross-department blockers.
- **Depth 1 (Department Leads):** Department Leads (`backend`, `frontend`, `security`, `qa`, `devops`, `ai-data`) receive departmental scopes and dispatch specialists via `team_delegate` or native `subagent` tools.
- **Depth 2 (Domain Specialists):** 68 domain specialists (e.g. `backend-architect`, `frontend-developer`, `database-optimizer`, `api-tester`, `a11y-auditor`) execute focused implementation, testing, or auditing tasks inside isolated Git worktrees.

---

## Core Architecture: Hub-and-Spoke with Delegating Agent as Resolver

### Rule 1: No Lead Launches Another Lead Directly
- Each department lead's scope is strictly confined to its own domain specialists.
- Leads cannot launch peer department leads directly. This prevents circular execution loops and write collisions.

### Rule 2: Management by Exception & Structured Escalation
- If a lead hits a cross-functional blocker (e.g. QA finds an unhandled backend route error, or Frontend needs a new authentication endpoint), it yields immediately with a structured escalation:
  ```text
  ESCALATE: <department> | WHAT: <need> | WHERE: <file/module> | CONTEXT: <what it did + what the other team must know>
  ```
- **Escalate Early:** Yield the escalation as soon as the blocker is identified while continuing any unblocked parallel work.

### Rule 3: The Delegating Agent is the Central Resolver
When `agent-teams` receives an `ESCALATE: <dept>` result from a lead:
1. **Identify the Fixer:** Checks if that department lead is already active in the session registry.
   - If already running: Resumes that lead's existing session with the escalation context.
   - If not running: Spawns the required department lead via `team_delegate` in a dedicated Git worktree.
2. **One-Writer-Per-Module Discipline:** Never spawn duplicate instances of the same department lead on the same module.
3. **Context Handoff:** Once the fixing lead verifies the resolution and auto-merges the worktree, `agent-teams` passes the resolution back to the originating lead to complete its blocked work.

---

## Swarm Concurrency & Git Worktree Sandboxing

1. **Parallel Independent Fan-Out:**
   When independent departmental requirements exist (e.g. Backend API endpoints in `src/routes/` and Frontend UI in `src/components/`), `agent-teams` dispatches both leads concurrently in the same turn.
2. **Isolated Git Worktrees (`worktree: true`):**
   Mutating tasks execute in dedicated `swarm/<team>-<task_id>` branches within isolated worktrees. Once changes are verified, they are committed and merged back into the base working branch automatically.
3. **Strict Read-Only Mode (`worktree: false`):**
   For architectural audits, code reviews, and testability evaluations, tasks execute in-place read-only without creating worktree directories or Git commits.

---

## Swarm Control Tools & Slash Commands

In OpenCode v2, orchestration runs 100% in-process via `@opencode/plugin` and `@opencode/client`:
- `team_delegate` — Dispatches tasks to department specialists with optional Git worktree sandboxing.
- `team_status` — Inspects the live hierarchical status tree, active workers, and Git worktrees.
- `team_broadcast` — Broadcasts steering guidance to active teammates simultaneously.
- `team_terminate` — Gracefully halts running workers and cleans up temporary worktrees.

Slash commands (`/team`, `/team-status`, `/team-stop`) provide real-time TUI progress monitoring and emergency swarm control.
<!-- agent-teams-orchestration:end -->
