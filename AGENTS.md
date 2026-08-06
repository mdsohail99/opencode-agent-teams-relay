<!-- agent-teams-orchestration:start -->
# Department Team-Lead Orchestration (Agent-Teams pattern)

The agent system is organized as departments, each led by an orchestrator (team lead):
Frontend, Backend, Security, DevOps, AI & Data, QA. Each lead fans out to its own
sub-agent team via the Task tool. Leads are `mode: all` (Tab-switchable + Task-launchable).

TWO MODES:
- **Normal mode (any agent except Agent-Teams):** the ACTIVE agent is the main agent
  of its session. If you are a department lead, your "main agent" is whoever spawned
  you (Agent-Teams or the active Tab agent) — escalate to THAT, not to a global "supervisor".
- **Agent-Teams mode:** Agent-Teams IS the main agent/router of the session. It
  receives escalations from its teams and routes to fixers itself (it can launch any
  agent). It reports the final result to the user.

## Core rule: hub-and-spoke — NO lead launches another lead
- Each orchestrator's `permission.task` allowlist contains ONLY its own team members.
  Leads cannot launch other leads (this is mechanically enforced).
- If a lead needs another department, it returns a structured escalation in this format:
  `ESCALATE: <department> | WHAT: <need> | WHERE: <file/module> | CONTEXT: <what it did + what the other team must know>`
- ESCALATE EARLY: return the escalation as soon as the blocker is detected, not after
  finishing all work — the receiving main agent starts the fixer while you continue
  unblocked work.

## You are the MAIN AGENT (Agent-Teams or Build) — how to handle escalations
1. When any sub-agent's result contains `ESCALATE: <dept> | ...`, parse it.
2. Decide the owner:
   - Is that department's lead ALREADY running (an active/prior task_id in this session)?
     → Route the escalation to THAT existing lead (resume its task_id with the context).
   - Not running → spawn that lead via the Task tool with the escalation as its prompt.
3. NEVER spawn a second instance of a department lead that's already running —
   reusing the running lead prevents two writers editing the same module (conflict).
4. Hand the resolution back to the originating team so it can continue.
5. Keep a running mental registry of which leads are active in this session.

## Fan-out is ESCALATION-DRIVEN by default — main agent may parallelize when it fits
The DEFAULT is one lead at a time: spawn a lead, and only spawn another department
when a running lead escalates and explicitly requests it. This is correct whenever
the cross-department dependency is only discovered DURING the work (e.g. QA finds
a backend bug mid-testing). Concurrency is produced by the RESUME pattern, not by
pre-spawning teams.

### When the main agent MAY parallelize (spawn leads in the same message)
Parallel spawn is allowed when the main agent can already see, from the user's
request, that two departments have INDEPENDENT work that can run at the same time
with no write conflict — e.g. frontend UI + backend API are both clearly needed AND
touch different modules. Use judgment: if the tracks are coupled or one waits on the
other, do NOT parallelize — use the default one-lead + escalation flow instead.

### The default flow — single-lead with on-demand escalation
1. Main agent spawns the ONE lead whose task is the user's request (e.g. QA).
2. The lead does all its independent work, then returns `ESCALATE: <dept> | ...`
   only if it actually hit a blocker requiring another department.
3. ONLY THEN does the main agent spawn (or resume) the requested department lead.
4. When the fix returns, the main agent resumes the requesting lead to finish.

### Yield-and-resume (how concurrency happens without pre-spawning)
When a lead escalates mid-task:
1. Lead does all work that does NOT depend on the other department (e.g. QA runs
   all tests except test X), then returns early with
   `ESCALATE: <dept> | ... | CONTEXT: I've done A,B,C; only X is blocked`.
   It does NOT block or wait — its session ends cleanly (main agent keeps task_id).
2. Main agent, in ONE parallel batch, BOTH:
   - resumes the requesting lead's task_id ("keep going on anything else you can; X pending"), AND
   - spawns the needed lead ("fix X for the QA team").
   If the requesting lead has no more independent work, skip the resume and only spawn.
3. When the fixing lead returns, main agent resumes the requesting lead's task_id
   with the fix → it finishes the blocked item.
4. Never keep a lead idle: if a lead can do more work while another department fixes
   its blocker, RESUME it to keep working rather than leaving it paused.
5. When the escalation is a mid-task discovery (like our QA → Backend test case),
   do NOT start both leads together — the dependent lead starts first, escalates,
   and only then is the second lead spawned. Parallel spawn is reserved for work
   the main agent can see is independent from the start.

### Resumption discipline
- Resuming a lead by task_id preserves its session context — it knows what it already did.
- Multiple Task calls in one message run concurrently (proven: 20 subagents in parallel).
- Escalation is non-destructive: the lead's independent output is kept; only the blocked
  item waits.

### Async fan-out plugin (agent-teams, relay-backed)
For true async fan-out (react to the FIRST finisher while others still run), use the
`agent-teams` plugin tools. The plugin is a thin HTTP proxy to a per-instance relay
server (an external opencode SDK client):
- `running_agents` — launch N sub-agent sessions in the background in parallel (non-blocking, UNLIMITED
  count). Returns session IDs immediately. Results return to the caller (chain preserved).
- `next_agent` — block until ONE running session finishes; return its result.
  Other sessions keep running. Call repeatedly to drain results as each finishes.
- `agents_status` — non-blocking snapshot of all running sessions' status/output. Use periodically to check execution progress across team members.

**Multi-instance safety:** one relay per opencode server instance. Each opencode
TUI/session has a unique serverUrl; the relay port is derived from that URL, so
every terminal/project/session gets its own isolated relay. Multiple opencode
sessions can run simultaneously and each spawns its own sub-agent teams.
The main agent keeps working independently while its team sub-agents run.

Used by leads to fan out their team, and by the main agent when it manages multiple
in-flight leads and needs to react to the first finisher. Sub-agents never report to
the main agent directly — always follow the chain: sub-agent -> lead -> main agent.

## One-writer-per-module discipline
When a lead delegates a file/module to another department (via escalation), that
module's ownership transfers. The originating lead must NOT edit the same module
until the other department returns it. Apply this in all dispatch prompts.

## If true parallel teams are needed
Use separate git worktrees (one per department), not parallel writers on the same files.
<!-- agent-teams-orchestration:end -->
